// ==========================================================
//  LINE x Google Sheets x OpenAI - Thai Pro Commerce Bot (Full)
//  - รองรับหลายสินค้าในออเดอร์เดียว
//  - ยืดหยุ่น ขัดจังหวะได้ (FAQ/ถามทั่วไป) แล้วกลับมาปิดการขาย
//  - อ่าน/เขียน Google Sheet ตามหัวตารางภาษาไทย (อยู่แถวแรกเท่านั้น)
//  - Promotions: ประเภทคำนวณ, เงื่อนไข, ใช้กับสินค้า/หมวดหมู่
//  - Payment: category | method | detail | qrcode
//  - Orders: บันทึกทีละแถว/สินค้า พร้อมเลขออเดอร์เดียวกัน
//  - แจ้งเตือนกลุ่มแอดมิน (ถ้าตั้ง ADMIN_GROUP_ID)
//  - ป้องกันตอบยาว/หยุดกลางทางด้วยการบังคับ Flow “ถามให้ครบ → สรุป → ชำระ”
//  - ใช้ google-spreadsheet v3.3.0
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

// ----------------------- CONST: SHEET NAMES ----------------
const FIXED_SHEETS = {
  products: 'Products',       // หัวตาราง: รหัสสินค้า | ชื่อสินค้า | หมวดหมู่ | ราคา | คำที่ลูกค้าเรียก | ตัวเลือก | หมายเหตุ(อิสระ)
  promotions: 'Promotions',   // หัวตาราง: รหัสโปรโมชั่น | รายละเอียดโปรโมชั่น | ประเภทคำนวณ | เงื่อนไข | ใช้กับสินค้า | ใช้กับหมวดหมู่
  faq: 'FAQ',                 // หัวตาราง: คำถาม | คำตอบ | คำหลัก
  personality: 'personality', // หัวตาราง: ชื่อพนักงาน | ชื่อเพจ | บุคลิก | คำเรียกลูกค้า | คำเรียกตัวเองแอดมิน | คำตอบเมื่อไม่รู้ | เพศ
  orders: 'Orders',           // หัวตาราง: เลขที่ออเดอร์ | รหัสสินค้า | ชื่อสินค้า | ตัวเลือก | จำนวน | ราคารวม | โปรโมชั่นที่ใช้ | ชื่อ-ที่อยู่ | เบอร์โทร | สถานะ
  payment: 'Payment',         // หัวตาราง: category | method | detail | qrcode(ลิงก์รูป QR ถ้ามี)
  sessions: 'Sessions',       // หัวตาราง: timestamp | userId | stage | cart | note
  logs: 'Logs'                // หัวตาราง: timestamp | userId | type(IN/OUT/ERR) | text
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

// ---------- helpers for sheet header-row based (row #1) ---
async function readSheet(title) {
  const sheet = doc.sheetsByTitle[title];
  if (!sheet) return [];
  await sheet.loadHeaderRow();
  const rows = await sheet.getRows();
  const headers = sheet.headerValues || [];
  return rows.map(r => {
    const obj = {};
    headers.forEach(h => (obj[h] = (r[h] ?? '').toString().trim()));
    return obj;
  });
}
async function appendRow(title, record) {
  const sheet = doc.sheetsByTitle[title];
  if (!sheet) throw new Error(`Sheet not found: ${title}`);
  await sheet.loadHeaderRow(); // ถ้า header ว่างจะ throw → ต้องมีหัวแถวก่อน
  await sheet.addRow(record);
}
function THB(n) {
  const v = Number(n || 0);
  return v.toLocaleString('th-TH', { style: 'currency', currency: 'THB', maximumFractionDigits: 0 });
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// ----------------------- CACHE (in-memory) ----------------
const cache = {
  products: [],
  promotions: [],
  faq: [],
  persona: null,
  payment: []
};

// ------- text utils / alias / options ---------------------
function normalizeThai(s=''){ return s.replace(/\s+/g,' ').trim(); }
function splitList(s=''){
  return normalizeThai(s).split(/,|，|\/|\||และ|และ\s*/).map(x=>x.trim()).filter(Boolean);
}
function buildAliasIndex(products){
  const idx = new Map();
  for (const p of products){
    const aliases = splitList(p['คำที่ลูกค้าเรียก'] || p['คําที่ลูกค้าเรียก'] || '');
    aliases.push(p['ชื่อสินค้า'], p['รหัสสินค้า']);
    for (const a of aliases.map(x=>x?.toLowerCase()).filter(Boolean)){
      const list = idx.get(a) || [];
      list.push(p);
      idx.set(a, list);
    }
  }
  return idx;
}
let PRODUCT_ALIAS_INDEX = new Map();

async function loadAllData(){
  await authSheet();
  const limit = pLimit(4);
  const [products, promotions, faq, personalityRows, payment] = await Promise.all([
    limit(()=>readSheet(FIXED_SHEETS.products)),
    limit(()=>readSheet(FIXED_SHEETS.promotions)),
    limit(()=>readSheet(FIXED_SHEETS.faq)),
    limit(()=>readSheet(FIXED_SHEETS.personality)),
    limit(()=>readSheet(FIXED_SHEETS.payment))
  ]);

  cache.products = products;
  cache.promotions = promotions;
  cache.faq = faq;
  cache.persona = personalityRows?.[0] || {
    'ชื่อพนักงาน':'แอดมิน','ชื่อเพจ':'','บุคลิก':'สุภาพ จริงใจ ช่วยเต็มที่',
    'คำเรียกลูกค้า':'คุณลูกค้า','คำเรียกตัวเองแอดมิน':'แอดมิน',
    'คำตอบเมื่อไม่รู้':'ขออนุญาตเช็คข้อมูลแล้วรีบแจ้งนะคะ','เพศ':'หญิง'
  };
  cache.payment = payment;
  PRODUCT_ALIAS_INDEX = buildAliasIndex(products);
}

// ----------------------- PROMOTION ENGINE -----------------
// Promotions: รหัสโปรโมชั่น | รายละเอียดโปรโมชั่น | ประเภทคำนวณ | เงื่อนไข | ใช้กับสินค้า | ใช้กับหมวดหมู่
// ประเภทคำนวณ: BUY_X_GET_Y, PERCENT, FIXED_DISCOUNT, FREE_SHIPPING
function parseCond(s=''){
  const out = {};
  splitList(s).forEach(pair=>{
    const [k,v] = pair.split('=').map(x=>x.trim());
    if(!k) return;
    const n = Number(v);
    out[k] = isNaN(n) ? v : n;
  });
  return out;
}
function promoApplies(promo, item){
  const bySku = splitList(promo['ใช้กับสินค้า']).map(x=>x.toLowerCase());
  const byCat = splitList(promo['ใช้กับหมวดหมู่']).map(x=>x.toLowerCase());
  const sku = (item.sku||'').toLowerCase();
  const cat = (item.category||'').toLowerCase();
  const skuOk = bySku.length ? bySku.includes(sku) : true;
  const catOk = byCat.length ? byCat.includes(cat) : true;
  return skuOk && catOk;
}
function bestPromotion(cart){
  if(!cart?.length) return {discount:0, code:'', detail:''};
  let best = {discount:0, code:'', detail:''};
  for (const pr of cache.promotions){
    const type = (pr['ประเภทคำนวณ']||'').toUpperCase();
    const cond = parseCond(pr['เงื่อนไข']||'');
    const items = cart.filter(it=>promoApplies(pr,it));
    if(!items.length) continue;
    const qty = items.reduce((s,it)=>s+Number(it.qty||0),0);
    const amt = items.reduce((s,it)=>s + Number(it.price||0)*Number(it.qty||0),0);

    if(cond.min_qty && qty < Number(cond.min_qty)) continue;
    if(cond.min_amount && amt < Number(cond.min_amount)) continue;

    let discount = 0, detail = '';
    if(type==='BUY_X_GET_Y'){
      const free = Number(cond.get_free||1);
      const prices = [];
      items.forEach(it=>{
        for(let i=0;i<Number(it.qty||0);i++) prices.push(Number(it.price||0));
      });
      prices.sort((a,b)=>a-b);
      discount = prices.slice(0,free).reduce((s,v)=>s+v,0);
      detail = `โปรซื้อครบ ${cond.min_qty} แถม ${free}`;
    } else if(type==='PERCENT'){
      const pct = Number(cond.percent||0);
      discount = Math.floor(amt * pct / 100);
      detail = `ส่วนลด ${pct}%`;
    } else if(type==='FIXED_DISCOUNT'){
      discount = Number(cond.amount||0);
      detail = `ลดทันที ${THB(discount)}`;
    } else if(type==='FREE_SHIPPING'){
      discount = Number(cond.fee || 40);
      detail = `ส่งฟรี (หักค่าขนส่ง ${THB(discount)})`;
    } else continue;

    if(discount > best.discount){
      best = {discount, code: pr['รหัสโปรโมชั่น']||'', detail: pr['รายละเอียดโปรโมชั่น']||detail};
    }
  }
  return best;
}

// ----------------------- PAYMENT PICKER -------------------
function pickPayment(category='all'){
  const rows = cache.payment || [];
  const cat = (category||'').toLowerCase();
  let row = rows.find(r=>(r['category']||'').toLowerCase()===cat);
  if(!row) row = rows.find(r=>(r['category']||'').toLowerCase()==='all');
  if(!row) row = rows[0];
  return {
    method: row?.['method'] || 'โอน/พร้อมเพย์/COD',
    detail: row?.['detail'] || '',
    qrcode: row?.['qrcode'] || ''
  };
}

// ----------------------- FAQ SIMPLE MATCH ----------------
function matchFAQ(text){
  const t = (text||'').toLowerCase();
  let best=null, score=0;
  for(const f of cache.faq){
    const q=(f['คำถาม']||'').toLowerCase();
    const keys = splitList(f['คำหลัก']||'');
    let s=0;
    if(q && t.includes(q)) s+=2;
    for(const k of keys) if(t.includes(k.toLowerCase())) s+=1;
    if(s>score){score=s; best=f;}
  }
  return score>=1 ? best['คำตอบ'] : null;
}

// ----------------------- SESSIONS -------------------------
const sessions = new Map(); // userId → state

function newSession(userId){
  const s = {
    userId,
    stage: 'idle',            // idle | picking_variant | picking_qty | confirming | collecting_info
    currentItem: null,        // { sku,name,category,price,options[], chosenOption }
    cart: [],                 // [{ sku,name,category,price,qty,chosenOption }]
    address: '',
    phone: '',
    lastActive: Date.now()
  };
  sessions.set(userId, s);
  return s;
}
function getSession(userId){
  let s = sessions.get(userId);
  if(!s) s = newSession(userId);
  s.lastActive = Date.now();
  return s;
}
async function saveSessionRow(s, note=''){
  try{
    await appendRow(FIXED_SHEETS.sessions, {
      'timestamp': dayjs().format('YYYY-MM-DD HH:mm:ss'),
      'userId': s.userId,
      'stage': s.stage,
      'cart': JSON.stringify(s.cart),
      'note': note
    });
  }catch(e){ /* ignore */ }
}

// ----------------------- PRODUCT HELPERS ------------------
function extractOptions(p){ return splitList(p['ตัวเลือก']||''); }
function searchProductsByText(text){
  const t = (text||'').toLowerCase();
  const tokens = splitList(t).concat([t]);
  const matched = new Set();
  for(const tok of tokens){
    const arr = PRODUCT_ALIAS_INDEX.get(tok);
    if(arr) arr.forEach(p=>matched.add(p));
  }
  cache.products.forEach(p=>{
    const name = (p['ชื่อสินค้า']||'').toLowerCase();
    const sku  = (p['รหัสสินค้า']||'').toLowerCase();
    if(name.includes(t)) matched.add(p);
    if(sku===t) matched.add(p);
  });
  return [...matched];
}
function getProductBySku(sku){
  return cache.products.find(p => (p['รหัสสินค้า']||'').toLowerCase() === (sku||'').toLowerCase());
}

// ----------------------- OPENAI GUARDRAILS ----------------
function systemPrompt(){
  const ps = cache.persona||{};
  const agent = ps['ชื่อพนักงาน'] || 'แอดมิน';
  const page  = ps['ชื่อเพจ'] || '';
  const tone  = ps['บุคลิก'] || 'สุภาพ จริงใจ ช่วยเต็มที่';
  const callCustomer = ps['คำเรียกลูกค้า'] || 'คุณลูกค้า';
  const callSelf = ps['คำเรียกตัวเองแอดมิน'] || 'แอดมิน';
  const unknown = ps['คำตอบเมื่อไม่รู้'] || 'ขออนุญาตเช็คข้อมูลแล้วรีบแจ้งนะคะ';
  const gender = ps['เพศ'] || 'หญิง';

  return `
คุณคือ “${agent}”${page?` จากเพจ ${page}`:''} เพศ${gender}
น้ำเสียง: ${tone}, ภาษาธรรมชาติ สุภาพ ใส่อิโมจิเล็กน้อย
เรียกลูกค้าว่า “${callCustomer}” และเรียกตัวเองว่า “${callSelf}”

กติกา:
- ถ้าลูกค้าพูดถึงสินค้า ให้ถามให้ครบ: รุ่น/รส/ตัวเลือก → จำนวน
- พยายามตอบสั้น กระชับ ไม่ยาวเกิน 6 บรรทัด
- ถ้าไม่ทราบ ให้ตอบ: “${unknown}”
- จบด้วยประโยคสุภาพสั้นๆ + อิโมจิ 1 ตัว
`.trim();
}
async function aiShortReply(userText, context=''){
  try{
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      max_tokens: 250,
      messages: [
        { role:'system', content: systemPrompt() },
        { role:'user', content: `${context?`[ข้อมูลเพิ่มเติม]\n${context}\n\n`:''}${userText}` }
      ]
    });
    return resp.choices?.[0]?.message?.content?.trim() || null;
  }catch(e){
    console.error('OpenAI error:', e.message);
    return null;
  }
}

// ----------------------- MESSAGES -------------------------
const msgText = text => ({ type: 'text', text });
const msgImage = url => ({ type:'image', originalContentUrl:url, previewImageUrl:url });
async function notifyAdmin(text, extra=[]){
  if(!ADMIN_GROUP_ID) return;
  try{ await lineClient.pushMessage(ADMIN_GROUP_ID, [msgText(text), ...extra].slice(0,5)); }
  catch(e){ console.error('notifyAdmin error:', e.message); }
}

// ----------------------- CART / ORDER HELPERS -------------
function cartSummary(cart){
  const sub = cart.reduce((s,it)=> s + Number(it.price||0)*Number(it.qty||0), 0);
  const promo = bestPromotion(cart);
  const total = Math.max(0, sub - (promo.discount||0));
  return { sub, promo, total };
}
function renderCartLines(cart){
  if(!cart?.length) return '-';
  return cart.map((it,i)=> `${i+1}. ${it.name}${it.chosenOption?` (${it.chosenOption})`:''} x ${it.qty} = ${THB(Number(it.price)*Number(it.qty))}`).join('\n');
}
async function persistOrder(userId, s, address='', phone='', status='รอยืนยัน'){
  const ts = dayjs().format('YYYYMMDDHHmmss');
  const orderNo = `ORD-${ts}-${(userId||'').slice(-4)}`;
  const sum = cartSummary(s.cart);
  const promoText = sum.promo.code ? `${sum.promo.code} - ${sum.promo.detail}` : '';
  for(const it of s.cart){
    await appendRow(FIXED_SHEETS.orders, {
      'เลขที่ออเดอร์': orderNo,
      'รหัสสินค้า': it.sku,
      'ชื่อสินค้า': it.name,
      'ตัวเลือก': it.chosenOption||'',
      'จำนวน': it.qty,
      'ราคารวม': Number(it.price)*Number(it.qty),
      'โปรโมชั่นที่ใช้': promoText,
      'ชื่อ-ที่อยู่': address || s.address || '',
      'เบอร์โทร': phone  || s.phone   || '',
      'สถานะ': status
    });
  }
  return { orderNo: orderNo, summary: sum };
}

// ----------------------- MULTI-ITEM PARSER ----------------
// พยายามดึง “ชื่อสินค้า + จำนวน” หลายชุดจากบรรทัดเดียว เช่น
// “เอาน้ำพริกเห็ด 2 ถุง กับกากหมู 1 กระปุก”
function parseMultiOrderText(text){
  const result = [];
  if(!text) return result;

  // ดึงจำนวน
  const qtyRegex = /(\d{1,3})\s*(ชิ้น|ถุง|กระปุก|หน่วย)?/i;
  // แยกด้วย "กับ , และ"
  const parts = text.split(/,|และ|กับ/).map(t=>t.trim()).filter(Boolean);

  for(const part of parts){
    const qtyMatch = part.match(qtyRegex);
    const qty = qtyMatch ? Number(qtyMatch[1]) : null;

    // ลองหา product จากข้อความส่วนนี้
    const found = searchProductsByText(part);
    if(found.length===1){
      result.push({ product: found[0], qty: qty||1 });
    }else if(found.length>1){
      // ถ้าชนหลายตัว ให้ผู้ใช้เลือกใน flow ปรกติ
      // ข้ามไป ให้ flow หลักจัดการ
    }else{
      // ไม่เจอ
    }
  }
  return result;
}

// ----------------------- MAIN TEXT HANDLER ----------------
async function handleText(userId, replyToken, text){
  const s = getSession(userId);
  const trimmed = (text||'').trim();

  // ---------- 0) ล็อก IN ----------
  try{
    await appendRow(FIXED_SHEETS.logs, {
      'timestamp': dayjs().format('YYYY-MM-DD HH:mm:ss'),
      'userId': userId,
      'type': 'IN',
      'text': trimmed
    });
  }catch(e){}

  // ---------- 1) FAQ/นอกเรื่อง (interrupt) ----------
  const faqAns = matchFAQ(trimmed);
  if(faqAns){
    await lineClient.replyMessage(replyToken, [msgText(faqAns)]);
    if(s.stage!=='idle'){
      await lineClient.pushMessage(userId, [
        msgText(`ต่อจากเมื่อกี้นะคะ 😊 ตอนนี้ตะกร้ามี:\n${renderCartLines(s.cart)}\nต้องการเพิ่มสินค้าอีกไหมคะ หรือ “สรุปออเดอร์” ได้เลยค่ะ ✨`)
      ]);
    }
    return;
  }

  // ---------- 2) Flow: picking_variant ----------
  if(s.stage==='picking_variant' && s.currentItem){
    const choice = splitList(trimmed)[0]?.toLowerCase();
    const options = s.currentItem.options || [];
    const matched = options.find(op => op.toLowerCase().includes(choice||''));
    if(matched || options.length===0){
      s.currentItem.chosenOption = matched || choice || '';
      s.stage = 'picking_qty';
      await saveSessionRow(s, 'picked_option');
      await lineClient.replyMessage(replyToken, [
        msgText(`ต้องการ “${s.currentItem.name}${s.currentItem.chosenOption?` (${s.currentItem.chosenOption})`:''}” จำนวนกี่ชิ้นดีคะ? (เช่น 2, 5)`)
      ]);
      return;
    }
    await lineClient.replyMessage(replyToken, [msgText(`ขอเลือกเป็นตัวไหนคะ\nตัวเลือกที่มี: ${options.join(', ')}`)]);
    return;
  }

  // ---------- 3) Flow: picking_qty ----------
  if(s.stage==='picking_qty' && s.currentItem){
    const m = trimmed.match(/\d+/);
    if(m){
      const qty = Math.max(1, Number(m[0]));
      s.cart.push({
        sku: s.currentItem.sku,
        name: s.currentItem.name,
        category: s.currentItem.category||'',
        price: Number(s.currentItem.price||0),
        chosenOption: s.currentItem.chosenOption||'',
        qty
      });
      s.currentItem = null;
      s.stage = 'confirming';
      await saveSessionRow(s, 'qty_added');

      const sum = cartSummary(s.cart);
      await lineClient.replyMessage(replyToken, [
        msgText(`รับทราบค่ะ 🧾\nตะกร้าปัจจุบัน:\n${renderCartLines(s.cart)}\n\nยอดสุทธิ: ${THB(sum.total)}${sum.promo.code?`\nโปรฯ: ${sum.promo.detail}`:''}\n\nต้องการเพิ่มสินค้าอีกไหมคะ? หรือพิมพ์ “สรุปออเดอร์” ได้เลยค่ะ ✨`)
      ]);
      return;
    }else{
      await lineClient.replyMessage(replyToken, [msgText(`พิมพ์เป็นตัวเลขจำนวนชิ้นนะคะ เช่น 2 หรือ 5`)]); 
      return;
    }
  }

  // ---------- 4) คำสั่งสรุป/จบ/ยืนยัน ----------
  if(/สรุป|ยืนยัน|ปิดการขาย|จบ/i.test(trimmed)){
    if(!s.cart.length){
      await lineClient.replyMessage(replyToken, [msgText(`ยังไม่มีสินค้าในตะกร้าเลยค่ะ 😊 พิมพ์ชื่อสินค้าที่ต้องการได้เลยนะคะ`)]); 
      return;
    }
    s.stage = 'collecting_info';
    await saveSessionRow(s, 'start_checkout');

    const cats = [...new Set(s.cart.map(it=>it.category||'all'))];
    const pay = pickPayment(cats[0] || 'all');
    await lineClient.replyMessage(replyToken, [
      msgText(`ขอสรุปข้อมูลสำหรับจัดส่งค่ะ\nกรุณาบอก “ชื่อ-ที่อยู่” และ “เบอร์โทร” ด้วยนะคะ`),
      msgText(`ช่องทางชำระเงินที่รองรับ: ${pay.method}\n${pay.detail?`รายละเอียด: ${pay.detail}`:''}${pay.qrcode?`\nถ้าต้องการ QR พิมพ์ว่า “ขอ QR” ได้เลย 📷`:''}${/cod|ปลายทาง/i.test(pay.method+pay.detail)?`\nหากต้องการเก็บเงินปลายทาง พิมพ์ “เก็บปลายทาง” ได้ค่ะ 📦`:''}`)
    ]);
    return;
  }

  // ---------- 5) ขั้นกลาง: ลูกค้าพิมพ์หลายรายการในบรรทัดเดียว ----------
  const multi = parseMultiOrderText(trimmed);
  if(multi.length){
    // ใส่ลง cart ทั้งหมด
    for(const x of multi){
      const p = x.product;
      const options = extractOptions(p);
      s.cart.push({
        sku: p['รหัสสินค้า'],
        name: p['ชื่อสินค้า'],
        category: p['หมวดหมู่']||'',
        price: Number(p['ราคา']||0),
        chosenOption: options[0]||'', // เดาอันแรก ถ้ามี
        qty: x.qty||1
      });
    }
    s.stage = 'confirming';
    await saveSessionRow(s, 'multi_add');

    const sum = cartSummary(s.cart);
    await lineClient.replyMessage(replyToken, [
      msgText(`เพิ่มสินค้าให้แล้วค่ะ 🧺\n${renderCartLines(s.cart)}\n\nยอดสุทธิ: ${THB(sum.total)}${sum.promo.code?`\nโปรฯ: ${sum.promo.detail}`:''}\nต้องการเพิ่มสินค้าอีกไหมคะ? หรือพิมพ์ “สรุปออเดอร์” ได้เลย ✨`)
    ]);
    return;
  }

  // ---------- 6) ตรวจการร้องขอ QR / COD ระหว่าง collect_info ----------
  if(s.stage==='collecting_info'){
    if(/qr|คิวอาร์|พร้อมเพย์/i.test(trimmed)){
      const cats = [...new Set(s.cart.map(it=>it.category||'all'))];
      const pay = pickPayment(cats[0]||'all');
      const msgs = [ msgText(`ส่ง QR ให้เลยค่ะ นำไปสแกนโอนได้เลย 🙏`) ];
      if(pay.qrcode) msgs.push(msgImage(pay.qrcode));
      else msgs.push(msgText(pay.detail || '—'));
      await lineClient.replyMessage(replyToken, msgs);
      return;
    }
    if(/cod|ปลายทาง/i.test(trimmed)){
      s.paymentMethod = 'COD';
      await lineClient.replyMessage(replyToken, [msgText(`รับทราบค่ะ จะเก็บเงินปลายทางนะคะ 📦 กรุณาส่ง “ชื่อ-ที่อยู่” และ “เบอร์โทร” ด้วยค่ะ`)]); 
      return;
    }
    // พยายามจับที่อยู่/โทรจากข้อความเดียวกัน
    const phone = trimmed.match(/0\d{8,9}/)?.[0] || '';
    if(phone) s.phone = phone;
    if(trimmed.length > 12 && !/qr|cod|ปลายทาง/i.test(trimmed)){
      s.address = trimmed;
    }
    if(s.address && s.phone){
      const { orderNo, summary } = await persistOrder(userId, s, s.address, s.phone, s.paymentMethod==='COD'?'เก็บปลายทาง':'รอชำระ');
      await lineClient.replyMessage(replyToken, [
        msgText(`สรุปออเดอร์ #${orderNo}\n${renderCartLines(s.cart)}\nโปรฯ: ${summary.promo.code?summary.promo.detail:'—'}\nยอดสุทธิ: ${THB(summary.total)}\n\nจัดส่ง: ${s.address}\nโทร: ${s.phone}\n\nขอบคุณมากค่ะ 🥰`)
      ]);
      await notifyAdmin(`🛒 ออเดอร์ใหม่ #${orderNo}\n${renderCartLines(s.cart)}\nยอด: ${THB(summary.total)}\nที่อยู่: ${s.address}\nโทร: ${s.phone}`);
      sessions.delete(userId);
      return;
    }else{
      await lineClient.replyMessage(replyToken, [msgText(`ขอ “ชื่อ-ที่อยู่” และ “เบอร์โทร” เพิ่มหน่อยนะคะ เพื่อดำเนินการต่อค่ะ 😊`)]);
      return;
    }
  }

  // ---------- 7) ตรวจว่าพูดถึงสินค้าเดี่ยว/ระบุชัด ----------
  const found = searchProductsByText(trimmed);
  if(found.length===1){
    const p = found[0];
    const options = extractOptions(p);
    s.currentItem = {
      sku: p['รหัสสินค้า'],
      name: p['ชื่อสินค้า'],
      category: p['หมวดหมู่']||'',
      price: Number(p['ราคา']||0),
      options
    };
    s.stage = options.length ? 'picking_variant' : 'picking_qty';
    await saveSessionRow(s, 'product_detected');

    if(options.length){
      await lineClient.replyMessage(replyToken, [
        msgText(`ต้องการ “${p['ชื่อสินค้า']}” แบบไหนดีคะ?\nตัวเลือก: ${options.join(', ')}`)
      ]);
    }else{
      await lineClient.replyMessage(replyToken, [
        msgText(`ต้องการ “${p['ชื่อสินค้า']}” จำนวนกี่ชิ้นคะ? (เช่น 2, 5)`)
      ]);
    }
    return;
  }else if(found.length>1){
    const list = found.slice(0,6).map(x=>'• '+x['ชื่อสินค้า']).join('\n');
    await lineClient.replyMessage(replyToken, [msgText(`หมายถึงตัวไหนคะ 😊\n${list}\n\nพิมพ์ให้ชัดขึ้นหน่อยได้ไหมคะ`)]); 
    return;
  }

  // ---------- 8) Fallback → ตอบสั้น ๆ ด้วย AI แล้วดึงกลับการขาย ----------
  const hint = `
[รายการตัวอย่าง]
${cache.products.slice(0,8).map(p=>`• ${p['ชื่อสินค้า']} (${THB(p['ราคา'])})${p['ตัวเลือก']?` – ตัวเลือก: ${extractOptions(p).join(', ')}`:''}`).join('\n')}
`.trim();
  const ai = await aiShortReply(trimmed, hint);
  await lineClient.replyMessage(replyToken, [msgText(ai || 'รับทราบค่ะ 😊')]);

  if(s.stage!=='idle'){
    await lineClient.pushMessage(userId, [
      msgText(`ตอนนี้ในตะกร้ามี:\n${renderCartLines(s.cart)}\nต้องการเพิ่มสินค้าอีกไหมคะ หรือพิมพ์ “สรุปออเดอร์” ได้เลยค่ะ ✨`)
    ]);
  }
}

// ----------------------- WEB SERVER -----------------------
const app = express();
app.get('/', (req,res)=>res.send('OK'));
app.get('/healthz', (req,res)=>res.send('ok'));

app.post('/webhook', lineMiddleware(lineConfig), async (req,res)=>{
  try{
    if(!cache.persona) await loadAllData(); // lazy load รอบแรก
    res.status(200).end();

    const events = req.body.events || [];
    for(const ev of events){
      if(ev.type==='message' && ev.message?.type==='text'){
        const userId = ev.source?.userId || ev.source?.groupId || ev.source?.roomId || 'unknown';
        await handleText(userId, ev.replyToken, ev.message.text);
      }else if(ev.type==='follow'){
        const hi = `สวัสดีค่ะ 😊 ยินดีต้อนรับสู่ร้านของเรา\nพิมพ์ชื่อสินค้าที่สนใจได้เลยค่ะ หรือถามข้อมูลอื่นๆ ก็ได้ค่ะ`;
        await lineClient.replyMessage(ev.replyToken, [msgText(hi)]);
      }
    }
  }catch(err){
    console.error('Webhook Error:', err);
    try{
      await appendRow(FIXED_SHEETS.logs, {
        'timestamp': dayjs().format('YYYY-MM-DD HH:mm:ss'),
        'userId': 'system',
        'type': 'ERR',
        'text': err?.message || String(err)
      });
    }catch(e){}
  }
});

// รีเฟรชข้อมูลทุก 10 นาที (กันข้อมูลแก้ในชีทแล้วไม่อัปเดต)
setInterval(async()=>{ try{ await loadAllData(); }catch(e){} }, 10*60*1000);

// ----------------------- START ----------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, async ()=>{
  try{
    await loadAllData();
    console.log(`🚀 Server running on port ${PORT}`);
  }catch(e){
    console.error('❌ Google Sheet Error:', e.message);
  }
});
