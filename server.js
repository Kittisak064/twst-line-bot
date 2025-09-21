// server.js
// ===================================================================
// LINE x Google Sheets Conversational Commerce Bot (TH)
// Guard-railed: ไม่มั่ว, ไม่เงียบ, ตอบทุกข้อความ, ปิดการขายได้
// ชีทที่ใช้ (หัวอยู่แถวที่ 1 เท่านั้น):
//  Products: [รหัสสินค้า, ชื่อสินค้า, หมวดหมู่, ราคา, คำที่ลูกค้าเรียก, ตัวเลือก, ขนาด]
//  Promotions: [รหัสโปรโมชั่น, รายละเอียดโปรโมชั่น, ประเภทคำนวณ, เงื่อนไข, ใช้กับสินค้า, ใช้กับหมวดหมู่]
//  FAQ: [คำถาม, คำตอบ, คำหลัก]
//  personality: [ชื่อพนักงาน, ชื่อเพจ, บุคลิก, คำเรียกลูกค้า, คำเรียกตัวเองแอดมิน, คำตอบเมื่อไม่รู้, เพศ]
//  Payment: [category, method, detail, qrcode]
//  Orders: [เลขที่ออเดอร์, รหัสสินค้า, ชื่อสินค้า, ตัวเลือก, จำนวน, ราคารวม, โปรโมชั่นที่ใช้, ชื่อ-ที่อยู่, เบอร์โทร, สถานะ]
//  Sessions: [timestamp, userId, stage, cart, note]
//  Logs: [timestamp, userId, type, text]
// ===================================================================

import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import OpenAI from 'openai';
import dayjs from 'dayjs';

// ----------------------- ENV ------------------------------
const {
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  GOOGLE_SHEET_ID,
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  OPENAI_API_KEY,
  ADMIN_GROUP_ID
} = process.env;

// ----------------------- LINE -----------------------------
const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};
const lineClient = new Client(lineConfig);

// ----------------------- OPENAI (optional) ----------------
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ----------------------- SHEETS ---------------------------
const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID);
const FIXED_SHEETS = {
  products: 'Products',
  promotions: 'Promotions',
  faq: 'FAQ',
  personality: 'personality',
  orders: 'Orders',
  payment: 'Payment',
  sessions: 'Sessions',
  logs: 'Logs',
};
async function authSheet() {
  const key = (GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  await doc.useServiceAccountAuth({
    client_email: GOOGLE_CLIENT_EMAIL,
    private_key: key,
  });
  await doc.loadInfo();
}
async function readSheet(name) {
  const sheet = doc.sheetsByTitle[name];
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
async function appendRow(name, obj) {
  const sh = doc.sheetsByTitle[name];
  if (!sh) throw new Error(`Sheet not found: ${name}`);
  await sh.loadHeaderRow();
  await sh.addRow(obj);
}

// ----------------------- UTILS ----------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const THB = n => Number(n || 0).toLocaleString('th-TH', { style: 'currency', currency: 'THB', maximumFractionDigits: 0 });
const now = () => dayjs().format('YYYY-MM-DD HH:mm:ss');
const lower = s => (s || '').toString().toLowerCase();
const normalize = s => (s || '').toString().replace(/\s+/g,' ').trim();
const splitList = s =>
  normalize(s)
    .split(/,|，|\/|\||\n|และ| หรือ /g)
    .map(x => x.trim())
    .filter(Boolean);

// ----------------------- CACHE ----------------------------
const cache = {
  persona: null,
  products: [],
  promotions: [],
  faq: [],
  payment: [],
  aliasIndex: new Map(), // alias/sku/name -> [product,...]
  lastLoaded: 0,
};
async function loadAll() {
  await authSheet();
  const [products, promotions, faq, personalityRows, payment] = await Promise.all([
    readSheet(FIXED_SHEETS.products),
    readSheet(FIXED_SHEETS.promotions),
    readSheet(FIXED_SHEETS.faq),
    readSheet(FIXED_SHEETS.personality),
    readSheet(FIXED_SHEETS.payment),
  ]);

  const persona = personalityRows?.[0] || {
    'ชื่อพนักงาน': 'แอดมิน',
    'ชื่อเพจ': '',
    'บุคลิก': 'สุภาพ จริงใจ ช่วยเต็มที่',
    'คำเรียกลูกค้า': 'คุณลูกค้า',
    'คำเรียกตัวเองแอดมิน': 'แอดมิน',
    'คำตอบเมื่อไม่รู้': 'ขออนุญาตเช็คข้อมูลก่อนนะคะ',
    'เพศ': 'หญิง',
  };

  // alias index
  const idx = new Map();
  for (const p of products) {
    const aliases = [
      p['ชื่อสินค้า'],
      p['รหัสสินค้า'],
      ...(splitList(p['คำที่ลูกค้าเรียก']) || []),
    ].map(x => lower(x));
    for (const a of aliases) {
      if (!a) continue;
      const list = idx.get(a) || [];
      list.push(p);
      idx.set(a, list);
    }
  }

  cache.persona = persona;
  cache.products = products;
  cache.promotions = promotions;
  cache.faq = faq;
  cache.payment = payment;
  cache.aliasIndex = idx;
  cache.lastLoaded = Date.now();
}

// ----------------------- ADMIN NOTIFY ---------------------
async function notifyAdmin(text, more = []) {
  if (!ADMIN_GROUP_ID) return;
  try {
    await lineClient.pushMessage(ADMIN_GROUP_ID, [{ type: 'text', text }, ...more].slice(0,5));
  } catch (e) {
    // swallow
  }
}

// ----------------------- PROMOTIONS -----------------------
function parseCond(s='') {
  const out = {};
  splitList(s).forEach(t=>{
    const [k,v] = t.split('=').map(x=>x.trim());
    if (!k) return;
    const n = Number(v);
    out[k] = isNaN(n) ? v : n;
  });
  return out;
}
function promoApplies(promo, item) {
  const bySku = splitList(promo['ใช้กับสินค้า']).map(lower);
  const byCat = splitList(promo['ใช้กับหมวดหมู่']).map(lower);
  const sku = lower(item.sku);
  const cat = lower(item.category);
  const okSku = bySku.length? bySku.includes(sku) : true;
  const okCat = byCat.length? byCat.includes(cat) : true;
  return okSku && okCat;
}
function computePromotion(cart=[]) {
  if (!cart.length) return { discount:0, code:'', detail:'' };
  let best = { discount:0, code:'', detail:'' };
  for (const p of cache.promotions) {
    const type = (p['ประเภทคำนวณ']||'').toUpperCase();
    const cond = parseCond(p['เงื่อนไข']||'');
    const items = cart.filter(it=>promoApplies(p,it));
    if (!items.length) continue;
    const qty = items.reduce((s,it)=>s+Number(it.qty||0),0);
    const amt = items.reduce((s,it)=>s+(Number(it.price||0)*Number(it.qty||0)),0);
    if (cond.min_qty && qty < Number(cond.min_qty)) continue;
    if (cond.min_amount && amt < Number(cond.min_amount)) continue;

    let discount=0, detail='';
    if (type==='PERCENT') {
      const pct = Number(cond.percent||0);
      discount = Math.floor(amt*pct/100);
      detail = `ส่วนลด ${pct}%`;
    } else if (type==='FIXED_DISCOUNT') {
      discount = Number(cond.amount||0);
      detail = `ลดทันที ${THB(discount)}`;
    } else if (type==='BUY_X_GET_Y') {
      const free = Number(cond.get_free||1);
      const prices=[];
      items.forEach(it=>{
        for (let i=0;i<Number(it.qty||0);i++) prices.push(Number(it.price||0));
      });
      prices.sort((a,b)=>a-b);
      discount = prices.slice(0,free).reduce((s,v)=>s+v,0);
      detail = `โปรซื้อครบ ${cond.min_qty} แถม ${free}`;
    } else if (type==='FREE_SHIPPING') {
      discount = Number(cond.fee||40);
      detail = `ส่งฟรี (หักค่าขนส่ง ${THB(discount)})`;
    } else continue;

    if (discount>best.discount) best={discount, code:p['รหัสโปรโมชั่น']||'', detail: p['รายละเอียดโปรโมชั่น']||detail};
  }
  return best;
}

// ----------------------- PAYMENT --------------------------
function pickPayment(category='all') {
  const cat = lower(category||'');
  let row = cache.payment.find(r=>lower(r['category'])===cat);
  if (!row) row = cache.payment.find(r=>lower(r['category'])==='all');
  if (!row) row = cache.payment[0] || {};
  return {
    method: row['method'] || 'โอน/พร้อมเพย์/COD',
    detail: row['detail'] || '',
    qrcode: row['qrcode'] || ''
  };
}

// ----------------------- FAQ MATCH ------------------------
function matchFAQ(text) {
  const t = lower(text);
  let best=null, scoreBest=0;
  for (const f of cache.faq) {
    let sc=0;
    if (lower(f['คำถาม']) && t.includes(lower(f['คำถาม']))) sc+=2;
    splitList(f['คำหลัก']).forEach(k=>{ if (t.includes(lower(k))) sc+=1; });
    if (sc>scoreBest) { scoreBest=sc; best=f; }
  }
  return scoreBest>=2 ? best : null;
}

// ----------------------- SESSIONS -------------------------
const sessions = new Map(); // userId -> state
const WATCHDOGS = new Map(); // userId -> timeoutId

function newSession(userId) {
  const s = {
    userId,
    stage: 'idle',
    currentItem: null, // {sku,name,category,price,options[],sizes[],chosenOption,chosenSize}
    cart: [], // {sku,name,category,price,chosenOption,chosenSize,qty}
    address: '',
    phone: '',
    lastActive: Date.now(),
  };
  sessions.set(userId, s);
  return s;
}
function getSession(userId) {
  const s = sessions.get(userId) || newSession(userId);
  s.lastActive = Date.now();
  return s;
}
async function saveSessionRow(s, note='') {
  try {
    await appendRow(FIXED_SHEETS.sessions, {
      timestamp: now(),
      userId: s.userId,
      stage: s.stage,
      cart: JSON.stringify(s.cart),
      note
    });
  } catch(e){}
}
function setWatchdog(userId, promptToCustomer) {
  // เตือนอัตโนมัติถ้าลูกค้าเงียบ 4 นาที
  if (WATCHDOGS.get(userId)) clearTimeout(WATCHDOGS.get(userId));
  const id = setTimeout(async()=>{
    try {
      await lineClient.pushMessage(userId, [{type:'text', text: promptToCustomer || 'ยังอยู่กับแอดมินนะคะ ต้องการให้ช่วยต่อในจุดไหน แจ้งได้เลยค่ะ 😊'}]);
    } catch(e){}
  }, 4*60*1000);
  WATCHDOGS.set(userId, id);
}

// ----------------------- PRODUCT HELPERS ------------------
function findProductsByText(text) {
  const t = lower(text);
  const found = new Set();

  // exact alias/sku/name
  const direct = cache.aliasIndex.get(t);
  if (direct) direct.forEach(p=>found.add(p));

  // fuzzy by name & sku
  cache.products.forEach(p=>{
    if (lower(p['ชื่อสินค้า']).includes(t)) found.add(p);
    if (lower(p['รหัสสินค้า'])===t) found.add(p);
    splitList(p['คำที่ลูกค้าเรียก']).forEach(a=>{ if (t.includes(lower(a))) found.add(p); });
    if (t && lower(p['หมวดหมู่']).includes(t)) found.add(p);
  });

  return [...found];
}
function extractOptions(p) { return splitList(p['ตัวเลือก']); }
function extractSizes(p) { return splitList(p['ขนาด']); }

// ----------------------- CART & ORDER ---------------------
function renderCart(cart) {
  if (!cart?.length) return '-';
  return cart.map((it, i)=> `${i+1}. ${it.name}${it.chosenSize?` ${it.chosenSize}`:''}${it.chosenOption?` (${it.chosenOption})`:''} x ${it.qty} = ${THB(it.price*it.qty)}`).join('\n');
}
function calcCartSummary(cart) {
  const sub = cart.reduce((s,it)=>s+(Number(it.price||0)*Number(it.qty||0)),0);
  const promo = computePromotion(cart);
  const total = Math.max(0, sub - (promo.discount||0));
  return { sub, promo, total };
}
async function persistOrder(userId, s, address, phone, status='รอชำระ/จัดส่ง') {
  const ts = dayjs().format('YYYYMMDDHHmmss');
  const orderNo = `ORD-${ts}-${(userId||'xxxx').slice(-4)}`;
  const sum = calcCartSummary(s.cart);
  const promoText = sum.promo.code ? `${sum.promo.code} - ${sum.promo.detail}` : '';
  for (const it of s.cart) {
    await appendRow(FIXED_SHEETS.orders, {
      'เลขที่ออเดอร์': orderNo,
      'รหัสสินค้า': it.sku,
      'ชื่อสินค้า': it.name,
      'ตัวเลือก': [it.chosenSize, it.chosenOption].filter(Boolean).join(' / '),
      'จำนวน': it.qty,
      'ราคารวม': it.price * it.qty,
      'โปรโมชั่นที่ใช้': promoText,
      'ชื่อ-ที่อยู่': address,
      'เบอร์โทร': phone,
      'สถานะ': status,
    });
  }
  return { orderNo, sum };
}

// ----------------------- AI (guarded) ---------------------
function personaPrompt() {
  const ps = cache.persona || {};
  const agent = ps['ชื่อพนักงาน'] || 'แอดมิน';
  const page = ps['ชื่อเพจ'] || '';
  const tone = ps['บุคลิก'] || 'สุภาพ จริงใจ ช่วยเต็มที่';
  const callCus = ps['คำเรียกลูกค้า'] || 'คุณลูกค้า';
  const callSelf = ps['คำเรียกตัวเองแอดมิน'] || 'แอดมิน';
  const unknown = ps['คำตอบเมื่อไม่รู้'] || 'ขออนุญาตเช็คข้อมูลก่อนนะคะ';
  const gender = ps['เพศ'] || 'หญิง';
  return `
คุณคือ “${agent}”${page?` จากเพจ ${page}`:''} เพศ${gender}
บุคลิก: ${tone}
ภาษาที่ใช้: ไทย สุภาพ กระชับ ไม่พรรณนายาว
เรียกลูกค้าว่า “${callCus}” เรียกตัวเองว่า “${callSelf}”
กฎสำคัญ:
- ห้ามแต่งราคา/โปรฯ เอง ต้องอิงข้อมูลที่ส่งให้เท่านั้น
- ถ้าไม่แน่ใจให้ถามยืนยัน 1 คำถาม
- อย่าทัก “สวัสดี” ถ้าไม่ใช่การทักครั้งแรก
- เรียกสินค้าน้ำพริกว่า “รสชาติ/ตัวเลือก” ไม่ใช้คำว่า “รุ่น”
- จบด้วยคำสุภาพสั้นๆ และอิโมจิได้นิดหน่อย
ไม่ต้องใส่หัวข้อ/ลิสต์ยาวโดยไม่จำเป็น
`.trim();
}
async function aiShortReply(userText, context='') {
  if (!openai) return null;
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 200,
      messages: [
        { role:'system', content: personaPrompt() },
        { role:'user', content: `${context?`[ข้อมูลที่ยืนยันแล้ว]\n${context}\n\n`:''}${userText}` }
      ]
    });
    let out = res.choices?.[0]?.message?.content?.trim() || '';
    // post-filter: ตัดคำทักซ้ำ & บีบให้ถามต่อ
    out = out.replace(/^สวัสดี.+?\n?/i,'').trim();
    return out;
  } catch(e){ return null; }
}

// ----------------------- INTENT ROUTER --------------------
function quickReplyYesNo() {
  return {
    items: [
      { type:'action', action:{ type:'message', label:'ใช่', text:'ใช่' } },
      { type:'action', action:{ type:'message', label:'ไม่ใช่', text:'ไม่ใช่' } },
    ]
  };
}
function isAffirm(s){ return /(ใช่|ได้|โอเค|ตกลง|เอา|ชัวร์)/i.test(s||''); }
function isAskPrice(s){ return /(เท่าไร|ราคา|กี่บาท)/i.test(s||''); }
function isAskList(s){ return /(มีอะไรบ้าง|มีอะไร|รายการ|ลิสต์)/i.test(s||''); }
function isAskPayment(s){ return /(จ่าย|โอน|cod|ปลายทาง|พร้อมเพย์|ชำระ)/i.test(s||''); }
function isEscalation(s){ return /(โกรธ|ร้องเรียน|คืนเงิน|โกง|ช้า|ไม่ส่ง|เสียหาย|ด่วน)/i.test(s||''); }
function extractQty(s){ const m = (s||'').match(/\d+/); return m? Math.max(1, Number(m[0])) : null; }

// ----------------------- REPLY HELPERS --------------------
const T = {
  listProductsShort(ps, category=null){
    const arr = category? ps.filter(p=>lower(p['หมวดหมู่'])===lower(category)) : ps;
    const top = arr.slice(0,12);
    return top.map(p=>`- ${p['ชื่อสินค้า']}`).join('\n') + (arr.length>12?`\n… และอีก ${arr.length-12} รายการ`:'');
  },
  askVariant(p){
    const ops = extractOptions(p);
    if (ops.length) return `ต้องการ “${p['ชื่อสินค้า']}” รสชาติ/ตัวเลือกไหนคะ?\nตัวเลือก: ${ops.join(', ')}`;
    const sizes = extractSizes(p);
    if (sizes.length) return `ต้องการ “${p['ชื่อสินค้า']}” ขนาดไหนคะ?\nขนาด: ${sizes.join(', ')}`;
    return `ต้องการ “${p['ชื่อสินค้า']}” จำนวนกี่ชิ้นคะ? (เช่น 2, 5)`;
  },
  askSize(p){
    const sizes = extractSizes(p);
    return `ต้องการ “${p['ชื่อสินค้า']}” ขนาดไหนคะ?\nขนาด: ${sizes.join(', ')}`;
  },
  askQty(p, chosen=''){
    return `ต้องการ “${p['ชื่อสินค้า']}${chosen?` ${chosen}`:''}” จำนวนกี่ชิ้นคะ? (เช่น 2, 5)`;
  },
  summary(cart){
    const view = renderCart(cart);
    const sum = calcCartSummary(cart);
    return `🧾 ตะกร้า:\n${view}\n\nยอดรวม: ${THB(sum.sub)}${sum.promo.code?`\nโปรฯ: ${sum.promo.detail} (-${THB(sum.promo.discount)})`:''}\nยอดสุทธิ: ${THB(sum.total)}\n\nพิมพ์ “สรุป” เพื่อดำเนินการชำระ หรือพิมพ์ชื่อสินค้าเพื่อเพิ่มได้ค่ะ`;
  }
};

// ----------------------- CORE FLOW ------------------------
async function handleText(userId, replyToken, text) {
  const s = getSession(userId);
  const txt = normalize(text);

  // log IN
  try { await appendRow(FIXED_SHEETS.logs, { timestamp: now(), userId, type:'IN', text: txt }); } catch(e){}

  // 0) reload data occasionally
  if (!cache.persona || Date.now()-cache.lastLoaded > 10*60*1000) await loadAll();

  // 1) intent: escalation
  if (isEscalation(txt)) {
    await notifyAdmin(`⚠️ ลูกค้าต้องการความช่วยเหลือด่วน\nuser:${userId}\nmsg:${txt}\nstage:${s.stage}\ncart:${JSON.stringify(s.cart)}`);
    await lineClient.replyMessage(replyToken, [{ type:'text', text:'รับทราบค่ะ แอดมินตัวจริงกำลังเข้ามาช่วยดูให้ทันทีนะคะ 🙏' }]);
    setWatchdog(userId);
    return;
  }

  // 2) FAQ (น้ำหนักสูง)
  const faq = matchFAQ(txt);
  if (faq) {
    await lineClient.replyMessage(replyToken, [{ type:'text', text: faq['คำตอบ'] }]);
    // กลับ flow เดิมถ้ากำลังเลือกของ
    if (s.stage!=='idle' && s.currentItem) {
      await lineClient.pushMessage(userId, [{ type:'text', text: T.askVariant(s.currentItemRaw || { 'ชื่อสินค้า': s.currentItem?.name }) }]);
    }
    setWatchdog(userId);
    return;
  }

  // 3) command words
  if (/^สรุป/i.test(txt) || /ยืนยัน|ปิดการขาย/.test(txt)) {
    if (!s.cart.length) {
      await lineClient.replyMessage(replyToken, [{type:'text', text:'ยังไม่มีสินค้าในตะกร้าค่ะ พิมพ์ชื่อสินค้าที่ต้องการได้เลยค่ะ'}]);
      return;
    }
    s.stage = 'collecting_info';
    await saveSessionRow(s,'start_checkout');
    const majorCat = s.cart[0]?.category || 'all';
    const pay = pickPayment(majorCat);
    await lineClient.replyMessage(replyToken, [
      {type:'text', text:'กรุณาบอก “ชื่อ-ที่อยู่” และ “เบอร์โทร” สำหรับจัดส่งด้วยนะคะ'},
      {type:'text', text:`ช่องทางชำระ: ${pay.method}\n${pay.detail}${pay.qrcode?'\nถ้าต้องการ QR พิมพ์ว่า "ขอ QR" ได้เลยค่ะ':''}\nหากต้องการเก็บเงินปลายทาง พิมพ์ "เก็บปลายทาง" ได้เลยค่ะ`}
    ]);
    setWatchdog(userId, 'ขอชื่อ-ที่อยู่ และเบอร์โทรได้ไหมคะ 😊');
    return;
  }
  if (/qr|คิวอาร์|พร้อมเพย์/i.test(txt)) {
    const cat = s.cart[0]?.category || 'all';
    const pay = pickPayment(cat);
    if (pay.qrcode) {
      await lineClient.replyMessage(replyToken, [
        {type:'text', text:'ส่ง QR ให้แล้วค่ะ โอนได้เลย แล้วแนบสลิปในแชทนี้นะคะ'},
        {type:'image', originalContentUrl: pay.qrcode, previewImageUrl: pay.qrcode}
      ]);
    } else {
      await lineClient.replyMessage(replyToken, [{type:'text', text:`รายละเอียดชำระเงิน: ${pay.detail || '-'}`}]);
    }
    setWatchdog(userId);
    return;
  }
  if (/เก็บปลายทาง|cod/i.test(txt)) {
    s.paymentMethod='COD';
    await lineClient.replyMessage(replyToken, [{type:'text', text:'รับทราบเก็บปลายทางค่ะ รบกวนขอ “ชื่อ-ที่อยู่” และ “เบอร์โทร” ด้วยนะคะ'}]);
    setWatchdog(userId,'ขอชื่อ-ที่อยู่ และเบอร์โทรหน่อยนะคะ');
    return;
  }

  // 4) Collecting info (address/phone)
  if (s.stage==='collecting_info') {
    const phone = (txt.match(/0\d{8,9}/)||[])[0];
    if (phone) s.phone = phone;
    if (txt.length>10 && !/qr|ปลายทาง|cod/i.test(txt)) s.address = txt;
    if (s.address && s.phone) {
      const { orderNo, sum } = await persistOrder(userId, s, s.address, s.phone, 'รอดำเนินการ');
      await lineClient.replyMessage(replyToken, [
        {type:'text', text:`สรุปคำสั่งซื้อ #${orderNo}\n${renderCart(s.cart)}\nยอดสุทธิ: ${THB(sum.total)}\nจัดส่ง: ${s.address}\nโทร: ${s.phone}\n\nขอบคุณมากค่ะ 🥰`},
      ]);
      await notifyAdmin(`🛒 ออเดอร์ใหม่ #${orderNo}\n${renderCart(s.cart)}\nยอดสุทธิ ${THB(sum.total)}\nที่อยู่: ${s.address}\nโทร: ${s.phone}`);
      sessions.delete(userId);
      if (WATCHDOGS.get(userId)) clearTimeout(WATCHDOGS.get(userId));
      return;
    }
    await lineClient.replyMessage(replyToken, [{type:'text', text:'ขอ “ชื่อ-ที่อยู่” และ “เบอร์โทร” เพื่อดำเนินการต่อนะคะ 😊'}]);
    setWatchdog(userId);
    return;
  }

  // 5) If in choosing variant/size/qty
  if (s.stage==='picking_variant' && s.currentItem) {
    // choose option or size if provided
    const cur = s.currentItem;
    const opt = cur.options.find(o=>lower(o).includes(lower(txt))) || null;
    const size = cur.sizes.find(o=>lower(o).includes(lower(txt))) || null;
    if (cur.options.length && opt) cur.chosenOption = opt;
    if (!cur.options.length) cur.chosenOption = '';
    if (cur.sizes.length && size) { cur.chosenSize = size; s.stage='picking_qty'; await saveSessionRow(s,'size_chosen'); await lineClient.replyMessage(replyToken,[{type:'text', text: T.askQty(cur, [cur.chosenSize, cur.chosenOption].filter(Boolean).join(' '))}]); setWatchdog(userId); return; }
    if (cur.options.length && cur.chosenOption && cur.sizes.length) {
      s.stage = 'picking_size';
      await saveSessionRow(s,'option_chosen');
      await lineClient.replyMessage(replyToken, [{type:'text', text: T.askSize({ 'ชื่อสินค้า': cur.name, 'ขนาด': cur.sizes.join(', ') }) }]);
      setWatchdog(userId);
      return;
    }
    if (cur.options.length && cur.chosenOption && !cur.sizes.length) {
      s.stage='picking_qty';
      await saveSessionRow(s,'option_chosen');
      await lineClient.replyMessage(replyToken, [{type:'text', text: T.askQty(cur, cur.chosenOption)}]);
      setWatchdog(userId);
      return;
    }
    // not matched → show options
    if (cur.options.length) {
      await lineClient.replyMessage(replyToken, [{type:'text', text:`รสชาติ/ตัวเลือกที่มี: ${cur.options.join(', ')}`}]);
    } else if (cur.sizes.length) {
      s.stage='picking_size';
      await lineClient.replyMessage(replyToken, [{type:'text', text: T.askSize(cur)}]);
    } else {
      s.stage='picking_qty';
      await lineClient.replyMessage(replyToken, [{type:'text', text: T.askQty(cur)}]);
    }
    setWatchdog(userId);
    return;
  }
  if (s.stage==='picking_size' && s.currentItem) {
    const cur = s.currentItem;
    const size = cur.sizes.find(o=>lower(o).includes(lower(txt)));
    if (size) {
      cur.chosenSize = size;
      s.stage = 'picking_qty';
      await saveSessionRow(s,'size_chosen');
      await lineClient.replyMessage(replyToken, [{type:'text', text: T.askQty(cur, size)}]);
    } else {
      await lineClient.replyMessage(replyToken, [{type:'text', text:`ขนาดที่มี: ${cur.sizes.join(', ')}\nเลือกได้เลยค่ะ` }]);
    }
    setWatchdog(userId);
    return;
  }
  if (s.stage==='picking_qty' && s.currentItem) {
    const q = extractQty(txt);
    if (q) {
      const cur = s.currentItem;
      s.cart.push({
        sku: cur.sku,
        name: cur.name,
        category: cur.category,
        price: Number(cur.price||0),
        chosenOption: cur.chosenOption || '',
        chosenSize: cur.chosenSize || '',
        qty: q
      });
      s.currentItem = null;
      s.stage = 'confirming';
      await saveSessionRow(s,'qty_added');
      await lineClient.replyMessage(replyToken, [{type:'text', text: T.summary(s.cart)}]);
    } else {
      await lineClient.replyMessage(replyToken, [{type:'text', text:'พิมพ์เป็นตัวเลขจำนวนชิ้นนะคะ (เช่น 2, 5)'}]);
    }
    setWatchdog(userId, 'ต้องการกี่ชิ้นดีคะ 😊');
    return;
  }

  // 6) Detect products / lists / price questions
  const found = findProductsByText(txt);

  if (isAskList(txt)) {
    // ถามรายการในหมวด ถ้าระบุ เช่น "มีรถเข็นอะไรบ้าง"
    let cat = null;
    const cats = [...new Set(cache.products.map(p=>p['หมวดหมู่']))];
    cats.forEach(c=>{ if (lower(txt).includes(lower(c))) cat=c; });
    const listing = T.listProductsShort(cache.products, cat);
    await lineClient.replyMessage(replyToken, [{type:'text', text:`รายการ${cat?cat:''}ที่มี:\n${listing}\n\nสนใจตัวไหนพิมพ์ชื่อได้เลยค่ะ` }]);
    setWatchdog(userId);
    return;
  }

  if (found.length === 1) {
    const p = found[0];
    const options = extractOptions(p);
    const sizes = extractSizes(p);
    s.currentItem = {
      sku: p['รหัสสินค้า'],
      name: p['ชื่อสินค้า'],
      category: p['หมวดหมู่'] || '',
      price: Number(p['ราคา']||0),
      options,
      sizes,
      chosenOption: '',
      chosenSize: ''
    };
    s.currentItemRaw = p;
    s.stage = 'picking_variant';
    await saveSessionRow(s,'product_detected');
    // ถ้าลูกค้าถาม "ราคาเท่าไร"
    if (isAskPrice(txt)) {
      let priceLine = `${p['ชื่อสินค้า']} ราคา ${THB(p['ราคา']||0)}`;
      if (sizes.length>1) priceLine = `${p['ชื่อสินค้า']} มีหลายขนาด ราคาเริ่มที่ ${THB(p['ราคา']||0)}`;
      await lineClient.replyMessage(replyToken, [{type:'text', text: `${priceLine}\n${T.askVariant(p)}`}]);
    } else {
      await lineClient.replyMessage(replyToken, [{type:'text', text: T.askVariant(p)}]);
    }
    setWatchdog(userId);
    return;
  }

  if (found.length > 1) {
    // ตอบสั้นและให้เลือก
    const names = found.slice(0,8).map(x=>`• ${x['ชื่อสินค้า']}`).join('\n');
    await lineClient.replyMessage(replyToken, [{type:'text', text:`หมายถึงตัวไหนคะ 😊\n${names}\n\nพิมพ์ชื่อให้ชัดขึ้น หรือบอก “รส/ตัวเลือก/ขนาด” ได้เลยค่ะ`}]);
    setWatchdog(userId);
    return;
  }

  // 7) If currently confirming & user asks price of something else → search again
  if (s.stage==='confirming' && isAskPrice(txt)) {
    await lineClient.replyMessage(replyToken, [{type:'text', text:T.summary(s.cart)}]);
    setWatchdog(userId);
    return;
  }

  // 8) Fallback -> Ask category & try LLM for natural talk (guarded)
  const cats = [...new Set(cache.products.map(p=>p['หมวดหมู่']))];
  const hint = `หมวดที่มี: ${cats.join(', ')}\nตัวอย่างสินค้า: \n${cache.products.slice(0,6).map(p=>`• ${p['ชื่อสินค้า']} (${THB(p['ราคา'])})`).join('\n')}`;
  const llm = await aiShortReply(txt, hint);
  const safeFallback = llm || 'รับทราบค่ะ สนใจสินค้าตัวไหนเอ่ย บอกชื่อได้เลย หรือพิมพ์ว่า “มีอะไรบ้าง” เพื่อดูรายการค่ะ 😊';
  await lineClient.replyMessage(replyToken, [{type:'text', text: safeFallback}]);
  setWatchdog(userId);
}

// ----------------------- WEBHOOK --------------------------
const app = express();
app.get('/', (req,res)=>res.send('OK'));
app.get('/healthz', (req,res)=>res.send('ok'));

app.post('/webhook',
  lineMiddleware(lineConfig),
  async (req,res)=>{
    res.status(200).end();
    try {
      if (!cache.persona) await loadAll();
      const events = req.body.events || [];
      for (const ev of events) {
        if (ev.type==='follow') {
          // ทักครั้งแรกเท่านั้น
          const ps = cache.persona || {};
          const hi = `ยินดีต้อนรับค่ะ 😊 สนใจสินค้าไหนบอกได้เลย หรือพิมพ์ “มีอะไรบ้าง” เพื่อดูรายการค่ะ`;
          await lineClient.replyMessage(ev.replyToken, [{type:'text', text:hi}]);
          continue;
        }
        if (ev.type==='message' && ev.message?.type==='text') {
          const userId = ev.source?.userId || ev.source?.groupId || ev.source?.roomId || 'unknown';
          await handleText(userId, ev.replyToken, ev.message.text);
        }
      }
    } catch (err) {
      try { await appendRow(FIXED_SHEETS.logs, { timestamp: now(), userId:'system', type:'ERR', text: err?.message || String(err)}); } catch(e){}
      // แจ้งลูกค้าไม่ให้เงียบ
      try {
        const ev = (req.body.events||[])[0];
        if (ev?.replyToken) {
          await lineClient.replyMessage(ev.replyToken, [{type:'text', text:'ขออภัยค่ะ ระบบติดขัดเล็กน้อย แอดมินตัวจริงจะช่วยต่อให้นะคะ 🙏'}]);
        }
        await notifyAdmin(`❗️Webhook Error: ${err?.message}`);
      } catch(e){}
    }
  }
);

// reload data background
setInterval(async()=>{ try { await loadAll(); } catch(e){} }, 10*60*1000);

// ----------------------- START ----------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, async ()=>{
  try {
    await loadAll();
    console.log(`🚀 bot ready on ${PORT}`);
  } catch(e) {
    console.error('❌ Sheet error:', e.message);
  }
});
