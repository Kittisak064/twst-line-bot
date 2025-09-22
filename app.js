/**
 * LINE Commerce Bot — Express + Google Sheets + OpenAI
 * Version: 1.1.0 (Production-ready for Render)
 * Author: AI Developer Assistant
 *
 * จุดแก้สำคัญจากฟีดแบ็ก:
 * - โทนเหมือนพนักงานขาย: คุยเป็นกันเอง สั้น กระชับ ไม่แข็ง
 * - ห้ามเงียบ: มี fallback ทุกทาง, try/catch ทุกรอบส่งข้อความ
 * - FAQ แบบคำหลักเคร่งครัด (no hallucination)
 * - Browse/Unknown ไม่โชว์ template แข็ง ๆ; ดึงของจริงจากชีท + list เป็นบรรทัด
 * - จำกัด 4–5 รายการ/ครั้ง อ่านง่าย มี quick reply ให้กด
 * - "รถเข็น" เคยเงียบ: แก้บั๊ก quickForProduct ที่หาย → เพิ่มฟังก์ชันให้ครบ
 * - ตอบชื่อพนักงาน/ชื่อเพจ/บุคลิก จากชีท Personality
 * - เพิ่ม /debug endpoint ให้เช็กว่าอ่านชีทจริง (counts + ตัวอย่าง)
 * - greeting ครั้งเดียว/ชั่วโมง, ตัดความยาวข้อความให้กระชับ
 * - รองรับเพิ่มคอลัมน์ในชีทได้ (map ด้วย header)
 */

'use strict';

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const { google } = require('googleapis');

// ---- Env & Constants -------------------------------------------------------

const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ADMIN_GROUP_ID = process.env.ADMIN_GROUP_ID;

const LINE_API_REPLY = 'https://api.line.me/v2/bot/message/reply';
const LINE_API_PUSH = 'https://api.line.me/v2/bot/message/push';

const HTTP_TIMEOUT_MS = 12000;

const SHEETS = {
  PRODUCTS: 'Products',
  PROMOTIONS: 'Promotions',
  FAQ: 'FAQ',
  PERSONALITY: 'Personality',
  ORDERS: 'Orders',
  PAYMENT: 'Payment',
  SESSIONS: 'Sessions',
  LOGS: 'Logs'
};

const sessionCache = new Map(); // userId -> { stage, cart, lastGreetAt, note }

let cache = {
  products: [],
  promotions: [],
  faq: [],
  personality: null,
  payments: [],
  lastLoadedAt: 0
};
const CACHE_TTL_MS = 1000 * 60 * 2;

// ---- Google Sheets Client ---------------------------------------------------

const auth = new google.auth.JWT({
  email: GOOGLE_CLIENT_EMAIL,
  key: GOOGLE_PRIVATE_KEY,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

async function readSheetWithHeader(sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${sheetName}!A:ZZ`
  });
  const rows = res.data.values || [];
  if (rows.length === 0) return [];
  const header = rows[0].map(h => (h || '').trim());
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const obj = {};
    header.forEach((h, idx) => {
      obj[h] = (row[idx] === undefined ? '' : row[idx]).toString();
    });
    list.push(obj);
  }
  return list;
}

async function appendRow(sheetName, rowArray) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${sheetName}!A:ZZ`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowArray] }
  });
}

async function ensureDataLoaded(force = false) {
  const now = Date.now();
  if (!force && now - cache.lastLoadedAt < CACHE_TTL_MS && cache.personality) return;

  const [products, promotions, faq, personalityList, payment] = await Promise.all([
    readSheetWithHeader(SHEETS.PRODUCTS),
    readSheetWithHeader(SHEETS.PROMOTIONS),
    readSheetWithHeader(SHEETS.FAQ),
    readSheetWithHeader(SHEETS.PERSONALITY),
    readSheetWithHeader(SHEETS.PAYMENT)
  ]);

  cache.products = normalizeProducts(products);
  cache.promotions = normalizePromotions(promotions);
  cache.faq = normalizeFAQ(faq);
  cache.personality = pickPersonality(personalityList);
  cache.payments = normalizePayment(payment);
  cache.lastLoadedAt = now;
}

// ---- Normalizers ------------------------------------------------------------

function splitCSV(s) {
  return (s || '').split(/[,|/、]+/).map(x => x.trim()).filter(Boolean);
}
function toNumber(x) {
  const n = Number((x || '0').toString().replace(/[^\d.]/g, ''));
  return isNaN(n) ? 0 : n;
}
function normalizeProducts(rows) {
  return rows.map(r => ({
    code: r['รหัสสินค้า'] || r['sku'] || r['code'] || '',
    name: r['ชื่อสินค้า'] || r['name'] || '',
    category: r['หมวดหมู่'] || r['category'] || '',
    price: toNumber(r['ราคา'] || r['price'] || '0'),
    aliases: splitCSV(r['คำที่ลูกค้าเรียก'] || r['aliases'] || ''),
    options: splitCSV(r['ตัวเลือก'] || r['options'] || ''), // น้ำพริก=รส/รุ่น
    size: splitCSV(r['ขนาด'] || r['size'] || ''),
    meta: r
  })).filter(p => p.code && p.name);
}
function normalizePromotions(rows) {
  return rows.map(r => ({
    code: r['รหัสโปรโมชั่น'] || r['promo_code'] || '',
    description: r['รายละเอียดโปรโมชั่น'] || r['description'] || '',
    type: (r['ประเภทคำนวณ'] || r['type'] || '').toLowerCase().trim(), // percent|amount|threshold|bundle
    condition: r['เงื่อนไข'] || r['condition'] || '',
    items: splitCSV(r['ใช้กับสินค้า'] || r['items'] || ''),
    categories: splitCSV(r['ใช้กับหมวดหมู่'] || r['categories'] || ''),
    raw: r
  })).filter(p => p.code && p.type);
}
function normalizeFAQ(rows) {
  return rows.map(r => ({
    q: r['คำถาม'] || r['question'] || '',
    keywords: splitCSV(r['คำหลัก'] || r['keywords'] || '').map(x => x.toLowerCase()),
    a: r['คำตอบ'] || r['answer'] || ''
  })).filter(x => x.keywords.length > 0 && x.a);
}
function pickPersonality(list) {
  if (!list || list.length === 0) {
    return {
      staffName: 'ทีมงาน',
      pageName: 'เพจของเรา',
      persona: 'คุยสุภาพ กระชับ เป็นกันเอง',
      customerPronoun: 'ลูกค้า',
      adminSelf: 'แอดมิน',
      dontKnow: 'ขอเช็กข้อมูลก่อนนะคะ เดี๋ยวอัปเดตให้เร็ว ๆ นี้',
      gender: 'female'
    };
  }
  const r = list[0];
  return {
    staffName: r['ชื่อพนักงาน'] || 'ทีมงาน',
    pageName: r['ชื่อเพจ'] || 'เพจของเรา',
    persona: r['บุคลิก'] || 'คุยสุภาพ กระชับ เป็นกันเอง',
    customerPronoun: r['คำเรียกลูกค้า'] || 'ลูกค้า',
    adminSelf: r['คำเรียกตัวเองแอดมิน'] || 'แอดมิน',
    dontKnow: r['คำตอบเมื่อไม่รู้'] || 'ขอเช็กข้อมูลก่อนนะคะ เดี๋ยวอัปเดตให้เร็ว ๆ นี้',
    gender: r['เพศ'] || 'female'
  };
}
function normalizePayment(rows) {
  return rows.map(r => ({
    category: r['category'] || '',
    method: r['method'] || '',
    detail: r['detail'] || '',
    qrcode: r['qrcode'] || ''
  })).filter(x => x.method);
}

// ---- Logging ---------------------------------------------------------------

async function logEvent(userId, type, text) {
  try {
    const ts = new Date().toISOString();
    await appendRow(SHEETS.LOGS, [ts, userId || '-', type || '-', (text || '').slice(0, 1200)]);
  } catch (e) { console.error('Log append failed:', e.message); }
}

// ---- Sessions ---------------------------------------------------------------

function getSession(userId) {
  const s = sessionCache.get(userId);
  if (s) return s;
  const ns = { stage: 'INIT', cart: [], lastGreetAt: 0, note: '', updatedAt: Date.now() };
  sessionCache.set(userId, ns);
  return ns;
}
async function persistSession(userId) {
  try {
    const s = sessionCache.get(userId);
    if (!s) return;
    const ts = new Date().toISOString();
    await appendRow(SHEETS.SESSIONS, [ts, userId, s.stage, JSON.stringify(s.cart), s.note || '']);
  } catch (e) { console.error('Persist session failed:', e.message); }
}

// ---- Promotions ------------------------------------------------------------

function parseKeyVal(s, key, defVal) {
  const m = new RegExp(`${key}\\s*=\\s*([\\d.]+)`, 'i').exec(s || '');
  if (!m) return defVal;
  return Number(m[1]) || defVal;
}
function parseKeyValStr(s, key, defVal) {
  const m = new RegExp(`${key}\\s*=\\s*([^;\\s]+)`, 'i').exec(s || '');
  if (!m) return defVal;
  return m[1];
}
function round2(n) { return Math.round(n * 100) / 100; }
function priceTHB(n) { return `${round2(n).toLocaleString('th-TH')} บาท`; }

function applyPromotions(cartItems) {
  const items = cartItems.map(it => ({ ...it, lineSubtotal: it.unitPrice * it.qty }));
  const subtotal = items.reduce((a, b) => a + b.lineSubtotal, 0);
  let discountTotal = 0;
  const applied = [];

  for (const p of cache.promotions) {
    const scopeItems = items.filter(it => {
      const inItem = p.items.length ? p.items.includes(it.code) : true;
      const inCat = p.categories.length ? p.categories.includes(it.category) : true;
      return inItem && inCat;
    });
    if (scopeItems.length === 0) continue;
    const scopeSum = scopeItems.reduce((a, b) => a + b.lineSubtotal, 0);
    let promoDiscount = 0;

    switch (p.type) {
      case 'percent': {
        const rate = parseKeyVal(p.condition, 'RATE', 0);
        if (rate > 0) promoDiscount = (scopeSum * rate) / 100;
        break;
      }
      case 'amount': {
        const amt = parseKeyVal(p.condition, 'AMOUNT', 0);
        if (amt > 0 && scopeSum >= amt) promoDiscount = amt;
        break;
      }
      case 'threshold': {
        const min = parseKeyVal(p.condition, 'MIN', 0);
        if (scopeSum >= min) {
          const rate = parseKeyVal(p.condition, 'RATE', 0);
          const amt = parseKeyVal(p.condition, 'AMOUNT', 0);
          if (rate > 0) promoDiscount = (scopeSum * rate) / 100; else if (amt > 0) promoDiscount = amt;
        }
        break;
      }
      case 'bundle': {
        const buy = parseKeyVal(p.condition, 'BUY', 0);
        const get = parseKeyVal(p.condition, 'GET', 0);
        const promoItem = parseKeyValStr(p.condition, 'ITEM', '');
        let bundleItems = scopeItems;
        if (promoItem) bundleItems = scopeItems.filter(it => it.code === promoItem);
        if (buy > 0 && get > 0 && bundleItems.length > 0) {
          for (const target of bundleItems) {
            const quota = Math.floor(target.qty / buy) * get;
            if (quota > 0) promoDiscount += target.unitPrice * quota;
          }
        }
        break;
      }
      default: break;
    }

    if (promoDiscount > 0.001) { discountTotal += promoDiscount; applied.push(p.code); }
  }

  discountTotal = Math.min(discountTotal, subtotal);
  const total = Math.max(subtotal - discountTotal, 0);

  return { items, promoApplied: applied, discountTotal: round2(discountTotal), subtotal: round2(subtotal), total: round2(total) };
}

// ---- LINE helpers -----------------------------------------------------------

function verifyLineSignature(rawBody, signature) {
  const hmac = crypto.createHmac('sha256', LINE_CHANNEL_SECRET);
  hmac.update(rawBody);
  const digest = hmac.digest('base64');
  return digest === signature;
}
async function lineReply(replyToken, messages) {
  try {
    await axios.post(LINE_API_REPLY, { replyToken, messages }, {
      headers: { 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: HTTP_TIMEOUT_MS
    });
  } catch (e) { console.error('LINE reply failed:', e.response?.status, e.response?.data || e.message); }
}
async function linePush(to, messages) {
  try {
    await axios.post(LINE_API_PUSH, { to, messages }, {
      headers: { 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: HTTP_TIMEOUT_MS
    });
  } catch (e) { console.error('LINE push failed:', e.response?.status, e.response?.data || e.message); }
}

// ---- OpenAI intent (minimal) ------------------------------------------------

async function parseIntentLLM(text, context) {
  const sys = `คุณเป็นตัวช่วยสรุปเจตนาสั้นๆ สำหรับแชทขายของ LINE ภาษาไทย
- คืนค่า JSON เท่านั้น
- intents: ["greet","browse","add_to_cart","remove_from_cart","checkout","faq","payment","address","phone","confirm","cancel","unknown","ask_name","ask_page"]
- fields: items(alias, qty, option, size, spec), phone, address, paymentPref, faqKeywords[]`;
  const usr = `ข้อความลูกค้า: """${text}""" บริบท: ${JSON.stringify({ stage: context.stage, hasCart: context.cart?.length > 0 })}`;

  try {
    const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      temperature: 0.1,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: usr }
      ],
      response_format: { type: 'json_object' }
    }, { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: HTTP_TIMEOUT_MS });

    const parsed = JSON.parse(resp.data.choices?.[0]?.message?.content || '{}');
    parsed.intent = parsed.intent || 'unknown';
    parsed.items = Array.isArray(parsed.items) ? parsed.items : [];
    parsed.faqKeywords = Array.isArray(parsed.faqKeywords) ? parsed.faqKeywords : [];
    parsed.paymentPref = parsed.paymentPref || null;
    parsed.phone = (parsed.phone || '').toString();
    parsed.address = (parsed.address || '').toString();
    return parsed;
  } catch (e) {
    console.error('OpenAI parseIntent failed:', e.response?.data || e.message);
    return { intent: 'unknown', items: [], faqKeywords: [] };
  }
}

// ---- Keyword fallback -------------------------------------------------------

function simpleKeywordClassifier(text) {
  const t = (text || '').toLowerCase();
  if (/(คุณชื่ออะไร|ชื่ออะไร|ใครคุย|ใครตอบ)/.test(t)) return 'ask_name';
  if (/(เพจอะไร|ร้านอะไร|นี่เพจอะไร|ชื่อเพจ)/.test(t)) return 'ask_page';
  if (/(ผ่อน|บัตรเครดิต|โอน|พร้อมเพย์|ชำระ|จ่ายเงิน|cod|ปลายทาง)/.test(t)) return 'payment';
  if (/(สั่ง|หยิบ|เพิ่ม|เอา|ซื้อ|ตะกร้า|อีก)/.test(t)) return 'add_to_cart';
  if (/(เช็กเอาท์|จ่าย|คิดเงิน|ยอดรวม|สรุป|ที่อยู่|เบอร์)/.test(t)) return 'checkout';
  if (/(ลบ|เอาออก|คืน)/.test(t)) return 'remove_from_cart';
  if (/(โปร|ส่วนลด|แถม|โค้ด)/.test(t)) return 'promotions';
  if (/(ขนาด|รส|รุ่น|สเปค)/.test(t)) return 'browse';
  if (/(อยู่ไหม|มีไหม|สินค้า|ราคา|ของ|แนะนำ)/.test(t)) return 'browse';
  if (/(สวัสดี|hello|hi|เฮลโหล|ทัก)/.test(t)) return 'greet';
  if (/(ส่งที่ไหน|ที่อยู่)/.test(t)) return 'address';
  if (/(เบอร์|ติดต่อ)/.test(t)) return 'phone';
  if (/(ยกเลิก|ไม่เอา)/.test(t)) return 'cancel';
  return 'unknown';
}

// ---- Catalog & FAQ ----------------------------------------------------------

function matchProductByAliasOrName(input) {
  const t = (input || '').toLowerCase();
  let p = cache.products.find(x => x.code.toLowerCase() === t);
  if (p) return p;
  p = cache.products.find(x => x.name.toLowerCase().includes(t));
  if (p) return p;
  p = cache.products.find(x => x.aliases.some(a => t.includes(a.toLowerCase())));
  return p || null;
}

function listBriefByCategory(cat) {
  const arr = cache.products.filter(p => p.category === cat);
  const show = arr.slice(0, 5);
  if (show.length === 0) return 'ยังไม่มีรายการในหมวดนี้ค่ะ';
  const lines = show.map(p => `• ${p.name}${p.size?.length ? ` (${p.size[0]})` : ''} ${priceTHB(p.price)}`);
  if (arr.length > show.length) lines.push('…ยังมีอีก สนใจดูเพิ่มไหมคะ?');
  return lines.join('\n');
}

function answerFAQByKeywords(text) {
  const tokens = tokenizeTH(text);
  let best = null, bestScore = 0;
  for (const f of cache.faq) {
    const score = f.keywords.reduce((acc, kw) => acc + (tokens.has(kw) ? 1 : 0), 0);
    if (score > bestScore) { best = f; bestScore = score; }
  }
  if (best && bestScore > 0) return best.a;
  return null;
}
function tokenizeTH(s) {
  const low = (s || '').toLowerCase();
  const words = low.split(/[^ก-๙a-z0-9]+/).filter(Boolean);
  return new Set(words);
}

// ---- Reply builders ---------------------------------------------------------

function makeReply(text, quick = []) {
  const t = (text || '').trim();
  const clipped = t.length > 320 ? t.slice(0, 317) + '…' : t; // กระชับ
  const msg = { type: 'text', text: clipped };
  if (quick && quick.length) {
    msg.quickReply = {
      items: quick.slice(0, 12).map(label => ({
        type: 'action',
        action: { type: 'message', label, text: label }
      }))
    };
  }
  return msg;
}
function customerName() { return cache.personality?.customerPronoun || 'ลูกค้า'; }
function staffPrefix() { return (cache.personality?.gender || 'female') === 'male' ? 'ครับ' : 'ค่ะ'; }
function avoidRepeatGreet(session) {
  const now = Date.now();
  if (now - (session.lastGreetAt || 0) < 1000 * 60 * 60) return false;
  session.lastGreetAt = now; return true;
}
function greetOnce(session) {
  if (!avoidRepeatGreet(session)) return null;
  const name = cache.personality?.staffName || 'ทีมงาน';
  const page = cache.personality?.pageName || 'เพจของเรา';
  return `${name}จาก ${page} ค่ะ สนใจดูสินค้าอะไรดีคะ`;
}
function shortConfirm(text) { return `${text} ${staffPrefix()}`; }

function quickForProduct(p) {
  // ปุ่มชัด ๆ ให้กดต่อ
  const labels = ['เพิ่มลงตะกร้า', 'สรุปตะกร้า', 'ดูโปร', 'เช็กเอาท์'];
  // เติมตัวเลือกถ้ามี
  if (p.options?.length) labels.unshift(`เลือก ${p.options[0]}`);
  if (p.size?.length) labels.unshift(`เลือก ${p.size[0]}`);
  return Array.from(new Set(labels)).slice(0, 6);
}

// ---- Cart -------------------------------------------------------------------

function addItemsToCart(session, items) {
  for (const it of items) {
    const existing = session.cart.find(x =>
      x.code === it.product.code &&
      (x.option || '') === (it.option || '') &&
      (x.size || '') === (it.size || '') &&
      (x.spec || '') === (it.spec || '')
    );
    if (existing) { existing.qty += it.qty; existing.updatedAt = Date.now(); }
    else {
      session.cart.push({
        code: it.product.code,
        name: it.product.name,
        category: it.product.category,
        unitPrice: it.product.price,
        qty: it.qty,
        option: it.option || '',
        size: it.size || '',
        spec: it.spec || '',
        updatedAt: Date.now()
      });
    }
  }
  session.updatedAt = Date.now();
}
function removeFromCart(session, aliasOrCode) {
  const before = session.cart.length;
  session.cart = session.cart.filter(x => {
    if (x.code.toLowerCase() === (aliasOrCode || '').toLowerCase()) return false;
    const p = matchProductByAliasOrName(aliasOrCode);
    if (p && p.code === x.code) return false;
    return true;
  });
  return before !== session.cart.length;
}
function cartSummary(session) {
  if (!session.cart.length) return 'ตะกร้ายังว่างอยู่ค่ะ';
  const { subtotal, discountTotal, total, promoApplied } = applyPromotions(session.cart);
  const lines = session.cart.map(x => {
    const opt = x.option ? ` (${x.option})` : '';
    const sz = x.size ? ` [${x.size}]` : '';
    return `• ${x.name}${opt}${sz} x${x.qty} = ${priceTHB(x.unitPrice * x.qty)}`;
  });
  if (promoApplied.length) lines.push(`ส่วนลด: -${priceTHB(discountTotal)} (โปร: ${promoApplied.join(',')})`);
  lines.push(`รวมทั้งสิ้น: ${priceTHB(total)}`);
  return lines.join('\n');
}

// ---- Category-aware attributes ---------------------------------------------

function fillCategoryAttributes(product, requested) {
  const pCat = product.category || '';
  const out = { option: '', size: '', spec: '' };

  if (/น้ำพริก/.test(pCat)) {
    out.option = pickFirstMatch(requested.option, product.options) || '';
    out.size = pickFirstMatch(requested.size, product.size) || '';
  } else if (/(รถเข็น|ไต่บันได|stair|ตีนตะขาบ|ขนของ)/i.test(pCat)) {
    out.option = pickFirstMatch(requested.option, product.options) || '';
    out.spec = requested.spec || '';
    out.size = pickFirstMatch(requested.size, product.size) || '';
  } else {
    out.option = pickFirstMatch(requested.option, product.options) || '';
    out.size = pickFirstMatch(requested.size, product.size) || '';
  }
  return out;
}
function pickFirstMatch(value, candidates) {
  if (!value) return '';
  if (!Array.isArray(candidates) || candidates.length === 0) return value;
  const low = value.toLowerCase();
  const found = candidates.find(c => c.toLowerCase() === low || low.includes(c.toLowerCase()) || c.toLowerCase().includes(low));
  return found || value;
}
function guessOptionFromText(text, prod) {
  const t = (text || '').toLowerCase();
  for (const o of prod.options || []) if (t.includes(o.toLowerCase())) return o;
  if (/เผ็ดน้อย|ไม่เผ็ด/.test(t)) return 'เผ็ดน้อย';
  if (/เผ็ดมาก|โคตรเผ็ด|เผ็ดจัด/.test(t)) return 'เผ็ดมาก';
  return '';
}
function guessSizeFromText(text, prod) {
  const t = (text || '').toLowerCase();
  for (const s of prod.size || []) if (t.includes(s.toLowerCase())) return s;
  const m = /(\d+)\s*(g|กรัม|ml|มล)/.exec(t);
  if (m) return `${m[1]}${m[2]}`;
  return '';
}

// ---- Payment ----------------------------------------------------------------

function paymentChoices() {
  const qs = [];
  for (const p of cache.payments) {
    if (p.method.toLowerCase().includes('promptpay')) qs.push('โอนพร้อมเพย์');
    if (p.method.toLowerCase().includes('cod') || /ปลายทาง/i.test(p.method)) qs.push('เก็บปลายทาง');
  }
  return Array.from(new Set(qs));
}
function paymentPayload(pref) {
  const low = (pref || '').toLowerCase();
  if (/พร้อมเพย์|promptpay/.test(low)) return cache.payments.find(x => /promptpay/i.test(x.method)) || null;
  if (/cod|ปลายทาง/.test(low)) return cache.payments.find(x => /cod|ปลายทาง/i.test(x.method)) || null;
  return cache.payments[0] || null;
}

// ---- Orders & Admin notify --------------------------------------------------

function rand4() { return Math.floor(1000 + Math.random() * 9000); }

async function createOrderAndNotify(userId, session, customer) {
  const { subtotal, discountTotal, total, promoApplied, items } = applyPromotions(session.cart);
  const orderId = `OD-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${rand4()}`;
  const promoStr = promoApplied.join(',');

  for (const it of items) {
    await appendRow(SHEETS.ORDERS, [
      orderId,
      it.code,
      it.name,
      it.option || it.spec || it.size || '',
      it.qty,
      it.lineSubtotal,
      promoStr,
      `${customer.name || ''} ${customer.address || ''}`.trim(),
      customer.phone || '',
      'PENDING'
    ]);
  }

  const summary = [
    `ออเดอร์ใหม่ #${orderId}`,
    ...items.map(it => `• ${it.name}${it.option ? ` (${it.option})` : ''}${it.size ? ` [${it.size}]` : ''} x${it.qty} = ${priceTHB(it.lineSubtotal)}`),
    promoStr ? `โปรที่ใช้: ${promoStr}` : null,
    discountTotal ? `ส่วนลดรวม: -${priceTHB(discountTotal)}` : null,
    `ยอดสุทธิ: ${priceTHB(total)}`,
    customer.name ? `ลูกค้า: ${customer.name}` : null,
    customer.phone ? `โทร: ${customer.phone}` : null,
    customer.address ? `ที่อยู่: ${customer.address}` : null
  ].filter(Boolean).join('\n');

  await linePush(ADMIN_GROUP_ID, [makeReply(summary)]);
  return { orderId, total };
}

// ---- Express App ------------------------------------------------------------

const app = express();

// Raw body for LINE signature
app.use('/webhook', bodyParser.raw({ type: '*/*' }));
// JSON elsewhere
app.use(bodyParser.json());

// Healthcheck
app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Manual reload cache
app.post('/reload', async (req, res) => {
  try { await ensureDataLoaded(true); res.json({ reloadedAt: cache.lastLoadedAt, personality: cache.personality?.staffName }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Debug: peek data counts (GET)
app.get('/debug', async (req, res) => {
  try {
    await ensureDataLoaded(false);
    res.json({
      personality: cache.personality,
      counts: { products: cache.products.length, promotions: cache.promotions.length, faq: cache.faq.length, payments: cache.payments.length },
      sample: {
        products: cache.products.slice(0, 3),
        promotions: cache.promotions.slice(0, 2),
        faq: cache.faq.slice(0, 2)
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// LINE webhook
app.post('/webhook', async (req, res) => {
  try {
    const signature = req.get('X-Line-Signature') || '';
    const rawBody = req.body;
    const rawString = rawBody.toString('utf8');
    if (!verifyLineSignature(rawString, signature)) return res.status(401).send('Unauthorized');
    res.status(200).send('OK');

    const body = JSON.parse(rawString);
    await ensureDataLoaded(false);

    for (const event of body.events || []) {
      if (event.type === 'message' && event.message?.type === 'text') {
        handleTextMessage(event).catch(e => console.error('handleTextMessage error:', e.message));
      } else {
        const replyToken = event.replyToken;
        if (replyToken) {
          const msg = makeReply(`รับทราบค่ะ พิมพ์ชื่อสินค้าหรือคำถามได้เลย`, ['ดูโปร', 'สินค้าแนะนำ', 'สรุปตะกร้า']);
          await lineReply(replyToken, [msg]);
        }
      }
    }
  } catch (e) {
    console.error('/webhook error:', e.message);
    try { res.status(200).send('OK'); } catch {}
  }
});

// ---- Message Handler --------------------------------------------------------

async function handleTextMessage(event) {
  const userId = event.source?.userId || 'unknown';
  const text = (event.message?.text || '').trim();
  const replyToken = event.replyToken;

  await logEvent(userId, 'IN', text);
  const session = getSession(userId);
  await ensureDataLoaded(false);

  // Greeting control
  let greeting = null;
  if (session.stage === 'INIT') {
    greeting = greetOnce(session);
    session.stage = 'GREETED';
  }

  // Personality Qs: "คุณชื่ออะไร", "เพจอะไร"
  const low = text.toLowerCase();
  if (/(คุณชื่ออะไร|ชื่ออะไร|ใครคุย|ใครตอบ)/.test(low)) {
    const name = cache.personality?.adminSelf || cache.personality?.staffName || 'แอดมิน';
    const msg = makeReply(`${name}${staffPrefix()}`);
    await lineReply(replyToken, greeting ? [makeReply(greeting), msg] : [msg]);
    await persistSession(userId); await logEvent(userId, 'OUT', '[ask_name]');
    return;
  }
  if (/(เพจอะไร|ร้านอะไร|นี่เพจอะไร|ชื่อเพจ)/.test(low)) {
    const page = cache.personality?.pageName || 'เพจของเรา';
    const msg = makeReply(`${page}${staffPrefix()}`);
    await lineReply(replyToken, greeting ? [makeReply(greeting), msg] : [msg]);
    await persistSession(userId); await logEvent(userId, 'OUT', '[ask_page]');
    return;
  }

  // FAQ strict first
  const faqAnswer = answerFAQByKeywords(text);
  if (faqAnswer) {
    const reply = makeReply(faqAnswer);
    const msgs = greeting ? [makeReply(greeting), reply] : [reply];
    await lineReply(replyToken, msgs);
    await persistSession(userId); await logEvent(userId, 'OUT', '[faq]');
    return;
  }

  // Intent parsing
  const llm = await parseIntentLLM(text, session);
  const fallbackIntent = simpleKeywordClassifier(text);
  const intent = llm.intent === 'unknown' ? fallbackIntent : llm.intent;

  switch (intent) {
    case 'greet': {
      const g = greetOnce(session);
      const say = g || `อยากดูสินค้าอะไรเป็นพิเศษไหมคะ`;
      const msg = makeReply(say, ['สินค้าแนะนำ', 'ดูโปร', 'สรุปตะกร้า']);
      await lineReply(replyToken, [msg]);
      break;
    }
    case 'browse': {
      // 1) Try a specific product
      const maybeProduct = tryExtractProductFromText(text);
      if (maybeProduct) {
        const brief = productBrief(maybeProduct);
        const msg = makeReply(brief, quickForProduct(maybeProduct));
        await lineReply(replyToken, greeting ? [makeReply(greeting), msg] : [msg]);
        break;
      }
      // 2) Guess category
      const cat = guessCategory(text);
      if (cat) {
        const list = listBriefByCategory(cat);
        const buttons = [
          ...cache.products.filter(p => p.category === cat).slice(0, 4).map(p => p.name),
          'ดูโปร', 'สรุปตะกร้า', 'เช็กเอาท์'
        ];
        const msg = makeReply(`กลุ่ม ${cat} ที่มีตอนนี้ค่ะ:\n${list}`, buttons);
        await lineReply(replyToken, greeting ? [makeReply(greeting), msg] : [msg]);
        break;
      }
      // 3) Default: show 4 แนะนำ
      const msg = makeReply(`แนะนำสินค้ายอดนิยม:\n${recommendList()}`, ['ดูโปร', 'สรุปตะกร้า']);
      await lineReply(replyToken, greeting ? [makeReply(greeting), msg] : [msg]);
      break;
    }
    case 'add_to_cart': {
      const toAdd = mapParsedItemsToProducts(llm.items, text);
      if (toAdd.length === 0) {
        const p = tryExtractProductFromText(text);
        if (p) {
          const attrs = fillCategoryAttributes(p, { option: '', size: '', spec: '' });
          addItemsToCart(session, [{ product: p, qty: 1, ...attrs }]);
          const msg = makeReply(shortConfirm(`เพิ่ม ${p.name} x1 ลงตะกร้าแล้ว`), ['สรุปตะกร้า', 'เช็กเอาท์', 'ดูโปร']);
          await lineReply(replyToken, greeting ? [makeReply(greeting), msg] : [msg]);
          break;
        }
        const msg = makeReply(`ยังไม่เจอสินค้า ลองพิมพ์ชื่อ/รหัสให้ชัดอีกนิดนะคะ`, ['สินค้าแนะนำ', 'ดูโปร']);
        await lineReply(replyToken, greeting ? [makeReply(greeting), msg] : [msg]);
        break;
      }
      addItemsToCart(session, toAdd);
      const caption = toAdd.map(x => `${x.product.name}${x.option ? ` (${x.option})` : ''}${x.size ? ` [${x.size}]` : ''} x${x.qty}`).join(', ');
      const msg = makeReply(shortConfirm(`เพิ่มลงตะกร้า: ${caption}`), ['สรุปตะกร้า', 'เช็กเอาท์']);
      await lineReply(replyToken, greeting ? [makeReply(greeting), msg] : [msg]);
      break;
    }
    case 'remove_from_cart': {
      const target = text.replace(/(ลบ|เอาออก|คืน|ออก)/g, '').trim() || '';
      const changed = removeFromCart(session, target || '');
      const say = changed ? 'ลบสินค้าแล้วค่ะ' : 'ไม่พบสินค้าที่จะลบ';
      const msg = makeReply(shortConfirm(say), ['สรุปตะกร้า', 'เช็กเอาท์']);
      await lineReply(replyToken, [msg]);
      break;
    }
    case 'promotions': {
      const list = cache.promotions.slice(0, 6).map(p => `• ${p.code}: ${p.description}`).join('\n') || 'ตอนนี้ไม่มีโปรค่ะ';
      const msg = makeReply(list, ['สรุปตะกร้า', 'เช็กเอาท์']);
      await lineReply(replyToken, greeting ? [makeReply(greeting), msg] : [msg]);
      break;
    }
    case 'checkout':
    case 'payment':
    case 'address':
    case 'phone': {
      session.stage = 'CHECKOUT_INFO';
      if (!session.cart.length) {
        const msg = makeReply(`ตะกร้ายังว่างค่ะ เพิ่มสินค้าก่อนนะคะ`, ['สินค้าแนะนำ', 'ดูโปร']);
        await lineReply(replyToken, [msg]); break;
      }
      let info = parseCustomerInfo(session.note);
      if (llm.phone) info.phone = sanitizePhone(llm.phone);
      if (llm.address) info.address = llm.address.trim();
      if (llm.paymentPref) info.paymentPref = llm.paymentPref;

      const missingPhone = !isValidPhone(info.phone);
      const missingAddress = !info.address;
      const missingPayment = !info.paymentPref;

      const need = [];
      if (missingPhone) need.push('เบอร์โทร');
      if (missingAddress) need.push('ที่อยู่จัดส่ง');
      if (missingPayment) need.push('วิธีชำระ (พร้อมเพย์/ปลายทาง)');

      if (need.length) {
        session.note = JSON.stringify(info);
        const msg = makeReply(`ขอ${need.join(' + ')}นะคะ`, [...paymentChoices(), 'สรุปตะกร้า', 'ยืนยันสั่งซื้อ']);
        await lineReply(replyToken, greeting ? [makeReply(greeting), msg] : [msg]);
        break;
      }

      const summary = cartSummary(session);
      const payment = paymentPayload(info.paymentPref);
      const payLine = payment ? (payment.qrcode ? `สแกนชำระ: ${payment.qrcode}` : `วิธีชำระ: ${payment.method} ${payment.detail || ''}`) : 'วิธีชำระ: -';
      const msg1 = makeReply(`สรุปบิล\n${summary}`);
      const msg2 = makeReply(payLine, ['ยืนยันสั่งซื้อ', 'เปลี่ยนวิธีชำระ', 'แก้ไขที่อยู่']);
      await lineReply(replyToken, [msg1, msg2]);
      session.stage = 'PAYMENT';
      break;
    }
    case 'confirm': {
      let info = parseCustomerInfo(session.note);
      if (!isValidPhone(info.phone) || !info.address || !info.paymentPref) {
        const msg = makeReply(`ข้อมูลยังไม่ครบค่ะ พิมพ์: เบอร์/ที่อยู่/วิธีชำระ`, paymentChoices());
        await lineReply(replyToken, [msg]); break;
      }
      const customer = { name: customerName(), phone: info.phone, address: info.address };
      const { orderId, total } = await createOrderAndNotify(userId, session, customer);
      session.stage = 'DONE'; session.cart = [];
      const say = `เลขที่ออเดอร์ ${orderId} ยอดสุทธิ ${priceTHB(total)} ${staffPrefix()}`;
      const payInfo = paymentPayload(info.paymentPref);
      const payHint = payInfo?.qrcode ? `แนบ QR แล้วนะคะ โอนแล้วแจ้งสลิปได้เลย` : `ชำระตามวิธีที่เลือกได้เลยค่ะ`;
      const msg = makeReply(`${say}\n${payHint}`, ['สั่งเพิ่ม', 'เช็กสถานะ']);
      await lineReply(replyToken, [msg]);
      break;
    }
    case 'cancel': {
      session.stage = 'BROWSING'; session.cart = [];
      const msg = makeReply(shortConfirm('ยกเลิกออเดอร์ให้แล้ว'), ['สินค้าแนะนำ', 'ดูโปร']);
      await lineReply(replyToken, [msg]);
      break;
    }
    default: {
      if (/สรุปตะกร้า|ตะกร้า|cart/i.test(text)) {
        const msg = makeReply(cartSummary(session), ['เช็กเอาท์', 'ดูโปร']);
        await lineReply(replyToken, [msg]);
      } else if (/ดูโปร|โปรโมชั่น/i.test(text)) {
        const list = cache.promotions.slice(0, 6).map(p => `• ${p.code}: ${p.description}`).join('\n') || 'ตอนนี้ไม่มีโปรค่ะ';
        const msg = makeReply(list, ['สรุปตะกร้า', 'เช็กเอาท์']);
        await lineReply(replyToken, [msg]);
      } else if (/ยืนยัน/.test(text)) {
        const fakeEvent = { ...event, message: { ...event.message, text: 'confirm' } };
        await handleTextMessage(fakeEvent); return;
      } else if (/เปลี่ยนวิธีชำระ/.test(text)) {
        let info = parseCustomerInfo(session.note); info.paymentPref = null; session.note = JSON.stringify(info);
        const msg = makeReply('เลือกวิธีชำระใหม่ค่ะ', paymentChoices()); await lineReply(replyToken, [msg]);
      } else if (/แก้ไขที่อยู่/.test(text)) {
        let info = parseCustomerInfo(session.note); info.address = ''; session.note = JSON.stringify(info);
        const msg = makeReply('พิมพ์ที่อยู่ใหม่ได้เลยค่ะ', ['ใช้พร้อมเพย์', 'เก็บปลายทาง']); await lineReply(replyToken, [msg]);
      } else if (/สินค้าแนะนำ/.test(text)) {
        const msg = makeReply(`แนะนำ:\n${recommendList()}`, ['ดูโปร', 'สรุปตะกร้า', 'เช็กเอาท์']);
        await lineReply(replyToken, [msg]);
      } else {
        const ans = answerFAQByKeywords(text) || (cache.personality?.dontKnow || 'ขอเช็กข้อมูลก่อนนะคะ');
        const msg = makeReply(ans, ['สินค้าแนะนำ', 'ดูโปร', 'สรุปตะกร้า']);
        await lineReply(replyToken, greeting ? [makeReply(greeting), msg] : [msg]);
      }
      break;
    }
  }

  await persistSession(userId);
  await logEvent(userId, 'OUT', '[replied]');
}

// ---- Helpers for browse -----------------------------------------------------

function recommendList() {
  const arr = cache.products.slice(0, 4);
  if (!arr.length) return '-';
  return arr.map(p => `• ${p.name} ${priceTHB(p.price)}`).join('\n');
}
function productBrief(p) {
  const opt = p.options?.length ? ` ตัวเลือก: ${p.options.join('/')} ` : '';
  const sz = p.size?.length ? ` ขนาด: ${p.size.join('/')} ` : '';
  return `${p.name} ราคาเริ่ม ${priceTHB(p.price)}${opt}${sz}`.trim();
}
function tryExtractProductFromText(text) {
  const t = text.toLowerCase();
  let best = null, bestLen = 0;
  for (const p of cache.products) {
    if (t.includes(p.name.toLowerCase()) && p.name.length > bestLen) { best = p; bestLen = p.name.length; }
    for (const a of p.aliases) if (t.includes(a.toLowerCase()) && a.length > bestLen) { best = p; bestLen = a.length; }
    if (t.includes(p.code.toLowerCase()) && p.code.length > bestLen) { best = p; bestLen = p.code.length; }
  }
  return best;
}
function guessCategory(s) {
  const t = (s || '').toLowerCase();
  if (/น้ำพริก|chili|chilli|chili paste/.test(t)) return 'น้ำพริก';
  if (/รถเข็น|stair|ไต่บันได|ตีนตะขาบ|ขนของ/.test(t)) return 'รถเข็นไต่บันได';
  return null;
}
function mapParsedItemsToProducts(llmItems, originalText) {
  const out = [];
  for (const it of llmItems || []) {
    const prod = matchProductByAliasOrName(it.alias || '');
    if (!prod) continue;
    const attrs = fillCategoryAttributes(prod, {
      option: it.option || guessOptionFromText(originalText, prod),
      size: it.size || guessSizeFromText(originalText, prod),
      spec: it.spec || ''
    });
    const qty = Math.max(1, Math.min(999, Number(it.qty) || 1));
    out.push({ product: prod, qty, ...attrs });
  }
  return out;
}

// ---- Customer info ----------------------------------------------------------

function sanitizePhone(p) { return (p || '').replace(/[^\d+]/g, ''); }
function isValidPhone(p) { const s = sanitizePhone(p); return /^(\+66|0)\d{8,9}$/.test(s); }
function parseCustomerInfo(note) {
  try {
    const obj = JSON.parse(note || '{}');
    return { phone: obj.phone || '', address: obj.address || '', paymentPref: obj.paymentPref || null };
  } catch { return { phone: '', address: '', paymentPref: null }; }
}

// ---- Startup & shutdown -----------------------------------------------------

app.listen(PORT, async () => {
  await ensureDataLoaded(true);
  console.log(`LINE commerce bot running on :${PORT}`);
});
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  console.log('Shutting down...'); setTimeout(() => process.exit(0), 500);
}
