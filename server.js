// ==========================================================
//  LINE x Google Sheets x OpenAI - Thai Pro Commerce Bot
//  Features:
//   - อ่านข้อมูลจากชีทไทยตามหัวตารางของคุณ (คงที่ แต่อยู่ที่บรรทัดแรกเท่านั้น)
//   - บุคลิกพนักงานจากชีท personality
//   - สั่งซื้อยืดหยุ่น: เลือกสินค้า/รสชาติ -> จำนวน -> สรุป -> บันทึก Orders
//   - รองรับ Interrupt: ทักทาย/FAQ/ถามทั่วไปกลางคัน แล้วกลับมาค้างที่ออเดอร์ได้
//   - คิดโปรโมชันจากชีท Promotions (ผูกสินค้า/หมวดหมู่/เงื่อนไข)
//   - วิธีชำระเงิน/QR/COD จากชีท Payment (เลือกตามหมวดหรือ all)
//   - บันทึก Sessions/Logs
//   - แจ้งเตือนแอดมิน (Group) เมื่อมีคำสั่งซื้อใหม่
//
//  NOTE:
//   - ใช้ google-spreadsheet v3.3.0 (รองรับ useServiceAccountAuth)
//   - ใช้ OpenAI ให้คำตอบเป็นธรรมชาติ (แต่ยังคุม Flow ออเดอร์ไว้)
//   - ข้อมูลในชีท: Products, Promotions, FAQ, personality, Orders, Payment, Sessions, Logs
//   - หัวตารางภาษาไทยของคุณต้องอยู่แถวที่ 1 เท่านั้น
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
  personality: 'personality',
  orders: 'Orders',
  payment: 'Payment',
  sessions: 'Sessions',
  logs: 'Logs'
};

// ----------------------- LINE -----------------------------
const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET
};
const lineClient = new Client(lineConfig);

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

// utility: read sheet to array of objects using header row #1 (Thai headers)
async function readSheet(name) {
  const sheet = doc.sheetsByTitle[name];
  if (!sheet) return [];
  await sheet.loadHeaderRow();
  const rows = await sheet.getRows();
  const headers = sheet.headerValues; // e.g. ['รหัสสินค้า','ชื่อสินค้า',...]
  return rows.map(r => {
    const o = {};
    headers.forEach(h => (o[h] = (r[h] ?? '').toString().trim()));
    return o;
  });
}

// append row to target sheet using provided object (keys must match headers)
async function appendRow(name, record) {
  const sheet = doc.sheetsByTitle[name];
  if (!sheet) throw new Error(`Sheet not found: ${name}`);
  await sheet.loadHeaderRow();
  
  const headers = sheet.headerValues || [];
  const cleanRecord = {};
  for (const h of headers) {
    if (record[h] !== undefined) cleanRecord[h] = record[h];
  }

  await sheet.addRow(cleanRecord);
}

function THB(n) {
  const v = Number(n || 0);
  return v.toLocaleString('th-TH', { style: 'currency', currency: 'THB', maximumFractionDigits: 0 });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ----------------------- CACHE IN MEMORY ------------------
const cache = {
  products: [],
  promotions: [],
  faq: [],
  persona: null,
  payment: []
};

// map for product aliases; and product options (ตัวเลือก)
function normalizeThaiCommaText(s = '') {
  return s.replace(/\s+/g, ' ').trim();
}
function splitList(s = '') {
  return normalizeThaiCommaText(s)
    .split(/,|，|\/|\|/).map(x => x.trim()).filter(Boolean);
}
function buildAliasIndex(products) {
  const idx = new Map();
  for (const p of products) {
    const aliases = splitList(p['คำที่ลูกค้าเรียก'] || p['คําที่ลูกค้าเรียก'] || '');
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

let PRODUCT_ALIAS_INDEX = new Map();

async function loadAllData() {
  await authSheet();
  const limit = pLimit(4);
  const [products, promotions, faq, personalityRows, payment] = await Promise.all([
    limit(() => readSheet(FIXED_SHEETS.products)),
    limit(() => readSheet(FIXED_SHEETS.promotions)),
    limit(() => readSheet(FIXED_SHEETS.faq)),
    limit(() => readSheet(FIXED_SHEETS.personality)),
    limit(() => readSheet(FIXED_SHEETS.payment))
  ]);

  // persona: เอาแถวแรกพอ
  const persona = personalityRows?.[0] || {
    'ชื่อพนักงาน': 'แอดมิน',
    'ชื่อเพจ': '',
    'บุคลิก': 'สุภาพ จริงใจ ช่วยเต็มที่',
    'คำเรียกลูกค้า': 'คุณลูกค้า',
    'คำเรียกตัวเองแอดมิน': 'แอดมิน',
    'คำตอบเมื่อไม่รู้': 'เดี๋ยวแอดมินเช็คแล้วรีบแจ้งนะคะ',
    'เพศ': 'หญิง'
  };

  cache.products = products;
  cache.promotions = promotions;
  cache.faq = faq;
  cache.persona = persona;
  cache.payment = payment;
  PRODUCT_ALIAS_INDEX = buildAliasIndex(products);
}

// ----------------------- PROMO ENGINE ---------------------
// Promotions headers you gave:
//  รหัสโปรโมชั่น | รายละเอียดโปรโมชั่น | ประเภทคำนวณ | เงื่อนไข | ใช้กับสินค้า | ใช้กับหมวดหมู่
// ประเภทคำนวณตัวอย่าง: BUY_X_GET_Y, PERCENT, FIXED_DISCOUNT, FREE_SHIPPING
// เงื่อนไขตัวอย่าง: min_qty=5, min_amount=300
function parseConditions(s = '') {
  const out = {};
  splitList(s).forEach(pair => {
    const [k, v] = pair.split('=').map(x => x.trim());
    if (!k) return;
    const num = Number(v);
    out[k] = isNaN(num) ? v : num;
  });
  return out;
}
function promoAppliesToItem(promo, item) {
  const bySku = splitList(promo['ใช้กับสินค้า']).map(x => x.toLowerCase());
  const byCat = splitList(promo['ใช้กับหมวดหมู่']).map(x => x.toLowerCase());
  const sku = (item.sku || '').toLowerCase();
  const cat = (item.category || '').toLowerCase();
  const skuMatch = bySku.length ? bySku.includes(sku) : true;
  const catMatch = byCat.length ? byCat.includes(cat) : true;
  return skuMatch && catMatch;
}

// compute best promotion given cart items (array of {sku, name, category, price, qty})
function computePromotion(cart) {
  if (!cart?.length) return { discount: 0, code: '', detail: '' };
  let best = { discount: 0, code: '', detail: '' };
  for (const promo of cache.promotions) {
    const type = (promo['ประเภทคำนวณ'] || '').toUpperCase();
    const cond = parseConditions(promo['เงื่อนไข'] || '');
    const appliedItems = cart.filter(it => promoAppliesToItem(promo, it));
    if (!appliedItems.length) continue;

    const qty = appliedItems.reduce((s, it) => s + Number(it.qty || 0), 0);
    const amount = appliedItems.reduce((s, it) => s + (Number(it.price || 0) * Number(it.qty || 0)), 0);

    // check basic conditions
    if (cond.min_qty && qty < Number(cond.min_qty)) continue;
    if (cond.min_amount && amount < Number(cond.min_amount)) continue;

    let discount = 0;
    let detail = '';
    if (type === 'BUY_X_GET_Y') {
      // e.g. min_qty=5 get 1 free (cheapest)
      const free = Number(cond.get_free || 1);
      // ฟรีถูกสุด
      const prices = [];
      appliedItems.forEach(it => {
        for (let i=0;i<Number(it.qty || 0);i++) prices.push(Number(it.price||0));
      });
      prices.sort((a,b)=>a-b);
      discount = prices.slice(0, free).reduce((s,v)=>s+v,0);
      detail = `โปรซื้อครบ ${cond.min_qty} แถม ${free}`;
    } else if (type === 'PERCENT') {
      const pct = Number(cond.percent || 0);
      discount = Math.floor(amount * pct / 100);
      detail = `ส่วนลด ${pct}%`;
    } else if (type === 'FIXED_DISCOUNT') {
      discount = Number(cond.amount || 0);
      detail = `ลดทันที ${THB(discount)}`;
    } else if (type === 'FREE_SHIPPING') {
      // ให้ส่วนลดเป็นค่าขนส่งสมมติ 40
      discount = Number(cond.fee || 40);
      detail = `ส่งฟรี (หักค่าขนส่ง ${THB(discount)})`;
    } else {
      continue;
    }

    if (discount > best.discount) {
      best = {
        discount,
        code: promo['รหัสโปรโมชั่น'] || '',
        detail: promo['รายละเอียดโปรโมชั่น'] || detail
      };
    }
  }
  return best;
}

// ----------------------- PAYMENT --------------------------
// Payment headers: category | method | detail
function pickPayment(category = 'all') {
  const rows = cache.payment;
  const cat = (category || '').toLowerCase();

  // priority: exact category -> 'all'
  let row = rows.find(r => (r['category'] || '').toLowerCase() === cat);
  if (!row) row = rows.find(r => (r['category'] || '').toLowerCase() === 'all');
  if (!row) row = rows[0];

  return {
    method: row?.['method'] || 'โอน/พร้อมเพย์/COD',
    detail: row?.['detail'] || ''
  };
}

// ----------------------- FAQ ------------------------------
function matchFAQ(text) {
  const t = (text || '').toLowerCase();
  let best = null, bestScore = 0;

  for (const f of cache.faq) {
    const q = (f['คำถาม'] || '').toLowerCase();
    const keys = splitList(f['คำหลัก'] || '');
    let score = 0;
    if (q && t.includes(q)) score += 2;
    for (const k of keys) if (t.includes(k.toLowerCase())) score += 1;
    if (score > bestScore) { bestScore = score; best = f; }
  }
  if (bestScore >= 1) return best['คำตอบ'];
  return null;
}

// ----------------------- SESSIONS (in-memory + sheet log) -
const sessions = new Map(); // userId -> state

function newSession(userId) {
  const s = {
    userId,
    stage: 'idle',         // idle | picking_variant | picking_qty | confirming | collecting_info
    currentItem: null,     // { sku, name, category, options[], chosenOption, price }
    cart: [],              // { sku, name, category, chosenOption, price, qty }
    address: '',
    phone: '',
    customer: '',
    lastActive: Date.now()
  };
  sessions.set(userId, s);
  return s;
}
function getSession(userId) {
  const s = sessions.get(userId);
  if (!s) return newSession(userId);
  s.lastActive = Date.now();
  return s;
}
async function saveSessionRow(s, note='') {
  try {
    await appendRow(FIXED_SHEETS.sessions, {
      'timestamp': dayjs().format('YYYY-MM-DD HH:mm:ss'),
      'userId': s.userId,
      'stage': s.stage,
      'cart': JSON.stringify(s.cart),
      'note': note
    });
  } catch (e) { /* ignore */ }
}

// ----------------------- PRODUCT HELPERS ------------------
function searchProductsByText(text) {
  const tokens = splitList(text.toLowerCase()).concat([text.toLowerCase()]);
  const matched = new Set();
  for (const tok of tokens) {
    const arr = PRODUCT_ALIAS_INDEX.get(tok);
    if (arr) arr.forEach(p => matched.add(p));
  }
  // fallback fuzzy includes
  const t = text.toLowerCase();
  cache.products.forEach(p => {
    if ((p['ชื่อสินค้า'] || '').toLowerCase().includes(t)) matched.add(p);
    if ((p['รหัสสินค้า'] || '').toLowerCase() === t) matched.add(p);
  });
  return [...matched];
}

function productFromSKU(sku) {
  return cache.products.find(p => (p['รหัสสินค้า'] || '').toLowerCase() === (sku||'').toLowerCase());
}

function extractOptions(p) {
  return splitList(p['ตัวเลือก'] || '');
}

// ----------------------- AI STYLE (OpenAI) ----------------
function buildSystemPrompt() {
  const ps = cache.persona || {};
  const agent = ps['ชื่อพนักงาน'] || 'แอดมิน';
  const page = ps['ชื่อเพจ'] || '';
  const tone = ps['บุคลิก'] || 'สุภาพ จริงใจ ช่วยเต็มที่';
  const callCustomer = ps['คำเรียกลูกค้า'] || 'คุณลูกค้า';
  const callSelf = ps['คำเรียกตัวเองแอดมิน'] || 'แอดมิน';
  const unknown = ps['คำตอบเมื่อไม่รู้'] || 'ขออนุญาตเช็คข้อมูลแล้วรีบแจ้งนะคะ';
  const gender = ps['เพศ'] || 'หญิง';

  return `
คุณคือ “${agent}”${page ? ` จากเพจ ${page}`:''} เพศ${gender}.
บุคลิก: ${tone}.
ภาษาที่ใช้: ไทย น้ำเสียงเป็นมิตร ธรรมชาติ ใส่อิโมจิพองาม
เรียกลูกค้าว่า “${callCustomer}” และเรียกตัวเองว่า “${callSelf}”.

กฎสำคัญ:
- ถ้าลูกค้าถามถึงสินค้า ให้แสดงเฉพาะสินค้าที่เกี่ยวข้อง ไม่ต้องแสดงทั้งหมด
- ถ้าไม่แน่ใจว่าสินค้าไหน ให้ถามกลับ เช่น “สนใจน้ำพริกเห็ด กากหมู หรือโครตกุ้งดีคะ?”
- ใช้ bullet หรืออิโมจิให้อ่านง่าย ไม่เกิน 3 บรรทัดต่อข้อความ
- ค่อย ๆ ถามทีละขั้น เช่น สินค้า → รสชาติ → จำนวน
- ห้ามขึ้นต้นทุกข้อความด้วย “สวัสดีค่ะ” ซ้ำ ๆ
- ถ้าไม่ทราบจริง ให้ตอบว่า: “${unknown}”
- ปิดท้ายด้วยคำสุภาพ + อิโมจิเล็กน้อย
  `.trim();
}

async function aiReply(userText, extraContext='') {
  try {
    const sys = buildSystemPrompt();
    const payload = {
      model: 'gpt-4o-mini',
      temperature: 0.3,
      max_tokens: 300,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: `${extraContext ? `[ข้อมูลเพิ่มเติม]\n${extraContext}\n\n`:''}${userText}` }
      ]
    };
    const res = await openai.chat.completions.create(payload);
    return res.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error('OpenAI error:', e?.message);
    return null;
  }
}

// ----------------------- MESSAGE BUILDERS -----------------
function msgText(text) {
  return { type: 'text', text };
}
function msgImage(url) {
  return { type: 'image', originalContentUrl: url, previewImageUrl: url };
}
async function notifyAdmin(text, extraMsgs=[]) {
  if (!ADMIN_GROUP_ID) return;
  try {
    await lineClient.pushMessage(ADMIN_GROUP_ID, [msgText(text), ...extraMsgs].slice(0,5));
  } catch (e) {
    console.error('notifyAdmin error:', e.message);
  }
}

// ----------------------- ORDER HELPERS --------------------
function calcCartSummary(cart) {
  const sub = cart.reduce((s, it) => s + (Number(it.price||0) * Number(it.qty||0)), 0);
  const promo = computePromotion(cart);
  const total = Math.max(0, sub - (promo.discount||0));
  return { sub, promo, total };
}

function renderCart(cart) {
  if (!cart?.length) return '-';
  return cart.map((it, idx) => `${idx+1}. ${it.name}${it.chosenOption?` (${it.chosenOption})`:''} x ${it.qty} = ${THB(it.price*it.qty)}`).join('\n');
}

async function persistOrder(userId, s, address = '', phone = '', status='รอยืนยัน') {
  const ts = dayjs().format('YYYYMMDDHHmmss');
  const orderNo = `ORD-${ts}-${userId.slice(-4)}`;
  const summary = calcCartSummary(s.cart);
  const promoText = summary.promo.code ? `${summary.promo.code} - ${summary.promo.detail}` : '';

  // บันทึกทีละบรรทัด (หนึ่งบรรทัด/รายการ) ให้หัวตารางของคุณ:
  // เลขที่ออเดอร์ | รหัสสินค้า | ชื่อสินค้า | ตัวเลือก | จำนวน | ราคาจรวม | โปรโมชั่นที่ใช้ | ชื่อ-ที่อยู่ | เบอร์โทร | สถานะ
  for (const it of s.cart) {
    await appendRow(FIXED_SHEETS.orders, {
      'เลขที่ออเดอร์': orderNo,
      'รหัสสินค้า': it.sku,
      'ชื่อสินค้า': it.name,
      'ตัวเลือก': it.chosenOption || '',
      'จำนวน': it.qty,
      'ราคารวม': it.price * it.qty,
      'โปรโมชั่นที่ใช้': promoText,
      'ชื่อ-ที่อยู่': address || s.address || '',
      'เบอร์โทร': phone || s.phone || '',
      'สถานะ': status
    });
  }
  return { orderNo, summary };
}

// ----------------------- FLOW LOGIC -----------------------
async function handleText(userId, replyToken, text) {
  const s = getSession(userId);
  const low = (text||'').trim().toLowerCase();

  // -------- Interrupt: FAQ / greeting -------------
  const faqAns = matchFAQ(text);
  if (faqAns) {
    await lineClient.replyMessage(replyToken, [msgText(faqAns)]);
    // กลับไป flow เดิมถ้ามี
    if (s.stage !== 'idle' && s.currentItem) {
      await lineClient.pushMessage(userId, [msgText(`ต่อจากเมื่อกี้นะคะ 😊 ต้องการ “${s.currentItem.name}” เลือกแบบไหนเอ่ย?${s.currentItem.options?.length?`\nตัวเลือก: ${s.currentItem.options.join(', ')}`:''}`)]);
    }
    return;
  }

  // -------- Detect product intent -----------------
  // 1) ถ้ากำลังรอ "ตัวเลือก/รสชาติ"
if (s.stage === 'picking_variant' && s.currentItem) {
  const choice = splitList(text)[0]?.trim();
  if (s.currentItem.options?.length && choice) {
    const matched = s.currentItem.options.find(op => op.toLowerCase().includes(choice.toLowerCase()));
    if (matched) {
      s.currentItem.chosenOption = matched;
      s.stage = 'picking_qty';
      await saveSessionRow(s, 'picked_option');
      return await lineClient.replyMessage(replyToken, [
        msgText(`ต้องการ “${s.currentItem.name} (${s.currentItem.chosenOption})” จำนวนกี่ชิ้นคะ?`)
      ]);
    }
  }
  // ตอบเป็น list สั้นๆ ชัดเจน
  return await lineClient.replyMessage(replyToken, [
    msgText(`ตัวเลือกของ “${s.currentItem.name}”:\n${s.currentItem.options.map(o=>`- ${o}`).join('\n')}\n\nเลือกได้เลยค่ะ ✨`)
  ]);
}

// 2) ถ้ากำลังรอ "จำนวน"
if (s.stage === 'picking_qty' && s.currentItem) {
  const m = text.match(/\d+/);
  if (m) {
    const qty = Math.max(1, Number(m[0]));
    s.cart.push({
      sku: s.currentItem.sku,
      name: s.currentItem.name,
      category: s.currentItem.category,
      chosenOption: s.currentItem.chosenOption || '',
      price: Number(s.currentItem.price || 0),
      qty
    });
    s.stage = 'confirming';
    s.currentItem = null;
    await saveSessionRow(s, 'qty_added');
    const cartTxt = renderCart(s.cart);
    const sum = calcCartSummary(s.cart);
    return await lineClient.replyMessage(replyToken, [
      msgText(`ตะกร้าปัจจุบัน:\n${cartTxt}\nยอดสุทธิ: ${THB(sum.total)}\n\nพิมพ์ “สรุปออเดอร์” ได้เลยค่ะ หรือเพิ่มสินค้าอื่น`)
    ]);
  }
  return await lineClient.replyMessage(replyToken, [
    msgText(`พิมพ์เป็นตัวเลขจำนวนชิ้น เช่น 2 หรือ 5`)
  ]);
}

  // 3) สถานะยืนยัน/เพิ่มสินค้า/ปิดการขาย
  if (s.stage === 'confirming' || s.stage === 'idle') {
    // ถ้าข้อความมี “สรุป/จบ/ยืนยัน/ปิดการขาย” -> เก็บข้อมูลที่อยู่/โทร/ช่องทางชำระ
    if (/สรุป|จบ|ยืนยัน|ปิด/i.test(text)) {
      if (!s.cart.length) {
        await lineClient.replyMessage(replyToken, [msgText(`ยังไม่มีสินค้าในตะกร้านะคะ 😊 บอกชื่อสินค้าที่ต้องการได้เลยค่ะ`)]); 
        return;
      }
      s.stage = 'collecting_info';
      await saveSessionRow(s, 'start_checkout');
      const cats = [...new Set(s.cart.map(it => it.category || 'all'))];
      const pay = pickPayment(cats[0] || 'all');
      await lineClient.replyMessage(replyToken, [
        msgText(`รับทราบค่ะ 🧾\nกรุณาบอก “ชื่อ-ที่อยู่” และ “เบอร์โทร” สำหรับจัดส่งด้วยนะคะ`),
        msgText(`ช่องทางชำระเงินที่รองรับ: ${pay.method}\n${pay.detail ? `รายละเอียด: ${pay.detail}`: ''}${/พร้อมเพย์|qr/i.test(pay.method+pay.detail) ? '\nถ้าต้องการ QR แจ้งว่า “ขอ QR โอนเงิน” ได้เลยค่ะ 📷' : ''}${/cod|ปลายทาง/i.test(pay.method+pay.detail) ? '\nหากต้องการเก็บเงินปลายทาง พิมพ์ “เก็บปลายทาง” ได้เลยค่ะ 📦' : ''}`)
      ]);
      return;
    }

    // ตรวจว่าลูกค้าพูดถึง “สินค้า” (match จาก alias/ชื่อ/รหัส)
    const found = searchProductsByText(text);
    if (found.length === 1) {
      const p = found[0];
      const options = extractOptions(p);
      s.currentItem = {
        sku: p['รหัสสินค้า'],
        name: p['ชื่อสินค้า'],
        category: p['หมวดหมู่'] || '',
        price: Number(p['ราคา'] || 0),
        options
      };
      s.stage = options.length ? 'picking_variant' : 'picking_qty';
      await saveSessionRow(s, 'product_detected');

      if (options.length) {
        await lineClient.replyMessage(replyToken, [msgText(`ต้องการ “${p['ชื่อสินค้า']}” แบบไหนคะ?\nตัวเลือก: ${options.join(', ')}`)]);
      } else {
        await lineClient.replyMessage(replyToken, [msgText(`ต้องการ “${p['ชื่อสินค้า']}” จำนวนกี่ชิ้นคะ? (เช่น 2, 5)`)]); 
      }
      return;
    } else if (found.length > 1) {
      // ถ้าพูดกว้างไป
      const names = found.slice(0,5).map(x => `• ${x['ชื่อสินค้า']}`).join('\n');
      await lineClient.replyMessage(replyToken, [msgText(`หมายถึงตัวไหนคะ 😊\n${names}\n\nพิมพ์ชื่อให้ชัดขึ้นหน่อยได้ไหมคะ`)]); 
      return;
    }
  }

  // 4) เก็บข้อมูลที่อยู่/โทร/วิธีจ่าย (collecting_info)
  if (s.stage === 'collecting_info') {
    // QR ปลายทาง
    if (/qr|คิวอาร์|พร้อมเพย์/i.test(text)) {
      const cats = [...new Set(s.cart.map(it => it.category || 'all'))];
      const pay = pickPayment(cats[0] || 'all');
      const qrUrl = (pay.detail || '').match(/https?:\/\/\S+/)?.[0];
      if (qrUrl) {
        await lineClient.replyMessage(replyToken, [
          msgText(`ส่ง QR สำหรับโอนเงินให้นะคะ ✅ โอนได้เลย แล้วแจ้งสลิปในแชทนี้ได้เลยค่ะ`),
          msgImage(qrUrl)
        ]);
      } else {
        await lineClient.replyMessage(replyToken, [msgText(`วิธีโอน/พร้อมเพย์: ${pay.detail || '—'}`)]);
      }
      return;
    }

    if (/เก็บปลายทาง|cod/i.test(text)) {
      s.paymentMethod = 'COD';
      await lineClient.replyMessage(replyToken, [msgText(`รับทราบเก็บเงินปลายทางค่ะ 📦 กรุณาส่ง “ชื่อ-ที่อยู่” และ “เบอร์โทร” ด้วยนะคะ`)]); 
      return;
    }

    // จับที่อยู่/ชื่อ/โทร แบบง่ายๆ
    const phone = text.match(/0\d{8,9}/)?.[0] || '';
    if (phone) s.phone = phone;
    if (text.length > 10 && !/qr|ปลายทาง|cod/i.test(text)) {
      s.address = text;
    }

    if (s.address && s.phone) {
      // persist order
      const { orderNo, summary } = await persistOrder(userId, s, s.address, s.phone, 'รอชำระ/จัดส่ง');
      await lineClient.replyMessage(replyToken, [
        msgText(`สรุปออเดอร์ #${orderNo}\n${renderCart(s.cart)}\nโปรฯ: ${summary.promo.code?summary.promo.detail:'—'}\nยอดสุทธิ: ${THB(summary.total)}\n\nจัดส่งไปที่: ${s.address}\nโทร: ${s.phone}\n\nขอบคุณมากค่ะ 🥰`)
      ]);
      // แจ้งแอดมิน
      await notifyAdmin(
        `🛒 ออเดอร์ใหม่ #${orderNo}\n${renderCart(s.cart)}\nยอดสุทธิ: ${THB(summary.total)}\nที่อยู่: ${s.address}\nโทร: ${s.phone}`
      );
      // reset session
      sessions.delete(userId);
      return;
    } else {
      await lineClient.replyMessage(replyToken, [
        msgText(`ขอรับ “ชื่อ-ที่อยู่” และ “เบอร์โทร” เพื่อดำเนินการต่อนะคะ 😊`)
      ]);
      return;
    }
  }

  // 5) Fallback → ให้ AI ตอบเชิงสนทนาตามบุคลิก + ดึงข้อมูลจากชีท (สั้นๆ)
  const extra = `
[สินค้าบางส่วน]
${cache.products.slice(0,10).map(p=>`• ${p['ชื่อสินค้า']} ราคา ${THB(p['ราคา'])}${p['ตัวเลือก']?` (ตัวเลือก: ${extractOptions(p).join(', ')})`:''}`).join('\n')}

[ตัวอย่าง FAQ]
${cache.faq.slice(0,5).map(f=>`• ${f['คำถาม']}: ${f['คำตอบ']}`).join('\n')}
  `.trim();

  const ai = await aiReply(text, extra);
  await lineClient.replyMessage(replyToken, [msgText(ai || 'รับทราบค่ะ 😊')]);
}

// ----------------------- WEB SERVER -----------------------
const app = express();
app.get('/', (req,res)=>res.send('OK'));
app.get('/healthz', (req,res)=>res.send('ok'));

app.post('/webhook',
  lineMiddleware(lineConfig),
  async (req, res) => {
    try {
      // load data (lazy) – โหลดครั้งแรก และรีโหลดทุก 10 นาที
      if (!cache.persona) await loadAllData();
      res.status(200).end();

      const events = req.body.events || [];
      for (const ev of events) {
        if (ev.type === 'message' && ev.message?.type === 'text') {
          const userId = ev.source?.userId || ev.source?.groupId || ev.source?.roomId || 'unknown';
          await appendRow(FIXED_SHEETS.logs, {
            'timestamp': dayjs().format('YYYY-MM-DD HH:mm:ss'),
            'userId': userId,
            'type': 'IN',
            'text': ev.message.text
          });
          await handleText(userId, ev.replyToken, ev.message.text);
        } else if (ev.type === 'follow') {
          const ps = cache.persona || {};
          const hi = `สวัสดีค่ะ 😊 ยินดีต้อนรับสู่ร้านของเรา พิมพ์ชื่อสินค้าที่สนใจได้เลยค่ะ`;
          await lineClient.replyMessage(ev.replyToken, [msgText(hi)]);
        }
      }
    } catch (err) {
      console.error('Webhook Error:', err);
      try {
        await appendRow(FIXED_SHEETS.logs, {
          'timestamp': dayjs().format('YYYY-MM-DD HH:mm:ss'),
          'userId': 'system',
          'type': 'ERR',
          'text': err?.message || String(err)
        });
      } catch(e) {/* ignore */}
      // do not reply error to LINE here
    }
  }
);

// scheduled light reload (optional ping/refresh every 10 min)
setInterval(async()=>{
  try { await loadAllData(); } catch(e){ /* ignore */ }
}, 10*60*1000);

// ----------------------- START ----------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  try {
    await loadAllData();
    console.log(`🚀 Server running on port ${PORT}`);
  } catch (e) {
    console.error('❌ Google Sheet Error:', e.message);
  }
});
