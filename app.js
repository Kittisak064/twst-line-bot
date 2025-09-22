/**
 * LINE Commerce Bot — Express + Google Sheets + OpenAI
 * Version: 1.0.0 (Production-ready for Render)
 * Author: AI Developer Assistant
 *
 * Features:
 * - Conversational sales flow: greet -> recommend -> close, human-like & concise
 * - Multi-item cart per session (order with multiple SKUs)
 * - FAQ by keyword (strict, no hallucination)
 * - Promotions engine (Products / Categories)
 * - Personality sheet (name, tone, pronouns, fallback)
 * - Payment sheet (PromptPay QR, COD)
 * - Orders write-back; Sessions & Logs write-back
 * - LINE admin group notify on new orders (ADMIN_GROUP_ID)
 * - Always reply to every message (no silence)
 * - Compact natural responses, avoid repeating "สวัสดีค่ะ" every message
 * - Product taxonomy awareness: Chili paste ("รสชาติ/ขนาด"), Stair-climber ("รุ่น/สเปค")
 * - Resilient to additional columns: header-mapped access only (no fixed indices)
 * - Render-friendly (graceful shutdown, healthcheck, robust env handling)
 *
 * Sheets structure (headers can have more columns; we map by header text):
 * Products (รหัสสินค้า|ชื่อสินค้า|หมวดหมู่|ราคา|คำที่ลูกค้าเรียก|ตัวเลือก|ขนาด)
 * Promotions (รหัสโปรโมชั่น|รายละเอียดโปรโมชั่น|ประเภทคำนวณ|เงื่อนไข|ใช้กับสินค้า|ใช้กับหมวดหมู่)
 * FAQ (คำถาม|คำหลัก|คำตอบ)
 * Personality (ชื่อพนักงาน|ชื่อเพจ|บุคลิก|คำเรียกลูกค้า|คำเรียกตัวเองแอดมิน|คำตอบเมื่อไม่รู้|เพศ)
 * Orders (เลขที่ออเดอร์|รหัสสินค้า|ชื่อสินค้า|ตัวเลือก|จำนวน|ราคารวม|โปรโมชั่นที่ใช้|ชื่อ-ที่อยู่|เบอร์โทร|สถานะ)
 * Payment (category|method|detail|qrcode)
 * Sessions (timestamp|userId|stage|cart|note)
 * Logs (timestamp|userId|type|text)
 *
 * Stages:
 *  - INIT -> GREETED -> BROWSING -> CARTING -> CHECKOUT_INFO -> PAYMENT -> DONE
 *
 * Concision policy:
 *  - Max ~350 Thai characters per reply; short sentences; avoid filler.
 *  - First greet once per session; track last greeting timestamp; never greet every message.
 *
 * OpenAI usage:
 *  - Lightweight intent/entity parser; never trust LLM facts for prices/stock/FAQ. Cross-check with Sheets.
 *  - If LLM unclear, fallback to rule-based keyword.
 *
 * LINE:
 *  - Reply to every text event.
 *  - Push admin group when order placed.
 *
 * Security:
 *  - No PII logs in console; only in Sheets Logs (minimal).
 *  - Google private key newline fix.
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

// timeouts & retry
const HTTP_TIMEOUT_MS = 12000;

// Sheet names (allow Thai headers in rows)
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

// Session in-memory cache to avoid extra round-trips (still persist to Sheets)
const sessionCache = new Map(); // key: userId -> { stage, cart, lastGreetAt, note, updatedAt }

// In-memory data caches for catalog and configs (auto-refresh)
let cache = {
  products: [],
  promotions: [],
  faq: [],
  personality: null,
  payments: [],
  lastLoadedAt: 0
};

const CACHE_TTL_MS = 1000 * 60 * 2; // 2 minutes

// ---- Google Sheets Client ---------------------------------------------------

const auth = new google.auth.JWT({
  email: GOOGLE_CLIENT_EMAIL,
  key: GOOGLE_PRIVATE_KEY,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

// Utility: read entire sheet with header mapping
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
    requestBody: {
      values: [rowArray]
    }
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

function normalizeProducts(rows) {
  // map known headers; preserve unknown columns in meta
  return rows.map(r => ({
    code: r['รหัสสินค้า'] || r['sku'] || r['code'] || '',
    name: r['ชื่อสินค้า'] || r['name'] || '',
    category: r['หมวดหมู่'] || r['category'] || '',
    price: toNumber(r['ราคา'] || r['price'] || '0'),
    aliases: splitCSV(r['คำที่ลูกค้าเรียก'] || r['aliases'] || ''),
    options: splitCSV(r['ตัวเลือก'] || r['options'] || ''), // e.g., รสชาติ/รุ่น
    size: splitCSV(r['ขนาด'] || r['size'] || ''),
    meta: r
  })).filter(p => p.code && p.name);
}

function normalizePromotions(rows) {
  return rows.map(r => ({
    code: r['รหัสโปรโมชั่น'] || r['promo_code'] || '',
    description: r['รายละเอียดโปรโมชั่น'] || r['description'] || '',
    type: (r['ประเภทคำนวณ'] || r['type'] || '').toLowerCase().trim(), // percent | amount | bundle | threshold
    condition: r['เงื่อนไข'] || r['condition'] || '', // JSON or simple (e.g., MIN=500, BUY3GET1)
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
  // pick first if multiple
  if (!list || list.length === 0) {
    return {
      staffName: 'ทีมงาน',
      pageName: 'เพจของเรา',
      persona: 'กระชับ อัธยาศัยดี ตรงประเด็น',
      customerPronoun: 'ลูกค้า',
      adminSelf: 'แอดมิน',
      dontKnow: 'ขอเช็กข้อมูลก่อนนะคะ แล้วจะรีบแจ้งค่ะ',
      gender: 'female'
    };
  }
  const r = list[0];
  return {
    staffName: r['ชื่อพนักงาน'] || 'ทีมงาน',
    pageName: r['ชื่อเพจ'] || 'เพจของเรา',
    persona: r['บุคลิก'] || 'กระชับ อัธยาศัยดี ตรงประเด็น',
    customerPronoun: r['คำเรียกลูกค้า'] || 'ลูกค้า',
    adminSelf: r['คำเรียกตัวเองแอดมิน'] || 'แอดมิน',
    dontKnow: r['คำตอบเมื่อไม่รู้'] || 'ขอเช็กข้อมูลก่อนนะคะ แล้วจะรีบแจ้งค่ะ',
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

function splitCSV(s) {
  return (s || '')
    .split(/[,|/、]+/).map(x => x.trim()).filter(Boolean);
}

function toNumber(x) {
  const n = Number((x || '0').toString().replace(/[^\d.]/g, ''));
  return isNaN(n) ? 0 : n;
}

// ---- Helper: Logging to Sheets ---------------------------------------------

async function logEvent(userId, type, text) {
  try {
    const ts = new Date().toISOString();
    await appendRow(SHEETS.LOGS, [ts, userId || '-', type || '-', (text || '').slice(0, 1200)]);
  } catch (e) {
    // Avoid throwing; print minimal
    console.error('Log append failed:', e.message);
  }
}

// ---- Session Management -----------------------------------------------------

function getSession(userId) {
  const s = sessionCache.get(userId);
  if (s) return s;
  const newS = {
    stage: 'INIT',
    cart: [], // [{code, name, category, unitPrice, qty, option, size, spec}]
    lastGreetAt: 0,
    note: '',
    updatedAt: Date.now()
  };
  sessionCache.set(userId, newS);
  return newS;
}

async function persistSession(userId) {
  try {
    const s = sessionCache.get(userId);
    if (!s) return;
    const ts = new Date().toISOString();
    const cartStr = JSON.stringify(s.cart);
    await appendRow(SHEETS.SESSIONS, [ts, userId, s.stage, cartStr, s.note || '']);
  } catch (e) {
    console.error('Persist session failed:', e.message);
  }
}

// ---- Promotions Engine ------------------------------------------------------

function applyPromotions(cartItems) {
  // Returns { items:[... with line totals], promoApplied:[codes], discountTotal, subtotal, total }
  const items = cartItems.map(it => ({
    ...it,
    lineSubtotal: it.unitPrice * it.qty
  }));
  const subtotal = items.reduce((a, b) => a + b.lineSubtotal, 0);
  let discountTotal = 0;
  const applied = [];

  // Evaluate each promotion rule
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
        // condition like "RATE=10" -> 10% off
        const rate = parseKeyVal(p.condition, 'RATE', 0);
        if (rate > 0) {
          promoDiscount = (scopeSum * rate) / 100;
        }
        break;
      }
      case 'amount': {
        // condition like "AMOUNT=100"
        const amt = parseKeyVal(p.condition, 'AMOUNT', 0);
        if (amt > 0 && scopeSum >= amt) {
          promoDiscount = amt;
        }
        break;
      }
      case 'threshold': {
        // condition: "MIN=500;RATE=10" or "MIN=1000;AMOUNT=100"
        const min = parseKeyVal(p.condition, 'MIN', 0);
        if (scopeSum >= min) {
          const rate = parseKeyVal(p.condition, 'RATE', 0);
          const amt = parseKeyVal(p.condition, 'AMOUNT', 0);
          if (rate > 0) promoDiscount = (scopeSum * rate) / 100;
          else if (amt > 0) promoDiscount = amt;
        }
        break;
      }
      case 'bundle': {
        // condition: "BUY=3;GET=1;ITEM=รหัส" or category-wide
        const buy = parseKeyVal(p.condition, 'BUY', 0);
        const get = parseKeyVal(p.condition, 'GET', 0);
        const promoItem = parseKeyValStr(p.condition, 'ITEM', '');
        let bundleItems = scopeItems;
        if (promoItem) bundleItems = scopeItems.filter(it => it.code === promoItem);
        if (buy > 0 && get > 0 && bundleItems.length > 0) {
          // free items value equals cheapest 'get' count per floor(qty/buy)*get
          for (const target of bundleItems) {
            const quota = Math.floor(target.qty / buy) * get;
            if (quota > 0) {
              // discount value: unitPrice * quota
              promoDiscount += target.unitPrice * quota;
            }
          }
        }
        break;
      }
      default:
        break;
    }

    if (promoDiscount > 0.001) {
      discountTotal += promoDiscount;
      applied.push(p.code);
    }
  }

  // ensure not exceed subtotal
  discountTotal = Math.min(discountTotal, subtotal);
  const total = Math.max(subtotal - discountTotal, 0);

  return {
    items,
    promoApplied: applied,
    discountTotal: round2(discountTotal),
    subtotal: round2(subtotal),
    total: round2(total)
  };
}

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

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---- LINE SDK lightweight helpers ------------------------------------------

function verifyLineSignature(rawBody, signature) {
  const hmac = crypto.createHmac('sha256', LINE_CHANNEL_SECRET);
  hmac.update(rawBody);
  const digest = hmac.digest('base64');
  return digest === signature;
}

async function lineReply(replyToken, messages) {
  try {
    await axios.post(LINE_API_REPLY, { replyToken, messages }, {
      headers: {
        'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: HTTP_TIMEOUT_MS
    });
  } catch (e) {
    console.error('LINE reply failed:', e.response?.status, e.response?.data || e.message);
  }
}

async function linePush(to, messages) {
  try {
    await axios.post(LINE_API_PUSH, { to, messages }, {
      headers: {
        'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: HTTP_TIMEOUT_MS
    });
  } catch (e) {
    console.error('LINE push failed:', e.response?.status, e.response?.data || e.message);
  }
}

// ---- OpenAI Intent Extraction (lightweight) --------------------------------

async function parseIntentLLM(text, context) {
  // Keep it minimal; return { intent, items:[{alias,qty,option,size,spec}], phone, address, paymentPref }
  // We will double-check all outputs with Sheets; never trust LLM for prices/IDs.
  const sys = `คุณเป็นตัวช่วยสรุปเจตนาสั้นๆ สำหรับแชทขายของ LINE ภาษาไทย
- คืนค่ารูป JSON เท่านั้น ห้ามบรรยาย
- intents: ["greet","browse","add_to_cart","remove_from_cart","checkout","faq","payment","address","phone","confirm","cancel","unknown"]
- fields: items(alias, qty, option, size, spec), phone, address, paymentPref ("promptpay"|"cod"|null), faqKeywords[]`;

  const usr = `ข้อความลูกค้า: """${text}"""
บริบท: ${JSON.stringify({
    stage: context.stage,
    hasCart: context.cart?.length > 0
  })}`;

  try {
    const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      temperature: 0.1,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: usr }
      ],
      response_format: { type: 'json_object' }
    }, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: HTTP_TIMEOUT_MS
    });

    const json = resp.data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(json);
    // sanitize
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

// ---- NLP-lite: Keyword fallback --------------------------------------------

function simpleKeywordClassifier(text) {
  const t = (text || '').toLowerCase();
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

// ---- Catalog search & matching ---------------------------------------------

function matchProductByAliasOrName(input) {
  const t = (input || '').toLowerCase();
  // exact code
  let p = cache.products.find(x => x.code.toLowerCase() === t);
  if (p) return p;
  // name contains
  p = cache.products.find(x => x.name.toLowerCase().includes(t));
  if (p) return p;
  // alias contains any
  p = cache.products.find(x => x.aliases.some(a => t.includes(a.toLowerCase())));
  return p || null;
}

function listBriefByCategory(cat) {
  const arr = cache.products.filter(p => p.category === cat);
  return arr.slice(0, 6).map(p => `${p.name} ${priceTHB(p.price)}`).join(' • ');
}

function priceTHB(n) {
  return `${round2(n).toLocaleString('th-TH')} บาท`;
}

// ---- FAQ strict matching ----------------------------------------------------

function answerFAQByKeywords(text) {
  const tokens = tokenizeTH(text);
  // Find best match by keyword intersection size
  let best = null;
  let bestScore = 0;
  for (const f of cache.faq) {
    const score = f.keywords.reduce((acc, kw) => acc + (tokens.has(kw) ? 1 : 0), 0);
    if (score > bestScore) {
      best = f;
      bestScore = score;
    }
  }
  if (best && bestScore > 0) return best.a;
  return null;
}

function tokenizeTH(s) {
  const low = (s || '').toLowerCase();
  const words = low.split(/[^ก-๙a-z0-9]+/).filter(Boolean);
  return new Set(words);
}

// ---- Response builder (concise, human-like) --------------------------------

function makeReply(text, quick = []) {
  // ensure concise
  const t = (text || '').trim();
  const clipped = t.length > 380 ? t.slice(0, 377) + '…' : t;
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

function customerName() {
  return cache.personality?.customerPronoun || 'ลูกค้า';
}

function staffPrefix() {
  // female => ค่ะ, male => ครับ, neutral => ครับ/ค่ะ
  const g = cache.personality?.gender || 'female';
  return g === 'male' ? 'ครับ' : 'ค่ะ';
}

function avoidRepeatGreet(session) {
  const now = Date.now();
  if (now - (session.lastGreetAt || 0) < 1000 * 60 * 60) return false; // 1 hr
  session.lastGreetAt = now;
  return true;
}

function greetOnce(session) {
  if (!avoidRepeatGreet(session)) return null;
  const name = cache.personality?.staffName || 'ทีมงาน';
  const page = cache.personality?.pageName || 'เพจของเรา';
  const persona = cache.personality?.persona || '';
  // concise greeting
  const greet = `${name}จาก ${page} ค่ะ — ต้องการดูสินค้าอะไรเป็นพิเศษไหมคะ`;
  return greet;
}

function shortConfirm(text) {
  return `${text} ${staffPrefix()}`;
}

// ---- Cart Operations --------------------------------------------------------

function addItemsToCart(session, items) {
  // items: [{product, qty, option, size, spec}]
  for (const it of items) {
    const key = `${it.product.code}|${it.option || ''}|${it.size || ''}|${it.spec || ''}`;
    const existing = session.cart.find(x =>
      x.code === it.product.code &&
      (x.option || '') === (it.option || '') &&
      (x.size || '') === (it.size || '') &&
      (x.spec || '') === (it.spec || '')
    );
    if (existing) {
      existing.qty += it.qty;
      existing.updatedAt = Date.now();
    } else {
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
    if (x.code.toLowerCase() === aliasOrCode.toLowerCase()) return false;
    const p = matchProductByAliasOrName(aliasOrCode);
    if (p && p.code === x.code) return false;
    return true;
  });
  return before !== session.cart.length;
}

function cartSummary(session) {
  if (!session.cart.length) return 'ตะกร้าว่าง';
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

// ---- Category-aware option helpers -----------------------------------------

function fillCategoryAttributes(product, requested) {
  // For chili paste: option -> รสชาติ, size -> ขนาด
  // For stair-climber: option -> รุ่น, spec -> สเปค
  const pCat = product.category || '';
  const out = { option: '', size: '', spec: '' };

  if (/น้ำพริก/.test(pCat)) {
    // map requested.option to รสชาติ
    out.option = pickFirstMatch(requested.option, product.options) || '';
    out.size = pickFirstMatch(requested.size, product.size) || '';
  } else if (/(รถเข็น|ไต่บันได|stair|ตีนตะขาบ|ขนของ)/i.test(pCat)) {
    out.option = pickFirstMatch(requested.option, product.options) || '';
    out.spec = requested.spec || '';
    out.size = pickFirstMatch(requested.size, product.size) || '';
  } else {
    // generic
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

// ---- Payment helpers --------------------------------------------------------

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
  if (/พร้อมเพย์|promptpay/.test(low)) {
    const p = cache.payments.find(x => /promptpay/i.test(x.method));
    return p || null;
  }
  if (/cod|ปลายทาง/.test(low)) {
    const p = cache.payments.find(x => /cod|ปลายทาง/i.test(x.method));
    return p || null;
  }
  // default first
  return cache.payments[0] || null;
}

// ---- Orders write-back & Admin notify --------------------------------------

async function createOrderAndNotify(userId, session, customer) {
  const { subtotal, discountTotal, total, promoApplied, items } = applyPromotions(session.cart);

  const orderId = `OD-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${rand4()}`;

  const promoStr = promoApplied.join(',');
  const lines = [];
  for (const it of items) {
    lines.push([
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

  // Append each line
  for (const row of lines) {
    await appendRow(SHEETS.ORDERS, row);
  }

  // Admin push
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

function rand4() {
  return Math.floor(1000 + Math.random() * 9000);
}

// ---- Express App ------------------------------------------------------------

const app = express();

// Raw body buffer for LINE signature verification
app.use('/webhook', bodyParser.raw({ type: '*/*' }));

// JSON body elsewhere
app.use(bodyParser.json());

// Healthcheck
app.get('/healthz', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Manual reload cache
app.post('/reload', async (req, res) => {
  try {
    await ensureDataLoaded(true);
    res.json({ reloadedAt: cache.lastLoadedAt, personality: cache.personality?.staffName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// LINE webhook
app.post('/webhook', async (req, res) => {
  try {
    const signature = req.get('X-Line-Signature') || '';
    const rawBody = req.body; // Buffer (because of bodyParser.raw)
    const rawString = rawBody.toString('utf8');

    // Verify signature
    if (!verifyLineSignature(rawString, signature)) {
      return res.status(401).send('Unauthorized');
    }

    // Must respond 200 quickly
    res.status(200).send('OK');

    // Process events async (but within this request lifecycle; no queue)
    const body = JSON.parse(rawString);
    await ensureDataLoaded(false);

    for (const event of body.events || []) {
      if (event.type === 'message' && event.message?.type === 'text') {
        handleTextMessage(event).catch(e => console.error('handleTextMessage error:', e.message));
      } else {
        // Always respond something (stickers/location ignored, but we reply a short text)
        const replyToken = event.replyToken;
        if (replyToken) {
          const msg = makeReply(`รับทราบค่ะ พิมพ์ชื่อสินค้าหรือคำถามได้เลย`, ['ดูโปร', 'สรุปตะกร้า', 'เช็กเอาท์']);
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

  // Greeting control (not every message)
  let greeting = null;
  if (session.stage === 'INIT') {
    greeting = greetOnce(session);
    session.stage = 'GREETED';
  }

  // 1) FAQ strict first (if message seems FAQ)
  const faqAnswer = answerFAQByKeywords(text);
  if (faqAnswer) {
    const reply = makeReply(faqAnswer);
    const msgs = greeting ? [makeReply(greeting), reply] : [reply];
    await lineReply(replyToken, msgs);
    await persistSession(userId);
    await logEvent(userId, 'OUT', faqAnswer);
    return;
  }

  // 2) Intent parsing (LLM then fallback)
  const llm = await parseIntentLLM(text, session);
  const fallbackIntent = simpleKeywordClassifier(text);
  const intent = llm.intent === 'unknown' ? fallbackIntent : llm.intent;

  // 3) Handle intents
  switch (intent) {
    case 'greet': {
      const g = greetOnce(session);
      const say = g || `มีอะไรให้ช่วยแนะนำไหมคะ`;
      const msg = makeReply(say, ['ดูโปร', 'สินค้าแนะนำ', 'สรุปตะกร้า']);
      await lineReply(replyToken, [msg]);
      break;
    }
    case 'browse': {
      // Try match product name/alias from message directly
      const maybeProduct = tryExtractProductFromText(text);
      if (maybeProduct) {
        const brief = productBrief(maybeProduct);
        const msg = makeReply(brief, quickForProduct(maybeProduct));
        await lineReply(replyToken, greeting ? [makeReply(greeting), msg] : [msg]);
        break;
      }
      // category hints
      const cat = guessCategory(text);
      if (cat) {
        const list = listBriefByCategory(cat);
        const msg = makeReply(`กลุ่ม ${cat}: ${list || '—'}`, ['ดูโปร', 'สรุปตะกร้า', 'เช็กเอาท์']);
        await lineReply(replyToken, greeting ? [makeReply(greeting), msg] : [msg]);
        break;
      }
      // default ask
      {
        const msg = makeReply(`พิมพ์ชื่อสินค้า/รหัสได้เลย เช่น "น้ำพริกเห็ด ขนาด 120g" หรือ "รถเข็นไต่บันได รุ่นท็อป"`, ['ดูโปร', 'สรุปตะกร้า']);
        await lineReply(replyToken, greeting ? [makeReply(greeting), msg] : [msg]);
      }
      break;
    }
    case 'add_to_cart': {
      const toAdd = mapParsedItemsToProducts(llm.items, text);
      if (toAdd.length === 0) {
        // fallback: try direct
        const p = tryExtractProductFromText(text);
        if (p) {
          const attrs = fillCategoryAttributes(p, { option: '', size: '', spec: '' });
          addItemsToCart(session, [{ product: p, qty: 1, ...attrs }]);
          const msg = makeReply(shortConfirm(`เพิ่ม ${p.name} x1 ลงตะกร้าแล้ว`), ['สรุปตะกร้า', 'เช็กเอาท์', 'ดูโปร']);
          await lineReply(replyToken, greeting ? [makeReply(greeting), msg] : [msg]);
          break;
        }
        const msg = makeReply(`ยังไม่เจอสินค้าในคลัง ลองพิมพ์ชื่อให้ชัดอีกนิดนะคะ`, ['สินค้าแนะนำ', 'ดูโปร']);
        await lineReply(replyToken, greeting ? [makeReply(greeting), msg] : [msg]);
        break;
      }
      // add all
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
      // Update session stage
      session.stage = 'CHECKOUT_INFO';
      // Ask for missing info
      const need = [];
      if (!session.cart.length) {
        const msg = makeReply(`ตะกร้าว่าง ลองเพิ่มสินค้าก่อนนะคะ`, ['สินค้าแนะนำ', 'ดูโปร']);
        await lineReply(replyToken, [msg]);
        break;
      }
      // Customer info draft in note (JSON)
      let info = parseCustomerInfo(session.note);
      // merge LLM extracted
      if (llm.phone) info.phone = sanitizePhone(llm.phone);
      if (llm.address) info.address = llm.address.trim();
      if (llm.paymentPref) info.paymentPref = llm.paymentPref;

      const missingPhone = !isValidPhone(info.phone);
      const missingAddress = !info.address;
      const missingPayment = !info.paymentPref;

      let prompt = [];
      if (missingPhone) prompt.push('เบอร์โทร');
      if (missingAddress) prompt.push('ที่อยู่จัดส่ง');
      if (missingPayment) prompt.push('วิธีชำระ (พร้อมเพย์/ปลายทาง)');

      if (prompt.length) {
        const msg = makeReply(`ขอ${prompt.join(' + ')}นะคะ`, [
          ...paymentChoices(),
          'สรุปตะกร้า',
          'ยืนยันสั่งซื้อ'
        ]);
        // keep info
        session.note = JSON.stringify(info);
        await lineReply(replyToken, greeting ? [makeReply(greeting), msg] : [msg]);
        break;
      }

      // show grand total and provide payment payload
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
      // need: phone, address, payment
      let info = parseCustomerInfo(session.note);
      if (!isValidPhone(info.phone) || !info.address || !info.paymentPref) {
        const msg = makeReply(`ข้อมูลยังไม่ครบค่ะ พิมพ์: เบอร์/ที่อยู่/วิธีชำระ`, paymentChoices());
        await lineReply(replyToken, [msg]);
        break;
      }
      // create order
      const customer = {
        name: customerName(), // placeholder; could extend to ask
        phone: info.phone,
        address: info.address
      };
      const { orderId, total } = await createOrderAndNotify(userId, session, customer);

      // reset cart, stage
      session.stage = 'DONE';
      session.cart = [];

      const say = `เลขที่ออเดอร์ ${orderId} ยอดสุทธิ ${priceTHB(total)} ${staffPrefix()}`;
      const payInfo = paymentPayload(info.paymentPref);
      const payHint = payInfo?.qrcode ? `แนบ QR แล้วนะคะ โอนแล้วแจ้งสลิปได้เลย` : `ชำระตามวิธีที่เลือกได้เลยค่ะ`;
      const msg = makeReply(`${say}\n${payHint}`, ['สั่งเพิ่ม', 'เช็กสถานะ']);
      await lineReply(replyToken, [msg]);
      break;
    }
    case 'cancel': {
      session.stage = 'BROWSING';
      session.cart = [];
      const msg = makeReply(shortConfirm('ยกเลิกออเดอร์ให้แล้ว'), ['สินค้าแนะนำ', 'ดูโปร']);
      await lineReply(replyToken, [msg]);
      break;
    }
    case 'faq': {
      const ans = answerFAQByKeywords(text) || cache.personality?.dontKnow || 'ขอเช็กข้อมูลก่อนนะคะ';
      const msg = makeReply(ans);
      await lineReply(replyToken, greeting ? [makeReply(greeting), msg] : [msg]);
      break;
    }
    default: {
      // Utility commands
      if (/สรุปตะกร้า|ตะกร้า|cart/i.test(text)) {
        const msg = makeReply(cartSummary(session), ['เช็กเอาท์', 'ดูโปร']);
        await lineReply(replyToken, [msg]);
      } else if (/ดูโปร|โปรโมชั่น/i.test(text)) {
        const list = cache.promotions.slice(0, 6).map(p => `• ${p.code}: ${p.description}`).join('\n') || 'ตอนนี้ไม่มีโปรค่ะ';
        const msg = makeReply(list, ['สรุปตะกร้า', 'เช็กเอาท์']);
        await lineReply(replyToken, [msg]);
      } else if (/ยืนยัน/.test(text)) {
        // map to confirm
        const fakeEvent = { ...event, message: { ...event.message, text: 'confirm' } };
        await handleTextMessage(fakeEvent);
        return;
      } else if (/เปลี่ยนวิธีชำระ/.test(text)) {
        let info = parseCustomerInfo(session.note);
        info.paymentPref = null;
        session.note = JSON.stringify(info);
        const msg = makeReply('เลือกวิธีชำระใหม่ค่ะ', paymentChoices());
        await lineReply(replyToken, [msg]);
      } else if (/แก้ไขที่อยู่/.test(text)) {
        let info = parseCustomerInfo(session.note);
        info.address = '';
        session.note = JSON.stringify(info);
        const msg = makeReply('พิมพ์ที่อยู่ใหม่ได้เลยค่ะ', ['ใช้พร้อมเพย์', 'เก็บปลายทาง']);
        await lineReply(replyToken, [msg]);
      } else if (/สินค้าแนะนำ/.test(text)) {
        const grp = pickRecommendations();
        const msg = makeReply(`แนะนำ: ${grp}`, ['ดูโปร', 'สรุปตะกร้า', 'เช็กเอาท์']);
        await lineReply(replyToken, [msg]);
      } else {
        // fallback unknown -> try FAQ again else persona.dontKnow
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

// ---- Util: Recommendation ---------------------------------------------------

function pickRecommendations() {
  // simple: top 3 newest (by list order) from two categories if exist
  const cats = Array.from(new Set(cache.products.map(p => p.category))).slice(0, 2);
  const names = [];
  for (const c of cats) {
    names.push(...cache.products.filter(p => p.category === c).slice(0, 2).map(p => `${p.name} ${priceTHB(p.price)}`));
  }
  if (names.length === 0) names.push(...cache.products.slice(0, 3).map(p => `${p.name} ${priceTHB(p.price)}`));
  return names.slice(0, 4).join(' • ');
}

// ---- Util: extractors -------------------------------------------------------

function tryExtractProductFromText(text) {
  // try by alias or name mention
  // check all products and pick the longest name match
  const t = text.toLowerCase();
  let best = null;
  let bestLen = 0;
  for (const p of cache.products) {
    if (t.includes(p.name.toLowerCase()) && p.name.length > bestLen) {
      best = p; bestLen = p.name.length;
    }
    for (const a of p.aliases) {
      if (t.includes(a.toLowerCase()) && a.length > bestLen) {
        best = p; bestLen = a.length;
      }
    }
    if (t.includes(p.code.toLowerCase()) && p.code.length > bestLen) {
      best = p; bestLen = p.code.length;
    }
  }
  return best;
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

function guessCategory(s) {
  const t = (s || '').toLowerCase();
  if (/น้ำพริก|chili|chilli|chili paste/.test(t)) return 'น้ำพริก';
  if (/รถเข็น|stair|ไต่บันได|ตีนตะขาบ|ขนของ/.test(t)) return 'รถเข็นไต่บันได';
  return null;
}

function guessOptionFromText(text, prod) {
  const t = (text || '').toLowerCase();
  for (const o of prod.options || []) {
    if (t.includes(o.toLowerCase())) return o;
  }
  // synonyms for chili
  if (/เผ็ดน้อย|ไม่เผ็ด/.test(t)) return 'เผ็ดน้อย';
  if (/เผ็ดมาก|โคตรเผ็ด|เผ็ดจัด/.test(t)) return 'เผ็ดมาก';
  return '';
}

function guessSizeFromText(text, prod) {
  const t = (text || '').toLowerCase();
  for (const s of prod.size || []) {
    if (t.includes(s.toLowerCase())) return s;
  }
  const m = /(\d+)\s*(g|กรัม|ml|มล)/.exec(t);
  if (m) return `${m[1]}${m[2]}`;
  return '';
}

function sanitizePhone(p) {
  return (p || '').replace(/[^\d+]/g, '');
}
function isValidPhone(p) {
  const s = sanitizePhone(p);
  return /^(\+66|0)\d{8,9}$/.test(s);
}

function parseCustomerInfo(note) {
  try {
    const obj = JSON.parse(note || '{}');
    return {
      phone: obj.phone || '',
      address: obj.address || '',
      paymentPref: obj.paymentPref || null
    };
  } catch {
    return { phone: '', address: '', paymentPref: null };
  }
}

// ---- Startup ----------------------------------------------------------------

app.listen(PORT, async () => {
  await ensureDataLoaded(true);
  console.log(`LINE commerce bot running on :${PORT}`);
});

// ---- Graceful shutdown ------------------------------------------------------

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down...');
  setTimeout(() => process.exit(0), 500);
}

// ------------------- END OF FILE (600+ lines including comments) ------------
