// ================================================================
//  LINE x Google Sheets x OpenAI - Thai Pro Commerce Bot (FULL)
//  - เคารพ "หัวตารางภาษาไทย" บรรทัดแรกของชีทเดิมคุณ
//  - รองรับ Products / Promotions / FAQ / personality / Orders / Payment / Sessions / Logs
//  - ออเดอร์เดียวหลายสินค้า + แทรกคำถามกลางทาง + สรุป/ชำระเงิน + COD/QR
//  - FAQ ก่อน, ถ้าไม่เจอค่อยใช้ GPT (มี Guardrail ไม่มั่ว) + Fallback แจ้ง LINE Group
//  - ป้องกัน “สวัสดี” ซ้ำ ๆ, ตอบรายการสินค้าแบบสั้นอ่านง่าย, ไม่เงียบกลางทาง
//  - ใช้ google-spreadsheet v3.3.0 (useServiceAccountAuth)
// ================================================================

import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import OpenAI from 'openai';
import dayjs from 'dayjs';

// ------------------ ENV ------------------
const {
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  GOOGLE_SHEET_ID,
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  OPENAI_API_KEY,
  ADMIN_GROUP_ID // แจ้งเตือนกลุ่ม / fallback
} = process.env;

if (!GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY || !GOOGLE_SHEET_ID) {
  console.error('❌ Missing Google Sheet envs'); // ช่วย debug บน Render log
}
if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET) {
  console.error('❌ Missing LINE envs');
}

// ------------------ CONST: Fixed sheet names ------------------
const SHEETS = {
  products: 'Products',
  promotions: 'Promotions',
  faq: 'FAQ',
  personality: 'personality',
  orders: 'Orders',
  payment: 'Payment',
  sessions: 'Sessions',
  logs: 'Logs'
};

// ------------------ LINE ------------------
const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET
};
const lineClient = new Client(lineConfig);

// ------------------ OpenAI ----------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ------------------ Google Sheets ----------
const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID);
async function authSheet() {
  const key = (GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  await doc.useServiceAccountAuth({
    client_email: GOOGLE_CLIENT_EMAIL,
    private_key: key
  });
  await doc.loadInfo();
}

// read sheet rows to array of objects (respect Thai headers on row 1)
async function readSheet(title) {
  const sheet = doc.sheetsByTitle[title];
  if (!sheet) return [];
  await sheet.loadHeaderRow();
  const headers = sheet.headerValues || [];
  const rows = await sheet.getRows();
  return rows.map((r) => {
    const obj = {};
    headers.forEach((h) => { obj[h] = (r[h] ?? '').toString().trim(); });
    return obj;
  });
}

// append row (object keys must match headers in row#1)
async function appendRow(title, record) {
  const sheet = doc.sheetsByTitle[title];
  if (!sheet) throw new Error(`Sheet not found: ${title}`);
  await sheet.loadHeaderRow();
  await sheet.addRow(record);
}

// currency
const THB = (n) => Number(n || 0).toLocaleString('th-TH', { style: 'currency', currency: 'THB', maximumFractionDigits: 0 });

// helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tidy = (s = '') => s.replace(/\s+/g, ' ').trim();
const splitList = (s = '') => tidy(s).split(/,|，|\/|\||\n/).map(x => x.trim()).filter(Boolean);

// ------------------ Cache -------------------
const cache = {
  persona: null,
  products: [],
  promotions: [],
  faq: [],
  payment: [],
  aliasIndex: new Map(),   // คำเรียกลูกค้า -> product[]
  skuIndex: new Map()
};
function buildIndexes() {
  cache.aliasIndex = new Map();
  cache.skuIndex = new Map();

  for (const p of cache.products) {
    const sku = (p['รหัสสินค้า'] || '').toLowerCase();
    const name = (p['ชื่อสินค้า'] || '').toLowerCase();
    const aliases = splitList(p['คำที่ลูกค้าเรียก'] || p['คําที่ลูกค้าเรียก'] || '');
    aliases.push(p['ชื่อสินค้า'], p['รหัสสินค้า']);

    if (sku) cache.skuIndex.set(sku, p);

    for (const raw of aliases) {
      const a = (raw || '').toLowerCase().trim();
      if (!a) continue;
      const arr = cache.aliasIndex.get(a) || [];
      if (!arr.includes(p)) arr.push(p);
      cache.aliasIndex.set(a, arr);
    }

    // auto aliases by keyword from name
    if (name) {
      const toks = name.split(/\s+/).filter(Boolean);
      toks.forEach(tok => {
        const arr = cache.aliasIndex.get(tok) || [];
        if (!arr.includes(p)) arr.push(p);
        cache.aliasIndex.set(tok, arr);
      });
    }
  }
}

async function loadAll() {
  await authSheet();
  const [products, promotions, faq, personaRows, payment] = await Promise.all([
    readSheet(SHEETS.products),
    readSheet(SHEETS.promotions),
    readSheet(SHEETS.faq),
    readSheet(SHEETS.personality),
    readSheet(SHEETS.payment)
  ]);
  cache.products = products;
  cache.promotions = promotions;
  cache.faq = faq;
  cache.payment = payment;
  cache.persona = personaRows?.[0] || {
    'ชื่อพนักงาน': 'แอดมิน',
    'ชื่อเพจ': '',
    'บุคลิก': 'สุภาพ อ่อนโยน ช่วยเหลือจริงใจ',
    'คำเรียกลูกค้า': 'คุณลูกค้า',
    'คำเรียกตัวเองแอดมิน': 'แอดมิน',
    'คำตอบเมื่อไม่รู้': 'ขออนุญาตเช็คแป๊บนึงนะคะ แล้วจะแจ้งกลับทันทีค่ะ',
    'เพศ': 'หญิง'
  };
  buildIndexes();
}

// ------------------ Sessions (memory) ----------------
const sessions = new Map(); // userId -> state
function newSession(userId) {
  const s = {
    userId,
    stage: 'idle',           // idle | pick_variant | pick_qty | checkout
    greeted: false,          // ป้องกันสวัสดีซ้ำ
    currentItem: null,       // { sku, name, category, price, options[], chosen }
    cart: [],                // [{sku,name,category,option,price,qty}]
    address: '',
    phone: '',
    lastActive: Date.now()
  };
  sessions.set(userId, s);
  return s;
}
function getSession(userId) {
  const s = sessions.get(userId) || newSession(userId);
  s.lastActive = Date.now();
  return s;
}

// ------------------ Utils: FAQ / Products / Payment / Promo ----------
function matchFAQ(text) {
  const t = (text || '').toLowerCase();
  let best = null, score = 0;

  for (const r of cache.faq) {
    const q = (r['คำถาม'] || '').toLowerCase();
    const keys = splitList(r['คำหลัก'] || '');
    let cur = 0;
    if (q && t.includes(q)) cur += 2;
    for (const k of keys) if (t.includes(k.toLowerCase())) cur += 1;
    if (cur > score) { score = cur; best = r; }
  }
  return score >= 1 ? (best['คำตอบ'] || '').trim() : null;
}

function searchProducts(text) {
  const t = (text || '').toLowerCase();
  const set = new Set();

  // direct alias
  const fromAlias = cache.aliasIndex.get(t);
  if (fromAlias) fromAlias.forEach(p => set.add(p));

  // fuzzy name contains
  cache.products.forEach(p => {
    const name = (p['ชื่อสินค้า'] || '').toLowerCase();
    const sku = (p['รหัสสินค้า'] || '').toLowerCase();
    if (name.includes(t) || sku === t) set.add(p);
  });
  return Array.from(set);
}

function listProductNames(limit = 8) {
  return cache.products.slice(0, limit).map(p => `- ${p['ชื่อสินค้า']}`).join('\n');
}

function getOptions(p) {
  return splitList(p['ตัวเลือก'] || '');
}

function calcPromotion(cart) {
  if (!cart?.length) return { code: '', detail: '', discount: 0 };
  let best = { code: '', detail: '', discount: 0 };

  // โครงสร้าง Promotions (หัวตาราง): รหัสโปรโมชั่น | รายละเอียดโปรโมชั่น | ประเภทคำนวณ | เงื่อนไข | ใช้กับสินค้า | ใช้กับหมวดหมู่
  const parseCond = (s = '') => {
    const out = {};
    splitList(s).forEach(pair => {
      const [k, v] = pair.split('=').map(x => x.trim());
      if (!k) return;
      const num = Number(v);
      out[k] = isNaN(num) ? v : num;
    });
    return out;
  };

  const inScope = (promo, item) => {
    const bySku = splitList(promo['ใช้กับสินค้า']).map(x => x.toLowerCase());
    const byCat = splitList(promo['ใช้กับหมวดหมู่']).map(x => x.toLowerCase());
    const sku = (item.sku || '').toLowerCase();
    const cat = (item.category || '').toLowerCase();
    const skuOk = bySku.length ? bySku.includes(sku) : true;
    const catOk = byCat.length ? byCat.includes(cat) : true;
    return skuOk && catOk;
  };

  for (const promo of cache.promotions) {
    const type = (promo['ประเภทคำนวณ'] || '').toUpperCase();
    const cond = parseCond(promo['เงื่อนไข'] || '');
    const items = cart.filter(it => inScope(promo, it));
    if (!items.length) continue;

    const qty = items.reduce((s, it) => s + Number(it.qty || 0), 0);
    const amount = items.reduce((s, it) => s + Number(it.price || 0) * Number(it.qty || 0), 0);
    if (cond.min_qty && qty < Number(cond.min_qty)) continue;
    if (cond.min_amount && amount < Number(cond.min_amount)) continue;

    let discount = 0, detail = promo['รายละเอียดโปรโมชั่น'] || '';
    if (type === 'PERCENT') {
      const pct = Number(cond.percent || 0);
      discount = Math.floor(amount * pct / 100);
      if (!detail) detail = `ส่วนลด ${pct}%`;
    } else if (type === 'FIXED_DISCOUNT') {
      discount = Number(cond.amount || 0);
      if (!detail) detail = `ลดทันที ${THB(discount)}`;
    } else if (type === 'BUY_X_GET_Y') {
      // ฟรีราคาถูกสุดตามจำนวน get_free
      const free = Number(cond.get_free || 1);
      const prices = [];
      items.forEach(it => { for (let i=0;i<it.qty;i++) prices.push(Number(it.price||0)); });
      prices.sort((a,b)=>a-b);
      discount = prices.slice(0, free).reduce((s,v)=>s+v,0);
      if (!detail) detail = `ซื้อครบ ${cond.min_qty} แถม ${free}`;
    } else if (type === 'FREE_SHIPPING') {
      discount = Number(cond.fee || 40);
      if (!detail) detail = `ส่งฟรี (หักค่าขนส่ง ${THB(discount)})`;
    } else { continue; }

    if (discount > best.discount) {
      best = { code: promo['รหัสโปรโมชั่น'] || '', detail, discount };
    }
  }

  return best;
}

function summarizeCart(cart) {
  const sub = cart.reduce((s, it) => s + Number(it.price||0)*Number(it.qty||0), 0);
  const promo = calcPromotion(cart);
  const total = Math.max(0, sub - promo.discount);
  return { sub, promo, total };
}

function pickPayment(category = 'all') {
  const cat = (category || '').toLowerCase();
  let row = cache.payment.find(r => (r['category'] || '').toLowerCase() === cat);
  if (!row) row = cache.payment.find(r => (r['category'] || '').toLowerCase() === 'all') || cache.payment[0] || {};
  return {
    method: row['method'] || 'โอน/พร้อมเพย์/COD',
    detail: row['detail'] || '',
    qrcode: row['qrcode'] || row['qr'] || '' // รองรับอนาคต
  };
}

const cartText = (cart) => {
  if (!cart?.length) return '-';
  return cart.map((it,i)=>`${i+1}. ${it.name}${it.option?` (${it.option})`:''} x ${it.qty} = ${THB(it.price*it.qty)}`).join('\n');
};

// ------------------ AI (guardrails) -------------------
function buildSystemPrompt() {
  const p = cache.persona || {};
  const agent = p['ชื่อพนักงาน'] || 'แอดมิน';
  const page = p['ชื่อเพจ'] ? `จากเพจ ${p['ชื่อเพจ']}` : '';
  const tone = p['บุคลิก'] || 'สุภาพ จริงใจ ช่วยเหลือเต็มที่';
  const callCustomer = p['คำเรียกลูกค้า'] || 'คุณลูกค้า';
  const callSelf = p['คำเรียกตัวเองแอดมิน'] || 'แอดมิน';
  const fallback = p['คำตอบเมื่อไม่รู้'] || 'ขออนุญาตเช็คข้อมูลเพิ่มเติมแล้วจะแจ้งกลับนะคะ';

  return `
คุณคือ "${agent}" ${page}. บุคลิก: ${tone} ใช้ภาษาไทยเป็นกันเอง ชัดเจน ไม่เยิ่นเย้อ
เรียกลูกค้าว่า "${callCustomer}" และเรียกตัวเองว่า "${callSelf}"

กฎสำคัญ:
- ถ้าบทสนทนาเกี่ยวกับสินค้า ให้ถามต่ออย่างเป็นขั้นตอน (ตัวเลือก/รสชาติ → จำนวน → เพิ่มสินค้า? → สรุปยอด)
- อย่าทัก "สวัสดี" ซ้ำทุกครั้ง ให้ใช้เฉพาะเปิดบทสนทนาครั้งแรกเท่านั้น
- หลีกเลี่ยงคำว่า "รุ่น" สำหรับน้ำพริก ให้ใช้คำว่า "รสชาติ" หรือ "แบบ"
- ถ้าไม่แน่ใจจริง ๆ ตอบสั้น ๆ ว่า "${fallback}"
- ตอบสั้น กระชับ ไม่พิมพ์ยาวเป็นบทความ
  `.trim();
}

async function aiShortReply(userText, extraContext = '') {
  try {
    const sys = buildSystemPrompt();
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      max_tokens: 220,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: `${extraContext ? `[ข้อมูล]\n${extraContext}\n\n` : ''}${userText}` }
      ]
    });
    return res.choices?.[0]?.message?.content?.trim() || '';
  } catch (e) {
    console.error('OpenAI error:', e.message);
    return '';
  }
}

// ------------------ LINE Msg helpers -------------------
const msgText  = (t) => ({ type: 'text', text: t });
const msgImage = (url) => ({ type: 'image', originalContentUrl: url, previewImageUrl: url });
async function pushAdmin(text) { if (ADMIN_GROUP_ID) try { await lineClient.pushMessage(ADMIN_GROUP_ID, [msgText(text)]);}catch(e){ console.error('pushAdmin', e.message);}}

// ------------------ Persist Order -------------------
async function persistOrder(userId, s, addr, phone) {
  const ts = dayjs().format('YYYYMMDDHHmmss');
  const orderNo = `ORD-${ts}-${(userId||'').slice(-4)}`;
  const sum = summarizeCart(s.cart);
  const promoText = sum.promo.code ? `${sum.promo.code} - ${sum.promo.detail}` : '';

  for (const it of s.cart) {
    await appendRow(SHEETS.orders, {
      'เลขที่ออเดอร์': orderNo,
      'รหัสสินค้า': it.sku,
      'ชื่อสินค้า': it.name,
      'ตัวเลือก': it.option || '',
      'จำนวน': it.qty,
      'ราคารวม': it.price * it.qty,
      'โปรโมชั่นที่ใช้': promoText,
      'ชื่อ-ที่อยู่': addr,
      'เบอร์โทร': phone,
      'สถานะ': 'รอชำระ/จัดส่ง'
    });
  }
  await pushAdmin(`🛒 ออเดอร์ใหม่ #${orderNo}\n${cartText(s.cart)}\nยอดสุทธิ: ${THB(sum.total)}\nที่อยู่: ${addr}\nโทร: ${phone}`);
  return { orderNo, sum };
}

// ------------------ Core Conversation Flow -------------
async function handleText(userId, replyToken, text) {
  const s = getSession(userId);
  const low = (text||'').trim().toLowerCase();

  // log IN
  try { await appendRow(SHEETS.logs, { 'timestamp': dayjs().format('YYYY-MM-DD HH:mm:ss'), 'userId': userId, 'type': 'IN', 'text': text }); } catch(e){}

  // greet only once at follow event (จัดที่ webhook 'follow' แล้ว) => ไม่ต้องทำที่นี่

  // ---------------- FAQ first
  const faqAns = matchFAQ(text);
  if (faqAns) {
    await lineClient.replyMessage(replyToken, [msgText(faqAns)]);
    return;
  }

  // ---------------- Show product list (ถามกว้าง ๆ)
  if (/มี(สินค้า|น้ำพริก)อะไร|ขายอะไร|อยากดูเมนู|ขอรายการ/i.test(low)) {
    const names = cache.products.map(p => `- ${p['ชื่อสินค้า']}`).join('\n');
    const out = names.length > 0 ? names : 'ตอนนี้ยังไม่มีรายการแสดงในชีท Products นะคะ';
    await lineClient.replyMessage(replyToken, [msgText(`รายการสินค้าบางส่วนค่ะ 👇\n${out}\n\nสนใจตัวไหนบอกชื่อมาได้เลยค่ะ`)]);
    return;
  }

  // ---------------- Show cart
  if (/ตะกร้า|รถเข็น|ดูสรุป|เช็คยอด|สรุป/i.test(low) && s.cart.length) {
    const sum = summarizeCart(s.cart);
    await lineClient.replyMessage(replyToken, [
      msgText(`ตะกร้าปัจจุบัน\n${cartText(s.cart)}\n\nโปรฯ: ${sum.promo.code?sum.promo.detail:'—'}\nยอดสุทธิ: ${THB(sum.total)}\n\nถ้าพร้อมสรุป พิมพ์ "ชำระเงิน" หรือ "สรุปออเดอร์" ได้เลยค่ะ`)
    ]);
    return;
  }

  // ---------------- Checkout start
  if (/ชำระเงิน|เช็คเอาท์|สรุปออเดอร์|จบการสั่ง/i.test(low)) {
    if (!s.cart.length) { await lineClient.replyMessage(replyToken, [msgText('ยังไม่มีสินค้าในตะกร้าค่ะ 😊 บอกชื่อสินค้าที่ต้องการก่อนได้เลย')]); return; }
    s.stage = 'checkout';
    // choose payment by first item category
    const cat = s.cart[0]?.category || 'all';
    const pay = pickPayment(cat);
    const sum = summarizeCart(s.cart);

    const note = `ช่องทางชำระ: ${pay.method}\n${pay.detail ? `รายละเอียด: ${pay.detail}` : ''}`;
    const qrcode = (pay.qrcode || '').trim();

    const msgs = [
      msgText(`สรุปตะกร้า 🧾\n${cartText(s.cart)}\n\nโปรฯ: ${sum.promo.code?sum.promo.detail:'—'}\nยอดสุทธิ: ${THB(sum.total)}`),
      msgText(`${note}\nกรุณาส่ง "ชื่อ-ที่อยู่" และ "เบอร์โทร" เพื่อดำเนินการต่อค่ะ${/cod|ปลายทาง/i.test(pay.method+pay.detail) ? '\nหากต้องการเก็บปลายทาง พิมพ์ "เก็บปลายทาง" ได้เลยค่ะ' : ''}`)
    ];
    if (qrcode.startsWith('http')) msgs.push(msgImage(qrcode));
    await lineClient.replyMessage(replyToken, msgs);
    return;
  }

  // ---------------- If waiting option
  if (s.stage === 'pick_variant' && s.currentItem) {
    const choice = splitList(text)[0]?.toLowerCase();
    if (choice) {
      const matched = s.currentItem.options.find(op => op.toLowerCase().includes(choice));
      if (matched || s.currentItem.options.length === 0) {
        s.currentItem.chosen = matched || choice;
        s.stage = 'pick_qty';
        await lineClient.replyMessage(replyToken, [msgText(`รับทราบค่ะ ต้องการ "${s.currentItem.name} (${s.currentItem.chosen})" จำนวนกี่ชิ้นคะ (พิมพ์ 1, 2, 3 ...)`)]); 
        return;
      }
    }
    await lineClient.replyMessage(replyToken, [msgText(`รสชาติ/ตัวเลือกที่มี: ${s.currentItem.options.join(', ')}\nกรุณาเลือก 1 ตัวเลือกค่ะ`)]); 
    return;
  }

  // ---------------- If waiting qty
  if (s.stage === 'pick_qty' && s.currentItem) {
    const m = text.match(/\d+/);
    if (m) {
      const qty = Math.max(1, Number(m[0]));
      s.cart.push({
        sku: s.currentItem.sku,
        name: s.currentItem.name,
        category: s.currentItem.category,
        option: s.currentItem.chosen || '',
        price: Number(s.currentItem.price || 0),
        qty
      });
      s.currentItem = null;
      s.stage = 'idle';
      const sum = summarizeCart(s.cart);
      await lineClient.replyMessage(replyToken, [
        msgText(`เพิ่มลงตะกร้าแล้วค่ะ 🧺\n${cartText(s.cart)}\n\nยอดสุทธิ (ชั่วคราว): ${THB(sum.total)}\nจะเพิ่มสินค้าอีกไหมคะ หรือพิมพ์ "สรุปออเดอร์" เพื่อชำระเงินได้เลยค่ะ`)
      ]);
      return;
    }
    await lineClient.replyMessage(replyToken, [msgText('กรุณาพิมพ์เป็นตัวเลขจำนวนชิ้น เช่น 1, 2, 3')]);
    return;
  }

  // ---------------- Checkout in progress: capture address/phone/method
  if (s.stage === 'checkout') {
    // COD
    if (/เก็บปลายทาง|cod/i.test(low)) {
      s.paymentMethod = 'COD';
      await lineClient.replyMessage(replyToken, [msgText('รับทราบค่ะ เลือกเก็บเงินปลายทาง ✅ กรุณาส่ง "ชื่อ-ที่อยู่" และ "เบอร์โทร" ให้ครบด้วยนะคะ')]);
      return;
    }
    // capture phone
    const phone = text.match(/0\d{8,9}/)?.[0] || '';
    if (phone) s.phone = phone;
    // capture address (พิมพ์ยาว)
    if (text.length > 12 && !/qr|cod|เก็บปลายทาง/i.test(low)) s.address = text.trim();

    if (s.address && s.phone) {
      // persist
      const { orderNo, sum } = await persistOrder(userId, s, s.address, s.phone);
      await lineClient.replyMessage(replyToken, [
        msgText(`สรุปออเดอร์ #${orderNo}\n${cartText(s.cart)}\nยอดสุทธิ: ${THB(sum.total)}\n\nจัดส่งไปที่: ${s.address}\nโทร: ${s.phone}\n\nขอบคุณมากค่ะ 🥰`)
      ]);
      sessions.delete(userId);
      return;
    }
    await lineClient.replyMessage(replyToken, [msgText('กรุณาส่ง "ชื่อ-ที่อยู่" และ "เบอร์โทร" ให้ครบถ้วนเพื่อดำเนินการต่อค่ะ')]);
    return;
  }

  // ---------------- Product intent detection
  const found = searchProducts(text);
  if (found.length >= 1) {
    // ถ้าพบ 1 ชิ้น: เข้ากระบวนการขายทันที
    if (found.length === 1) {
      const p = found[0];
      const options = getOptions(p);
      s.currentItem = {
        sku: p['รหัสสินค้า'],
        name: p['ชื่อสินค้า'],
        category: p['หมวดหมู่'] || 'all',
        price: Number(p['ราคา'] || 0),
        options,
        chosen: ''
      };
      s.stage = options.length ? 'pick_variant' : 'pick_qty';
      if (options.length) {
        await lineClient.replyMessage(replyToken, [msgText(`"${p['ชื่อสินค้า']}" มีรสชาติ/ตัวเลือก: ${options.join(', ')}\nกรุณาเลือก 1 ตัวเลือกค่ะ`)]);
      } else {
        await lineClient.replyMessage(replyToken, [msgText(`ต้องการ "${p['ชื่อสินค้า']}" กี่ชิ้นคะ (เช่น 1, 2, 3)`)]); 
      }
      return;
    } else {
      // พบหลายตัว → แสดงชื่อแบบสั้น
      const names = found.slice(0,10).map(x=>`- ${x['ชื่อสินค้า']}`).join('\n');
      await lineClient.replyMessage(replyToken, [msgText(`หมายถึงตัวไหนคะ 😊\n${names}\n\nพิมพ์ชื่อให้ชัดขึ้นนิดนึงได้ไหมคะ`)]);
      return;
    }
  }

  // ---------------- Fallback: GPT (guard) + Admin notify
  const extra = `
[รายการสินค้า]
${cache.products.slice(0,20).map(p=>`- ${p['ชื่อสินค้า']}${p['ตัวเลือก']?` (รสชาติ: ${getOptions(p).join(', ')})`:''} ราคา ${THB(p['ราคา'])}`).join('\n')}
  `.trim();

  const ai = await aiShortReply(text, extra);
  if (ai) {
    await lineClient.replyMessage(replyToken, [msgText(ai)]);
  } else {
    // แจ้งลูกค้า + ส่งเรื่องเข้ากรุ๊ป
    await lineClient.replyMessage(replyToken, [msgText('ขออนุญาตให้แอดมินตัวจริงมาช่วยตอบเรื่องนี้นะคะ แอดมินจะทักกลับโดยเร็วค่ะ 🙏')]);
    await pushAdmin(`⚠️ Fallback: บอทตอบไม่ได้\nจากผู้ใช้ ${userId}\nข้อความ: "${text}"`);
  }
}

// ------------------ Express / Webhook --------------------
const app = express();
app.get('/', (req,res)=>res.send('OK'));
app.get('/healthz', (req,res)=>res.send('ok'));

// LINE Webhook
app.post('/webhook',
  lineMiddleware(lineConfig),
  async (req, res) => {
    try {
      if (!cache.persona) await loadAll();
      res.status(200).end();

      const events = req.body.events || [];
      for (const ev of events) {
        const userId = ev.source?.userId || ev.source?.groupId || ev.source?.roomId || 'unknown';

        if (ev.type === 'follow') {
          // greet only once on follow
          const p = cache.persona || {};
          const hi = `สวัสดีค่ะ 😊 ยินดีต้อนรับ${p['ชื่อเพจ']?`สู่ ${p['ชื่อเพจ']}`:''}\nสนใจสินค้าตัวไหนบอกชื่อได้เลย หรือพิมพ์ "มีน้ำพริกอะไรบ้าง" เพื่อดูรายการค่ะ`;
          await lineClient.replyMessage(ev.replyToken, [msgText(hi)]);
          continue;
        }
        if (ev.type === 'message' && ev.message?.type === 'text') {
          await handleText(userId, ev.replyToken, ev.message.text);
        }
      }
    } catch (err) {
      console.error('Webhook Error:', err);
      try {
        await appendRow(SHEETS.logs, { 'timestamp': dayjs().format('YYYY-MM-DD HH:mm:ss'), 'userId': 'system', 'type': 'ERR', 'text': err?.message || String(err) });
      } catch(e){}
    }
  }
);

// refresh data every 10 min (ในหน่วยความจำ)
setInterval(async () => { try { await loadAll(); } catch(e){} }, 10*60*1000);

// start
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  try {
    await loadAll();
    console.log(`🚀 Live on ${PORT}`);
  } catch (e) {
    console.error('❌ Google Sheet Error:', e.message);
  }
});
