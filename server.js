// ==========================================================
//  LINE x Google Sheets x OpenAI - Thai Pro Commerce Bot
//  FULL VERSION (multi-product, promo engine, FAQ interrupt,
//  payment with QR/COD, admin notify, robust error handling).
//  Sheets headers = ภาษาไทย (ตามที่คุณฟิกไว้) + อังกฤษ Payment.
//
//  IMPORTANT:
//   - google-spreadsheet v3.3.0 (supports useServiceAccountAuth)
//   - Do NOT use Base64 private key; set GOOGLE_PRIVATE_KEY with \n
//   - Headers MUST be the first row of each sheet
//
//  SHEETS (REQUIRED):
//   Products:   รหัสสินค้า | ชื่อสินค้า | หมวดหมู่ | ราคา | คำที่ลูกค้าเรียก | ตัวเลือก
//   Promotions: รหัสโปรโมชั่น | รายละเอียดโปรโมชั่น | ประเภทคำนวณ | เงื่อนไข | ใช้กับสินค้า | ใช้กับหมวดหมู่
//   FAQ:        คำถาม | คำหลัก | คำตอบ
//   personality:ชื่อพนักงาน | ชื่อเพจ | บุคลิก | คำเรียกลูกค้า | คำเรียกตัวเองแอดมิน | คำตอบเมื่อไม่รู้ | เพศ
//   Payment:    category | method | detail
//   Orders:     เลขที่ออเดอร์ | รหัสสินค้า | ชื่อสินค้า | ตัวเลือก | จำนวน | ราคารวม | โปรโมชั่นที่ใช้ | ชื่อ-ที่อยู่ | เบอร์โทร | สถานะ
//   Sessions:   timestamp | userId | stage | cart | note
//   Logs:       timestamp | userId | type | text
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

// Validate ENV (fail fast but don't crash webhook)
function requireEnv(name) {
  if (!process.env[name]) {
    console.warn(`[ENV WARN] Missing ${name}`);
  }
}
['GOOGLE_CLIENT_EMAIL','GOOGLE_PRIVATE_KEY','GOOGLE_SHEET_ID','LINE_CHANNEL_ACCESS_TOKEN','LINE_CHANNEL_SECRET','OPENAI_API_KEY']
  .forEach(requireEnv);

// Fixed sheet names (must match your tabs)
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

// utility: read as array of objects by header row (row 1)
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

// append row to target sheet; keys must match headers
async function appendRow(name, record) {
  const sheet = doc.sheetsByTitle[name];
  if (!sheet) throw new Error(`Sheet not found: ${name}`);
  await sheet.loadHeaderRow(); // ensure header exists
  await sheet.addRow(record);
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

// helpers for splitting alias/options (Thai-friendly)
function normalizeThaiCommaText(s = '') {
  return s.replace(/\s+/g, ' ').trim();
}
function splitList(s = '') {
  return normalizeThaiCommaText(s)
    .split(/,|，|\/|\||\n/).map(x => x.trim()).filter(Boolean);
}
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

// ----------------------- PROMO ENGINE ---------------------
// Promotions headers you gave:
//  รหัสโปรโมชั่น | รายละเอียดโปรโมชั่น | ประเภทคำนวณ | เงื่อนไข | ใช้กับสินค้า | ใช้กับหมวดหมู่
// Types: BUY_X_GET_Y, PERCENT, FIXED_DISCOUNT, FREE_SHIPPING
// Examples: เงื่อนไข => "min_qty=5,get_free=1" | "percent=10" | "amount=50" | "fee=40"
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
      appliedItems.forEach(it => { for (let i=0;i<Number(it.qty||0);i++) prices.push(Number(it.price||0)); });
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
function pickPayment(category = 'all') {
  const rows = cache.payment || [];
  const cat = (category || '').toLowerCase();
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

// ----------------------- SESSIONS -------------------------
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
  const results = new Set();
  const t = (text||'').toLowerCase();

  // alias index exact-ish
  const parts = splitList(text.toLowerCase()).concat([t]);
  for (const tok of parts) {
    const arr = PRODUCT_ALIAS_INDEX.get(tok);
    if (arr) arr.forEach(p => results.add(p));
  }

  // fuzzy includes (ชื่อสินค้า)
  cache.products.forEach(p => {
    const name = (p['ชื่อสินค้า'] || '').toLowerCase();
    if (name && t && name.includes(t)) results.add(p);
  });

  return [...results];
}
function productFromSKU(sku) {
  return cache.products.find(p => (p['รหัสสินค้า'] || '').toLowerCase() === (sku||'').toLowerCase());
}
function extractOptions(p) {
  return splitList(p['ตัวเลือก'] || '');
}

// ----------------------- AI STYLE -------------------------
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
ภาษา: ไทย ธรรมชาติ เป็นกันเอง ใส่อิโมจิพองาม (1-2 อันต่อข้อความ)

บทบาท:
- เป็นพนักงานหน้าร้านตัวจริง ตอบทุกคำถาม ไม่เงียบ
- ถ้าลูกค้าเอ่ยถึงสินค้า ให้ช่วยระบุ “รสชาติ/ตัวเลือก” (สำหรับน้ำพริก) หรือ “รุ่น/คุณสมบัติ” (สำหรับรถเข็น) ให้ครบก่อน แล้วค่อยถาม “จำนวน”
- ถ้าลูกค้าวกไปถามเรื่องอื่นระหว่างสั่งซื้อ ให้ตอบสั้นๆ แล้วพากลับเข้ากระบวนการสั่งซื้อเดิม
- ห้ามส่ง “รหัสสินค้า” ให้ลูกค้า
- ถ้าไม่ทราบจริง ให้ตอบว่า: “${unknown}”

รูปแบบ:
- ถ้าลูกค้าถามกว้าง เช่น “มีน้ำพริกอะไรบ้าง” ให้สรุปรายการย่อแบบ bullet สั้นๆ 5-6 รายการ ไม่ยาว
- ถ้าลูกค้าถามราคา แต่ไม่ได้ระบุสินค้า ให้ถามย้อนแบบสุภาพว่า “หมายถึงตัวไหน” แล้วแนะนำตัวเลือก 3-5 ตัวอย่าง
- ปิดท้ายสุภาพและชวนคุยต่อเสมอ
`.trim();
}

async function aiReply(userText, extraContext='') {
  try {
    const sys = buildSystemPrompt();
    const payload = {
      model: 'gpt-4o-mini',
      temperature: 0.3,
      max_tokens: 340,
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

// ----------------------- LINE MESSAGE BUILDERS ------------
function msgText(text) {
  return { type: 'text', text: (text||'').slice(0, 5000) };
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
  const orderNo = `ORD-${ts}-${(userId||'xxxx').slice(-4)}`;
  const summary = calcCartSummary(s.cart);
  const promoText = summary.promo.code ? `${summary.promo.code} - ${summary.promo.detail}` : '';

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

// ----------------------- CORE HANDLER ---------------------
async function handleText(userId, replyToken, text) {
  const s = getSession(userId);
  const low = (text||'').trim().toLowerCase();

  // 0) quick small talk → respond short then keep flow
  if (/^สวัสดี|ดีจ้า|hello|hi\b/i.test(text)) {
    await lineClient.replyMessage(replyToken, [msgText(`สวัสดีค่ะ 😊 สนใจดูสินค้าตัวไหนบ้างคะ บอกชื่อได้เลยค่ะ`)]);
    return;
  }

  // 1) FAQ interrupt
  const faqAns = matchFAQ(text);
  if (faqAns) {
    await lineClient.replyMessage(replyToken, [msgText(faqAns)]);
    if (s.stage !== 'idle' && s.currentItem) {
      await lineClient.pushMessage(userId, [msgText(`ต่อจากเมื่อกี้นะคะ 😊 ต้องการ “${s.currentItem.name}” เลือกแบบไหนเอ่ย?${s.currentItem.options?.length?`\nตัวเลือก: ${s.currentItem.options.join(', ')}`:''}`)]);
    }
    return;
  }

  // 2) If waiting for option/flavor (น้ำพริกเรียก "รสชาติ")
  if (s.stage === 'picking_variant' && s.currentItem) {
    const choice = splitList(text)[0]?.trim();
    if (s.currentItem.options?.length && choice) {
      const matched = s.currentItem.options.find(op => op.toLowerCase().includes(choice.toLowerCase()));
      if (matched || s.currentItem.options.length === 0) {
        s.currentItem.chosenOption = matched || choice;
        s.stage = 'picking_qty';
        await saveSessionRow(s, 'picked_option');
        const noun = (s.currentItem.category||'').includes('รถเข็น') ? 'รุ่น' : 'รสชาติ';
        await lineClient.replyMessage(replyToken, [msgText(`รับเป็น “${s.currentItem.name}${s.currentItem.chosenOption?` (${s.currentItem.chosenOption})`:''}” จำนวนกี่ชิ้นคะ? (เช่น 2, 5)`)]);
        return;
      }
    }
    await lineClient.replyMessage(replyToken, [msgText(`ขอเลือกเป็นแบบไหนคะ\nตัวเลือกที่มี: ${s.currentItem.options.join(', ')}`)]);
    return;
  }

  // 3) If waiting for qty
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
      const cartTxt = renderCart(s.cart);
      const sum = calcCartSummary(s.cart);
      s.stage = 'confirming';
      s.currentItem = null;
      await saveSessionRow(s, 'qty_added');
      await lineClient.replyMessage(replyToken, [
        msgText(`รับทราบแล้วค่ะ 🧾\nตะกร้าปัจจุบัน:\n${cartTxt}\n\nยอดสุทธิ: ${THB(sum.total)}${sum.promo.code?`\nโปรฯ: ${sum.promo.detail}`:''}\nต้องการเพิ่มสินค้าอีกไหมคะ หรือพิมพ์ “สรุปออเดอร์” ได้เลยค่ะ ✨`)
      ]);
      return;
    } else {
      await lineClient.replyMessage(replyToken, [msgText(`พิมพ์เป็นตัวเลขจำนวนชิ้นนะคะ เช่น 2 หรือ 5`)]); 
      return;
    }
  }

  // 4) Confirming or Idle → detect product or checkout
  if (s.stage === 'confirming' || s.stage === 'idle') {
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
        msgText(`รับทราบค่ะ 🧾 ช่วยส่ง “ชื่อ-ที่อยู่จัดส่ง” และ “เบอร์โทร” ด้วยนะคะ`),
        msgText(`ช่องทางชำระเงิน: ${pay.method}\n${pay.detail ? `รายละเอียด: ${pay.detail}`: ''}${/พร้อมเพย์|qr/i.test(pay.method+pay.detail) ? '\nต้องการ QR โอนเงิน พิมพ์ “ขอ QR” ได้เลยค่ะ 📷' : ''}${/cod|ปลายทาง/i.test(pay.method+pay.detail) ? '\nถ้าต้องการเก็บเงินปลายทาง พิมพ์ “เก็บปลายทาง” ได้ค่ะ 📦' : ''}`)
      ]);
      return;
    }

    // detect product by text
    const found = searchProductsByText(text);
    if (found.length === 1) {
      const p = found[0];
      const options = extractOptions(p);
      const noun = (p['หมวดหมู่']||'').includes('รถเข็น') ? 'รุ่น' : 'รสชาติ';
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
        await lineClient.replyMessage(replyToken, [msgText(`รับ “${p['ชื่อสินค้า']}” ${noun}ไหนคะ?\nตัวเลือก: ${options.join(', ')}`)]);
      } else {
        await lineClient.replyMessage(replyToken, [msgText(`รับ “${p['ชื่อสินค้า']}” จำนวนกี่ชิ้นคะ? (เช่น 2, 5)`)]); 
      }
      return;
    } else if (found.length > 1) {
      // suggest short list (human-friendly)
      const top = found.slice(0,6);
      const bullets = top.map(x => `• ${x['ชื่อสินค้า']}${x['ตัวเลือก']?` (${splitList(x['ตัวเลือก']).slice(0,3).join(', ')}...)`:''}`).join('\n');
      await lineClient.replyMessage(replyToken, [msgText(`หมายถึงตัวไหนคะ 😊\n${bullets}\n\nพิมพ์ชื่อให้ชัดขึ้น เช่น “เห็ดดั้งเดิมถุง” หรือ “โครตกุ้ง ต้มยำ ถุง”`)]); 
      return;
    }
  }

  // 5) collecting_info → address/phone/payment
  if (s.stage === 'collecting_info') {
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

    // parse phone & address
    const phone = text.match(/0\d{8,9}/)?.[0] || '';
    if (phone) s.phone = phone;
    if (text.length > 12 && !/qr|ปลายทาง|cod/i.test(text)) s.address = text;

    if (s.address && s.phone) {
      const { orderNo, summary } = await persistOrder(userId, s, s.address, s.phone, s.paymentMethod==='COD'?'รอจัดส่ง(COD)':'รอชำระ');
      await lineClient.replyMessage(replyToken, [
        msgText(`สรุปออเดอร์ #${orderNo}\n${renderCart(s.cart)}\nโปรฯ: ${summary.promo.code?summary.promo.detail:'—'}\nยอดสุทธิ: ${THB(summary.total)}\n\nจัดส่งไปที่: ${s.address}\nโทร: ${s.phone}\n\nขอบคุณมากค่ะ 🥰`)
      ]);
      await notifyAdmin(
        `🛒 ออเดอร์ใหม่ #${orderNo}\n${renderCart(s.cart)}\nยอดสุทธิ: ${THB(summary.total)}\nที่อยู่: ${s.address}\nโทร: ${s.phone}\nชำระ: ${s.paymentMethod||'โอน/พร้อมเพย์'}`
      );
      sessions.delete(userId);
      return;
    } else {
      await lineClient.replyMessage(replyToken, [msgText(`ขอรับ “ชื่อ-ที่อยู่” และ “เบอร์โทร” เพื่อดำเนินการต่อนะคะ 😊`)]);
      return;
    }
  }

  // 6) Fallback → concise AI (not too long)
  const extra = `
[สินค้า (ตัวอย่าง)]
${cache.products.slice(0,8).map(p=>`• ${p['ชื่อสินค้า']} ราคา ${THB(p['ราคา'])}${p['ตัวเลือก']?` (ตัวเลือก: ${splitList(p['ตัวเลือก']).slice(0,3).join(', ')}${splitList(p['ตัวเลือก']).length>3?'...':''})`:''}`).join('\n')}

[FAQ (ตัวอย่าง)]
${cache.faq.slice(0,5).map(f=>`• ${f['คำถาม']}: ${f['คำตอบ']}`).join('\n')}
  `.trim();

  const ai = await aiReply(text, extra);
  const say = ai || 'รับทราบค่ะ 😊 สนใจตัวไหนบอกได้เลยนะคะ';
  await lineClient.replyMessage(replyToken, [msgText(say)]);
}

// ----------------------- WEB SERVER -----------------------
const app = express();
app.get('/', (req,res)=>res.send('OK'));
app.get('/healthz', (req,res)=>res.send('ok'));

app.post('/webhook',
  lineMiddleware(lineConfig),
  async (req, res) => {
    try {
      if (!cache.persona) await loadAllData(); // first load
      res.status(200).end(); // must 200 quickly for LINE

      const events = req.body.events || [];
      for (const ev of events) {
        try {
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
            const hi = `สวัสดีค่ะ 😊 ยินดีต้อนรับสู่ร้านของเรา บอกชื่อสินค้าที่สนใจได้เลยค่ะ`;
            await lineClient.replyMessage(ev.replyToken, [msgText(hi)]);
          }
        } catch (inner) {
          console.error('Event error:', inner?.message);
          // tell admin if critical
          await notifyAdmin(`⚠️ Event error: ${inner?.message||inner}`);
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
    }
  }
);

// periodic reload data (every 10 min)
setInterval(async()=>{
  try { await loadAllData(); } catch(e){ console.warn('Reload warn:', e?.message); }
}, 10*60*1000);

// ----------------------- START ----------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  try {
    await loadAllData();
    console.log(`🚀 Server running on port ${PORT}`);
  } catch (e) {
    console.error('❌ Google Sheet Error:', e.message);
    await notifyAdmin(`❌ Google Sheet Error: ${e.message}`);
  }
});
