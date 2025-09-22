// =============================================================
// LINE Commerce Sales Bot — Single File app.js
// Google Sheets (RAG) + LINE Messaging API + OpenAI (tone only)
// Author: Dev Assistant
// =============================================================
//
//  หมวดโค้ด:
//  1) Imports & Env
//  2) Google Sheets / OpenAI / Cache
//  3) Helpers (format, NLP, validation)
//  4) Retrieval (RAG): products/promotions/faq from sheets
//  5) Session Memory (in-RAM + persist to Google Sheets: Sessions/Logs)
//  6) Sales Flow State Machine (WELCOME → BROWSING → CART → DETAILS → CONFIRM)
//  7) Promotion engine (rule-based)
//  8) Order saving + Admin notify
//  9) LINE API (verify/reply/push) + OpenAI rewrite (STRICT, tone only)
// 10) Intent detection + Handlers per state
// 11) Express endpoints (/webhook /healthz /reload /debug)
// 12) Bootstrap
//
//  NOTE:
//  - ทุกข้อความอ้างอิงข้อมูล “จากชีทเท่านั้น” (RAG). GPT ใช้เฉพาะ “ปรับโทน” ห้ามแต่งเพิ่ม
//  - FAQ/Checkout/Address ขั้นตอนสำคัญ “ไม่เรียก GPT” เพื่อลดดีเลย์และกันมั่ว
//  - เก็บ memory: ข้อความล่าสุด 5 turn ต่อ user, stage, cart, lastCategory
//  - Persist: เขียน Sessions/Logs/Orders กลับไปในชีท
// =============================================================


// =============================================================
// 1) Imports & Env
// =============================================================
import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import { google } from "googleapis";
import fetch from "node-fetch";
import OpenAI from "openai";

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
  console.error("[BOOT] Missing some environment variables.");
}

const GOOGLE_PRIVATE_KEY_FIX = GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");


// =============================================================
// 2) Google Sheets / OpenAI / Cache
// =============================================================
const sheets = google.sheets("v4");
const auth = new google.auth.JWT(
  GOOGLE_CLIENT_EMAIL,
  null,
  GOOGLE_PRIVATE_KEY_FIX,
  ["https://www.googleapis.com/auth/spreadsheets"]
);

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const cache = {
  products: [],
  promotions: [],
  faq: [],
  personality: null,
  payment: [],
  lastLoadedAt: 0
};

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

  const [prod, promos, faq, persona, pay] = await Promise.all([
    loadSheet("Products!A2:G"),
    loadSheet("Promotions!A2:F"),
    loadSheet("FAQ!A2:C"),
    loadSheet("Personality!A2:G"),
    loadSheet("Payment!A2:C")
  ]);

  cache.products = (prod||[]).filter(r=>r[0]).map(r=>({
    code:r[0], name:r[1]||"", category:r[2]||"",
    price:Number(r[3]||0), aliases:splitList(r[4]),
    options:splitList(r[5]), sizes:splitList(r[6])
  }));

  cache.promotions = (promos||[]).filter(r=>r[0]||r[1]).map(r=>({
    code:r[0]||"", detail:r[1]||"", type:(r[2]||"").toLowerCase(),
    condition:r[3]||"", products:splitList(r[4]), categories:splitList(r[5])
  }));

  cache.faq = (faq||[]).filter(r=>r[1]||r[2]).map(r=>({ q:r[0]||"", keyword:r[1]||"", a:r[2]||"" }));

  if (persona?.length) {
    const p = persona[0];
    cache.personality = {
      staffName:p[0]||"ทีมงาน",
      pageName:p[1]||"เพจของเรา",
      persona:p[2]||"พนักงานขาย สุภาพ กระชับ เป็นกันเอง",
      customerName:p[3]||"ลูกค้า",
      adminSelf:p[4]||"แอดมิน",
      dontKnow:p[5]||"ขอเช็กข้อมูลให้ก่อนนะ",
      gender:p[6]||"หญิง"
    };
  }

  cache.payment = (pay||[]).filter(r=>r[0]||r[1]).map(r=>({
    category:r[0]||"", method:r[1]||"", detail:r[2]||"", qrcode:r[3]||""
  }));

  cache.lastLoadedAt = Date.now();
  log("Sheets reloaded.");
}


// =============================================================
// 3) Helpers (format, NLP, validation)
// =============================================================
const log = (...a)=>console.log("[BOT]",...a);
const nowISO = ()=>new Date().toISOString();
const shortId = ()=>Math.random().toString(36).slice(2,10);
const priceTHB = n => `${Number(n||0).toLocaleString("th-TH")} บาท`;

const staffPrefix = ()=> cache.personality?.gender === "หญิง" ? "ค่ะ" : "ครับ";
const staffName = ()=> cache.personality?.staffName || "ทีมงาน";
const pageName  = ()=> cache.personality?.pageName  || "เพจของเรา";
const customerName = ()=> cache.personality?.customerName || "ลูกค้า";
const dontKnow = ()=> cache.personality?.dontKnow || "ขอเช็กข้อมูลให้ก่อนนะ";

const normalize = (s)=>String(s||"").trim().toLowerCase();

function parseQuantity(text){
  const t=normalize(text);
  const m=t.match(/(\d+)\s*(ชิ้น|กระปุก|กล่อง|คัน|ขวด|กิโล|แพ็ค)?/);
  if (m) return Math.max(1, parseInt(m[1]));
  const map={หนึ่ง:1,สอง:2,สาม:3,สี่:4,ห้า:5,หก:6,เจ็ด:7,แปด:8,เก้า:9,สิบ:10};
  for(const [k,v] of Object.entries(map)) if(t.includes(k)) return v;
  return 1;
}

function parsePhone(text){
  const m=String(text).match(/(\+?\d[\d\s-]{7,15}\d)/);
  return m ? m[1].replace(/\s+/g,"") : "";
}

function parseAddress(text){
  // เอาง่าย ๆ: ถ้ามีคำเช่น ต., อ., จ., เขต, แขวง, จังหวัด, รหัสไปรษณีย์ → ถือว่าเป็น address
  const t=String(text);
  if (/(ต\.|อ\.|จ\.|แขวง|เขต|จังหวัด|\d{5})/.test(t)) return t.trim();
  return "";
}


// =============================================================
// 4) Retrieval (RAG)
// =============================================================
function retrieveFAQ(text){
  const low=normalize(text);
  return cache.faq.find(f=>f.keyword && low.includes(normalize(f.keyword)));
}

function retrieveProductsByCategory(cat){
  return cache.products.filter(p=>normalize(p.category)===normalize(cat));
}

function retrieveProductCandidates(text){
  const low=normalize(text);
  // ใช้ทั้งชื่อ, alias, และแยกคำ
  const tokens=low.split(/\s+/).filter(Boolean);
  return cache.products.filter(p=>{
    const name=normalize(p.name);
    const alias=p.aliases.map(a=>normalize(a));
    const hitName=tokens.some(tok=>name.includes(tok));
    const hitAlias=tokens.some(tok=>alias.some(a=>a.includes(tok)));
    return hitName || hitAlias;
  });
}


// =============================================================
// 5) Session Memory (RAM + persist to Google Sheets)
// =============================================================
const sessions={};
/*
 session:
 {
   userId, stage, lastCategory, cart: [ {code,name,option,size,qty,price,category} ],
   history: [ {role:'u'|'b', text:'...'} ], note:'', addr:'', phone:''
 }
*/
function getSession(uid){
  if(!sessions[uid]) sessions[uid]={userId:uid,stage:"WELCOME",lastCategory:"",cart:[],history:[],note:"",addr:"",phone:""};
  return sessions[uid];
}
function remember(session, role, text){
  session.history.push({role, text: String(text||"")});
  if (session.history.length>10) session.history.shift();
}
async function persistSession(session){
  try{
    await sheets.spreadsheets.values.append({
      auth, spreadsheetId: GOOGLE_SHEET_ID,
      range:"Sessions!A:F", valueInputOption:"RAW",
      requestBody:{ values:[[
        nowISO(), session.userId, session.stage,
        JSON.stringify(session.cart||[]), JSON.stringify(session.history||[]),
        session.note||""
      ]]}
    });
  }catch(e){ log("persistSession error", e.message); }
}
async function logEvent(userId,type,text){
  try{
    await sheets.spreadsheets.values.append({
      auth, spreadsheetId: GOOGLE_SHEET_ID,
      range:"Logs!A:D", valueInputOption:"RAW",
      requestBody:{ values:[[nowISO(), userId, type, String(text||"")]] }
    });
  }catch(e){ log("logEvent error", e.message); }
}


// =============================================================
// 6) Sales Flow State Machine
//    WELCOME → BROWSING → CART → DETAILS (addr, phone) → CONFIRM
// =============================================================
function addToCart(session, product, qty=1, option="", size=""){
  if(!product) return;
  const existed=session.cart.find(c=>c.code===product.code&&c.option===option&&c.size===size);
  if(existed) existed.qty+=qty;
  else session.cart.push({ code:product.code,name:product.name,option,size,qty,
                           price:Number(product.price||0),category:product.category });
}
function cartTotal(session){ return (session.cart||[]).reduce((s,c)=>s+c.price*c.qty,0); }
function cartSummary(session){
  if (!session.cart?.length) return `ตะกร้ายังว่างอยู่${staffPrefix()} 🛒`;
  const lines=session.cart.map(c=>`• ${c.name}${c.size?` ${c.size}`:""} x${c.qty} = ${priceTHB(c.price*c.qty)}`);
  return `สรุปตะกร้าค่ะ:\n${lines.join("\n")}\nรวมทั้งหมด ${priceTHB(cartTotal(session))}`;
}
function paymentText(){
  if (!cache.payment.length) return "ยังไม่มีวิธีชำระเงินในชีทค่ะ";
  return cache.payment.map(p=>`• ${p.category}: ${p.method} (${p.detail})`).join("\n");
}


// =============================================================
// 7) Promotion Engine (rule-based สั้นๆ)
// =============================================================
function applyPromotions(session){
  const promos=[];
  for(const promo of cache.promotions){
    // ใช้เมื่อหมวดในตะกร้า match
    if (promo.categories?.length && session.cart.some(c=>promo.categories.includes(c.category))) {
      promos.push(promo.detail);
    }
    // ใช้เมื่อรหัสสินค้าตรง
    if (promo.products?.length && session.cart.some(c=>promo.products.includes(c.code))) {
      promos.push(promo.detail);
    }
  }
  return Array.from(new Set(promos));
}
const promotionSummary = session => {
  const p=applyPromotions(session);
  return p.length ? `โปรโมชั่นที่ใช้ได้:\n${p.map(x=>"• "+x).join("\n")}` : "";
};


// =============================================================
// 8) Orders & Admin notify
// =============================================================
async function saveOrder(session,nameAddr="",phone=""){
  const orderId="ORD-"+shortId();
  const rows=(session.cart||[]).map(c=>[
    orderId, c.code, c.name, c.option, c.qty, c.price*c.qty,
    promotionSummary(session), nameAddr, phone, "ใหม่"
  ]);
  if(!rows.length) return orderId;

  await sheets.spreadsheets.values.append({
    auth, spreadsheetId: GOOGLE_SHEET_ID, range:"Orders!A:J",
    valueInputOption:"RAW", requestBody:{ values: rows }
  });
  return orderId;
}
async function notifyAdmin(orderId, session){
  if (!ADMIN_GROUP_ID) return;
  const lines=session.cart.map(c=>`• ${c.name}${c.size?` ${c.size}`:""} x${c.qty} = ${priceTHB(c.price*c.qty)}`);
  const total=priceTHB(cartTotal(session));
  await linePush(ADMIN_GROUP_ID, [
    { type:"text", text:`🛒 ออเดอร์ใหม่ ${orderId}` },
    { type:"text", text:`${lines.join("\n")}\nรวม ${total}\n${promotionSummary(session)}` }
  ]);
}


// =============================================================
// 9) LINE API + OpenAI rewrite
// =============================================================
async function lineReply(replyToken,messages){
  const url="https://api.line.me/v2/bot/message/reply";
  const res=await fetch(url,{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`},
    body:JSON.stringify({replyToken,messages})
  });
  if(!res.ok) log("LINE reply error", res.status, await res.text());
}
async function linePush(to,messages){
  const url="https://api.line.me/v2/bot/message/push";
  const res=await fetch(url,{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`},
    body:JSON.stringify({to,messages})
  });
  if(!res.ok) log("LINE push error", res.status, await res.text());
}
const makeReply=(text,quick=[])=>{
  const msg={type:"text",text:String(text||"")};
  if(quick.length){
    msg.quickReply={items:quick.map(label=>({type:"action",action:{type:"message",label,text:label}}))};
  }
  return msg;
};
function verifySignature(signature, bodyBuffer){
  const h=crypto.createHmac("SHA256",LINE_CHANNEL_SECRET).update(bodyBuffer).digest("base64");
  return signature===h;
}

// STRICT rewriter (ไม่แต่ง/ไม่เพิ่มข้อมูลใหม่)
async function rewriteWithAI(structuredMsg, ragContext="", session=null){
  try{
    const history = (session?.history||[]).slice(-4).map(h=>{
      const role = h.role==="u"?"user":"assistant";
      return { role, content:h.text };
    });

    const system = `คุณคือพนักงานขายชื่อ "${staffName()}" จาก "${pageName()}" 
บุคลิก: ${cache.personality?.persona}
กฎเหล็ก:
- ห้ามเพิ่มหรือแต่งข้อมูลใหม่ที่ไม่มีในข้อมูลด้านล่าง
- ตอบสั้น กระชับ ไม่เกิน 2 ประโยค
- ถ้าข้อมูลไม่พอ ให้ถามต่อ 1 คำถามเพื่อช่วยลูกค้าตัดสินใจ`;

    const user = `ข้อมูลจากชีท (RAG):
${ragContext || "-ไม่มี-"}
ข้อความต้นฉบับที่ต้องปรับโทน:
${structuredMsg}`;

    const resp=await openai.chat.completions.create({
      model:"gpt-4o-mini",
      temperature:0.4, max_tokens:180,
      messages: [
        { role:"system", content: system },
        ...history,
        { role:"user", content: user }
      ]
    });
    return (resp.choices?.[0]?.message?.content||structuredMsg).trim();
  }catch(e){
    log("rewrite error:", e.message);
    return structuredMsg;
  }
}


// =============================================================
// 10) Intent detection + Handlers per state
// =============================================================
function detectIntent(text){
  const low=normalize(text);
  if (/(สวัสดี|hello|hi)/.test(low)) return {type:"greet"};
  if (/(ชื่ออะไร|ใครคุย|ใครตอบ)/.test(low)) return {type:"ask_name"};
  if (/(เพจอะไร|ชื่อเพจ)/.test(low)) return {type:"ask_page"};
  if (/วิธีชำระ|จ่ายเงิน|โอน|พร้อมเพย์|qr|เช็กเอาท์|สรุปออเดอร์/.test(low)) return {type:"checkout"};
  if (/ยืนยัน|คอนเฟิร์ม|สั่งซื้อเลย|ตกลง/.test(low)) return {type:"confirm"};
  if (/ยกเลิก|ไม่เอา/.test(low)) return {type:"cancel"};
  if (/ที่อยู่|จัดส่ง|ส่งของ|บ้านเลขที่/.test(low)) return {type:"provide_addr"};
  if (/เบอร์|ติดต่อ|โทร/.test(low)) return {type:"provide_phone"};
  if (/โปร|ส่วนลด|ของแถม/.test(low)) return {type:"ask_promo"};
  if (/น้ำพริก/.test(low)) return {type:"browse", category:"น้ำพริก"};
  if (/รถเข็น/.test(low)) return {type:"browse", category:"รถเข็นไต่บันได"};
  const f=retrieveFAQ(text); if(f) return {type:"faq",answer:f.a};
  // default: treat as add-to-cart try
  return {type:"free_text"};
}

async function handleMessage(userId, replyToken, text){
  await ensureDataLoaded();
  const s = getSession(userId);
  remember(s,"u",text);
  await logEvent(userId,"in",text);

  const intent = detectIntent(text);
  let structured="", rag="", quick=[], finalText="";
  let nextStage = s.stage;

  // ===== Global commands that override stage =====
  if (intent.type==="ask_name"){
    structured=`ฉันชื่อ ${staffName()} จากเพจ ${pageName()}`;
    nextStage = s.stage || "WELCOME";
    finalText = structured;
  }
  else if (intent.type==="ask_page"){
    structured=`เพจนี้คือ "${pageName()}" ${staffPrefix()}`;
    nextStage = s.stage || "WELCOME";
    finalText = structured;
  }
  else if (intent.type==="faq"){
    structured=intent.answer;
    nextStage = s.stage || "WELCOME";
    finalText = structured;
  }
  else {
    // ===== State-based =====
    switch(s.stage){
      case "WELCOME":
      default: {
        if (intent.type==="greet"){
          structured = `สวัสดี${staffPrefix()} คุณกำลังคุยกับ${staffName()}จากเพจ ${pageName()} สนใจหมวดไหนคะ น้ำพริกหรือรถเข็นไต่บันได`;
          quick = ["น้ำพริก","รถเข็น"];
          nextStage = "BROWSING";
          break;
        }
        // goto browsing if user names category
        if (intent.type==="browse"){
          s.lastCategory = intent.category;
          const items = retrieveProductsByCategory(intent.category);
          if (items.length){
            rag = items.map(p=>`${p.name}${p.sizes.length?` (${p.sizes.join("/")})`:""} = ${priceTHB(p.price)}`).join("\n");
            structured = `รายการสินค้าในหมวด ${intent.category} (ดู context)`;
            quick = items.slice(0,3).map(p=>p.name).concat(["ดูโปร","เช็กเอาท์"]);
            nextStage = "BROWSING";
          } else {
            structured = `ยังไม่มีสินค้าในหมวด ${intent.category}`;
            nextStage = "WELCOME";
          }
          break;
        }
        // free text: try candidates & add to cart
        if (intent.type==="free_text"){
          let cands = retrieveProductCandidates(text);
          if (!cands.length && s.lastCategory) cands = retrieveProductsByCategory(s.lastCategory);
          if (cands.length){
            const p = cands[0];
            const qty = parseQuantity(text);
            addToCart(s, p, qty, "", p.sizes[0]||"");
            structured = `เพิ่ม ${p.name} จำนวน ${qty} ชิ้น ลงตะกร้าแล้ว`;
            rag = `${p.name} = ${priceTHB(p.price)}`;
            quick = ["ดูโปร","เช็กเอาท์","สรุปตะกร้า"];
            nextStage = "CART";
          } else {
            structured = `${dontKnow()} ตอนนี้มี 2 หมวดหลัก: น้ำพริก และ รถเข็นไต่บันได เลือกดูหมวดไหนคะ`;
            quick = ["น้ำพริก","รถเข็น"];
            nextStage = "WELCOME";
          }
          break;
        }
        if (intent.type==="checkout"){
          structured = `${cartSummary(s)}\n${promotionSummary(s)}\n\nวิธีชำระเงิน:\n${paymentText()}\n\nถ้าพร้อม สะดวกแจ้งชื่อ-ที่อยู่ และเบอร์โทรได้เลยค่ะ`;
          quick = ["แจ้งที่อยู่","แจ้งเบอร์","ยืนยันสั่งซื้อ"];
          nextStage = "DETAILS";
          break;
        }
        // other
        structured = `${dontKnow()} สนใจเริ่มที่หมวดสินค้าเลยไหม${staffPrefix()} น้ำพริก หรือ รถเข็นไต่บันได`;
        quick = ["น้ำพริก","รถเข็น"];
        nextStage = "WELCOME";
      }
    }
  }

  // ===== Separate handlers for some explicit intents (works in any stage) =====
  if (intent.type==="ask_promo"){
    structured = promotionSummary(s) || "ตอนนี้ยังไม่มีโปรที่เข้าเงื่อนไขตะกร้าค่ะ";
    nextStage = s.stage || "CART";
    finalText = structured;
  }
  if (intent.type==="checkout"){
    structured = `${cartSummary(s)}\n${promotionSummary(s)}\n\nวิธีชำระเงิน:\n${paymentText()}\n\nหากพร้อม แจ้งชื่อ-ที่อยู่ และเบอร์โทรได้เลยค่ะ`;
    quick = ["แจ้งที่อยู่","แจ้งเบอร์","ยืนยันสั่งซื้อ"];
    nextStage = "DETAILS";
    finalText = structured;
  }
  if (intent.type==="provide_phone"){
    const phone = parsePhone(text);
    if (phone){
      s.phone = phone;
      structured = `รับเบอร์ ${phone} เรียบร้อยค่ะ\nต่อไปขอชื่อ-ที่อยู่จัดส่งหน่อยนะคะ`;
      quick = ["แจ้งที่อยู่","เช็กเอาท์"];
      nextStage = "DETAILS";
      finalText = structured;
    }
  }
  if (intent.type==="provide_addr"){
    const addr = parseAddress(text);
    if (addr){
      s.addr = addr;
      structured = `รับที่อยู่เรียบร้อยค่ะ ✅\nถ้าพร้อมกดยืนยันสั่งซื้อได้เลย`;
      quick = ["ยืนยันสั่งซื้อ","เช็กเอาท์"];
      nextStage = "CONFIRM";
      finalText = structured;
    }
  }
  if (intent.type==="confirm"){
    if (!s.cart.length){
      structured = `ตะกร้ายังว่างอยู่${staffPrefix()} เพิ่มสินค้าแล้วค่อยยืนยันนะคะ`;
      nextStage = "BROWSING";
      finalText = structured;
    } else if (!s.addr || !s.phone){
      structured = `ขาดข้อมูลจัดส่งค่ะ กรุณาแจ้งที่อยู่และเบอร์โทรก่อนยืนยันนะคะ`;
      quick = ["แจ้งที่อยู่","แจ้งเบอร์"];
      nextStage = "DETAILS";
      finalText = structured;
    } else {
      const orderId = await saveOrder(s, s.addr, s.phone);
      await notifyAdmin(orderId, s);
      structured = `รับออเดอร์ ${orderId} เรียบร้อยค่ะ 🎉\nยอดรวม ${priceTHB(cartTotal(s))}\n${promotionSummary(s)}\n\nวิธีชำระเงิน:\n${paymentText()}\nโอนแล้วส่งสลิปได้เลยนะคะ`;
      nextStage = "WELCOME";
      s.cart = []; // clear cart after order issued
      finalText = structured;
    }
  }
  if (intent.type==="cancel"){
    s.cart = [];
    structured = `เคลียร์ตะกร้าให้แล้ว${staffPrefix()} ถ้าต้องการเริ่มใหม่พิมพ์ชื่อสินค้าได้เลย`;
    nextStage = "WELCOME";
    finalText = structured;
  }

  // ===== Build final text (Hybrid: บางเคสไม่เรียก GPT เพื่อให้ไว/ไม่มั่ว) =====
  const noAI = (
    intent.type==="ask_name" ||
    intent.type==="ask_page" ||
    intent.type==="faq" ||
    intent.type==="checkout" ||
    intent.type==="provide_phone" ||
    intent.type==="provide_addr" ||
    intent.type==="confirm" ||
    intent.type==="cancel"
  );

  if (!finalText){
    if (noAI) {
      finalText = structured;
    } else {
      finalText = await rewriteWithAI(structured, rag, s);
    }
  }

  // ===== Send & persist =====
  s.stage = nextStage;
  remember(s,"b",finalText);
  await lineReply(replyToken, [ makeReply(finalText, quick) ]);
  await persistSession(s);
  await logEvent(userId,"out",finalText);
}


// =============================================================
// 11) Express endpoints
// =============================================================
const app = express();

// raw body for /webhook
app.use("/webhook", bodyParser.raw({ type:"*/*" }));
app.use(bodyParser.json());

app.get("/healthz", (req,res)=> res.json({ ok:true, ts: Date.now() }));

app.post("/reload", async (req,res)=>{
  try{
    await ensureDataLoaded(true);
    res.json({ reloadedAt: cache.lastLoadedAt, staff: staffName() });
  }catch(e){ res.status(500).json({ error:e.message }); }
});

app.get("/debug", async (req,res)=>{
  try{
    await ensureDataLoaded();
    res.json({
      personality: cache.personality,
      productsSample: cache.products.slice(0,5),
      payments: cache.payment,
      promosSample: cache.promotions.slice(0,3),
      faqSample: cache.faq.slice(0,3),
      lastLoadedAt: cache.lastLoadedAt
    });
  }catch(e){ res.status(500).json({ error:e.message }); }
});

app.post("/webhook", async (req,res)=>{
  const sig=req.headers["x-line-signature"];
  if (!verifySignature(sig, req.body)) return res.status(400).send("Bad signature");
  const body=JSON.parse(req.body.toString("utf8"));
  res.sendStatus(200);

  for (const ev of (body.events||[])) {
    try{
      if (ev.type==="message" && ev.message?.type==="text") {
        await handleMessage(ev.source.userId, ev.replyToken, ev.message.text);
      } else {
        await lineReply(ev.replyToken, [ makeReply(`ขออภัย ตอนนี้รองรับเฉพาะข้อความตัวอักษร${staffPrefix()}`, ["น้ำพริก","รถเข็น","เช็กเอาท์"]) ]);
      }
    }catch(e){
      log("event error", e.message);
      try {
        await lineReply(ev.replyToken, [ makeReply(`${dontKnow()} หากสะดวก พิมพ์ชื่อสินค้าหรือเลือกหมวดได้เลย${staffPrefix()}`, ["น้ำพริก","รถเข็น"]) ]);
      } catch {}
    }
  }
});


// =============================================================
// 12) Bootstrap
// =============================================================
const port = PORT || 3000;
app.listen(port, async ()=>{
  log(`🚀 Server running on port ${port}`);
  try{
    await ensureDataLoaded(true);
  }catch(e){ log("initial load error:", e.message); }
  // โหลดซ้ำทุก 5 นาที (ลดการ call ชีทบ่อย)
  setInterval(()=> ensureDataLoaded(true), 5*60*1000);
});
