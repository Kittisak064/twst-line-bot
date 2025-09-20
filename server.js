// ==========================================================
//  LINE x Google Sheets x OpenAI - Thai Pro Commerce Bot
//  Author: (your team)
//  Version: 1.0 (full features)
//
//  ✅ Features
//   - อ่าน/เขียน Google Sheets ตามหัวตาราง "ภาษาไทย" ที่คุณใช้อยู่
//     * Products:  รหัสสินค้า | ชื่อสินค้า | หมวดหมู่ | ราคา | คำที่ลูกค้าเรียก | ตัวเลือก | (หมายเหตุ ไม่บังคับ)
//     * Promotions: รหัสโปรโมชั่น | รายละเอียดโปรโมชั่น | ประเภทคำนวณ | เงื่อนไข | ใช้กับสินค้า | ใช้กับหมวดหมู่
//     * FAQ: คำถาม | คำตอบ | คำหลัก
//     * personality: ชื่อพนักงาน | ชื่อเพจ | บุคลิก | คำเรียกลูกค้า | คำเรียกตัวเองแอดมิน | คำตอบเมื่อไม่รู้ | เพศ
//     * Orders: เลขที่ออเดอร์ | รหัสสินค้า | ชื่อสินค้า | ตัวเลือก | จำนวน | ราคารวม | โปรโมชั่นที่ใช้ | ชื่อ-ที่อยู่ | เบอร์โทร | สถานะ
//     * Payment: category | method | detail | qrcode(ไม่บังคับ)
//     * Sessions: (auto prepare header ถ้ายังว่าง) timestamp | userId | stage | cart | note
//     * Logs:     (auto prepare header ถ้ายังว่าง) timestamp | userId | type | text
//
//   - ตะกร้าหลายสินค้า (multi-item cart)
//   - เลือก "รสชาติ" เมื่อหมวดหมู่ = food / เลือก "รุ่น" เมื่อหมวดอื่น เช่น machine
//   - Interrupt ได้ (ทักถามอย่างอื่นกลางคัน แล้วกลับไปต่อ flow สั่งซื้อเดิม)
//   - โปรโมชัน: PERCENT, FIXED_DISCOUNT, BUY_X_GET_Y, FREE_SHIPPING
//   - ชำระเงิน: โอน/พร้อมเพย์/COD และส่ง QR อัตโนมัติถ้ามีคอลัมน์ qrcode
//   - แจ้งเตือนแอดมินด้วย Group ID (ถ้าตั้งค่า)
//   - รีเฟรช cache ทุก 10 นาที
//
//  ⚙️ ENV ต้องมี
//   GOOGLE_CLIENT_EMAIL
//   GOOGLE_PRIVATE_KEY   (มี \n ให้แทนด้วย newline อัตโนมัติ)
//   GOOGLE_SHEET_ID
//   LINE_CHANNEL_ACCESS_TOKEN
//   LINE_CHANNEL_SECRET
//   OPENAI_API_KEY
//   ADMIN_GROUP_ID (ไม่บังคับ)
//
//  📦 package.json (แนะนำ)
//   "dependencies": {
//     "@line/bot-sdk": "^7.5.2",
//     "express": "^4.19.2",
//     "google-spreadsheet": "3.3.0",
//     "google-auth-library": "^9.14.2",
//     "openai": "^4.52.0",
//     "dayjs": "^1.11.13",
//     "p-limit": "^5.0.0"
//   }
//
//  หมายเหตุ:
//   - โค้ดนี้คุม Flow ให้จบการขายได้เสมอ และตอบเป็นธรรมชาติ (ใช้ OpenAI แต่ล็อกเงื่อนไขที่จำเป็น)
//   - ไม่แก้หัวตารางของคุณ (เฉพาะ Sessions/Logs ถ้าไม่มี header จะสร้างให้อัตโนมัติ)
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
  ADMIN_GROUP_ID
} = process.env;

if (!GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY || !GOOGLE_SHEET_ID) {
  console.warn('⚠️ Google env is missing. Please set GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY / GOOGLE_SHEET_ID');
}
if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET) {
  console.warn('⚠️ LINE env is missing. Please set LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET');
}
if (!OPENAI_API_KEY) {
  console.warn('⚠️ OPENAI_API_KEY is missing.');
}

// ----------------------- CONSTANTS ------------------------
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

async function ensureHeader(name, headers) {
  const sheet = doc.sheetsByTitle[name];
  if (!sheet) return;
  await sheet.loadHeaderRow();
  const have = (sheet.headerValues || []).filter(Boolean);
  if (!have || have.length === 0) {
    await sheet.setHeaderRow(headers);
  }
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

async function appendRow(name, record) {
  const sheet = doc.sheetsByTitle[name];
  if (!sheet) throw new Error(`Sheet not found: ${name}`);
  await sheet.loadHeaderRow();
  await sheet.addRow(record);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function THB(n) {
  const v = Number(n || 0);
  return v.toLocaleString('th-TH', { style: 'currency', currency: 'THB', maximumFractionDigits: 0 });
}

// ----------------------- CACHE ----------------------------
const cache = {
  products: [],
  promotions: [],
  faq: [],
  persona: null,
  payment: []
};

//  utilities
function normalizeThaiCommaText(s = '') {
  return s.replace(/\s+/g, ' ').trim();
}
function splitList(s = '') {
  return normalizeThaiCommaText(s).split(/,|，|\/|\|/).map(x => x.trim()).filter(Boolean);
}

function buildAliasIndex(products) {
  const idx = new Map();
  for (const p of products) {
    const aliases = splitList(p['คำที่ลูกค้าเรียก'] || p['คําที่ลูกค้าเรียก'] || '');
    // รวมชื่อจริงและรหัสด้วย
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

  // เตรียม header ให้ Sessions/Logs ถ้ายังไม่ตั้ง (ไม่ไปยุ่งชีทอื่น)
  await ensureHeader(FIXED_SHEETS.sessions, ['timestamp', 'userId', 'stage', 'cart', 'note']);
  await ensureHeader(FIXED_SHEETS.logs, ['timestamp', 'userId', 'type', 'text']);

  const limit = pLimit(4);
  const [products, promotions, faq, personalityRows, payment] = await Promise.all([
    limit(() => readSheet(FIXED_SHEETS.products)),
    limit(() => readSheet(FIXED_SHEETS.promotions)),
    limit(() => readSheet(FIXED_SHEETS.faq)),
    limit(() => readSheet(FIXED_SHEETS.personality)),
    limit(() => readSheet(FIXED_SHEETS.payment))
  ]);

  // บุคลิก เอาแถวแรกพอ
  const persona = personalityRows?.[0] || {
    'ชื่อพนักงาน': 'แอดมิน',
    'ชื่อเพจ': '',
    'บุคลิก': 'สุภาพ จริงใจ ช่วยเต็มที่',
    'คำเรียกลูกค้า': 'คุณลูกค้า',
    'คำเรียกตัวเองแอดมิน': 'แอดมิน',
    'คำตอบเมื่อไม่รู้': 'ขออนุญาตเช็คข้อมูลแล้วรีบแจ้งนะคะ',
    'เพศ': 'หญิง'
  };

  cache.products = products;
  cache.promotions = promotions;
  cache.faq = faq;
  cache.persona = persona;
  cache.payment = payment;
  PRODUCT_ALIAS_INDEX = buildAliasIndex(products);
}

// ----------------------- PROMOTIONS -----------------------
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

    if (cond.min_qty && qty < Number(cond.min_qty)) continue;
    if (cond.min_amount && amount < Number(cond.min_amount)) continue;

    let discount = 0;
    let detail = '';

    if (type === 'BUY_X_GET_Y') {
      const free = Number(cond.get_free || 1);
      const prices = [];
      appliedItems.forEach(it => {
        for (let i = 0; i < Number(it.qty || 0); i++) prices.push(Number(it.price || 0));
      });
      prices.sort((a, b) => a - b);
      discount = prices.slice(0, free).reduce((s, v) => s + v, 0);
      detail = `โปรซื้อครบ ${cond.min_qty} แถม ${free}`;
    } else if (type === 'PERCENT') {
      const pct = Number(cond.percent || 0);
      discount = Math.floor(amount * pct / 100);
      detail = `ส่วนลด ${pct}%`;
    } else if (type === 'FIXED_DISCOUNT') {
      discount = Number(cond.amount || 0);
      detail = `ลดทันที ${THB(discount)}`;
    } else if (type === 'FREE_SHIPPING') {
      const fee = Number(cond.fee || 40);
      discount = fee;
      detail = `ส่งฟรี (หักค่าขนส่ง ${THB(fee)})`;
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
function pickPayment(category = 'all') {
  const rows = cache.payment || [];
  const cat = (category || '').toLowerCase();

  let row = rows.find(r => (r['category'] || '').toLowerCase() === cat);
  if (!row) row = rows.find(r => (r['category'] || '').toLowerCase() === 'all');
  if (!row) row = rows[0];

  return {
    method: row?.['method'] || 'โอน/พร้อมเพย์/COD',
    detail: row?.['detail'] || '',
    qrcode: row?.['qrcode'] || ''
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

// ----------------------- SESSIONS -------------------------
const sessions = new Map();

function newSession(userId) {
  const s = {
    userId,
    stage: 'idle',                 // idle | picking_variant | picking_qty | confirming | collecting_info
    currentItem: null,             // { sku, name, category, price, options[], chosenOption }
    cart: [],                      // [{ sku, name, category, price, chosenOption, qty }, ...]
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

async function saveSessionRow(s, note = '') {
  try {
    await appendRow(FIXED_SHEETS.sessions, {
      'timestamp': dayjs().format('YYYY-MM-DD HH:mm:ss'),
      'userId': s.userId,
      'stage': s.stage,
      'cart': JSON.stringify(s.cart),
      'note': note
    });
  } catch (_) {}
}

// ----------------------- PRODUCTS -------------------------
function searchProductsByText(text) {
  const tokens = splitList(text.toLowerCase()).concat([text.toLowerCase()]);
  const matched = new Set();
  for (const tok of tokens) {
    const arr = PRODUCT_ALIAS_INDEX.get(tok);
    if (arr) arr.forEach(p => matched.add(p));
  }
  // fallback
  const t = text.toLowerCase();
  cache.products.forEach(p => {
    if ((p['ชื่อสินค้า'] || '').toLowerCase().includes(t)) matched.add(p);
    if ((p['รหัสสินค้า'] || '').toLowerCase() === t) matched.add(p);
  });
  return [...matched];
}

function extractOptions(p) {
  return splitList(p['ตัวเลือก'] || '');
}

function optionWordByCategory(cat = '') {
  const c = (cat || '').toLowerCase();
  if (c === 'food') return 'รสชาติ';
  return 'รุ่น';
}

// ----------------------- AI PROMPT ------------------------
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
คุณคือ “${agent}”${page ? ` จากเพจ ${page}` : ''} เพศ${gender}
บุคลิก: ${tone}
เรียกลูกค้าว่า “${callCustomer}” และเรียกตัวเองว่า “${callSelf}”
พูดไทยแบบเป็นกันเอง ใส่อิโมจิพอดี ไม่ยาวเกินไป

กฎ:
- ถ้าลูกค้าสนใจสินค้า ให้ถามให้ครบ: ชื่อสินค้า → ${'รสชาติ/รุ่น'} (ขึ้นกับหมวดหมู่สินค้า) → จำนวน
- ถ้าลูกค้าถามอย่างอื่นกลางคัน ให้ตอบ แล้วพากลับไปขั้นตอนค้างไว้
- ห้ามเปิดเผยรหัสสินค้า
- ถ้าไม่ทราบจริง ให้ตอบ: “${unknown}”
`.trim();
}

async function aiReply(userText, extraContext = '') {
  try {
    const sys = buildSystemPrompt();
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      max_tokens: 350,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: `${extraContext ? `[ข้อมูล]\n${extraContext}\n\n` : ''}${userText}` }
      ]
    });
    return res.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error('OpenAI error:', e?.message);
    return null;
  }
}

// ----------------------- LINE HELPERS ---------------------
function msgText(text) { return { type: 'text', text }; }
function msgImage(url) { return { type: 'image', originalContentUrl: url, previewImageUrl: url }; }

async function notifyAdmin(text, extraMsgs = []) {
  if (!ADMIN_GROUP_ID) return;
  try {
    await lineClient.pushMessage(ADMIN_GROUP_ID, [msgText(text), ...extraMsgs].slice(0, 5));
  } catch (e) {
    console.error('notifyAdmin error:', e.message);
  }
}

// ----------------------- ORDER HELPERS --------------------
function calcCartSummary(cart) {
  const sub = cart.reduce((s, it) => s + (Number(it.price || 0) * Number(it.qty || 0)), 0);
  const promo = computePromotion(cart);
  const total = Math.max(0, sub - (promo.discount || 0));
  return { sub, promo, total };
}

function renderCart(cart) {
  if (!cart?.length) return '-';
  return cart.map((it, idx) =>
    `${idx + 1}. ${it.name}${it.chosenOption ? ` (${it.chosenOption})` : ''} x ${it.qty} = ${THB(it.price * it.qty)}`
  ).join('\n');
}

async function persistOrder(userId, s, address = '', phone = '', status = 'รอยืนยัน') {
  const ts = dayjs().format('YYYYMMDDHHmmss');
  const orderNo = `ORD-${ts}-${(userId || '').slice(-4)}`;
  const summary = calcCartSummary(s.cart);
  const promoText = summary.promo.code ? `${summary.promo.code} - ${summary.promo.detail}` : '';

  for (const it of s.cart) {
    await appendRow(FIXED_SHEETS.orders, {
      'เลขที่ออเดอร์': orderNo,
      'รหัสสินค้า': it.sku || '',
      'ชื่อสินค้า': it.name || '',
      'ตัวเลือก': it.chosenOption || '',
      'จำนวน': it.qty || 1,
      'ราคารวม': (Number(it.price || 0) * Number(it.qty || 0)) || 0,
      'โปรโมชั่นที่ใช้': promoText,
      'ชื่อ-ที่อยู่': address || s.address || '',
      'เบอร์โทร': phone || s.phone || '',
      'สถานะ': status
    });
  }
  return { orderNo, summary };
}

// ----------------------- MAIN FLOW ------------------------
async function handleText(userId, replyToken, textRaw) {
  const text = (textRaw || '').trim();
  const low = text.toLowerCase();
  const s = getSession(userId);

  // 0) FAQ interrupt
  const faq = matchFAQ(text);
  if (faq) {
    await lineClient.replyMessage(replyToken, [msgText(faq)]);
    if (s.stage !== 'idle' && s.currentItem) {
      const ow = optionWordByCategory(s.currentItem.category);
      await lineClient.pushMessage(userId, [
        msgText(`ต่อจากเมื่อกี้นะคะ 😊 ต้องการ “${s.currentItem.name}” เลือก${ow}ไหนคะ${s.currentItem.options?.length ? ` (ตัวเลือก: ${s.currentItem.options.join(', ')})` : ''}`)
      ]);
    }
    return;
  }

  // 1) ถ้ากำลังรอ "ตัวเลือก" ตามหมวด
  if (s.stage === 'picking_variant' && s.currentItem) {
    const choice = splitList(text)[0] || '';
    const options = s.currentItem.options || [];
    const ow = optionWordByCategory(s.currentItem.category);

    if (!options.length) {
      // ไม่มีตัวเลือก → ข้ามไปถามจำนวน
      s.stage = 'picking_qty';
      await saveSessionRow(s, 'no_options_skip_to_qty');
      await lineClient.replyMessage(replyToken, [msgText(`ต้องการ “${s.currentItem.name}” จำนวนกี่ชิ้นคะ? (เช่น 2, 5)`)]); 
      return;
    }

    const matched = options.find(op => op.toLowerCase().includes(choice.toLowerCase()));
    if (matched) {
      s.currentItem.chosenOption = matched;
      s.stage = 'picking_qty';
      await saveSessionRow(s, 'picked_option');
      await lineClient.replyMessage(replyToken, [msgText(`รับทราบค่ะ ต้องการ “${s.currentItem.name} (${matched})” จำนวนกี่ชิ้นคะ? (เช่น 2, 5)`)]); 
      return;
    }
    // ไม่ตรง → แสดงรายการสั้นๆ
    await lineClient.replyMessage(replyToken, [msgText(`เลือก${ow}ได้เลยค่ะ:\n- ${options.join('\n- ')}`)]);
    return;
  }

  // 2) ถ้ากำลังรอ "จำนวน"
  if (s.stage === 'picking_qty' && s.currentItem) {
    const m = text.match(/\d+/);
    if (!m) {
      await lineClient.replyMessage(replyToken, [msgText(`พิมพ์เป็นตัวเลขจำนวนชิ้นนะคะ เช่น 2 หรือ 5`)]); 
      return;
    }
    const qty = Math.max(1, Number(m[0]));
    s.cart.push({
      sku: s.currentItem.sku,
      name: s.currentItem.name,
      category: s.currentItem.category,
      chosenOption: s.currentItem.chosenOption || '',
      price: Number(s.currentItem.price || 0),
      qty
    });
    const cartTxt = renderCart(s.cart);
    const sum = calcCartSummary(s.cart);
    s.stage = 'confirming';
    s.currentItem = null;
    await saveSessionRow(s, 'qty_added');
    await lineClient.replyMessage(replyToken, [
      msgText(`เพิ่มลงตะกร้าแล้ว 🧺\n${cartTxt}\n\nยอดสุทธิชั่วคราว: ${THB(sum.total)}${sum.promo.code ? `\nโปรฯ: ${sum.promo.detail}` : ''}\n\nต้องการเพิ่มสินค้าอีกไหมคะ หรือพิมพ์ “สรุปออเดอร์” ได้เลยค่ะ ✨`)
    ]);
    return;
  }

  // 3) โหมดยืนยัน / วนขายต่อ
  if (s.stage === 'confirming' || s.stage === 'idle') {
    // จบการขาย
    if (/สรุป|ยืนยัน|ปิดการขาย|จบ/i.test(text)) {
      if (!s.cart.length) {
        await lineClient.replyMessage(replyToken, [msgText(`ยังไม่มีสินค้าในตะกร้าค่ะ 😊 บอกชื่อสินค้าที่ต้องการได้เลย`)]);
        return;
      }
      s.stage = 'collecting_info';
      await saveSessionRow(s, 'start_checkout');

      // เลือกช่องทางจ่ายหลักจากหมวดแรกในตะกร้า
      const cats = [...new Set(s.cart.map(it => it.category || 'all'))];
      const pay = pickPayment(cats[0] || 'all');
      const payLine1 = `ช่องทางชำระ: ${pay.method}`;
      const payLine2 = pay.detail ? `รายละเอียด: ${pay.detail}` : '';
      const qrHint  = pay.qrcode ? `มี QR พร้อมเพย์ให้สแกนได้เลย 📷` : '';
      const codHint = /cod|ปลายทาง/i.test(pay.method + pay.detail) ? `หากต้องการเก็บเงินปลายทาง พิมพ์ “เก็บปลายทาง” ได้เลย 📦` : '';

      await lineClient.replyMessage(replyToken, [
        msgText(`รับทราบค่ะ 🧾 กรุณาส่ง “ชื่อ-ที่อยู่” และ “เบอร์โทร” สำหรับจัดส่งด้วยนะคะ`),
        msgText([payLine1, payLine2, qrHint, codHint].filter(Boolean).join('\n'))
      ]);
      return;
    }

    // ตรวจว่าข้อความนี้คือการ "เพิ่มสินค้าใหม่"
    const found = searchProductsByText(text);
    if (found.length === 1) {
      const p = found[0];
      const options = extractOptions(p);
      const ow = optionWordByCategory(p['หมวดหมู่'] || '');
      const item = {
        sku: p['รหัสสินค้า'],
        name: p['ชื่อสินค้า'],
        category: p['หมวดหมู่'] || '',
        price: Number(p['ราคา'] || 0),
        options
      };
      s.currentItem = item;

      s.stage = options.length ? 'picking_variant' : 'picking_qty';
      await saveSessionRow(s, 'product_detected');

      if (options.length) {
        await lineClient.replyMessage(replyToken, [
          msgText(`${p['ชื่อสินค้า']} มี${ow}ให้เลือกค่ะ:\n- ${options.join('\n- ')}\n\nต้องการ${ow}ไหนเอ่ย?`)
        ]);
      } else {
        await lineClient.replyMessage(replyToken, [
          msgText(`ต้องการ “${p['ชื่อสินค้า']}” จำนวนกี่ชิ้นคะ? (เช่น 2, 5)`)
        ]);
      }
      return;
    } else if (found.length > 1) {
      const names = found.slice(0, 8).map(x => `• ${x['ชื่อสินค้า']}`).join('\n');
      await lineClient.replyMessage(replyToken, [msgText(`หมายถึงตัวไหนคะ 😊\n${names}\n\nพิมพ์ชื่อให้ชัดขึ้นนิดนึงได้ไหมคะ`)]); 
      return;
    }
  }

  // 4) เก็บข้อมูลที่อยู่/โทร/วิธีจ่าย
  if (s.stage === 'collecting_info') {
    // QR
    if (/qr|คิวอาร์|พร้อมเพย์/i.test(text)) {
      const cats = [...new Set(s.cart.map(it => it.category || 'all'))];
      const pay = pickPayment(cats[0] || 'all');
      if (pay.qrcode) {
        await lineClient.replyMessage(replyToken, [
          msgText(`ส่ง QR ให้แล้วค่ะ โอนได้เลย แล้วแนบสลิปในแชทนี้ได้เลยนะคะ 🙏`),
          msgImage(pay.qrcode)
        ]);
      } else {
        await lineClient.replyMessage(replyToken, [msgText(`ตอนนี้ยังไม่ได้แนบ QR ในชีท Payment ค่ะ (คอลัมน์ qrcode)`)]); 
      }
      return;
    }
    // COD
    if (/เก็บปลายทาง|cod/i.test(text)) {
      s.paymentMethod = 'COD';
      await lineClient.replyMessage(replyToken, [msgText(`รับทราบค่ะ เก็บเงินปลายทางได้ค่ะ 📦 รบกวนส่ง “ชื่อ-ที่อยู่” และ “เบอร์โทร” ด้วยนะคะ`)]); 
      return;
    }

    // ดึงเบอร์ & ที่อยู่แบบง่าย
    const phone = text.match(/0\d{8,9}/)?.[0] || '';
    if (phone) s.phone = phone;
    if (text.length > 10 && !/qr|ปลายทาง|cod/i.test(text)) {
      s.address = text;
    }

    if (s.address && s.phone) {
      const { orderNo, summary } = await persistOrder(userId, s, s.address, s.phone, 'รอชำระ/จัดส่ง');
      const cartTxt = renderCart(s.cart);

      await lineClient.replyMessage(replyToken, [
        msgText(`สรุปออเดอร์ #${orderNo}\n${cartTxt}\nโปรฯ: ${summary.promo.code ? summary.promo.detail : '—'}\nยอดสุทธิ: ${THB(summary.total)}\n\nจัดส่งไปที่: ${s.address}\nโทร: ${s.phone}\n\nขอบคุณมากค่ะ 🥰`)
      ]);

      await notifyAdmin(`🛒 ออเดอร์ใหม่ #${orderNo}\n${cartTxt}\nยอดสุทธิ: ${THB(summary.total)}\nที่อยู่: ${s.address}\nโทร: ${s.phone}`);

      sessions.delete(userId);
      return;
    } else {
      await lineClient.replyMessage(replyToken, [msgText(`รบกวนส่ง “ชื่อ-ที่อยู่” และ “เบอร์โทร” เพิ่มเติมด้วยนะคะ 😊`)]); 
      return;
    }
  }

  // 5) Fallback → AI ช่วยตอบ แต่ปิดท้ายด้วยการดันกลับสู่การขาย
  const topProducts = cache.products.slice(0, 6).map(p => {
    const ow = optionWordByCategory(p['หมวดหมู่'] || '');
    const opts = extractOptions(p);
    return `• ${p['ชื่อสินค้า']} ราคา ${THB(p['ราคา'])}${opts.length ? ` (${ow}: ${opts.join(', ')})` : ''}`;
  }).join('\n');

  const extra = `[สินค้าแนะนำ]\n${topProducts}`;
  const ai = await aiReply(text, extra);

  if (ai) {
    // ถ้ามีสินค้าที่ detect ได้ในข้อความ Fallback → ใส่ CTA ถามต่อ
    const found = searchProductsByText(text);
    if (found.length === 1) {
      const p = found[0];
      const opts = extractOptions(p);
      const ow = optionWordByCategory(p['หมวดหมู่'] || '');
      const tail = opts.length ? `\n\nสนใจ “${p['ชื่อสินค้า']}” ${ow}ไหนคะ?` : `\n\nสนใจ “${p['ชื่อสินค้า']}” กี่ชิ้นคะ?`;
      await lineClient.replyMessage(replyToken, [msgText(ai + tail)]);
      return;
    }
  }

  await lineClient.replyMessage(replyToken, [msgText(ai || 'รับทราบค่ะ 😊 สนใจสินค้าอะไรเพิ่มเติมบอกแอดมินได้เลยนะคะ')]);
}

// ----------------------- WEB SERVER -----------------------
const app = express();
app.get('/', (req, res) => res.send('OK'));
app.get('/healthz', (req, res) => res.send('ok'));

app.post('/webhook',
  lineMiddleware(lineConfig),
  async (req, res) => {
    try {
      if (!cache.persona) await loadAllData();
      res.status(200).end();

      const events = req.body.events || [];
      for (const ev of events) {
        if (ev.type === 'message' && ev.message?.type === 'text') {
          const uid = ev.source?.userId || ev.source?.groupId || ev.source?.roomId || 'unknown';
          try {
            await appendRow(FIXED_SHEETS.logs, {
              'timestamp': dayjs().format('YYYY-MM-DD HH:mm:ss'),
              'userId': uid,
              'type': 'IN',
              'text': ev.message.text
            });
          } catch (_) {}
          await handleText(uid, ev.replyToken, ev.message.text);
        } else if (ev.type === 'follow') {
          const hi = `สวัสดีค่ะ 😊 ยินดีต้อนรับ ร้านของเรามีหลายรายการให้เลือกนะคะ พิมพ์ชื่อสินค้าที่สนใจได้เลยค่ะ`;
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
      } catch (_) {}
    }
  }
);

// รีโหลด cache ทุก 10 นาที
setInterval(async () => {
  try { await loadAllData(); } catch (_) {}
}, 10 * 60 * 1000);

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
