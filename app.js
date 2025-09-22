// =============================================================
// LINE Commerce Hybrid RAG Bot (Google Sheets + GPT-4o-mini)
// Author: Dev Assistant
// =============================================================

import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import { google } from "googleapis";
import fetch from "node-fetch";
import OpenAI from "openai";

// ------------------ ENV ------------------
const {
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  GOOGLE_SHEET_ID,
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  OPENAI_API_KEY,
  ADMIN_GROUP_ID,
  PORT
} = process.env;

if (!GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY || !GOOGLE_SHEET_ID ||
    !LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET || !OPENAI_API_KEY) {
  console.error("[BOOT] Missing environment variables");
}

const GOOGLE_PRIVATE_KEY_FIX = GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

// ------------------ Google Sheets ------------------
const sheets = google.sheets("v4");
const auth = new google.auth.JWT(
  GOOGLE_CLIENT_EMAIL,
  null,
  GOOGLE_PRIVATE_KEY_FIX,
  ["https://www.googleapis.com/auth/spreadsheets"]
);

// ------------------ OpenAI ------------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ------------------ Cache ------------------
const cache = {
  products: [],
  promotions: [],
  faq: [],
  personality: null,
  payment: [],
  lastLoadedAt: 0
};

// ------------------ Utils ------------------
const log = (...a) => console.log("[BOT]", ...a);
const nowISO = () => new Date().toISOString();
const shortId = () => Math.random().toString(36).slice(2,10);
const priceTHB = (n) => `${Number(n||0).toLocaleString("th-TH")} บาท`;

const staffPrefix = () => cache.personality?.gender==="หญิง" ? "ค่ะ" : "ครับ";
const staffName = () => cache.personality?.staffName || "ทีมงาน";
const pageName = () => cache.personality?.pageName || "เพจของเรา";
const dontKnow = () => cache.personality?.dontKnow || "ขอเช็กข้อมูลให้ก่อนนะ";

// ------------------ Load Sheets ------------------
async function loadSheet(range) {
  const res = await sheets.spreadsheets.values.get({
    auth, spreadsheetId: GOOGLE_SHEET_ID, range
  });
  return res.data.values || [];
}

function splitList(s) {
  if (!s) return [];
  return String(s).split(",").map(t=>t.trim()).filter(Boolean);
}

async function ensureDataLoaded(force=false) {
  if (!force && Date.now()-cache.lastLoadedAt < 5*60*1000) return;
  log("Reloading sheets data…");

  const [prod,promos,faq,persona,pay] = await Promise.all([
    loadSheet("Products!A2:G"),
    loadSheet("Promotions!A2:F"),
    loadSheet("FAQ!A2:C"),
    loadSheet("Personality!A2:G"),
    loadSheet("Payment!A2:C")
  ]);

  cache.products = prod.filter(r=>r[0]).map(r=>({
    code:r[0], name:r[1]||"", category:r[2]||"",
    price:Number(r[3]||0), aliases:splitList(r[4]),
    options:splitList(r[5]), sizes:splitList(r[6])
  }));

  cache.promotions = promos.filter(r=>r[0]||r[1]).map(r=>({
    code:r[0]||"", detail:r[1]||"", type:(r[2]||"").toLowerCase(),
    condition:r[3]||"", products:splitList(r[4]), categories:splitList(r[5])
  }));

  cache.faq = faq.filter(r=>r[1]||r[2]).map(r=>({ q:r[0]||"", keyword:r[1]||"", a:r[2]||"" }));

  if (persona && persona.length) {
    const p = persona[0];
    cache.personality = {
      staffName:p[0]||"ทีมงาน", pageName:p[1]||"เพจของเรา",
      persona:p[2]||"พนักงานขาย สุภาพ กระชับ เป็นกันเอง",
      customerName:p[3]||"ลูกค้า", adminSelf:p[4]||"แอดมิน",
      dontKnow:p[5]||"ขอเช็กข้อมูลให้ก่อนนะ", gender:p[6]||"หญิง"
    };
  }

  cache.payment = pay.filter(r=>r[0]||r[1]).map(r=>({
    category:r[0]||"", method:r[1]||"", detail:r[2]||""
  }));

  cache.lastLoadedAt = Date.now();
  log("Sheets reloaded");
}

// ------------------ LINE API ------------------
async function lineReply(replyToken,messages){
  const url="https://api.line.me/v2/bot/message/reply";
  await fetch(url,{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`},
    body:JSON.stringify({replyToken,messages})
  });
}

async function linePush(to,messages){
  const url="https://api.line.me/v2/bot/message/push";
  await fetch(url,{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`},
    body:JSON.stringify({to,messages})
  });
}

const makeReply=(text,quick=[])=>{
  const msg={type:"text",text:String(text||"")};
  if(quick.length){
    msg.quickReply={items:quick.map(label=>({
      type:"action",action:{type:"message",label,text:label}
    }))};
  }
  return msg;
};

function verifySignature(signature, bodyBuffer){
  const h=crypto.createHmac("SHA256",LINE_CHANNEL_SECRET).update(bodyBuffer).digest("base64");
  return signature===h;
}

// ------------------ NLP + Retrieval ------------------
const normalize=s=>String(s||"").trim().toLowerCase();

function parseQuantity(text){
  const t=normalize(text);
  const m=t.match(/(\d+)/);
  return m?Math.max(1,parseInt(m[1])):1;
}

function retrieveFAQ(text){
  const low=normalize(text);
  return cache.faq.find(f=>f.keyword && low.includes(normalize(f.keyword)));
}

function retrieveProductsByCategory(cat){
  return cache.products.filter(p=>normalize(p.category)===normalize(cat));
}

function retrieveProductCandidates(text){
  const low=normalize(text);
  return cache.products.filter(p=>
    normalize(p.name).includes(low) ||
    p.aliases.some(a=>normalize(a).includes(low))
  );
}

// ------------------ Session + Cart ------------------
const sessions={};
function getSession(uid){
  if(!sessions[uid]) sessions[uid]={userId:uid,stage:"",cart:[],note:""};
  return sessions[uid];
}
function addToCart(session,product,qty=1,option="",size=""){
  if(!product) return;
  const found=session.cart.find(c=>c.code===product.code&&c.option===option&&c.size===size);
  if(found) found.qty+=qty;
  else session.cart.push({
    code:product.code,name:product.name,option,size,qty,
    price:Number(product.price||0),category:product.category
  });
}
function cartTotal(session){ return session.cart.reduce((s,c)=>s+c.price*c.qty,0); }
function cartSummary(session){
  if(!session.cart.length) return `ตะกร้าว่างอยู่${staffPrefix()} 🛒`;
  const lines=session.cart.map(c=>`• ${c.name}${c.size?` ${c.size}`:""} x${c.qty} = ${priceTHB(c.price*c.qty)}`);
  return `สรุปตะกร้า:\n${lines.join("\n")}\nรวม ${priceTHB(cartTotal(session))}`;
}

// ------------------ Promotions ------------------
function applyPromotions(session){
  const promos=[];
  for(const promo of cache.promotions){
    if(promo.categories.some(cat=>session.cart.some(c=>c.category===cat))){
      promos.push(promo.detail);
    }
  }
  return promos;
}
const promotionSummary=session=>{
  const p=applyPromotions(session);
  return p.length?`โปรโมชั่น:\n${p.map(x=>"• "+x).join("\n")}`:"";
};

// ------------------ Orders ------------------
async function saveOrder(session,nameAddr="",phone=""){
  const orderId="ORD-"+shortId();
  const rows=session.cart.map(c=>[
    orderId,c.code,c.name,c.option,c.qty,c.price*c.qty,
    promotionSummary(session),nameAddr,phone,"ใหม่"
  ]);
  if(!rows.length) return orderId;

  await sheets.spreadsheets.values.append({
    auth,spreadsheetId:GOOGLE_SHEET_ID,range:"Orders!A:J",
    valueInputOption:"RAW",requestBody:{values:rows}
  });
  return orderId;
}

async function notifyAdmin(orderId,session){
  if(!ADMIN_GROUP_ID) return;
  const lines=session.cart.map(c=>`${c.name} x${c.qty} = ${priceTHB(c.price*c.qty)}`);
  const total=priceTHB(cartTotal(session));
  await linePush(ADMIN_GROUP_ID,[
    {type:"text",text:`🛒 ออเดอร์ใหม่ ${orderId}`},
    {type:"text",text:`${lines.join("\n")}\nรวม ${total}`}
  ]);
}

// ------------------ AI ------------------
async function rewriteWithAI(structuredMsg,ragContext=""){
  try{
    const resp=await openai.chat.completions.create({
      model:"gpt-4o-mini",temperature:0.4,max_tokens:200,
      messages:[
        {role:"system",content:`คุณคือพนักงานขายชื่อ "${staffName()}" จาก "${pageName()}"
บุคลิก: ${cache.personality?.persona}
ห้ามแต่งหรือเพิ่มข้อมูลเอง ตอบสั้น กระชับ ชวนคุยต่อเล็กน้อย`},
        {role:"user",content:`Context:\n${ragContext}\n\nMessage:\n${structuredMsg}`}
      ]
    });
    return resp.choices[0].message.content.trim();
  }catch(e){
    log("AI error",e.message);
    return structuredMsg;
  }
}

// ------------------ Intent ------------------
function detectIntent(text){
  const low=normalize(text);
  if(/(สวัสดี|hello|hi)/.test(low)) return {type:"greet"};
  if(/ชื่ออะไร/.test(low)) return {type:"ask_name"};
  if(/เพจอะไร/.test(low)) return {type:"ask_page"};
  if(/(เช็กเอาท์|ชำระเงิน|สรุปออเดอร์)/.test(low)) return {type:"checkout"};
  if(low.includes("น้ำพริก")) return {type:"browse",category:"น้ำพริก"};
  if(low.includes("รถเข็น")) return {type:"browse",category:"รถเข็นไต่บันได"};
  const f=retrieveFAQ(text); if(f) return {type:"faq",answer:f.a};
  return {type:"unknown"};
}

// ------------------ Handle Message ------------------
async function handleMessage(userId,replyToken,text){
  await ensureDataLoaded();
  const session=getSession(userId);
  const intent=detectIntent(text);
  let structured="",ragContext="",quick=[],finalText="";

  switch(intent.type){
    case "greet":
      structured=`สวัสดี${staffPrefix()} ยินดีต้อนรับสู่เพจ ${pageName()} สนใจดูหมวดไหนคะ น้ำพริกหรือรถเข็นไต่บันได`;
      quick=["น้ำพริก","รถเข็น"];
      break;
    case "ask_name": structured=`ฉันชื่อ ${staffName()} จากเพจ ${pageName()}`; break;
    case "ask_page": structured=`เพจนี้คือ ${pageName()}`; break;
    case "faq": structured=intent.answer; break;
    case "browse":
      const items=retrieveProductsByCategory(intent.category);
      if(items.length){
        ragContext=items.map(p=>`${p.name} = ${priceTHB(p.price)}`).join("\n");
        structured=`หมวด ${intent.category} ดูรายการใน context`;
        quick=items.slice(0,3).map(p=>p.name).concat(["เช็กเอาท์"]);
      }else structured=`ยังไม่มีสินค้าในหมวด ${intent.category}`;
      break;
    case "checkout":
      const cart=cartSummary(session);
      const promos=promotionSummary(session);
      const pays=cache.payment.map(p=>`${p.category}: ${p.method} (${p.detail})`).join("\n");
      structured=`${cart}\n${promos}\nวิธีชำระเงิน:\n${pays}`;
      break;
    default:
      structured=`${dontKnow()} สนใจหมวดน้ำพริกหรือรถเข็นไต่บันไดคะ`;
      quick=["น้ำพริก","รถเข็น"];
  }

  if(["faq","checkout","ask_name","ask_page"].includes(intent.type)){
    finalText=structured;
  }else{
    finalText=await rewriteWithAI(structured,ragContext);
  }

  await lineReply(replyToken,[makeReply(finalText,quick)]);
}

// ------------------ Express ------------------
const app=express();
app.use("/webhook",bodyParser.raw({type:"*/*"}));
app.use(bodyParser.json());

app.get("/healthz",(req,res)=>res.json({ok:true,ts:Date.now()}));

app.post("/webhook",async(req,res)=>{
  const sig=req.headers["x-line-signature"];
  if(!verifySignature(sig,req.body)) return res.status(400).send("Bad sig");
  const body=JSON.parse(req.body.toString("utf8"));
  res.sendStatus(200);

  for(const ev of body.events||[]){
    if(ev.type==="message" && ev.message?.type==="text"){
      await handleMessage(ev.source.userId,ev.replyToken,ev.message.text);
    }else{
      await lineReply(ev.replyToken,[makeReply(`รองรับเฉพาะข้อความตัวอักษร${staffPrefix()}`,["น้ำพริก","รถเข็น"])]);
    }
  }
});

const port=PORT||3000;
app.listen(port,async()=>{
  log(`🚀 Server running on port ${port}`);
  await ensureDataLoaded(true);
  setInterval(()=>ensureDataLoaded(true),5*60*1000);
});
