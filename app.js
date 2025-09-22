// LINE Commerce Bot — Staff-like, Sheet-first (strict), Session-aware
// Node >=18, "type": "module"
import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import fetch from "node-fetch";
import { google } from "googleapis";
import OpenAI from "openai";

/* ========= ENV ========= */
const PORT = process.env.PORT || 10000;
const LINE_TOKEN   = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_SECRET  = process.env.LINE_CHANNEL_SECRET;
const G_CLIENT     = process.env.GOOGLE_CLIENT_EMAIL;
const G_PRIVATE    = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const SHEET_ID     = process.env.GOOGLE_SHEET_ID;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;
const ADMIN_GROUP  = process.env.ADMIN_GROUP_ID || "";

/* ========= Utilities ========= */
const log = (...a)=>console.log("[BOT]", ...a);
const nowISO = ()=>new Date().toISOString();
const thb = n => `${Number(n||0).toLocaleString("th-TH")} บาท`;
const norm = s => String(s||"").trim().toLowerCase();
const csv  = s => String(s||"").split(",").map(x=>x.trim()).filter(Boolean);
const trimLabel = s => (String(s||"").length>20?String(s).slice(0,17)+"...":String(s||""));

/* ========= Google Sheets ========= */
const auth = new google.auth.JWT(G_CLIENT, null, G_PRIVATE, ["https://www.googleapis.com/auth/spreadsheets.readonly"]);
const sheets = google.sheets("v4");
async function getRange(range){
  const res = await sheets.spreadsheets.values.get({auth, spreadsheetId: SHEET_ID, range});
  return res.data.values || [];
}

const store = {
  products: [],     // {code,name,category,price,aliases[],options[],sizes[]}
  promotions: [],   // {code,detail,type,condition,products[],categories[]}
  faq: [],          // {keyword,answer}
  personality: {},  // {staffName,pageName,persona,callCustomer,adminSelf,dontKnow,gender}
  payment: [],      // {category,method,detail,qrcode}
  lastLoadedAt: 0
};

async function loadSheets(force=false){
  if(!force && Date.now()-store.lastLoadedAt<3*60*1000) return;
  log("Reloading sheets...");
  const [prod, promo, faq, pers, pay] = await Promise.all([
    getRange("Products!A2:G"),
    getRange("Promotions!A2:F"),
    getRange("FAQ!A2:C"),
    getRange("Personality!A2:G"),
    getRange("Payment!A2:D"),
  ]);

  store.products = (prod||[]).filter(r=>r[0]).map(r=>({
    code: r[0], name: r[1]||"", category: r[2]||"",
    price: Number(r[3]||0),
    aliases: csv(r[4]), options: csv(r[5]), sizes: csv(r[6])
  }));

  store.promotions = (promo||[]).map(r=>({
    code: r[0]||"", detail:r[1]||"", type:(r[2]||"text").toLowerCase(),
    condition:r[3]||"", products:csv(r[4]), categories:csv(r[5]),
  }));

  store.faq = (faq||[]).map(r=>({ keyword:r[1]||"", answer:r[2]||"" }));

  const p = (pers?.[0]||[]);
  store.personality = {
    staffName: p[0]||"แอดมิน", pageName:p[1]||"ร้านเรา",
    persona: p[2]||"สุภาพ กระชับ ช่วยตัดสินใจ",
    callCustomer: p[3]||"คุณลูกค้า", adminSelf:p[4]||"แอดมิน",
    dontKnow: p[5]||"ขอเช็กข้อมูลเพิ่มเติมก่อนนะคะ", gender:p[6]||"หญิง"
  };

  store.payment = (pay||[]).map(r=>({category:r[0]||"", method:r[1]||"", detail:r[2]||"", qrcode:r[3]||""}));

  store.lastLoadedAt=Date.now();
  log("Sheets reloaded OK. products:", store.products.length);
}
const staffPrefix = ()=>store.personality.gender==="หญิง"?"ค่ะ":"ครับ";

/* ========= OpenAI (tone only) ========= */
const openai = new OpenAI({ apiKey: OPENAI_KEY });
async function toneRewrite(text, context=""){
  try{
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      max_tokens: 180,
      messages: [
        { role:"system", content:
`คุณคือพนักงานขายชื่อ "${store.personality.staffName}" จาก "${store.personality.pageName}" 
บุคลิก: ${store.personality.persona}
ห้ามแต่งข้อมูลใหม่ หากไม่มีใน Context ให้บอกว่าไม่มีข้อมูล และถามต่อ 1 คำถาม
คำตอบต้องสั้น กระชับ เป็นธรรมชาติ ไม่เกิน 2 ประโยค` },
        { role:"user", content:`Context:\n${context || "-"}\n\nตอบข้อความนี้ให้สุภาพและเป็นกันเอง:\n${text}` }
      ]
    });
    return (res.choices?.[0]?.message?.content||text).trim();
  }catch(e){ log("AI error", e.message); return text; }
}

/* ========= LINE API ========= */
function verifySignature(sig, bodyBuf){
  const h = crypto.createHmac("SHA256", LINE_SECRET).update(bodyBuf).digest("base64");
  return h===sig;
}
async function lineReply(replyToken, messages){
  const res = await fetch("https://api.line.me/v2/bot/message/reply",{
    method:"POST",
    headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ replyToken, messages })
  });
  if(!res.ok){ log("LINE reply error", res.status, await res.text()); }
}
async function linePush(to, messages){
  const res = await fetch("https://api.line.me/v2/bot/message/push",{
    method:"POST",
    headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to, messages })
  });
  if(!res.ok){ log("LINE push error", res.status, await res.text()); }
}
function makeText(text, quick=[]){
  return {
    type:"text", text:String(text||""),
    quickReply: quick.length?{
      items: quick.map(q=>({ type:"action", action:{type:"message", label: trimLabel(q), text:q} }))
    }:undefined
  };
}

/* ========= Retrieval helpers (strict-sheet) ========= */
function findProductsByText(msg, catHint=""){
  const low = norm(msg);
  // try direct name / alias
  let list = store.products.filter(p => norm(p.name).includes(low) || p.aliases.some(a=>norm(a)&&low.includes(norm(a))));
  if(list.length) return list;
  // try category keyword present
  if(catHint) list = store.products.filter(p => norm(p.category)===norm(catHint));
  return list;
}
function faqAnswer(msg){
  const low = norm(msg);
  const f = store.faq.find(f=>f.keyword && low.includes(norm(f.keyword)));
  return f ? f.answer : "";
}
function paymentSummary(){
  if(!store.payment.length) return "ยังไม่มีวิธีชำระเงินในระบบ"+staffPrefix();
  return store.payment.map(p=>`• ${p.category}: ${p.method} (${p.detail})`).join("\n");
}
function promotionsForCart(cart){
  const hits = [];
  for(const pr of store.promotions){
    let ok = false;
    if(pr.categories?.length && cart.some(c=>pr.categories.includes(c.category))) ok = true;
    if(pr.products?.length && cart.some(c=>pr.products.includes(c.code))) ok = true;
    if(pr.type==="text") ok = true;
    if(ok && pr.detail) hits.push(pr.detail);
  }
  return [...new Set(hits)];
}

/* ========= Session (in-memory) ========= */
const sessions = {}; // userId -> session
function getSess(uid){
  if(!sessions[uid]) sessions[uid] = {
    stage:"WELCOME", focusCategory:"", focusProduct:"", cart:[], addr:"", phone:"", history:[]
  };
  return sessions[uid];
}
const cartTotal = s => (s.cart||[]).reduce((sum,i)=>sum+i.price*i.qty,0);
function cartText(s){
  if(!s.cart.length) return `ตะกร้ายังว่างอยู่${staffPrefix()} 🛒`;
  const lines = s.cart.map(i=>`• ${i.name}${i.size?` ${i.size}`:""} x${i.qty} = ${thb(i.price*i.qty)}`);
  return `สรุปตะกร้า:\n${lines.join("\n")}\nรวมทั้งหมด ${thb(cartTotal(s))}`;
}
function addCart(s, p, qty=1, size="", option=""){
  const ex = s.cart.find(i=>i.code===p.code && i.size===size && i.option===option);
  if(ex) ex.qty+=qty; else s.cart.push({code:p.code,name:p.name,price:p.price,qty,category:p.category,size,option});
}

/* ========= Intent ========= */
function detectIntent(msg){
  const low = norm(msg);
  if (/(สวัสดี|hello|hi)/.test(low)) return "greet";
  if (/(ชื่อ(อะไร)?|ใครคุย|พนักงาน)/.test(low)) return "ask_staff";
  if (/(โปร|ส่วนลด|promotion)/.test(low)) return "ask_promo";
  if (/(จ่าย|โอน|พร้อมเพย์|เก็บปลายทาง|ชำระ)/.test(low)) return "ask_payment";
  if (/(สรุป|ตะกร้า|เช็กเอาท์|checkout)/.test(low)) return "cart";
  if (/(ยืนยัน|คอนเฟิร์ม|สั่งซื้อเลย|ตกลง)/.test(low)) return "confirm";
  if (/(ยกเลิก|ล้างตะกร้า)/.test(low)) return "cancel_cart";
  if (/(ที่อยู่|จัดส่ง|จังหวัด|แขวง|อำเภอ|รหัสไปรษณีย์)/.test(low)) return "addr";
  if (/(เบอร์|โทร)/.test(low)) return "phone";
  if (/น้ำพริก/.test(low)) return "cat_chili";
  if (/รถเข็น/.test(low)) return "cat_cart";
  if (faqAnswer(msg)) return "faq";
  return "free";
}

/* ========= Webhook handling ========= */
const app = express();
app.use("/webhook", bodyParser.raw({type:"*/*"}));
app.get("/healthz",(req,res)=>res.json({ok:true, loaded:store.lastLoadedAt}));

app.post("/webhook", async (req,res)=>{
  try{
    if(!verifySignature(req.headers["x-line-signature"], req.body)) return res.status(400).send("bad signature");
    const body = JSON.parse(req.body.toString("utf8"));
    res.sendStatus(200);
    await loadSheets();
    for (const ev of (body.events||[])){
      if (ev.type==="message" && ev.message.type==="text") {
        const uid = ev.source.userId, text = ev.message.text, s = getSess(uid);
        const intent = detectIntent(text);
        let out="", quick=[], ctx="";
        try{
          switch(intent){
            case "greet":
              s.stage="BROWSING";
              out = `สวัสดี${staffPrefix()} คุณกำลังคุยกับ${store.personality.staffName}จากเพจ ${store.personality.pageName} สนใจหมวดไหนคะ (น้ำพริก / รถเข็นไต่บันได)`;
              quick = ["น้ำพริก","รถเข็น","สรุปตะกร้า"]; break;

            case "ask_staff":
              out = `ที่นี่${store.personality.pageName}${staffPrefix()} พูดคุยกับ${store.personality.staffName}ค่ะ`; break;

            case "cat_chili":
            case "cat_cart":{
              s.focusCategory = intent==="cat_chili" ? "น้ำพริก" : "รถเข็นไต่บันได";
              const items = store.products.filter(p=>norm(p.category)===norm(s.focusCategory));
              if(!items.length){ out = `ตอนนี้ยังไม่มีสินค้าในหมวด ${s.focusCategory}${staffPrefix()}`; break; }
              ctx = items.map(p=>`${p.name}${p.sizes.length?` (${p.sizes.join("/")})`:""} ${thb(p.price)}`).join("\n");
              out = `หมวด ${s.focusCategory} มีดังนี้ (ดู context)\nเลือกชื่อสินค้า/ไซส์ได้เลยค่ะ`;
              quick = items.slice(0,3).map(p=>p.name).concat(["ดูโปร","สรุปตะกร้า"]);
            } break;

            case "ask_promo":{
              const promos = promotionsForCart(s.cart);
              out = promos.length ? `โปรที่ใช้ได้:\n- ${promos.join("\n- ")}` : `ตอนนี้ยังไม่มีโปรที่เข้าเงื่อนไขตะกร้าค่ะ`;
            } break;

            case "ask_payment":
              out = `วิธีชำระเงิน:\n${paymentSummary()}`; break;

            case "cart":
              out = `${cartText(s)}`; quick = ["ดูโปร","ยืนยันสั่งซื้อ"]; break;

            case "cancel_cart":
              s.cart = []; out = `ล้างตะกร้าให้แล้ว${staffPrefix()} ต้องการดูสินค้าเพิ่มหมวดไหนดีคะ`; quick=["น้ำพริก","รถเข็น"]; break;

            case "addr":{
              const t = String(text);
              if (/(ต\.|อ\.|จ\.|แขวง|เขต|จังหวัด|\d{5})/.test(t)) { s.addr = t.trim(); out = `บันทึกที่อยู่แล้ว${staffPrefix()} ต่อไปแจ้งเบอร์โทรได้เลย`; quick=["แจ้งเบอร์","ยืนยันสั่งซื้อ"]; }
              else out = `รบกวนส่งที่อยู่จัดส่งให้ครบหน่อยค่ะ (เช่น บ้านเลขที่/แขวง/เขต/จังหวัด/รหัสไปรษณีย์)`;
            } break;

            case "phone":{
              const m = text.match(/(\+?\d[\d\s-]{7,15}\d)/);
              if (m){ s.phone = m[1].replace(/\s+/g,""); out = `บันทึกเบอร์ ${s.phone} แล้ว${staffPrefix()} หากพร้อมพิมพ์ "ยืนยัน" ได้เลย`; quick=["ยืนยันสั่งซื้อ","สรุปตะกร้า"]; }
              else out = `ขอเบอร์โทร 10 หลักสำหรับติดต่อจัดส่งด้วยนะคะ`;
            } break;

            case "faq":{
              out = faqAnswer(text) || store.personality.dontKnow; 
            } break;

            case "confirm":{
              if (!s.cart.length){ out = `ตะกร้ายังว่างอยู่${staffPrefix()} เลือกสินค้าก่อนนะคะ`; break; }
              if (!s.addr || !s.phone){ out = `ยังขาดข้อมูลจัดส่ง${staffPrefix()} กรุณาแจ้งที่อยู่และเบอร์โทรก่อนยืนยันค่ะ`; quick=["แจ้งที่อยู่","แจ้งเบอร์"]; break; }
              const orderId = "ORD-"+Math.random().toString(36).slice(2,10).toUpperCase();
              // Save to Orders sheet
              const rows = s.cart.map(c=>[orderId,c.code,c.name,c.option||"",c.qty,c.price*c.qty,promotionsForCart(s.cart).join(", "),s.addr,s.phone,"ใหม่"]);
              await sheets.spreadsheets.values.append({
                auth, spreadsheetId:SHEET_ID, range:"Orders!A:J",
                valueInputOption:"RAW", requestBody:{ values: rows }
              });
              // Push to admin group
              if(ADMIN_GROUP){
                const lines = s.cart.map(c=>`• ${c.name}${c.size?` ${c.size}`:""} x${c.qty} = ${thb(c.price*c.qty)}`).join("\n");
                await linePush(ADMIN_GROUP, [{type:"text", text:`🛒 ออเดอร์ใหม่ ${orderId}`},{type:"text", text:`${lines}\nรวม ${thb(cartTotal(s))}`}]);
              }
              out = `รับออเดอร์ ${orderId} เรียบร้อย${staffPrefix()} ยอดรวม ${thb(cartTotal(s))}\nวิธีชำระเงิน:\n${paymentSummary()}`;
              s.cart=[]; s.addr=""; s.phone=""; s.stage="WELCOME";
            } break;

            case "free":
            default:{
              // sheet-first: ลองจับสินค้าจากข้อความ/บริบท
              const cands = findProductsByText(text, s.focusCategory);
              if (cands.length){
                const p = cands[0];
                s.focusProduct = p.name;
                // auto-add ถ้าลูกค้าใส่ตัวเลข
                const m = norm(text).match(/(\d+)/); const qty = m?Math.max(1,parseInt(m[1])):0;
                if(qty>0){ addCart(s, p, qty, p.sizes[0]||"", ""); out = `เพิ่ม ${p.name} x${qty} ลงตะกร้าแล้ว${staffPrefix()}`; quick=["สรุปตะกร้า","ยืนยันสั่งซื้อ"]; }
                else {
                  ctx = `${p.name} = ${thb(p.price)} ${p.sizes.length?`ขนาด: ${p.sizes.join("/")}`:""} ${p.options.length?`ตัวเลือก: ${p.options.join("/")}`:""}`;
                  out = await toneRewrite(`ลูกค้าสนใจสินค้า "${p.name}" แจ้งราคาและชวนเลือกจำนวน/ขนาดแบบสั้นๆ`, ctx);
                  quick = ["+1 ชิ้น", "สรุปตะกร้า", "ยืนยันสั่งซื้อ"];
                }
              } else {
                // ไม่มีในชีท → อย่ามั่ว: ให้ถามต่อ
                out = await toneRewrite(`ไม่มีข้อมูลตรงจากระบบ ให้บอกลูกค้าว่าไม่มีข้อมูล และชวนระบุชื่อสินค้าหรือหมวด`, "");
                quick = ["น้ำพริก","รถเข็น","สรุปตะกร้า"];
              }
            }
          }
        }catch(err){
          log("handler error", err.message);
          out = `ขออภัย ระบบติดขัดชั่วคราว${staffPrefix()} ลองใหม่อีกครั้งนะคะ`;
        }
        await lineReply(ev.replyToken, [ makeText(out, quick) ]);
      } else {
        // non-text
        await lineReply(ev.replyToken, [ makeText(`ตอนนี้รองรับเฉพาะข้อความตัวอักษร${staffPrefix()}`, ["น้ำพริก","รถเข็น","สรุปตะกร้า"]) ]);
      }
    }
  }catch(e){ log("webhook error", e.message); res.sendStatus(200); }
});

/* ========= Start ========= */
const server = app.listen(PORT, async ()=>{
  log(`🚀 Server running on port ${PORT}`);
  await loadSheets(true);
  setInterval(()=>loadSheets(true), 5*60*1000); // refresh cache
});
export default server;
