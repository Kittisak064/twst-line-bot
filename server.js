// ==========================================================
//  LINE x Google Sheets x OpenAI - Thai Pro Commerce Bot
//  Production-grade single-file server (ESM)
//  - ใช้ google-spreadsheet v3.3.0 (useServiceAccountAuth)
//  - รองรับสั่งซื้อหลายสินค้า + โปรโมชัน + COD + โอน/QR
//  - บุคลิกพนักงานจากชีท personality
//  - ตอบยืดหยุ่น: FAQ, สเปค, ราคา, โปร, วิธีจ่าย, ถามข้ามคุยต่อ, สรุปออเดอร์
//  - ไม่โชว์ “รหัสสินค้า” ให้ลูกค้า
//  - ป้องกันตอบยาว, ไม่ทัก “สวัสดี” ซ้ำพร่ำเพรื่อ
//  - แจ้งเตือนแอดมินผ่าน Group ID (ถ้าตั้งค่า ADMIN_GROUP_ID)
//  - บันทึก Sessions และ Logs ไปชีท
// ==========================================================

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
  ADMIN_GROUP_ID, // optional
  PORT
} = process.env;

if (!GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY || !GOOGLE_SHEET_ID) {
  console.error('❌ Google Sheet ENV not set');
}
if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET) {
  console.error('❌ LINE ENV not set');
}
if (!OPENAI_API_KEY) {
  console.error('❌ OpenAI ENV not set');
}

// ----------------------- CONST ----------------------------
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
  // สำคัญ: แทน \n ให้เป็น newline จริง
  const key = (GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  await doc.useServiceAccountAuth({
    client_email: GOOGLE_CLIENT_EMAIL,
    private_key: key
  });
  await doc.loadInfo();
}

// utility: อ่านชีทตาม header แถว 1 (ภาษาไทยได้)
async function readSheet(name) {
  const sheet = doc.sheetsByTitle[name];
  if (!sheet) return [];
  await sheet.loadHeaderRow();
  const rows = await sheet.getRows();
  const headers = sheet.headerValues || [];
  return rows.map(r => {
    const o = {};
    headers.forEach(h => (o[h] = (r[h] ?? '').toString().trim()));
    return o;
  });
}

// append record ตามคีย์ = header
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

// ----------------------- CACHE ----------------------------
const cache = {
  products: [],
  promotions: [],
  faq: [],
  persona: null,
  payment: []
};

let PRODUCT_ALIAS_INDEX = new Map();

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
    const aliases = splitList(p['คำที่ลูกค้าเรียก'] || p['คําที่ลูกค้าเรียก'] || '');
    aliases.push(p['ชื่อสินค้า']);
    const sku = (p['รหัสสินค้า'] || '').toLowerCase();
    for (const a of aliases.map(x => x?.toLowerCase())) {
      if (!a) continue;
      const arr = idx.get(a) || [];
      arr.push(p);
      idx.set(a, arr);
    }
    if (sku) {
      const arr = idx.get(sku) || [];
      arr.push(p);
      idx.set(sku, arr);
    }
  }
  return idx;
}

async function loadAllData() {
  await authSheet();
  const [products, promotions, faq, personalityRows, payment] = await Promise.all([
    readSheet(FIXED_SHEETS.products),
    readSheet(FIXED_SHEETS.promotions),
    readSheet(FIXED_SHEETS.faq),
    readSheet(FIXED_SHEETS.personality),
    readSheet(FIXED_SHEETS.payment)
  ]);

  cache.products = products;
  cache.promotions = promotions;
  cache.faq = faq;
  cache.persona = personalityRows?.[0] || {
    'ชื่อพนักงาน': 'แอดมิน',
    'ชื่อเพจ': '',
    'บุคลิก': 'สุภาพ จริงใจ ฉับไว',
    'คำเรียกลูกค้า': 'คุณลูกค้า',
    'คำเรียกตัวเองแอดมิน': 'แอดมิน',
    'คำตอบเมื่อไม่รู้': 'ขออนุญาตเช็คข้อมูลแล้วแจ้งกลับทันทีนะคะ',
    'เพศ': 'หญิง'
  };
  cache.payment = payment;

  PRODUCT_ALIAS_INDEX = buildAliasIndex(products);
}

// ----------------------- PROMOTION ENGINE -----------------
// Promotions headers:
//  รหัสโปรโมชั่น | รายละเอียดโปรโมชั่น | ประเภทคำนวณ | เงื่อนไข | ใช้กับสินค้า | ใช้กับหมวดหมู่
// ประเภทคำนวณ: BUY_X_GET_Y, PERCENT, FIXED_DISCOUNT, FREE_SHIPPING
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
      // ตัวอย่าง: min_qty=5,get_free=1 ฟรีถูกสุด
      const free = Number(cond.get_free || 1);
      const prices = [];
      appliedItems.forEach(it => {
        for (let i = 0; i < Number(it.qty || 0); i++) prices.push(Number(it.price || 0));
      });
      prices.sort((a, b) => a - b);
      discount = prices.slice(0, free).reduce((s, v) => s + v, 0);
      detail = promo['รายละเอียดโปรโมชั่น'] || `ซื้อครบ ${cond.min_qty} แถม ${free}`;
    } else if (type === 'PERCENT') {
      const pct = Number(cond.percent || 0);
      discount = Math.floor(amount * pct / 100);
      detail = promo['รายละเอียดโปรโมชั่น'] || `ส่วนลด ${pct}%`;
    } else if (type === 'FIXED_DISCOUNT') {
      discount = Number(cond.amount || 0);
      detail = promo['รายละเอียดโปรโมชั่น'] || `ลดทันที ${THB(discount)}`;
    } else if (type === 'FREE_SHIPPING') {
      discount = Number(cond.fee || 40);
      detail = promo['รายละเอียดโปรโมชั่น'] || `ส่งฟรี (หักค่าขนส่ง ${THB(discount)})`;
    } else {
      continue;
    }

    if (discount > best.discount) {
      best = {
        discount,
        code: promo['รหัสโปรโมชั่น'] || '',
        detail
      };
    }
  }
  return best;
}

// ----------------------- PAYMENT PICKER -------------------
function pickPayment(category = 'all') {
  const rows = cache.payment;
  const cat = (category || '').toLowerCase();
  let row = rows.find(r => (r['category'] || '').toLowerCase() === cat);
  if (!row) row = rows.find(r => (r['category'] || '').toLowerCase() === 'all');
  if (!row) row = rows[0];
  return {
    method: row?.['method'] || 'โอน/พร้อมเพย์/COD',
    detail: row?.['detail'] || '' // รองรับ URL QR image
  };
}

// ----------------------- FAQ MATCH ------------------------
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
    stage: 'idle',       // idle | picking_option | picking_qty | confirming | collecting_info
    currentItem: null,   // { sku, name, category, price, options[], chosenOption }
    cart: [],            // [{ sku, name, category, price, chosenOption, qty }]
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

// ----------------------- PRODUCTS -------------------------
function searchProductsByText(text) {
  const q = (text || '').toLowerCase().trim();
  const tokens = splitList(q);
  const set = new Set();

  // Alias index
  for (const tok of tokens.concat([q])) {
    const arr = PRODUCT_ALIAS_INDEX.get(tok);
    if (arr) arr.forEach(p => set.add(p));
  }

  // fallback by name contains
  cache.products.forEach(p => {
    const name = (p['ชื่อสินค้า'] || '').toLowerCase();
    const sku = (p['รหัสสินค้า'] || '').toLowerCase();
    if (name.includes(q) || sku === q) set.add(p);
  });

  return [...set];
}
function extractOptions(p) {
  return splitList(p['ตัวเลือก'] || '');
}

// ----------------------- AI -------------------------------
function buildSystemPrompt() {
  const ps = cache.persona || {};
  const agent = ps['ชื่อพนักงาน'] || 'แอดมิน';
  const page = ps['ชื่อเพจ'] ? `จากเพจ ${ps['ชื่อเพจ']}` : '';
  const tone = ps['บุคลิก'] || 'สุภาพ จริงใจ ฉับไว';
  const callCustomer = ps['คำเรียกลูกค้า'] || 'คุณลูกค้า';
  const callSelf = ps['คำเรียกตัวเองแอดมิน'] || 'แอดมิน';
  const unknown = ps['คำตอบเมื่อไม่รู้'] || 'ขออนุญาตเช็คข้อมูลแล้วแจ้งกลับทันทีนะคะ';
  const gender = ps['เพศ'] || 'หญิง';

  return `
คุณคือ “${agent}” ${page} เพศ${gender}. บุคลิก: ${tone}.
พูดไทยเป็นธรรมชาติ ใส่อิโมจิพองาม หลีกเลี่ยงบรรทัดยาวๆ
เรียกลูกค้าว่า “${callCustomer}” เรียกตัวเองว่า “${callSelf}”.

กฎ:
- ถ้าพูดถึง "น้ำพริก" ใช้คำว่า "รสชาติ" แทน "รุ่น"
- อย่าส่ง "รหัสสินค้า" ให้ลูกค้า
- อย่าเริ่มต้นทุกข้อความด้วยคำทักซ้ำๆ (เช่น สวัสดีค่ะ) หากคุยอยู่แล้ว
- ถ้าลูกค้าถามกว้าง ให้สรุปตัวเลือกสั้นๆ เช่น “น้ำพริกมี: เห็ด, กากหมู, โครตกุ้ง … ต้องการรสไหนคะ?”
- ถ้าไม่ทราบจริง ให้ตอบ: “${unknown}” และชวนเก็บรายละเอียดเพื่อส่งต่อแอดมิน
  `.trim();
}

async function aiReply(userText, extraContext='') {
  try {
    const sys = buildSystemPrompt();
    const payload = {
      model: 'gpt-4o-mini',
      temperature: 0.3,
      max_tokens: 250,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: `${extraContext ? `[ข้อมูล]\n${extraContext}\n\n`:''}${userText}` }
      ]
    };
    const res = await openai.chat.completions.create(payload);
    return res.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error('OpenAI error:', e?.message);
    return null;
  }
}

// ----------------------- LINE HELPERS ---------------------
function msgText(text) { return { type: 'text', text }; }
function msgImage(url) { return { type: 'image', originalContentUrl: url, previewImageUrl: url }; }
async function notifyAdmin(text, extra=[]) {
  if (!ADMIN_GROUP_ID) return;
  try { await lineClient.pushMessage(ADMIN_GROUP_ID, [msgText(text), ...extra].slice(0,5)); }
  catch(e){ console.error('notifyAdmin error:', e.message); }
}

// ----------------------- ORDER HELPERS --------------------
function calcCartSummary(cart) {
  const sub = cart.reduce((s, it) => s + (Number(it.price||0) * Number(it.qty||0)), 0);
  const promo = computePromotion(cart);
  const total = Math.max(0, sub - (promo.discount||0));
  return { sub, promo, total };
}
function renderCart(cart) {
  if (!cart?.length) return '—';
  return cart.map((it, idx) => `${idx+1}. ${it.name}${it.chosenOption?` (${it.chosenOption})`:''} x ${it.qty} = ${THB(it.price*it.qty)}`).join('\n');
}
async function persistOrder(userId, s, address = '', phone = '', status='รอยืนยัน') {
  const ts = dayjs().format('YYYYMMDDHHmmss');
  const orderNo = `ORD-${ts}-${(userId||'').slice(-4)}`;
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
      'สถานะ': status,
      'qrcode': '' // เผื่ออนาคตใส่ URL QR ต่อออเดอร์
    });
  }
  return { orderNo, summary };
}

// ----------------------- CORE HANDLER ---------------------
function conciseCategoryList() {
  // แสดงชื่อสินค้าสั้นๆ แบบกลุ่ม
  const cats = {};
  for (const p of cache.products) {
    const cat = p['หมวดหมู่'] || 'อื่นๆ';
    if (!cats[cat]) cats[cat] = new Set();
    cats[cat].add(p['ชื่อสินค้า']);
  }
  const lines = [];
  Object.keys(cats).forEach(cat => {
    const arr = [...cats[cat]].slice(0,5);
    lines.push(`• ${cat}: ${arr.join(', ')}`);
  });
  return lines.join('\n');
}

function optionsText(p) {
  const ops = extractOptions(p);
  if (!ops.length) return '';
  // เน้นคำว่า “รสชาติ” สำหรับหมวด น้ำพริก
  const isNamPrik = ((p['หมวดหมู่']||'').toLowerCase().includes('น้ำพริก'));
  return isNamPrik ? `รสชาติที่มี: ${ops.join(', ')}` : `ตัวเลือกที่มี: ${ops.join(', ')}`;
}

async function handleText(userId, replyToken, text, isFirstMsg=false) {
  const s = getSession(userId);
  const lower = (text||'').toLowerCase();

  // ---------- FAQ interrupt ----------
  const faqAns = matchFAQ(text);
  if (faqAns) {
    await lineClient.replyMessage(replyToken, [msgText(faqAns)]);
    if (s.stage !== 'idle' && s.currentItem) {
      const p = s.currentItem;
      const isNamPrik = ((p.category||'').toLowerCase().includes('น้ำพริก'));
      await lineClient.pushMessage(userId, [
        msgText(`ต่อจากเมื่อกี้นะคะ 😊 ต้องการ “${p.name}”${isNamPrik?' รสไหนคะ?':' ตัวไหนคะ?'}\n${optionsText({ 'หมวดหมู่': p.category, 'ตัวเลือก': (p.options||[]).join(', ') })}`)
      ]);
    }
    return;
  }

  // ---------- Flow: choose option (รสชาติ/ตัวเลือก) ----------
  if (s.stage === 'picking_option' && s.currentItem) {
    const choice = splitList(text)[0]?.trim();
    const ops = s.currentItem.options || [];
    if (!ops.length) {
      s.stage = 'picking_qty';
      await lineClient.replyMessage(replyToken, [msgText(`ต้องการ “${s.currentItem.name}” จำนวนกี่ชิ้นคะ (เช่น 2, 5)`)]); 
      return;
    }
    const matched = ops.find(op => op.toLowerCase().includes((choice||'').toLowerCase()));
    if (matched) {
      s.currentItem.chosenOption = matched;
      s.stage = 'picking_qty';
      await saveSessionRow(s, 'picked_option');
      await lineClient.replyMessage(replyToken, [msgText(`ต้องการ “${s.currentItem.name}”${matched?` (${matched})`:''} จำนวนกี่ชิ้นคะ (เช่น 2, 5)`)]); 
      return;
    } else {
      const isNamPrik = ((s.currentItem.category||'').toLowerCase().includes('น้ำพริก'));
      await lineClient.replyMessage(replyToken, [
        msgText(`${isNamPrik?'รสชาติ':'ตัวเลือก'}ที่มี: ${ops.join(', ')}\nเลือกอันไหนคะ?`)
      ]);
      return;
    }
  }

  // ---------- Flow: choose quantity ----------
  if (s.stage === 'picking_qty' && s.currentItem) {
    const m = text.match(/\d+/);
    if (m) {
      const qty = Math.max(1, Number(m[0]));
      const it = s.currentItem;
      s.cart.push({
        sku: it.sku,
        name: it.name,
        category: it.category,
        chosenOption: it.chosenOption || '',
        price: Number(it.price || 0),
        qty
      });
      s.currentItem = null;
      s.stage = 'confirming';
      await saveSessionRow(s, 'qty_added');

      const sum = calcCartSummary(s.cart);
      await lineClient.replyMessage(replyToken, [
        msgText(`รับทราบค่ะ 🧾\n${renderCart(s.cart)}\nยอดสุทธิ: ${THB(sum.total)}${sum.promo.code?`\nโปรฯ: ${sum.promo.detail}`:''}\n\nจะ “เพิ่มสินค้า” ต่อ หรือ “สรุปออเดอร์” เลยดีคะ?`)
      ]);
      return;
    } else {
      await lineClient.replyMessage(replyToken, [msgText(`พิมพ์เป็นตัวเลขจำนวนชิ้นนะคะ เช่น 2 หรือ 5`)]); 
      return;
    }
  }

  // ---------- Detect products from text ----------
  const found = searchProductsByText(text);

  // ถ้าพบสินค้าอย่างน้อย 1: เข้า flow เลือกตัวเลือก/จำนวน
  if (found.length >= 1) {
    if (found.length > 1) {
      // ถ้าพูดกว้างไป สรุปสั้นๆ
      const names = found.slice(0,5).map(x => `• ${x['ชื่อสินค้า']}`).join('\n');
      await lineClient.replyMessage(replyToken, [msgText(`หมายถึงตัวไหนคะ 😊\n${names}\n\nพิมพ์ชื่อให้ชัดขึ้นหน่อย เช่น “น้ำพริกเห็ด รสต้มยำ”`)]); 
      return;
    }

    const p = found[0];
    const ops = extractOptions(p);
    s.currentItem = {
      sku: p['รหัสสินค้า'],
      name: p['ชื่อสินค้า'],
      category: p['หมวดหมู่'] || '',
      price: Number(p['ราคา'] || 0),
      options: ops
    };
    await saveSessionRow(s, 'product_detected');

    if (ops.length) {
      s.stage = 'picking_option';
      const isNamPrik = ((p['หมวดหมู่']||'').toLowerCase().includes('น้ำพริก'));
      await lineClient.replyMessage(replyToken, [
        msgText(`ต้องการ “${p['ชื่อสินค้า']}” ${isNamPrik?'รสไหนคะ?':'ตัวไหนคะ?'}\n${optionsText(p)}`)
      ]);
    } else {
      s.stage = 'picking_qty';
      await lineClient.replyMessage(replyToken, [msgText(`ต้องการ “${p['ชื่อสินค้า']}” จำนวนกี่ชิ้นคะ (เช่น 2, 5)`)]); 
    }
    return;
  }

  // ---------- Confirming / Checkout ----------
  if (/สรุป|จบ|ยืนยัน|ปิด/i.test(text)) {
    if (!s.cart.length) {
      await lineClient.replyMessage(replyToken, [
        msgText(`ยังไม่มีสินค้าในตะกร้าเลยค่ะ 😅 พิมพ์ชื่อสินค้าที่ต้องการได้เลย เช่น “น้ำพริกเห็ด”`)
      ]);
      return;
    }
    s.stage = 'collecting_info';
    await saveSessionRow(s, 'start_checkout');
    const cats = [...new Set(s.cart.map(it => it.category || 'all'))];
    const pay = pickPayment(cats[0] || 'all');
    await lineClient.replyMessage(replyToken, [
      msgText(`รบกวนแจ้ง “ชื่อ-ที่อยู่จัดส่ง” และ “เบอร์โทร” ด้วยนะคะ`),
      msgText(`ช่องทางชำระ: ${pay.method}\n${pay.detail ? `รายละเอียด: ${pay.detail}` : ''}${/พร้อมเพย์|qr/i.test(pay.method+pay.detail) ? '\nต้องการ QR โอนเงิน? พิมพ์ “ขอ QR” ได้เลยค่ะ' : ''}${/cod|ปลายทาง/i.test(pay.method+pay.detail) ? '\nเก็บเงินปลายทางได้ค่ะ พิมพ์ “เก็บปลายทาง”' : ''}`)
    ]);
    return;
  }

  if (s.stage === 'confirming') {
    // ลูกค้ายังพิมพ์ชื่อสินค้าอื่นเพิ่มได้
    // ถ้าไม่ match อะไรเลย ให้ AI ช่วยตอบสั้น + ดันกลับเข้าขาย
    const shortList = conciseCategoryList();
    const ai = await aiReply(text, `[รายการหมวด/สินค้า]\n${shortList}`);
    await lineClient.replyMessage(replyToken, [
      msgText(ai || 'รับทราบค่ะ 😊 ต้องการสินค้าตัวไหนเพิ่มเติมคะ?')
    ]);
    return;
  }

  if (s.stage === 'collecting_info') {
    if (/qr|คิวอาร์|พร้อมเพย์/i.test(text)) {
      const cats = [...new Set(s.cart.map(it => it.category || 'all'))];
      const pay = pickPayment(cats[0] || 'all');
      const qrUrl = (pay.detail || '').match(/https?:\/\/\S+/)?.[0];
      if (qrUrl) {
        await lineClient.replyMessage(replyToken, [
          msgText(`ส่ง QR ให้แล้วค่ะ โอนแล้วแจ้งสลิปในแชทนี้ได้เลยนะคะ 🙏`),
          msgImage(qrUrl)
        ]);
      } else {
        await lineClient.replyMessage(replyToken, [msgText(`รายละเอียดการชำระ: ${pay.detail || '—'}`)]);
      }
      return;
    }
    if (/เก็บปลายทาง|cod/i.test(text)) {
      s.paymentMethod = 'COD';
      await lineClient.replyMessage(replyToken, [msgText(`รับทราบ “เก็บเงินปลายทาง” ค่ะ 📦 แจ้ง “ชื่อ-ที่อยู่” และ “เบอร์โทร” ด้วยนะคะ`)]); 
      return;
    }
    // จับเบอร์+ที่อยู่แบบง่าย
    const phone = text.match(/0\d{8,9}/)?.[0] || '';
    if (phone) s.phone = phone;
    if (text.length > 10 && !/qr|ปลายทาง|cod/i.test(text)) s.address = text;

    if (s.address && s.phone) {
      const { orderNo, summary } = await persistOrder(userId, s, s.address, s.phone, s.paymentMethod==='COD'?'รอจัดส่ง(COD)':'รอชำระ');
      await lineClient.replyMessage(replyToken, [
        msgText(`สรุปออเดอร์ #${orderNo}\n${renderCart(s.cart)}\nโปรฯ: ${summary.promo.code?summary.promo.detail:'—'}\nยอดสุทธิ: ${THB(summary.total)}\n\nจัดส่ง: ${s.address}\nโทร: ${s.phone}\n\nขอบคุณมากค่ะ 🥰`)
      ]);
      await notifyAdmin(`🛒 ออเดอร์ใหม่ #${orderNo}\n${renderCart(s.cart)}\nยอด: ${THB(summary.total)}\nที่อยู่: ${s.address}\nโทร: ${s.phone}${s.paymentMethod?' \nชำระ: '+s.paymentMethod:''}`);
      sessions.delete(userId);
      return;
    } else {
      await lineClient.replyMessage(replyToken, [msgText(`ยังขาด “ชื่อ-ที่อยู่” หรือ “เบอร์โทร” ค่ะ ส่งมาได้เลยนะคะ 😊`)]);
      return;
    }
  }

  // ---------- General small-talk / discovery ----------
  // สั้น กระชับ ไม่ขายยัดเยียด แต่ดันกลับสู่การขายเบาๆ
  const shortList = conciseCategoryList();
  const ai = await aiReply(text, `[หมวดและตัวอย่างสินค้า]\n${shortList}`);
  await lineClient.replyMessage(replyToken, [msgText(ai || 'รับทราบค่ะ 😊 สนใจหมวดไหนบอกได้เลยค่ะ')]);
}

// ----------------------- WEB SERVER -----------------------
const app = express();
app.get('/', (req,res)=>res.send('OK'));
app.get('/healthz', (req,res)=>res.send('ok'));

app.post('/webhook',
  lineMiddleware(lineConfig),
  async (req, res) => {
    try {
      if (!cache.persona) await loadAllData();
      res.status(200).end();

      const events = req.body.events || [];
      for (const ev of events) {
        if (ev.type === 'message' && ev.message?.type === 'text') {
          const userId = ev.source?.userId || ev.source?.groupId || ev.source?.roomId || 'unknown';
          const txt = ev.message.text || '';
          await appendRow(FIXED_SHEETS.logs, {
            'timestamp': dayjs().format('YYYY-MM-DD HH:mm:ss'),
            'userId': userId,
            'type': 'IN',
            'text': txt
          });
          await handleText(userId, ev.replyToken, txt);
        } else if (ev.type === 'follow') {
          // ทักครั้งแรกเท่านั้น
          await lineClient.replyMessage(ev.replyToken, [
            msgText('ยินดีต้อนรับค่ะ ✨ พิมพ์ชื่อสินค้า/หมวดที่สนใจได้เลย เช่น “น้ำพริกเห็ด” หรือ “รถเข็นไฟฟ้า”')
          ]);
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
      } catch(e) { /* ignore */ }
    }
  }
);

// ----------------------- START ----------------------------
const port = Number(PORT || 10000);
app.listen(port, async () => {
  try {
    await loadAllData();
    console.log(`🚀 Server running on port ${port}`);
  } catch (e) {
    console.error('❌ Google Sheet Error:', e.message);
  }
});
