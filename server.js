// ==========================================================
//  LINE x Google Sheets x OpenAI - Thai Pro Commerce Bot
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
  const headers = sheet.headerValues;
  return rows.map(r => {
    const o = {};
    headers.forEach(h => (o[h] = (r[h] ?? '').toString().trim()));
    return o;
  });
}

// append row to target sheet
async function appendRow(name, record) {
  const sheet = doc.sheetsByTitle[name];
  if (!sheet) throw new Error(`Sheet not found: ${name}`);
  await sheet.loadHeaderRow();
  await sheet.addRow(record);
}

function THB(n) {
  const v = Number(n || 0);
  return v.toLocaleString('th-TH', { style: 'currency', currency: 'THB', maximumFractionDigits: 0 });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ----------------------- CACHE ----------------------------
const cache = {
  products: [],
  promotions: [],
  faq: [],
  persona: null,
  payment: []
};

function normalizeThaiCommaText(s = '') {
  return s.replace(/\s+/g, ' ').trim();
}
function splitList(s = '') {
  return normalizeThaiCommaText(s).split(/,|，|\/|\|/).map(x => x.trim()).filter(Boolean);
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
    let discount = 0, detail = '';
    if (type === 'PERCENT') {
      const pct = Number(cond.percent || 0);
      discount = Math.floor(amount * pct / 100);
      detail = `ส่วนลด ${pct}%`;
    } else if (type === 'FIXED_DISCOUNT') {
      discount = Number(cond.amount || 0);
      detail = `ลดทันที ${THB(discount)}`;
    }
    if (discount > best.discount) {
      best = { discount, code: promo['รหัสโปรโมชั่น'] || '', detail: promo['รายละเอียดโปรโมชั่น'] || detail };
    }
  }
  return best;
}

// ----------------------- PAYMENT --------------------------
function pickPayment(category = 'all') {
  const rows = cache.payment;
  const cat = (category || '').toLowerCase();
  let row = rows.find(r => (r['category'] || '').toLowerCase() === cat);
  if (!row) row = rows.find(r => (r['category'] || '').toLowerCase() === 'all');
  if (!row) row = rows[0];
  return { method: row?.['method'] || 'โอน/พร้อมเพย์/COD', detail: row?.['detail'] || '', qrcode: row?.['qrcode'] || '' };
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

// ----------------------- SESSION --------------------------
const sessions = new Map();
function newSession(userId) {
  const s = { userId, stage: 'idle', currentItem: null, cart: [], address: '', phone: '', customer: '', lastActive: Date.now() };
  sessions.set(userId, s);
  return s;
}
function getSession(userId) {
  const s = sessions.get(userId);
  if (!s) return newSession(userId);
  s.lastActive = Date.now();
  return s;
}

// ----------------------- PRODUCT HELPERS ------------------
function searchProductsByText(text) {
  const tokens = splitList(text.toLowerCase()).concat([text.toLowerCase()]);
  const matched = new Set();
  for (const tok of tokens) {
    const arr = PRODUCT_ALIAS_INDEX.get(tok);
    if (arr) arr.forEach(p => matched.add(p));
  }
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

// ✅ ฟังก์ชันใหม่
function listAllNamPrik() {
  const np = cache.products.filter(p => (p['หมวดหมู่'] || '').toLowerCase().includes('น้ำพริก'));
  const names = [...new Set(np.map(p => p['ชื่อสินค้า']))];
  return names.length ? `น้ำพริกที่มีทั้งหมด:\n- ${names.join('\n- ')}` : 'ยังไม่มีข้อมูลน้ำพริกในระบบค่ะ';
}

// ----------------------- AI STYLE -------------------------
function buildSystemPrompt() {
  const ps = cache.persona || {};
  const agent = ps['ชื่อพนักงาน'] || 'แอดมิน';
  const tone = ps['บุคลิก'] || 'สุภาพ จริงใจ ช่วยเต็มที่';
  return `คุณคือ “${agent}” บุคลิก: ${tone}`;
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
        { role: 'user', content: `${extraContext?`[ข้อมูล]\n${extraContext}\n\n`:''}${userText}` }
      ]
    };
    const res = await openai.chat.completions.create(payload);
    return res.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}

// ----------------------- MESSAGE HELPERS ------------------
function msgText(text) { return { type: 'text', text }; }

// ----------------------- ORDER HELPERS --------------------
function calcCartSummary(cart) {
  const sub = cart.reduce((s, it) => s + (Number(it.price||0) * Number(it.qty||0)), 0);
  const promo = computePromotion(cart);
  const total = Math.max(0, sub - (promo.discount||0));
  return { sub, promo, total };
}

// ----------------------- FLOW -----------------------------
async function handleText(userId, replyToken, text) {
  const s = getSession(userId);

  // FAQ + น้ำพริกทั้งหมด
  const faqAns = matchFAQ(text);
  if (faqAns) {
    if (/น้ำพริก.*อะไร/i.test(text)) {
      const list = listAllNamPrik();
      await lineClient.replyMessage(replyToken, [msgText(list)]);
      return;
    }
    await lineClient.replyMessage(replyToken, [msgText(faqAns)]);
    return;
  }
  if (/น้ำพริก.*อะไร/i.test(text)) {
    const list = listAllNamPrik();
    await lineClient.replyMessage(replyToken, [msgText(list)]);
    return;
  }

  // fallback AI
  const ai = await aiReply(text);
  await lineClient.replyMessage(replyToken, [msgText(ai || 'รับทราบค่ะ 😊')]);
}

// ----------------------- SERVER ---------------------------
const app = express();
app.post('/webhook', lineMiddleware(lineConfig), async (req,res)=>{
  try {
    if (!cache.persona) await loadAllData();
    res.status(200).end();
    for (const ev of req.body.events||[]) {
      if (ev.type==='message' && ev.message?.type==='text') {
        const userId = ev.source?.userId || 'unknown';
        await handleText(userId, ev.replyToken, ev.message.text);
      }
    }
  } catch(e){ console.error(e); }
});
const PORT = process.env.PORT || 10000;
app.listen(PORT, async()=>{ await loadAllData(); console.log('Bot ready'); });
