// server.js
// ======================================================================
//  LINE x Google Sheets x OpenAI : Thai Commerce Bot (Monolith Version)
//  - ไม่เปลี่ยนหัวตารางภาษาไทยของคุณ (ต้องอยู่แถวแรกเท่านั้น)
//  - ตอบสั้น กระชับ ทีละสเต็ป เหมือนคนขายจริง
//  - ซื้อได้หลายสินค้าในออเดอร์เดียว, กลับมาคุยเรื่องอื่นแล้วคืนสเต็ปเดิมได้
//  - FAQ ก่อน GPT, ถ้าตอบไม่ได้ค่อยใช้ GPT และยังคุมโทนพนักงานขาย
//  - บันทึก Orders / Sessions / Logs, แจ้งแอดมินเมื่อเจอเคสที่ต้องให้คนจริงช่วย
//  - Payment อ่านตามหมวด/หรือ all (รองรับ COD / พร้อมเพย์ / QR ในอนาคต)
// ======================================================================

import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import OpenAI from 'openai';
import dayjs from 'dayjs';

// -------------------------- ENV ---------------------------------------
const {
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  GOOGLE_SHEET_ID,
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  OPENAI_API_KEY,
  ADMIN_GROUP_ID // optional: กลุ่มแอดมิน
} = process.env;

// -------------------------- CONST: sheet names -------------------------
const SHEETS = {
  products: 'Products',
  promotions: 'Promotions',
  faq: 'FAQ',
  persona: 'personality',
  orders: 'Orders',
  payment: 'Payment',
  sessions: 'Sessions',
  logs: 'Logs'
};

// -------------------------- LINE --------------------------------------
const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET
};
const lineClient = new Client(lineConfig);

// -------------------------- OpenAI ------------------------------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// -------------------------- Google Sheet -------------------------------
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

function THB(n) {
  const v = Number(n || 0);
  return v.toLocaleString('th-TH', { style: 'currency', currency: 'THB', maximumFractionDigits: 0 });
}

// -------------------------- In-memory cache ----------------------------
const cache = {
  products: [],
  promotions: [],
  faq: [],
  persona: null,
  payment: []
};

// normalize helpers
function normalize(s=''){ return s.replace(/\s+/g,' ').trim(); }
function splitList(s=''){ return normalize(s).split(/,|，|\/|\|/).map(x=>x.trim()).filter(Boolean); }

// Base name: ตัดข้อความในวงเล็บออก (สำหรับรวมรุ่น/บรรจุภัณฑ์เดียวกัน)
function baseName(name=''){
  return normalize(name).replace(/\(.*?\)/g,'').trim();
}

// สร้างดัชนีเพื่อค้นหาอย่างฉลาด
function buildProductIndex(products){
  const byAlias = new Map();   // alias(lower) -> [product rows]
  const byBase  = new Map();   // baseName(lower) -> [product rows]
  for (const p of products){
    const name = p['ชื่อสินค้า'] || '';
    const sku  = p['รหัสสินค้า'] || '';
    const aliases = splitList(p['คำที่ลูกค้าเรียก'] || '');
    const keys = [name, sku, ...aliases];
    for (const k of keys){
      const key = (k||'').toLowerCase();
      if(!key) continue;
      const arr = byAlias.get(key) || [];
      arr.push(p);
      byAlias.set(key, arr);
    }
    const bn = baseName(name).toLowerCase();
    if (bn) {
      const arr = byBase.get(bn) || [];
      arr.push(p);
      byBase.set(bn, arr);
    }
  }
  return { byAlias, byBase };
}

let PRODUCT_IDX = { byAlias:new Map(), byBase:new Map() };

async function loadAll() {
  await authSheet();
  const [products, promotions, faq, personaRows, payment] = await Promise.all([
    readSheet(SHEETS.products),
    readSheet(SHEETS.promotions),
    readSheet(SHEETS.faq),
    readSheet(SHEETS.persona),
    readSheet(SHEETS.payment)
  ]);
  cache.products = products;
  cache.promotions = promotions;
  cache.faq = faq;
  cache.persona = personaRows?.[0] || {
    'ชื่อพนักงาน':'แอดมิน','ชื่อเพจ':'','บุคลิก':'สุภาพ จริงใจ ช่วยเต็มที่',
    'คำเรียกลูกค้า':'คุณลูกค้า','คำเรียกตัวเองแอดมิน':'แอดมิน','คำตอบเมื่อไม่รู้':'เดี๋ยวแอดมินเช็คให้นะคะ','เพศ':'หญิง'
  };
  cache.payment = payment;
  PRODUCT_IDX = buildProductIndex(products);
}

// -------------------------- Sessions ----------------------------------
// stage: idle | picking_product | picking_variant | picking_qty | confirming | collecting_info
const sessions = new Map();
function newSession(userId){
  const s = {
    userId,
    stage:'idle',
    lastActive:Date.now(),
    current: null,  // { groupKey, candidates[], chosenIndex, chosenVariant, price }
    cart: [],       // [{sku,name,category,price,qty,variant}]
    address: '',
    phone: '',
    tries: 0        // ใช้นับเมื่อผู้ใช้ถามวกวน เพื่อ pivot กลับแคบ ๆ
  };
  sessions.set(userId, s);
  return s;
}
function getSession(userId){ return sessions.get(userId) || newSession(userId); }
async function logSession(s, note=''){
  try{
    await appendRow(SHEETS.sessions, {
      'timestamp': dayjs().format('YYYY-MM-DD HH:mm:ss'),
      'userId': s.userId,
      'stage': s.stage,
      'cart': JSON.stringify(s.cart),
      'note': note
    });
  }catch(e){ /* ignore */ }
}

// -------------------------- Promotions (simple best-pick) --------------
function parseCond(s=''){
  const obj={};
  splitList(s).forEach(pair=>{
    const [k,v] = pair.split('=').map(x=>x.trim());
    if(!k) return;
    const n = Number(v);
    obj[k] = isNaN(n)?v:n;
  });
  return obj;
}
function promoHit(promo, item){
  const bySku = splitList(promo['ใช้กับสินค้า']).map(x=>x.toLowerCase());
  const byCat = splitList(promo['ใช้กับหมวดหมู่']).map(x=>x.toLowerCase());
  const sku = (item.sku||'').toLowerCase();
  const cat = (item.category||'').toLowerCase();
  const skuOk = bySku.length ? bySku.includes(sku) : true;
  const catOk = byCat.length ? byCat.includes(cat) : true;
  return skuOk && catOk;
}
function computePromotion(cart){
  if(!cart?.length) return {discount:0, code:'', detail:''};
  let best={discount:0, code:'', detail:''};
  for(const p of cache.promotions){
    const type = (p['ประเภทคำนวณ']||'').toUpperCase();
    const cond = parseCond(p['เงื่อนไข']||'');
    const items = cart.filter(it=>promoHit(p,it));
    if(!items.length) continue;
    const qty = items.reduce((s,it)=>s+Number(it.qty||0),0);
    const amount = items.reduce((s,it)=>s+(Number(it.price||0)*Number(it.qty||0)),0);
    if (cond.min_qty && qty < Number(cond.min_qty)) continue;
    if (cond.min_amount && amount < Number(cond.min_amount)) continue;
    let discount=0, detail='';
    if(type==='PERCENT'){
      const pct = Number(cond.percent||0);
      discount = Math.floor(amount*pct/100);
      detail = `ส่วนลด ${pct}%`;
    }else if(type==='FIXED_DISCOUNT'){
      discount = Number(cond.amount||0);
      detail = `ลดทันที ${THB(discount)}`;
    }else if(type==='BUY_X_GET_Y'){
      const free = Number(cond.get_free||1);
      const prices=[];
      items.forEach(it=>{ for(let i=0;i<Number(it.qty||0);i++) prices.push(Number(it.price||0)); });
      prices.sort((a,b)=>a-b);
      discount = prices.slice(0,free).reduce((s,v)=>s+v,0);
      detail = `โปรซื้อครบ ${cond.min_qty} แถม ${free}`;
    }else if(type==='FREE_SHIPPING'){
      discount = Number(cond.fee||40);
      detail = `ส่งฟรี (หักค่าขนส่ง ${THB(discount)})`;
    }
    if(discount>best.discount){
      best = {discount, code: p['รหัสโปรโมชั่น']||'', detail: p['รายละเอียดโปรโมชั่น']||detail};
    }
  }
  return best;
}
function cartSummary(cart){
  const sub = cart.reduce((s,it)=>s+(Number(it.price||0)*Number(it.qty||0)),0);
  const promo = computePromotion(cart);
  const total = Math.max(0, sub - (promo.discount||0));
  return {sub,promo,total};
}
function renderCart(cart){
  if(!cart?.length) return '—';
  return cart.map((it,i)=>`${i+1}. ${it.name}${it.variant?` (${it.variant})`:''} x ${it.qty} = ${THB(it.price*it.qty)}`).join('\n');
}

// -------------------------- FAQ first -------------------------------
function matchFAQ(text){
  const t=(text||'').toLowerCase();
  let best=null,score=0;
  for(const f of cache.faq){
    const q=(f['คำถาม']||'').toLowerCase();
    const keys=splitList(f['คำหลัก']||'').map(x=>x.toLowerCase());
    let s=0;
    if(q && t.includes(q)) s+=2;
    for(const k of keys) if(t.includes(k)) s+=1;
    if(s>score){ score=s; best=f; }
  }
  return score>=1? best['คำตอบ'] : null;
}

// -------------------------- Payment --------------------------------
function pickPayment(category='all'){
  const cat=(category||'').toLowerCase();
  let row = cache.payment.find(r=>(r['category']||'').toLowerCase()===cat);
  if(!row) row = cache.payment.find(r=>(r['category']||'').toLowerCase()==='all');
  if(!row) row = cache.payment[0] || {};
  return {
    method: row['method'] || 'โอน/พร้อมเพย์/COD',
    detail: row['detail'] || '',
    qrcode: row['qrcode'] || '' // เผื่อคุณเพิ่มคอลัมน์นี้ในอนาคต
  };
}

// -------------------------- Product search -------------------------
function searchProducts(text){
  const t = (text||'').toLowerCase().trim();
  if(!t) return [];
  const set = new Set();

  // 1) alias/exact
  const exact = PRODUCT_IDX.byAlias.get(t);
  if(exact) exact.forEach(p=>set.add(p));

  // 2) base-name fuzzy
  for (const [bn, arr] of PRODUCT_IDX.byBase.entries()){
    if (bn.includes(t)) arr.forEach(p=>set.add(p));
  }
  // 3) ชื่อสินค้ารวม ๆ
  cache.products.forEach(p=>{
    const name=(p['ชื่อสินค้า']||'').toLowerCase();
    const sku=(p['รหัสสินค้า']||'').toLowerCase();
    if(name.includes(t) || sku===t) set.add(p);
  });

  return [...set];
}

// กลุ่มสินค้าตาม baseName เพื่อถาม “แบบไหน/ขนาดไหน” ถูกต้อง
function groupByBaseName(list){
  const m = new Map();
  list.forEach(p=>{
    const key = baseName(p['ชื่อสินค้า']||'').toLowerCase();
    const arr = m.get(key) || [];
    arr.push(p);
    m.set(key, arr);
  });
  // คืน array ของ { key, items[] }
  return [...m.entries()].map(([key, items])=>({ key, items }));
}

// -------------------------- AI prompt (fallback) -------------------
function systemPersona(){
  const ps = cache.persona || {};
  return `
คุณคือ “${ps['ชื่อพนักงาน']||'แอดมิน'}” เพจ ${ps['ชื่อเพจ']||''} เพศ${ps['เพศ']||'หญิง'}
บุคลิก: ${ps['บุคลิก']||'สุภาพ จริงใจ ช่วยเต็มที่'}
เรียกลูกค้าว่า “${ps['คำเรียกลูกค้า']||'คุณลูกค้า'}” เรียกตัวเองว่า “${ps['คำเรียกตัวเองแอดมิน']||'แอดมิน'}”
คุยสั้น กระชับ ตรงประเด็น ทีละขั้น เพื่อปิดการขาย ไม่ทักสวัสดีซ้ำถ้าไม่จำเป็น
ถ้าไม่ทราบจริง ให้ใช้ประโยค: “${ps['คำตอบเมื่อไม่รู้']||'เดี๋ยวแอดมินเช็คให้นะคะ'}”
`.trim();
}
async function aiShort(userText, extra=''){
  try{
    const res = await openai.chat.completions.create({
      model:'gpt-4o-mini',
      temperature:0.2,
      max_tokens:220,
      messages:[
        {role:'system', content: systemPersona()},
        {role:'user', content: `${extra?`[ข้อมูลเพิ่มเติม]\n${extra}\n\n`:''}${userText}`}
      ]
    });
    return res.choices?.[0]?.message?.content?.trim() || '';
  }catch(e){
    console.error('OpenAI error:', e?.message);
    return '';
  }
}

// -------------------------- LINE message helpers -------------------
const msgText = text => ({ type:'text', text });
const msgImage = url => ({ type:'image', originalContentUrl:url, previewImageUrl:url });

async function notifyAdmin(text, more=[]) {
  if(!ADMIN_GROUP_ID) return;
  try { await lineClient.pushMessage(ADMIN_GROUP_ID, [msgText(text), ...more].slice(0,5)); }
  catch(e){ console.error('notifyAdmin error:', e.message); }
}

// -------------------------- Persist Order --------------------------
async function persistOrder(userId, s, address, phone, status='รอชำระ/จัดส่ง'){
  const ts = dayjs().format('YYYYMMDDHHmmss');
  const orderNo = `ORD-${ts}-${(userId||'').slice(-4)}`;
  const sum = cartSummary(s.cart);
  const promoText = sum.promo.code ? `${sum.promo.code} - ${sum.promo.detail}` : '';

  for(const it of s.cart){
    await appendRow(SHEETS.orders, {
      'เลขที่ออเดอร์': orderNo,
      'รหัสสินค้า': it.sku,
      'ชื่อสินค้า': it.name,
      'ตัวเลือก': it.variant || '',
      'จำนวน': it.qty,
      'ราคารวม': it.price * it.qty,
      'โปรโมชั่นที่ใช้': promoText,
      'ชื่อ-ที่อยู่': address || '',
      'เบอร์โทร': phone || '',
      'สถานะ': status
    });
  }
  return { orderNo, sum };
}

// -------------------------- Conversation Core ---------------------
// กฏสั้น ๆ: FAQ -> สินค้า/ตะกร้า -> ชำระเงิน -> Fallback AI -> แจ้งแอดมิน
function shortListProducts(limit=8){
  // ถ้าเยอะ ให้เลือกเฉพาะหมวด food ก่อน แล้วค่อยเติม
  const items = cache.products.slice(0, limit);
  return items.map(p=>`• ${p['ชื่อสินค้า']} ราคา ${THB(p['ราคา'])}${p['ตัวเลือก']?` (รสชาติ: ${splitList(p['ตัวเลือก']).join(', ')})`:''}`).join('\n');
}
function isAskPrice(text){
  return /(ราคา|เท่าไหร่|กี่บาท)/i.test(text||'');
}
function extractQty(text){
  const m = (text||'').match(/\d+/);
  return m? Math.max(1, Number(m[0])) : null;
}
function extractPhone(text){
  const m = (text||'').match(/0\d{8,9}/);
  return m? m[0] : '';
}

async function handleText(userId, replyToken, text) {
  const s = getSession(userId);
  s.lastActive = Date.now();

  // 0) บันทึก log เข้า sheet
  try{
    await appendRow(SHEETS.logs, {
      'timestamp': dayjs().format('YYYY-MM-DD HH:mm:ss'),
      'userId': userId,
      'type': 'IN',
      'text': text
    });
  }catch(e){}

  const plain = (text||'').trim();

  // 1) ตรวจ FAQ ก่อน
  const faqAns = matchFAQ(plain);
  if(faqAns){
    await lineClient.replyMessage(replyToken, [msgText(faqAns)]);
    // กลับมายังคง stage เดิม
    return;
  }

  // 2) คำสั่งจบ/สรุป/เช็คเอาท์
  if (/สรุป|ปิดการขาย|เช็คเอาท์|ยืนยัน/i.test(plain)) {
    if(!s.cart.length){
      await lineClient.replyMessage(replyToken,[msgText('ตอนนี้ยังไม่มีสินค้าในตะกร้านะคะ พิมพ์ชื่อสินค้าที่ต้องการได้เลยค่ะ 😊')]);
      return;
    }
    const sum = cartSummary(s.cart);
    const cats = [...new Set(s.cart.map(it=>it.category||'all'))];
    const pay = pickPayment(cats[0]||'all');
    s.stage = 'collecting_info';
    await logSession(s,'checkout');

    const cartTxt = renderCart(s.cart);
    await lineClient.replyMessage(replyToken, [
      msgText(`สรุปตะกร้า 🧾\n${cartTxt}\nยอดสุทธิ: ${THB(sum.total)}${sum.promo.code?`\nโปรฯ: ${sum.promo.detail}`:''}`),
      msgText(`ช่องทางชำระ: ${pay.method}\n${pay.detail?`รายละเอียด: ${pay.detail}`:''}\nกรุณาส่ง “ชื่อ-ที่อยู่” และ “เบอร์โทร” เพื่อจัดส่งนะคะ`)
    ]);
    return;
  }

  // 3) ระหว่าง checkout: ขอ QR / COD / ส่งที่อยู่โทร
  if (s.stage === 'collecting_info') {
    if (/qr|คิวอาร์|พร้อมเพย์/i.test(plain)) {
      const cats = [...new Set(s.cart.map(it=>it.category||'all'))];
      const pay = pickPayment(cats[0]||'all');
      const qr = pay.qrcode || (pay.detail||'').match(/https?:\/\/\S+/)?.[0] || '';
      if(qr) await lineClient.replyMessage(replyToken, [ msgText('แนบ QR สำหรับโอนได้เลยค่ะ 📷'), msgImage(qr) ]);
      else   await lineClient.replyMessage(replyToken, [ msgText(`วิธีโอน/พร้อมเพย์: ${pay.detail||'—'}`) ]);
      return;
    }
    if (/เก็บปลายทาง|cod/i.test(plain)) {
      s.payment='COD';
      await lineClient.replyMessage(replyToken,[msgText('รับเป็นเก็บปลายทางได้ค่ะ 📦 กรุณาส่ง “ชื่อ-ที่อยู่” และ “เบอร์โทร” ด้วยนะคะ')]);
      return;
    }
    // เก็บที่อยู่/เบอร์
    const phone = extractPhone(plain);
    if(phone) s.phone = phone;
    if (plain.length>12 && !/qr|ปลายทาง|cod/i.test(plain)) s.address = plain;

    if (s.address && s.phone) {
      const { orderNo, sum } = await persistOrder(userId, s, s.address, s.phone, 'รอชำระ/จัดส่ง');
      await lineClient.replyMessage(replyToken, [
        msgText(`ออเดอร์ #${orderNo}\n${renderCart(s.cart)}\nยอดสุทธิ: ${THB(sum.total)}\nจัดส่ง: ${s.address}\nโทร: ${s.phone}\nขอบคุณมากค่ะ 🥰`)
      ]);
      await notifyAdmin(`🛒 ออเดอร์ใหม่ #${orderNo}\n${renderCart(s.cart)}\nยอดสุทธิ: ${THB(sum.total)}\nที่อยู่: ${s.address}\nโทร: ${s.phone}`);
      sessions.delete(userId);
      return;
    } else {
      await lineClient.replyMessage(replyToken,[msgText('ส่ง “ชื่อ-ที่อยู่” และ “เบอร์โทร” ได้เลยค่ะ 😊')]);
      return;
    }
  }

  // 4) ถ้ากำลังเลือกจำนวนอยู่
  if (s.stage === 'picking_qty' && s.current?.candidates?.length) {
    const qty = extractQty(plain);
    if (qty) {
      const p = s.current.candidates[s.current.chosenIndex];
      s.cart.push({
        sku: p['รหัสสินค้า'],
        name: p['ชื่อสินค้า'],
        category: p['หมวดหมู่'] || '',
        price: Number(p['ราคา']||0),
        qty,
        variant: s.current.chosenVariant || ''
      });
      s.current = null;
      s.stage = 'confirming';
      await logSession(s,'qty_added');
      const sum = cartSummary(s.cart);
      await lineClient.replyMessage(replyToken, [
        msgText(`เพิ่มลงตะกร้าแล้วค่ะ 🧺\n${renderCart(s.cart)}\nยอดสุทธิ: ${THB(sum.total)}\nพิมพ์ชื่อสินค้าอื่นเพิ่มได้ หรือพิมพ์ “สรุป” เพื่อไปชำระเงินค่ะ`)
      ]);
      return;
    } else {
      await lineClient.replyMessage(replyToken,[msgText('พิมพ์เป็นตัวเลขจำนวนชิ้นนะคะ เช่น 2 หรือ 5')]);
      return;
    }
  }

  // 5) ถ้ากำลังเลือกตัวเลือกรสชาติ/ตัวเลือก
  if (s.stage === 'picking_variant' && s.current?.candidates?.length) {
    const p = s.current.candidates[s.current.chosenIndex];
    const ops = splitList(p['ตัวเลือก']||'');
    // ถ้าผู้ใช้ถามราคา → ตอบราคาเลย (อย่าเปลี่ยน flow)
    if (isAskPrice(plain)) {
      await lineClient.replyMessage(replyToken,[msgText(`ราคา ${THB(Number(p['ราคา']||0))} ต่อชิ้นค่ะ`)])
      return;
    }
    // รับค่าตัวเลือก
    if (!ops.length) {
      s.current.chosenVariant = '';
      s.stage = 'picking_qty';
      await lineClient.replyMessage(replyToken,[msgText('ต้องการกี่ชิ้นคะ? (เช่น 2, 5)')]);
      return;
    }
    const choice = normalize(plain);
    const match = ops.find(op=>op.toLowerCase().includes(choice.toLowerCase()));
    if (match) {
      s.current.chosenVariant = match;
      s.stage = 'picking_qty';
      await lineClient.replyMessage(replyToken,[msgText(`รับรสชาติ “${match}” นะคะ ต้องการกี่ชิ้นคะ? (เช่น 2, 5)`)]); 
    } else {
      await lineClient.replyMessage(replyToken,[msgText(`มีรสชาติ: ${ops.join(', ')}\nเลือกได้เลยค่ะ`)]);
    }
    return;
  }

  // 6) หา product intent
  const found = searchProducts(plain);

  if (found.length >= 1) {
    // รวมตาม baseName
    const groups = groupByBaseName(found);
    if (groups.length >= 2) {
      // ลูกค้าพิมพ์กว้างเกิน มีหลายกลุ่ม → แสดงรายการสั้น ๆ
      const names = groups.slice(0,6).map(g=>`• ${cache.products.find(p=>baseName(p['ชื่อสินค้า']).toLowerCase()===g.key)?.['ชื่อสินค้า'] || g.items[0]['ชื่อสินค้า']}`).join('\n');
      await lineClient.replyMessage(replyToken,[msgText(`หมายถึงตัวไหนคะ 😊\n${names}\nลองพิมพ์ชื่อให้ชัดขึ้นอีกนิดได้ไหมคะ`)]);
      return;
    }
    // 1 กลุ่ม → อาจมีหลาย variant/บรรจุภัณฑ์
    const group = groups[0];
    const items = group.items.sort((a,b)=>Number(a['ราคา']||0)-Number(b['ราคา']||0));

    if (items.length > 1) {
      // ให้เลือกรุ่น/บรรจุภัณฑ์ (ที่อยู่ในชื่อ)
      s.current = { groupKey: group.key, candidates: items, chosenIndex: -1, chosenVariant: '' };
      s.stage = 'picking_product';
      const lines = items.slice(0,8).map((it,i)=>`- ${it['ชื่อสินค้า']} ราคา ${THB(Number(it['ราคา']||0))}`).join('\n');
      await lineClient.replyMessage(replyToken,[msgText(`มีให้เลือกดังนี้ค่ะ:\n${lines}\nพิมพ์ชื่อแบบที่สนใจได้เลยค่ะ`)]); 
      return;
    } else {
      // เหลือชิ้นเดียว → ถามรสชาติ/ตัวเลือก ถ้ามี
      const p = items[0];
      s.current = { groupKey: group.key, candidates: [p], chosenIndex: 0, chosenVariant: '' };
      const ops = splitList(p['ตัวเลือก']||'');
      if (ops.length) {
        s.stage = 'picking_variant';
        await lineClient.replyMessage(replyToken,[msgText(`รสชาติที่มี: ${ops.join(', ')}\nต้องการรสไหนคะ?`)]); 
      } else {
        s.stage = 'picking_qty';
        await lineClient.replyMessage(replyToken,[msgText(`ราคา ${THB(Number(p['ราคา']||0))} ต่อชิ้นค่ะ ต้องการกี่ชิ้นคะ? (เช่น 2, 5)`)]); 
      }
      return;
    }
  }

  // 7) ถ้าอยู่ในขั้น picking_product (ลูกค้าคลิก/พิมพ์ชื่อรุ่น)
  if (s.stage === 'picking_product' && s.current?.candidates?.length) {
    const idx = s.current.candidates.findIndex(it => it['ชื่อสินค้า']?.toLowerCase().includes(plain.toLowerCase()));
    if (idx >= 0) {
      s.current.chosenIndex = idx;
      const p = s.current.candidates[idx];
      const ops = splitList(p['ตัวเลือก']||'');
      if (ops.length) {
        s.stage = 'picking_variant';
        await lineClient.replyMessage(replyToken,[msgText(`รับทราบค่ะ ราคา ${THB(Number(p['ราคา']||0))}\nรสชาติที่มี: ${ops.join(', ')}\nต้องการรสไหนคะ?`)]); 
      } else {
        s.stage = 'picking_qty';
        await lineClient.replyMessage(replyToken,[msgText(`รับรุ่น “${p['ชื่อสินค้า']}” ค่ะ ราคา ${THB(Number(p['ราคา']||0))}\nต้องการกี่ชิ้นคะ? (เช่น 2, 5)`)]); 
      }
      return;
    } else {
      // อยู่ขั้นเลือกรุ่น แต่พิมพ์ไม่ตรง
      const lines = s.current.candidates.slice(0,8).map(it=>`- ${it['ชื่อสินค้า']} ราคา ${THB(Number(it['ราคา']||0))}`).join('\n');
      await lineClient.replyMessage(replyToken,[msgText(`มีรายการดังนี้นะคะ:\n${lines}\nพิมพ์ชื่อแบบที่สนใจได้เลยค่ะ`)]); 
      return;
    }
  }

  // 8) ไม่เข้าเงื่อนไข → ใช้ AI ช่วย แต่มีบริบทสินค้า/FAQ สั้น ๆ (กันตอบนอกเรื่อง)
  const extra = `
[รายการสินค้า (บางส่วน)]
${shortListProducts(8)}

[ตัวอย่าง FAQ]
${cache.faq.slice(0,5).map(f=>`• ${f['คำถาม']}: ${f['คำตอบ']}`).join('\n')}
  `.trim();

  const ai = await aiShort(plain, extra);
  const answer = ai || 'รับทราบค่ะ 😊';
  await lineClient.replyMessage(replyToken,[msgText(answer)]);

  // ถ้า AI ยังดูนอก topic / ลูกค้าพิมพ์ "ขอแอดมิน" / "คนจริง"
  if (/แอดมิน|คนจริง|เจ้าหน้าที่/i.test(plain)) {
    await notifyAdmin(`⚠️ ผู้ใช้ต้องการคนจริงช่วย\nข้อความ: ${plain}`);
  }
}

// -------------------------- Web server ------------------------------
const app = express();
app.get('/', (req,res)=>res.send('OK'));
app.get('/healthz', (req,res)=>res.send('ok'));

app.post('/webhook', lineMiddleware(lineConfig), async (req,res)=>{
  try{
    if(!cache.persona) await loadAll();
    res.status(200).end();

    const events = req.body.events || [];
    for (const ev of events){
      if (ev.type === 'message' && ev.message?.type === 'text') {
        const userId = ev.source?.userId || ev.source?.groupId || ev.source?.roomId || 'unknown';
        await handleText(userId, ev.replyToken, ev.message.text);
      } else if (ev.type === 'follow') {
        // ทักครั้งเดียว (ไม่ทักวน)
        await lineClient.replyMessage(ev.replyToken, [msgText('ยินดีต้อนรับค่ะ พิมพ์ชื่อสินค้าที่สนใจได้เลย หรือพิมพ์ “สรุป” เพื่อตรวจตะกร้า 🧺')]);
      }
    }
  }catch(err){
    console.error('Webhook Error:', err);
    try{
      await appendRow(SHEETS.logs, {
        'timestamp': dayjs().format('YYYY-MM-DD HH:mm:ss'),
        'userId': 'system',
        'type': 'ERR',
        'text': err?.message || String(err)
      });
    }catch(e){}
  }
});

// refresh data ทุก 10 นาที
setInterval(async()=>{
  try{ await loadAll(); }catch(e){}
}, 10*60*1000);

// -------------------------- Start -----------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, async ()=>{
  try{
    await loadAll();
    console.log(`🚀 Bot running on ${PORT}`);
  }catch(e){
    console.error('❌ Google Sheet Error:', e?.message);
  }
});
