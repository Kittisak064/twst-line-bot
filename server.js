// ==========================================================
//  LINE x Google Sheets x OpenAI - Thai Commerce Bot (Stable)
//  - ยึดหัวตารางภาษาไทยตามชีทของคุณ (แถวที่ 1)
//  - โฟลว์เหมือนพนักงานขายจริง: เลือกสินค้า -> รสชาติ/ตัวเลือก -> ขนาด/บรรจุ -> จำนวน -> สรุป -> ชำระ
//  - รองรับหลายสินค้าในออเดอร์เดียว, ข้ามเรื่อง/ถาม FAQ ระหว่างทางได้ แล้วกลับมาโฟลว์เดิม
//  - ตอบสั้นเป็นธรรมชาติ, ไม่วนถามซ้ำ, รู้จำคอนเท็กซ์ (size/flavor/pack/qty)
//  - โปรโมชันจากชีท Promotions, วิธีชำระจากชีท Payment (พร้อมเพย์/โอน/COD + QR ถ้ามี)
//  - บันทึก Orders/Sessions/Logs, แจ้งแอดมินเข้า LINE Group เมื่อบอทตอบไม่ได้
//  - ป้องกัน “ยืดยาว/พัง/เงียบ” และ harden error
//
//  Sheets (ต้องมี): 
//   Products(รหัสสินค้า, ชื่อสินค้า, หมวดหมู่, ราคา, คำที่ลูกค้าเรียก, ตัวเลือก)
//   Promotions(รหัสโปรโมชั่น, รายละเอียดโปรโมชั่น, ประเภทคำนวณ, เงื่อนไข, ใช้กับสินค้า, ใช้กับหมวดหมู่)
//   FAQ(คำถาม, คำตอบ, คำหลัก)
//   personality(ชื่อพนักงาน, ชื่อเพจ, บุคลิก, คำเรียกลูกค้า, คำเรียกตัวเองแอดมิน, คำตอบเมื่อไม่รู้, เพศ)
//   Orders(เลขที่ออเดอร์, รหัสสินค้า, ชื่อสินค้า, ตัวเลือก, จำนวน, ราคารวม, โปรโมชั่นที่ใช้, ชื่อ-ที่อยู่, เบอร์โทร, สถานะ)
//   Payment(category, method, detail, qrcode[ออปชัน])
//   Sessions(timestamp, userId, stage, cart, note)
//   Logs(timestamp, userId, type, text)
//
//  NOTE: ใช้ google-spreadsheet v3.3.0
// ==========================================================

import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import OpenAI from 'openai';
import dayjs from 'dayjs';
import pLimit from 'p-limit';

// ----------------------- ENV ------------------------------
const {
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  GOOGLE_SHEET_ID,
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  OPENAI_API_KEY,
  ADMIN_GROUP_ID // optional
} = process.env;

const FIXED_SHEETS = {
  products: 'Products',
  promotions: 'Promotions',
  faq: 'FAQ',
  persona: 'personality',
  orders: 'Orders',
  payment: 'Payment',
  sessions: 'Sessions',
  logs: 'Logs'
};

// ----------------------- LINE -----------------------------
const lineClient = new Client({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET
});
const msgText = (text) => ({ type: 'text', text });
const msgImage = (url) => ({ type: 'image', originalContentUrl: url, previewImageUrl: url });

// ----------------------- OPENAI ---------------------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ----------------------- GOOGLE SHEETS --------------------
const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID);
async function authSheet() {
  const key = (GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  await doc.useServiceAccountAuth({
    client_email: GOOGLE_CLIENT_EMAIL,
    private_key: key
  });
  await doc.loadInfo();
}

async function readSheet(title) {
  const sheet = doc.sheetsByTitle[title];
  if (!sheet) return [];
  await sheet.loadHeaderRow();
  const rows = await sheet.getRows();
  const headers = sheet.headerValues;
  return rows.map(r => {
    const o = {};
    headers.forEach(h => (o[h] = (r[h] ?? '').toString().trim()));
    return o;
  });
}

async function appendRow(title, record) {
  const sheet = doc.sheetsByTitle[title];
  if (!sheet) throw new Error(`Sheet not found: ${title}`);
  await sheet.loadHeaderRow();
  await sheet.addRow(record);
}

const THB = (n) => Number(n || 0).toLocaleString('th-TH', { style: 'currency', currency: 'THB', maximumFractionDigits: 0 });

// ----------------------- CACHE ----------------------------
const cache = {
  products: [],
  promotions: [],
  faq: [],
  persona: null,
  payment: []
};

// helpers
const norm = (s='') => s.replace(/\s+/g,' ').trim();
const splitList = (s='') => norm(s).split(/,|，|\/|\||\n/).map(x=>x.trim()).filter(Boolean);
function buildAliasIndex(products) {
  const idx = new Map();
  for (const p of products) {
    const aliases = splitList(p['คำที่ลูกค้าเรียก'] || '');
    aliases.push(p['รหัสสินค้า'], p['ชื่อสินค้า']);
    for (const a of aliases.map(x => x?.toLowerCase())) {
      if (!a) continue;
      const arr = idx.get(a) || [];
      arr.push(p);
      idx.set(a, arr);
    }
  }
  return idx;
}
let PRODUCT_ALIAS = new Map();

async function loadAllData() {
  await authSheet();
  const limit = pLimit(5);
  const [products, promotions, faq, personaRows, payment] = await Promise.all([
    limit(()=>readSheet(FIXED_SHEETS.products)),
    limit(()=>readSheet(FIXED_SHEETS.promotions)),
    limit(()=>readSheet(FIXED_SHEETS.faq)),
    limit(()=>readSheet(FIXED_SHEETS.persona)),
    limit(()=>readSheet(FIXED_SHEETS.payment))
  ]);
  cache.products = products;
  cache.promotions = promotions;
  cache.faq = faq;
  cache.persona = personaRows?.[0] || {
    'ชื่อพนักงาน': 'แอดมิน',
    'ชื่อเพจ': '',
    'บุคลิก': 'สุภาพ จริงใจ ช่วยเต็มที่',
    'คำเรียกลูกค้า': 'คุณลูกค้า',
    'คำเรียกตัวเองแอดมิน': 'แอดมิน',
    'คำตอบเมื่อไม่รู้': 'ขออนุญาตเช็คแล้วรีบแจ้งนะคะ',
    'เพศ': 'หญิง'
  };
  cache.payment = payment;
  PRODUCT_ALIAS = buildAliasIndex(products);
}

// ----------------------- PROMOTION ------------------------
function parseCond(s=''){const o={};splitList(s).forEach(p=>{const [k,v]=p.split('=').map(x=>x.trim());if(!k)return;const n=Number(v);o[k]=isNaN(n)?v:n;});return o;}
function promoItemMatch(promo, item){
  const bySku = splitList(promo['ใช้กับสินค้า']).map(x=>x.toLowerCase());
  const byCat = splitList(promo['ใช้กับหมวดหมู่']).map(x=>x.toLowerCase());
  const sku = (item.sku||'').toLowerCase();
  const cat = (item.category||'').toLowerCase();
  const sOk = bySku.length?bySku.includes(sku):true;
  const cOk = byCat.length?byCat.includes(cat):true;
  return sOk && cOk;
}
function computePromotion(cart){
  if(!cart?.length) return {discount:0, code:'', detail:''};
  let best = {discount:0, code:'', detail:''};
  for(const promo of cache.promotions){
    const type = (promo['ประเภทคำนวณ']||'').toUpperCase();
    if(!type) continue;
    const cond = parseCond(promo['เงื่อนไข']||'');
    const items = cart.filter(it=>promoItemMatch(promo,it));
    if(!items.length) continue;
    const qty = items.reduce((s,it)=>s+Number(it.qty||0),0);
    const amt = items.reduce((s,it)=>s+Number(it.price||0)*Number(it.qty||0),0);
    if(cond.min_qty && qty < Number(cond.min_qty)) continue;
    if(cond.min_amount && amt < Number(cond.min_amount)) continue;

    let discount=0, detail='';
    if(type==='PERCENT'){
      const pct=Number(cond.percent||0);
      discount=Math.floor(amt*pct/100);
      detail=`ส่วนลด ${pct}%`;
    } else if(type==='FIXED_DISCOUNT'){
      discount=Number(cond.amount||0);
      detail=`ลด ${THB(discount)}`;
    } else if(type==='BUY_X_GET_Y'){
      const getFree=Number(cond.get_free||1);
      const prices=[];
      items.forEach(it=>{for(let i=0;i<Number(it.qty||0);i++) prices.push(Number(it.price||0));});
      prices.sort((a,b)=>a-b);
      discount=prices.slice(0,getFree).reduce((s,v)=>s+v,0);
      detail=`ซื้อครบ ${cond.min_qty||''} แถม ${getFree}`;
    } else if(type==='FREE_SHIPPING'){
      discount=Number(cond.fee||40); detail=`ส่งฟรี (หักค่าขนส่ง ${THB(discount)})`;
    } else continue;

    if(discount>best.discount) best={discount, code:promo['รหัสโปรโมชั่น']||'', detail:promo['รายละเอียดโปรโมชั่น']||detail};
  }
  return best;
}

// ----------------------- PAYMENT --------------------------
function pickPayment(category='all'){
  const cat = (category||'').toLowerCase();
  let row = cache.payment.find(r=>(r['category']||'').toLowerCase()===cat);
  if(!row) row = cache.payment.find(r=>(r['category']||'').toLowerCase()==='all') || cache.payment[0] || {};
  return {
    method: row['method'] || 'โอน/พร้อมเพย์/COD',
    detail: row['detail'] || '',
    qrcode: row['qrcode'] || ''
  };
}

// ----------------------- FAQ ------------------------------
function matchFAQ(text){
  const t = (text||'').toLowerCase();
  let best=null,score=0;
  for(const f of cache.faq){
    const q=(f['คำถาม']||'').toLowerCase();
    const keys=splitList(f['คำหลัก']||'');
    let s=0; if(q && t.includes(q)) s+=2;
    keys.forEach(k=>{if(t.includes(k.toLowerCase())) s+=1;});
    if(s>score){score=s; best=f;}
  }
  return score>=1?best:null;
}

// ----------------------- SESSION --------------------------
const sessions=new Map();
/*
  stage:
    idle | picking_product | picking_flavor | picking_pack | picking_qty
    confirming | collecting_info
  currentItem: { sku, name, category, price, flavors[], packs[], chosenFlavor, chosenPack }
  cart: [{ sku,name,category,chosenFlavor,chosenPack,price,qty }]
*/
function newSession(userId){
  const s={
    userId, stage:'idle',
    currentItem:null,
    cart:[],
    address:'', phone:'', customer:'',
    lastActive:Date.now()
  };
  sessions.set(userId,s); return s;
}
function getSession(userId){
  const s=sessions.get(userId)||newSession(userId);
  s.lastActive=Date.now(); return s;
}
async function saveSessionRow(s,note=''){
  try{await appendRow(FIXED_SHEETS.sessions,{
    'timestamp':dayjs().format('YYYY-MM-DD HH:mm:ss'),
    'userId':s.userId,'stage':s.stage,'cart':JSON.stringify(s.cart),'note':note
  });}catch(e){}
}

// ----------------------- PRODUCT HELPERS ------------------
function searchProducts(text){
  const low=(text||'').toLowerCase().trim();
  const set=new Set();
  // alias exact
  const byAlias=PRODUCT_ALIAS.get(low);
  if(byAlias) byAlias.forEach(p=>set.add(p));
  // include name
  cache.products.forEach(p=>{
    if((p['ชื่อสินค้า']||'').toLowerCase().includes(low)) set.add(p);
    if((p['รหัสสินค้า']||'').toLowerCase()===low) set.add(p);
  });
  return [...set];
}
function productByName(name){
  return cache.products.find(p=>(p['ชื่อสินค้า']||'').toLowerCase()=== (name||'').toLowerCase());
}
const getFlavors = (p)=> splitList(p['ตัวเลือก']||''); // ใช้เป็น “รส/ตัวเลือก”
const getPacks = (p)=>{ // ดึงขนาด/บรรจุจากชื่อสินค้าในวงเล็บเช่น "(ถุง80กรัม)" "(กระปุก120กรัม)" ถ้าไม่มีจะคืน []
  const m = (p['ชื่อสินค้า']||'').match(/\((.*?)\)/g) || [];
  const clean = m.map(x=>x.replace(/[()]/g,'').trim()).filter(Boolean);
  return clean.length? clean : []; // ถ้ามีหลายวงเล็บจะคืนหลายค่า
};

// ----------------------- CONVERSATION STYLE ----------------
function personaText(){
  const ps=cache.persona||{};
  const agent=ps['ชื่อพนักงาน']||'แอดมิน';
  const page=ps['ชื่อเพจ']||'';
  const tone=ps['บุคลิก']||'สุภาพ จริงใจ ช่วยเต็มที่';
  const callCustomer=ps['คำเรียกลูกค้า']||'คุณลูกค้า';
  const callSelf=ps['คำเรียกตัวเองแอดมิน']||'แอดมิน';
  const unknown=ps['คำตอบเมื่อไม่รู้']||'ขออนุญาตเช็คแล้วรีบแจ้งนะคะ';
  const gender=ps['เพศ']||'หญิง';
  return {agent,page,tone,callCustomer,callSelf,unknown,gender};
}

async function aiAssist(userText, context=''){
  try{
    const ps=personaText();
    const sys = `
คุณคือ “${ps.agent}” เพศ${ps.gender}${ps.page?` จากเพจ ${ps.page}`:''}.
บุคลิก: ${ps.tone}. สื่อสารแบบกระชับ เป็นธรรมชาติ ใช้ไทยสุภาพ ใส่อิโมจิได้ 1-2 ตัว.
อย่าพิมพ์ยาว ถ้าเป็นคำถามสั้น ให้ตอบสั้นและถามต่อเพื่อพาไปปิดการขาย.
ห้ามแสดงรหัสสินค้าให้ลูกค้า.
ถ้าไม่ทราบจริง ให้ตอบว่า “${ps.unknown}”.
`.trim();

    const res=await openai.chat.completions.create({
      model:'gpt-4o-mini',
      temperature:0.3,
      max_tokens:250,
      messages:[
        {role:'system', content:sys},
        {role:'user', content: `${context?`[ข้อมูล]\n${context}\n\n`:''}${userText}`}
      ]
    });
    return res.choices?.[0]?.message?.content?.trim()||null;
  }catch(e){ console.error('AI error', e.message); return null;}
}

// ----------------------- ADMIN NOTIFY ---------------------
async function notifyAdmin(text, extra=[]){
  if(!ADMIN_GROUP_ID) return;
  try{ await lineClient.pushMessage(ADMIN_GROUP_ID,[msgText(text), ...extra].slice(0,5)); }
  catch(e){ console.error('notifyAdmin', e.message); }
}

// ----------------------- CART/ORDER -----------------------
const cartSummary=(cart)=>{
  const sub=cart.reduce((s,it)=>s+Number(it.price||0)*Number(it.qty||0),0);
  const promo=computePromotion(cart);
  const total=Math.max(0, sub - (promo.discount||0));
  return {sub,promo,total};
};
const cartText=(cart)=>{
  if(!cart?.length) return '–';
  return cart.map((it,idx)=>`${idx+1}. ${it.name}${it.chosenFlavor?` (${it.chosenFlavor})`:''}${it.chosenPack?` - ${it.chosenPack}`:''} x ${it.qty} = ${THB(it.price*it.qty)}`).join('\n');
};

async function persistOrder(userId, session, address, phone, status='รอชำระ/จัดส่ง'){
  const ts=dayjs().format('YYYYMMDDHHmmss');
  const orderNo=`ORD-${ts}-${(userId||'').slice(-4)}`;
  const sum=cartSummary(session.cart);
  const promoText = sum.promo.code ? `${sum.promo.code} - ${sum.promo.detail}` : '';
  for(const it of session.cart){
    await appendRow(FIXED_SHEETS.orders,{
      'เลขที่ออเดอร์': orderNo,
      'รหัสสินค้า': it.sku,
      'ชื่อสินค้า': it.name,
      'ตัวเลือก': [it.chosenFlavor, it.chosenPack].filter(Boolean).join(' / '),
      'จำนวน': it.qty,
      'ราคารวม': Number(it.price||0)*Number(it.qty||0),
      'โปรโมชั่นที่ใช้': promoText,
      'ชื่อ-ที่อยู่': address||'',
      'เบอร์โทร': phone||'',
      'สถานะ': status
    });
  }
  return {orderNo, sum};
}

// ----------------------- MESSAGE HELPERS ------------------
function listProductsShort(category){
  // แสดงรายการแบบสั้น (ชื่ออย่างเดียว) ไม่เกิน 12 รายการ
  const arr = cache.products.filter(p=>{
    if(!category) return true;
    return (p['หมวดหมู่']||'').toLowerCase()===(category||'').toLowerCase();
  }).map(p=>`• ${p['ชื่อสินค้า']}`).slice(0,12);
  if(!arr.length) return 'ตอนนี้ยังไม่มีสินค้าที่พร้อมขายค่ะ';
  return `มีดังนี้ค่ะ:\n${arr.join('\n')}\n\nสนใจตัวไหนบอกชื่อได้เลยนะคะ 😊`;
}

// ----------------------- INTENT / FLOW --------------------
function isYes(text){ return /(ได้|โอเค|เอา|ค่ะ|ครับ|คับ|ตกลง)/i.test(text||'');}
function isConfirm(text){ return /(สรุป|ยืนยัน|จบ|เช็คบิล|ปิดการขาย)/i.test(text||'');}
function isAskPrice(text){ return /(ราคา|เท่าไร|เท่าไหร่|กี่บาท)/i.test(text||'');}
function isAskFlavor(text){ return /(รส|รสชาติ|ตัวเลือก)/i.test(text||'');}
function isAskPack(text){ return /(ถุง|กระปุก|ขนาด|บรรจุ)/i.test(text||'');}
function isAskQty(text){ return /(กี่ชิ้น|จำนวน|กี่อัน|เอากี่)/i.test(text||'');}
function containsNumber(text){ return /\d+/.test(text||''); }

function extractNumber(text){
  const m = (text||'').match(/\d+/); return m? Number(m[0]) : null;
}

// core: step guide
async function goAskFlavor(replyToken, s){
  const opts = s.currentItem.flavors;
  if(opts?.length){
    await lineClient.replyMessage(replyToken, [msgText(`น้ำพริกของเรามีหลายรสให้เลือกค่ะ เช่น: ${opts.join(', ')}\nเลือกรสที่ชอบได้เลยค่ะ 😊`)]);
  }else{
    // ไม่มีรส ให้ข้ามไปบรรจุ
    s.stage='picking_pack';
    await saveSessionRow(s,'skip_flavor');
    await goAskPack(replyToken, s);
  }
}
async function goAskPack(replyToken, s){
  const packs=s.currentItem.packs;
  if(packs?.length){
    await lineClient.replyMessage(replyToken,[msgText(`เลือกรูปแบบบรรจุ/ขนาดได้เลยค่ะ เช่น: ${packs.join(', ')}\n(พิมพ์บางคำก็ได้ เช่น "ถุง" หรือ "120")`)]);
  }else{
    s.stage='picking_qty';
    await saveSessionRow(s,'skip_pack');
    await lineClient.replyMessage(replyToken, [msgText(`ต้องการกี่ชิ้นดีคะ? (พิมพ์ตัวเลข เช่น 2, 5)`)])
  }
}
async function goAskQty(replyToken){
  await lineClient.replyMessage(replyToken, [msgText(`รับกี่ชิ้นดีคะ? (พิมพ์ตัวเลข เช่น 2, 5)`)]); 
}

function findFlavorLike(flavorList, text){
  const t=(text||'').toLowerCase();
  return flavorList.find(x=>x.toLowerCase().includes(t));
}
function findPackLike(packList, text){
  const t=(text||'').toLowerCase();
  return packList.find(x=>x.toLowerCase().includes(t));
}

// ----------------------- MAIN HANDLER ---------------------
async function handleText(userId, replyToken, text){
  const s=getSession(userId);
  const raw=text.trim();
  const low=raw.toLowerCase();

  // log IN
  try{ await appendRow(FIXED_SHEETS.logs,{
    'timestamp':dayjs().format('YYYY-MM-DD HH:mm:ss'),
    'userId': userId, 'type': 'IN', 'text': raw
  }); }catch(e){}

  // 1) FAQ interrupt (เช่น เผ็ดไหม / เก็บได้นานไหม)
  const faq = matchFAQ(raw);
  if(faq && s.stage!=='picking_qty'){ // ตอบ FAQ แล้วค่อยกลับ flow
    await lineClient.replyMessage(replyToken,[msgText(faq['คำตอบ'])]);
    // กลับหัวข้อค้าง
    if(s.currentItem){
      await lineClient.pushMessage(userId,[msgText(`ต่อจากเมื่อกี้นะคะ สนใจ “${s.currentItem.name}” อยู่ เลือกต่อได้เลยค่ะ 💁‍♀️`)]);
    }
    return;
  }

  // 2) คำสั่งย่อ
  if(isConfirm(raw)){
    if(!s.cart.length){
      await lineClient.replyMessage(replyToken,[msgText(`ยังไม่มีสินค้าในตะกร้าเลยค่ะ ลองพิมพ์ชื่อสินค้าที่สนใจได้เลย เช่น “น้ำพริกเห็ด” 😊`)]);
      return;
    }
    s.stage='collecting_info';
    await saveSessionRow(s,'start_checkout');
    const cats=[...new Set(s.cart.map(it=>it.category||'all'))];
    const pay=pickPayment(cats[0]||'all');
    const sum=cartSummary(s.cart);
    await lineClient.replyMessage(replyToken,[
      msgText(`สรุปตะกร้า\n${cartText(s.cart)}\nโปรฯ: ${sum.promo.code? sum.promo.detail : '—'}\nยอดสุทธิ: ${THB(sum.total)}`),
      msgText(`กรุณาส่ง “ชื่อ-ที่อยู่” และ “เบอร์โทร” เพื่อจัดส่งนะคะ\nช่องทางชำระ: ${pay.method}\n${pay.detail?`รายละเอียด: ${pay.detail}\n`:''}${pay.qrcode? 'พิมพ์ "ขอ QR" เพื่อรับคิวอาร์โอนได้ค่ะ' : ''}${/cod|ปลายทาง/i.test(pay.method+pay.detail)?'\nต้องการเก็บปลายทางพิมพ์ “เก็บปลายทาง” ได้เลย':''}`)
    ]);
    return;
  }

  // 3) หากอยู่กลาง flow เลือกรส/บรรจุ/จำนวน
  if(s.stage==='picking_flavor' && s.currentItem){
    const f=findFlavorLike(s.currentItem.flavors, raw) || (isAskPack(raw)||isAskQty(raw)?null: (s.currentItem.flavors.length?null:raw));
    if(f || !s.currentItem.flavors.length){
      s.currentItem.chosenFlavor=f||'';
      s.stage='picking_pack';
      await saveSessionRow(s,'picked_flavor');
      await goAskPack(replyToken,s);
    }else{
      await lineClient.replyMessage(replyToken,[msgText(`รสที่มี: ${s.currentItem.flavors.join(', ')}\nลองพิมพ์บางคำก็ได้ค่ะ เช่น “ต้มยำ”`)]); 
    }
    return;
  }

  if(s.stage==='picking_pack' && s.currentItem){
    const p=findPackLike(s.currentItem.packs, raw) || (isAskQty(raw)?null: (s.currentItem.packs.length?null:raw));
    if(p || !s.currentItem.packs.length){
      s.currentItem.chosenPack=p||'';
      s.stage='picking_qty';
      await saveSessionRow(s,'picked_pack');
      await goAskQty(replyToken);
    }else{
      await lineClient.replyMessage(replyToken,[msgText(`บรรจุ/ขนาดที่มี: ${s.currentItem.packs.join(', ')}\nพิมพ์บางคำก็ได้ เช่น “ถุง” หรือ “120”`)]); 
    }
    return;
  }

  if(s.stage==='picking_qty' && s.currentItem){
    const n=extractNumber(raw);
    if(n && n>0){
      // add to cart
      s.cart.push({
        sku: s.currentItem.sku,
        name: s.currentItem.name,
        category: s.currentItem.category,
        chosenFlavor: s.currentItem.chosenFlavor || '',
        chosenPack: s.currentItem.chosenPack || '',
        price: Number(s.currentItem.price||0),
        qty: n
      });
      const sum=cartSummary(s.cart);
      await saveSessionRow(s,'qty_added');
      s.stage='confirming'; s.currentItem=null;
      await lineClient.replyMessage(replyToken,[
        msgText(`เพิ่มลงตะกร้าแล้วค่ะ 🧺\n${cartText(s.cart)}\nยอดรวมชั่วคราว: ${THB(sum.total)}${sum.promo.code? `\nโปรฯ: ${sum.promo.detail}`:''}`),
        msgText(`ต้องการเพิ่มสินค้าอีกไหมคะ? ถ้าพร้อม “สรุปยอด” ได้เลย ✨`)
      ]);
    }else{
      await lineClient.replyMessage(replyToken,[msgText(`ระบุเป็นตัวเลขนะคะ เช่น 2, 5`)]); 
    }
    return;
  }

  if(s.stage==='collecting_info'){
    // การชำระ
    if(/qr|คิวอาร์|พร้อมเพย์/i.test(raw)){
      const cats=[...new Set(s.cart.map(it=>it.category||'all'))];
      const pay=pickPayment(cats[0]||'all');
      if(pay.qrcode){
        await lineClient.replyMessage(replyToken,[msgText(`นี่คือ QR พร้อมเพย์สำหรับชำระเงินค่ะ โอนแล้วแจ้งสลิปได้เลยน้า 😊`), msgImage(pay.qrcode)]);
      }else{
        await lineClient.replyMessage(replyToken,[msgText(`ช่องทางโอน/พร้อมเพย์:\n${pay.detail || '—'}`)]);
      }
      return;
    }
    if(/เก็บปลายทาง|cod/i.test(raw)){
      s.paymentMethod='COD';
      await lineClient.replyMessage(replyToken,[msgText(`รับทราบจัดส่งแบบเก็บปลายทางค่ะ 📦\nรบกวนส่ง “ชื่อ-ที่อยู่” และ “เบอร์โทร” ด้วยนะคะ`)]);
      return;
    }
    // ดึงเบอร์/ที่อยู่แบบง่าย
    const phone = raw.match(/0\d{8,9}/)?.[0] || '';
    if(phone) s.phone=phone;
    if(raw.length>10 && !/qr|ปลายทาง|cod/i.test(raw)){
      s.address=raw;
    }
    if(s.address && s.phone){
      const {orderNo, sum} = await persistOrder(userId, s, s.address, s.phone, s.paymentMethod==='COD'?'เก็บเงินปลายทาง':'รอชำระ');
      await lineClient.replyMessage(replyToken,[
        msgText(`สรุปออเดอร์ #${orderNo}\n${cartText(s.cart)}\nโปรฯ: ${sum.promo.code?sum.promo.detail:'—'}\nยอดสุทธิ: ${THB(sum.total)}\n\nจัดส่ง: ${s.address}\nโทร: ${s.phone}\n\nขอบคุณมากค่ะ 🥰`)
      ]);
      await notifyAdmin(`🛒 ออเดอร์ใหม่ #${orderNo}\n${cartText(s.cart)}\nยอดสุทธิ: ${THB(sum.total)}\nที่อยู่: ${s.address}\nโทร: ${s.phone}`);
      sessions.delete(userId);
    }else{
      await lineClient.replyMessage(replyToken,[msgText(`ขอรับ “ชื่อ-ที่อยู่” และ “เบอร์โทร” เพื่อดำเนินการต่อนะคะ 😊`)]);
    }
    return;
  }

  // 4) ตรวจเจตนาซื้อสินค้าใหม่ / เพิ่มสินค้า
  const found=searchProducts(raw);
  if(found.length===1){
    const p=found[0];
    const flavors=getFlavors(p);
    const packs=getPacks(p); // อาจว่างได้
    s.currentItem={
      sku: p['รหัสสินค้า'],
      name: p['ชื่อสินค้า'],
      category: p['หมวดหมู่']||'',
      price: Number(p['ราคา']||0),
      flavors, packs,
      chosenFlavor:'', chosenPack:''
    };
    await saveSessionRow(s,'product_detected');
    // ตอบสั้น
    if(isAskPrice(raw)){
      await lineClient.replyMessage(replyToken,[msgText(`${p['ชื่อสินค้า']} ราคา ${THB(p['ราคา'])}${packs.length? ` (${packs.join(', ')})`:''}`)]);
      return;
    }
    // เริ่ม flow
    s.stage='picking_flavor';
    await lineClient.replyMessage(replyToken,[msgText(`รับ “${p['ชื่อสินค้า']}” ให้ค่ะ ราคา ${THB(p['ราคา'])}`)]);
    await goAskFlavor(replyToken, s);
    return;
  }else if(found.length>1){
    const names=found.slice(0,8).map(x=>`• ${x['ชื่อสินค้า']}`).join('\n');
    await lineClient.replyMessage(replyToken,[msgText(`หมายถึงตัวไหนคะ 😊\n${names}\n\nพิมพ์ชื่อให้ชัดขึ้นอีกนิดได้ไหมคะ`)]); 
    return;
  }

  // 5) ถามทั่วไปว่า “มีน้ำพริกอะไรบ้าง” → รายชื่อแบบสั้น
  if(/มีอะไรบ้าง|ขายอะไร|สินค้าอะไร|น้ำพริกอะไรบ้าง|มีน้ำพริก/i.test(low)){
    await lineClient.replyMessage(replyToken,[msgText(listProductsShort(''))]);
    return;
  }

  // 6) ตอบไม่ได้ → ให้ AI ช่วยแบบสั้น + แจ้งแอดมิน (ครั้งแรกเฉพาะข้อความนี้)
  const extra = `
[ตัวอย่างสินค้า]
${cache.products.slice(0,8).map(p=>`• ${p['ชื่อสินค้า']} ราคา ${THB(p['ราคา'])}`).join('\n')}

[ตัวอย่าง FAQ]
${cache.faq.slice(0,4).map(f=>`• ${f['คำถาม']}: ${f['คำตอบ']}`).join('\n')}
  `.trim();

  const ai=await aiAssist(raw, extra);
  await lineClient.replyMessage(replyToken,[msgText(ai || 'รับทราบค่ะ 😊')]);
  await notifyAdmin(`❓ ลูกค้าถามที่บอทตอบไม่ได้:\n"${raw}"\nกรุณาช่วยตอบต่อในห้องแชท`,[]);
}

// ----------------------- SERVER ---------------------------
const app=express();
app.get('/',(req,res)=>res.send('OK'));
app.get('/healthz',(req,res)=>res.send('ok'));

app.post('/webhook', lineMiddleware({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET
}), async (req,res)=>{
  res.status(200).end();
  try{
    if(!cache.persona) await loadAllData();
    const events=req.body.events||[];
    for(const ev of events){
      if(ev.type==='message' && ev.message?.type==='text'){
        const userId=ev.source?.userId || ev.source?.groupId || ev.source?.roomId || 'unknown';
        await handleText(userId, ev.replyToken, ev.message.text||'');
      }else if(ev.type==='follow'){
        const ps=personaText();
        await lineClient.replyMessage(ev.replyToken,[msgText(`สวัสดีค่ะ ${ps.callCustomer} 😊 สนใจตัวไหนบอก “${ps.agent}” ได้เลยนะคะ`)])
      }
    }
  }catch(err){
    console.error('Webhook Error:', err);
    try{ await appendRow(FIXED_SHEETS.logs,{
      'timestamp':dayjs().format('YYYY-MM-DD HH:mm:ss'),
      'userId':'system','type':'ERR','text': err?.message || String(err)
    }); }catch(e){}
    // แจ้งแอดมิน
    await notifyAdmin(`🚨 Webhook Error: ${err?.message||err}`);
  }
});

// reload data every 10 min
setInterval(async()=>{ try{ await loadAllData(); }catch(e){} }, 10*60*1000);

// ----------------------- START ----------------------------
const PORT=process.env.PORT||10000;
app.listen(PORT, async ()=>{
  try{
    await loadAllData();
    console.log(`🚀 Server running on ${PORT}`);
  }catch(e){
    console.error('❌ Google Sheet Error:', e.message);
  }
});
