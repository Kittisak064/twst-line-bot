// =============================================================
// LINE Commerce RAG Bot — Google Sheets + LINE + OpenAI
// Single-file production app.js (RAG-first, Strict, Thai)
// =============================================================

/*
สิ่งที่ไฟล์นี้มีให้ครบ:
- Google Sheets: Products, Promotions, FAQ, Personality, Payment
- Retrieval (RAG): ค้นข้อมูลจากชีทแบบ strict (ไม่เดา ไม่แต่ง)
- NLP parser เบื้องต้น: จำนวน/ขนาด/คำค้น จากข้อความธรรมชาติ
- Session + Cart หลายรายการ/หลายหมวด
- Orders -> บันทึกชีท + แจ้งเตือน ADMIN_GROUP_ID
- Promotions สรุป (แบบ rule-based เบื้องต้น)
- ทุกข้อความผ่าน OpenAI เพื่อ "ปรับโทน" เท่านั้น (ห้ามเพิ่มข้อมูลใหม่)
- LINE Webhook + Signature Verify (raw body)
- Endpoints: /healthz /reload /debug
- Error handling + logging + null guard กับแถวว่างในชีท
*/

// ------------------ Imports ------------------
import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import { google } from "googleapis";
import fetch from "node-fetch";
import OpenAI from "openai";

// ------------------ Env ------------------
const {
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  GOOGLE_SHEET_ID,
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  OPENAI_API_KEY,
  ADMIN_GROUP_ID,
  PORT
} = process.env;

if (!GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY || !GOOGLE_SHEET_ID ||
    !LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET || !OPENAI_API_KEY) {
  console.error("[BOOT] Missing required environment variables.");
  console.error("Required:", [
    "GOOGLE_CLIENT_EMAIL","GOOGLE_PRIVATE_KEY","GOOGLE_SHEET_ID",
    "LINE_CHANNEL_ACCESS_TOKEN","LINE_CHANNEL_SECRET","OPENAI_API_KEY"
  ].join(", "));
  // ไม่ throw ให้ Render รันขึ้นเพื่อดู healthz ได้
}

const GOOGLE_PRIVATE_KEY_FIX = GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

// ------------------ Google Sheets ------------------
const sheets = google.sheets("v4");
const auth = new google.auth.JWT(
  GOOGLE_CLIENT_EMAIL,
  null,
  GOOGLE_PRIVATE_KEY_FIX,
  ["https://www.googleapis.com/auth/spreadsheets"]
);

// ------------------ OpenAI ------------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ------------------ Cache ------------------
const cache = {
  products: [],
  promotions: [],
  faq: [],
  personality: null,
  payment: [],
  lastLoadedAt: 0
};

// ------------------ Utils ------------------
const log = (...a) => console.log("[BOT]", ...a);
const nowISO = () => new Date().toISOString();
const shortId = () => Math.random().toString(36).slice(2, 10);
const priceTHB = (n) => `${Number(n||0).toLocaleString("th-TH")} บาท`;

// ------------------ Personality helpers ------------------
const staffPrefix = () => cache.personality?.gender === "หญิง" ? "ค่ะ" : "ครับ";
const customerName = () => cache.personality?.customerName || "ลูกค้า";
const staffName = () => cache.personality?.staffName || "ทีมงาน";
const pageName = () => cache.personality?.pageName || "เพจของเรา";
const dontKnow = () => cache.personality?.dontKnow || "ขอเช็กข้อมูลให้ก่อนนะ";

// ------------------ Load Sheets ------------------
async function loadSheet(range) {
  const res = await sheets.spreadsheets.values.get({
    auth, spreadsheetId: GOOGLE_SHEET_ID, range
  });
  return res.data.values || [];
}

function splitList(s) {
  if (!s) return [];
  return String(s).split(",").map(t => t.trim()).filter(Boolean);
}

async function ensureDataLoaded(force=false) {
  if (!force && Date.now()-cache.lastLoadedAt < 5*60*1000) return;
  log("Reloading sheets data…");
  const [prod, promos, faq, persona, pay] = await Promise.all([
    loadSheet("Products!A2:G"),
    loadSheet("Promotions!A2:F"),
    loadSheet("FAQ!A2:C"),
    loadSheet("Personality!A2:G"),
    loadSheet("Payment!A2:C")
  ]);

  cache.products = prod
    .filter(r => r && r[0]) // มีรหัส
    .map(r => ({
      code: r[0], name: r[1] || "", category: r[2] || "",
      price: Number(r[3]||0),
      aliases: splitList(r[4]),
      options: splitList(r[5]),
      sizes: splitList(r[6])
    }));

  cache.promotions = promos
    .filter(r => r && (r[0]||r[1]||r[2]))
    .map(r => ({
      code: r[0] || "", detail: r[1] || "",
      type: (r[2]||"").toLowerCase(), condition: r[3] || "",
      products: splitList(r[4]), categories: splitList(r[5])
    }));

  cache.faq = faq
    .filter(r => r && (r[1]||r[2]))
    .map(r => ({ q: r[0]||"", keyword: r[1]||"", a: r[2]||"" }));

  if (persona && persona.length) {
    const p = persona[0];
    cache.personality = {
      staffName: p[0] || "ทีมงาน",
      pageName: p[1] || "เพจของเรา",
      persona: p[2] || "พนักงานขาย สุภาพ กระชับ เป็นกันเอง",
      customerName: p[3] || "ลูกค้า",
      adminSelf: p[4] || "แอดมิน",
      dontKnow: p[5] || "ขอเช็กข้อมูลให้ก่อนนะ",
      gender: p[6] || "หญิง"
    };
  }

  cache.payment = pay
    .filter(r => r && (r[0]||r[1]||r[2]))
    .map(r => ({ category: r[0]||"", method: r[1]||"", detail: r[2]||"" }));

  cache.lastLoadedAt = Date.now();
  log("Sheets reloaded");
}

// ------------------ LINE API ------------------
async function lineReply(replyToken, messages) {
  const url = "https://api.line.me/v2/bot/message/reply";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type":"application/json",
      Authorization:`Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({ replyToken, messages })
  });
  if (!res.ok) log("LINE reply error", res.status, await res.text());
}

async function linePush(to, messages) {
  const url = "https://api.line.me/v2/bot/message/push";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type":"application/json",
      Authorization:`Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({ to, messages })
  });
  if (!res.ok) log("LINE push error", res.status, await res.text());
}

const makeReply = (text, quick=[]) => {
  const msg = { type:"text", text: String(text||"") };
  if (quick.length) {
    msg.quickReply = {
      items: quick.map(label => ({
        type:"action",
        action: { type:"message", label, text: label }
      }))
    };
  }
  return msg;
};

function verifySignature(signature, bodyBuffer) {
  const h = crypto.createHmac("SHA256", LINE_CHANNEL_SECRET)
                  .update(bodyBuffer)
                  .digest("base64");
  return signature === h;
}

// ------------------ NLP / Retrieval ------------------
const normalize = (s="") => String(s).trim().toLowerCase().replace(/\s+/g," ");

function parseQuantity(text) {
  const t = normalize(text);
  const m = t.match(/(\d+)\s*(ชิ้น|กระปุก|กล่อง|คัน|ขวด|กิโล|แพ็ค)?/);
  if (m) return Math.max(1, parseInt(m[1],10));
  const map = { "หนึ่ง":1,"สอง":2,"สาม":3,"สี่":4,"ห้า":5,"หก":6,"เจ็ด":7,"แปด":8,"เก้า":9,"สิบ":10 };
  for (const [k,v] of Object.entries(map)) if (t.includes(k)) return v;
  return 1;
}

function parseSize(text) {
  const m = text.match(/(\d+\s?(g|กรัม|ml|ลิตร|ah|กก))/i);
  return m ? m[1].replace(/\s+/g,"").toLowerCase() : "";
}

function detectCategory(text) {
  const t = normalize(text);
  if (t.includes("น้ำพริก")) return "น้ำพริก";
  if (t.includes("รถเข็น")) return "รถเข็นไต่บันได";
  return "";
}

// Retrieval (RAG) — ค้นจากชีทเท่านั้น
function retrieveProductsByCategory(category) {
  return cache.products.filter(p => normalize(p.category) === normalize(category));
}

function retrieveProductCandidates(text) {
  const low = normalize(text);
  // ช่วยด้วย alias + partial name
  return cache.products.filter(p =>
    normalize(p.name).includes(low) ||
    p.aliases.some(a => normalize(a).includes(low))
  );
}

function retrieveFAQ(text) {
  const low = normalize(text);
  return cache.faq.find(f => f.keyword && low.includes(normalize(f.keyword)));
}

// ------------------ Cart / Session ------------------
const sessions = {}; // in-memory (ย้ายไป Redis/DB ได้ในอนาคต)

function getSession(uid) {
  if (!sessions[uid]) sessions[uid] = { userId: uid, stage:"", cart:[], note:"" };
  return sessions[uid];
}

function addToCart(session, product, qty=1, option="", size="") {
  if (!product) return;
  const found = session.cart.find(c => c.code===product.code && c.option===option && c.size===size);
  if (found) found.qty += qty;
  else session.cart.push({
    code: product.code, name: product.name, option, size, qty,
    price: Number(product.price||0), category: product.category
  });
}

function cartTotal(session) {
  return (session.cart||[]).reduce((s,c)=> s + (c.price*c.qty), 0);
}

function cartSummary(session) {
  if (!session.cart || !session.cart.length) return `ตะกร้ายังว่างอยู่${staffPrefix()} 🛒`;
  const lines = session.cart.map(c =>
    `• ${c.name}${c.option?` (${c.option})`:""}${c.size?` ${c.size}`:""} x${c.qty} = ${priceTHB(c.price*c.qty)}`
  );
  return `สรุปตะกร้าค่ะ:\n${lines.join("\n")}\nรวมทั้งหมด ${priceTHB(cartTotal(session))}`;
}

// ------------------ Promotions (rule-based เบื้องต้น) ------------------
function applyPromotions(session) {
  const promos = [];
  if (!session.cart?.length) return promos;

  for (const promo of cache.promotions) {
    const type = promo.type || "";
    if (type === "discount") {
      // ใช้ได้ถ้าหมวดใดหมวดหนึ่งในตะกร้าอยู่ใน promo.categories
      const match = session.cart.some(c => promo.categories.includes(c.category));
      if (match) promos.push(promo.detail);
    } else if (type === "buyxgety") {
      const match = session.cart.some(c => promo.categories.includes(c.category));
      if (match) promos.push(promo.detail);
    }
  }
  return promos;
}
const promotionSummary = (session) => {
  const p = applyPromotions(session);
  return p.length ? `โปรโมชั่นที่ใช้ได้:\n${p.map(x=>"• "+x).join("\n")}` : "";
};

// ------------------ Orders + Logs + Payment + Admin notify ------------------
async function saveOrder(userId, session, nameAddr="", phone="") {
  const orderId = "ORD-"+shortId();
  const rows = (session.cart||[]).map(c => [
    orderId, c.code, c.name, c.option, c.qty, c.price*c.qty,
    promotionSummary(session), nameAddr, phone, "ใหม่"
  ]);
  if (!rows.length) return orderId;

  try {
    await sheets.spreadsheets.values.append({
      auth, spreadsheetId: GOOGLE_SHEET_ID,
      range: `Orders!A:J`, valueInputOption: "RAW",
      requestBody: { values: rows }
    });
  } catch (e) { log("saveOrder error:", e.message); }
  return orderId;
}

async function logEvent(userId, type, text) {
  try {
    await sheets.spreadsheets.values.append({
      auth, spreadsheetId: GOOGLE_SHEET_ID,
      range:`Logs!A:D`, valueInputOption:"RAW",
      requestBody: { values: [[nowISO(), userId, type, String(text||"")]] }
    });
  } catch(e) { log("logEvent error:", e.message); }
}

const paymentReply = () => {
  const lines = cache.payment.map(p=>`• ${p.category}: ${p.method} (${p.detail})`);
  return lines.length ? `วิธีชำระเงินที่รองรับค่ะ:\n${lines.join("\n")}` : "วิธีชำระเงินยังไม่ถูกตั้งค่าในชีทค่ะ";
};

async function notifyAdmin(orderId, session) {
  if (!ADMIN_GROUP_ID) return;
  const lines = (session.cart||[]).map(c =>
    `• ${c.name}${c.size?" "+c.size:""} x${c.qty} = ${priceTHB(c.price*c.qty)}`
  );
  const total = cartTotal(session);
  const promo = promotionSummary(session);
  await linePush(ADMIN_GROUP_ID, [
    { type:"text", text: `🛒 ออเดอร์ใหม่ ${orderId}`},
    { type:"text", text: `${lines.join("\n")}\nรวม ${priceTHB(total)}${promo?`\n${promo}`:""}` }
  ]);
}

// ------------------ Listing helpers (RAG listing) ------------------
function listByCategory(category, limit=6) {
  const items = retrieveProductsByCategory(category);
  if (!items.length) return `ยังไม่มีสินค้าในหมวด ${category} ${staffPrefix()}`;
  const lines = items.slice(0, limit).map(p =>
    `• ${p.name}${p.sizes.length?` (${p.sizes.join("/")})`:""} — ${priceTHB(p.price)}`
  );
  return `${category}ที่มีค่ะ:\n${lines.join("\n")}${items.length>limit?`\n...ยังมีอีก สนใจดูเพิ่มเติมไหม${staffPrefix()}?`:""}`;
}

// ------------------ Intent detection + FAQ strict ------------------
function matchFAQStrict(text) {
  const f = retrieveFAQ(text);
  return f ? f.a : null;
}

function detectIntent(text) {
  const low = normalize(text);
  // FAQ ก่อน
  const fa = matchFAQStrict(text);
  if (fa) return { type:"faq", answer: fa };

  if (/(สวัสดี|hello|hi|เฮลโล)/.test(low)) return { type:"greet" };
  if (/(คุณชื่ออะไร|ชื่ออะไร|ใครคุย|ใครตอบ)/.test(low)) return { type:"ask_name" };
  if (/(เพจอะไร|ร้านอะไร|นี่เพจอะไร|ชื่อเพจ)/.test(low)) return { type:"ask_page" };
  if (/(เช็กเอาท์|checkout|จ่ายเงิน|สรุปออเดอร์|ชำระเงิน)/.test(low)) return { type:"checkout" };

  // add_to_cart หากมีคำอย่าง "เอา, สั่ง, รับ, ใส่"
  if (/(เอา|สั่ง|ใส่|รับ|เพิ่ม)/.test(low)) return { type:"add_to_cart" };

  // browse category
  if (low.includes("น้ำพริก")) return { type:"browse", category:"น้ำพริก" };
  if (low.includes("รถเข็น")) return { type:"browse", category:"รถเข็นไต่บันได" };

  return { type:"unknown" };
}

// ------------------ OpenAI Rewriter (STRICT, RAG-only) ------------------
async function rewriteWithAI(structuredMsg, ragContext="") {
  // structuredMsg = เนื้อหาที่สกัดจากชีทเท่านั้น
  // ragContext = รายการข้อมูลจากชีท (รายการสินค้า/ราคา/คำตอบ FAQ/วิธีจ่าย)
  try {
    const persona = cache.personality?.persona || "พนักงานขาย สุภาพ กระชับ เป็นกันเอง";
    const staff = staffName();
    const page = pageName();
    const cName = customerName();

    const system = `
คุณคือพนักงานขายชื่อ "${staff}" จาก "${page}" บุคลิก: ${persona}
กฎเหล็ก (สำคัญมาก ต้องปฏิบัติตามทุกข้อ):
- ห้ามแต่งหรือเพิ่มข้อมูลใหม่ที่ไม่ได้อยู่ใน "บริบท (RAG Context)" หรือ "ข้อความต้นฉบับ"
- ห้ามสมมุติ/คาดเดา/โฆษณาเกินจริง
- ทำหน้าที่เพียง "ปรับโทน" ให้สุภาพ เป็นธรรมชาติ ชวนคุยต่อเล็กน้อย
- คำตอบต้องสั้น กระชับ อ่านง่าย
- ถ้า structuredMsg ว่างหรือกำกวม ให้ตอบแนวสุภาพว่าไม่แน่ใจและชวนลูกค้าเลือกหมวด (น้ำพริก/รถเข็น) แทน
`;

    const user = `
[RAG Context จากชีท]
${ragContext || "(ไม่มีบริบทเพิ่มเติม)"}

[ข้อความต้นฉบับให้ปรับโทน (ห้ามเพิ่ม/ห้ามตัดสารสำคัญ)]
${structuredMsg}
    `.trim();

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      max_tokens: 220,
      messages: [
        { role:"system", content: system },
        { role:"user", content: user }
      ]
    });

    const out = (resp.choices?.[0]?.message?.content || structuredMsg).trim();
    return out;
  } catch (e) {
    log("rewriteWithAI error:", e.message);
    return structuredMsg;
  }
}

// ------------------ Conversation Handler (RAG-first) ------------------
async function handleMessage(userId, replyToken, text) {
  await ensureDataLoaded();
  const session = getSession(userId);
  await logEvent(userId, "in", text);

  const intent = detectIntent(text);
  log("intent:", intent);

  let structured = "";     // เนื้อหาจากชีท (จริงเท่านั้น)
  let ragContext = "";     // รายการที่ค้นเจอเพื่อให้ AI เห็นบริบท
  let quick = [];

  switch (intent.type) {
    case "greet": {
      structured = `สวัสดี${staffPrefix()} ตอนนี้คุยกับแอดมิน${staffName()}จากเพจ ${pageName()} สนใจดูหมวดไหน น้ำพริกหรือรถเข็นไต่บันได`;
      quick = ["น้ำพริก","รถเข็น"];
      break;
    }
    case "ask_name": {
      structured = `ฉันชื่อ ${staffName()} เป็นพนักงานขายจากเพจ ${pageName()}`;
      break;
    }
    case "ask_page": {
      structured = `เพจที่กำลังคุยคือ "${pageName()}"`;
      break;
    }
    case "faq": {
      // ใช้คำตอบจากชีทตรง ๆ
      structured = intent.answer;
      break;
    }
    case "browse": {
      session.stage = intent.category;
      const items = retrieveProductsByCategory(intent.category);
      if (items.length) {
        ragContext = items.map(p => `${p.name}${p.sizes.length?` (${p.sizes.join("/")})`:""} = ${priceTHB(p.price)}`).join("\n");
        structured = `รายการสินค้าในหมวด ${intent.category} (ดูในบริบท)`;
        quick = items.slice(0,3).map(p=>p.name).concat(["เช็กเอาท์"]);
      } else {
        structured = `ยังไม่มีสินค้าในหมวด ${intent.category}`;
      }
      break;
    }
    case "add_to_cart": {
      // 1) พยายามอ่านสินค้าจากข้อความ
      const qty = parseQuantity(text);
      const size = parseSize(text);
      // หา candidate โดย keyword ทั้งก้อน
      let candidates = retrieveProductCandidates(text);

      // ถ้าไม่มี candidate: ใช้ stage ปัจจุบันเป็นตัวช่วย (เช่นกำลังอยู่หมวดน้ำพริก)
      if (!candidates.length && session.stage) {
        candidates = retrieveProductsByCategory(session.stage);
      }

      if (candidates.length) {
        // เลือกตัวแรก (หรือจะทำ disambiguation เพิ่มได้)
        const p = candidates[0];
        const finalSize = size || (p.sizes[0] || "");
        addToCart(session, p, qty, "", finalSize);
        structured = `เพิ่ม ${p.name}${finalSize?` ${finalSize}`:""} จำนวน ${qty} ชิ้น ลงตะกร้าแล้ว`;
        ragContext = `${p.name}${finalSize?` ${finalSize}`:""} = ${priceTHB(p.price)}`;
        quick = ["ดูโปร","เช็กเอาท์"];
      } else {
        // ไม่เจอจริง ๆ → อย่าแต่ง ให้เสนอหมวดหลักแทน
        structured = `${dontKnow()} ตอนนี้มี 2 หมวดหลักให้เลือกคือ น้ำพริก และ รถเข็นไต่บันได`;
        quick = ["น้ำพริก","รถเข็น"];
      }
      break;
    }
    case "checkout": {
      // สรุปตะกร้า + โปร + วิธีจ่าย
      const itemsLines = (session.cart||[]).map(c =>
        `${c.name}${c.size?` ${c.size}`:""} x${c.qty} = ${priceTHB(c.price*c.qty)}`
      ).join("\n");
      const total = priceTHB(cartTotal(session));
      const promos = promotionSummary(session);
      const payments = paymentReply();

      ragContext = [
        itemsLines ? `ตะกร้า:\n${itemsLines}\nรวม: ${total}` : "ตะกร้าว่าง",
        promos || "",
        payments || ""
      ].filter(Boolean).join("\n\n");

      structured = `สรุปตะกร้าและวิธีชำระเงินดูในบริบทด้านบน`;
      quick = ["ยืนยันสั่งซื้อ","น้ำพริก","รถเข็น"];
      break;
    }
    case "unknown":
    default: {
      // ลองสลับหมวดอัตโนมัติ
      const cat = detectCategory(text);
      if (cat) {
        session.stage = cat;
        const items = retrieveProductsByCategory(cat);
        if (items.length) {
          ragContext = items.map(p => `${p.name}${p.sizes.length?` (${p.sizes.join("/")})`:""} = ${priceTHB(p.price)}`).join("\n");
          structured = `รายการสินค้าในหมวด ${cat} (ดูในบริบท)`;
          quick = items.slice(0,3).map(p=>p.name).concat(["เช็กเอาท์"]);
        } else {
          structured = `ยังไม่มีสินค้าในหมวด ${cat}`;
        }
      } else {
        structured = `${dontKnow()} สนใจดูหมวดไหน น้ำพริก หรือ รถเข็นไต่บันได`;
        quick = ["น้ำพริก","รถเข็น"];
      }
      break;
    }
  }

  if (!structured) {
    structured = `${dontKnow()} ถ้าพร้อม เลือกดูหมวดหลักก่อนก็ได้ค่ะ`;
    quick = ["น้ำพริก","รถเข็น"];
  }

  const finalText = await rewriteWithAI(structured, ragContext);
  await lineReply(replyToken, [makeReply(finalText, quick)]);
  await logEvent(userId, "out", finalText);
}

// ------------------ Express App / Webhook ------------------
const app = express();

// ใช้ raw body สำหรับ /webhook (verify signature)
app.use("/webhook", bodyParser.raw({ type:"*/*" }));
app.use(bodyParser.json());

// healthz
app.get("/healthz", (req,res)=> res.json({ ok:true, ts: Date.now() }));

// reload cache
app.post("/reload", async (req,res) => {
  try {
    await ensureDataLoaded(true);
    res.json({ reloadedAt: cache.lastLoadedAt, staff: cache.personality?.staffName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// debug (ตัดให้สั้นเพื่อความปลอดภัย)
app.get("/debug", async (req,res) => {
  try {
    await ensureDataLoaded();
    res.json({
      productsSample: cache.products.slice(0,5),
      promotionsSample: cache.promotions.slice(0,3),
      faqSample: cache.faq.slice(0,3),
      personality: cache.personality,
      payment: cache.payment
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// webhook
app.post("/webhook", async (req,res) => {
  const signature = req.headers["x-line-signature"];
  if (!verifySignature(signature, req.body)) {
    return res.status(400).send("Invalid signature");
  }
  const body = JSON.parse(req.body.toString("utf8"));
  res.sendStatus(200);

  for (const ev of (body.events||[])) {
    try {
      if (ev.type==="message" && ev.message?.type==="text") {
        const uid = ev.source?.userId || "unknown";
        await handleMessage(uid, ev.replyToken, ev.message.text || "");
      } else {
        // ตอบทุกข้อความ ห้ามเงียบ
        await lineReply(ev.replyToken, [makeReply(`ขออภัย ตอนนี้รองรับเฉพาะข้อความตัวอักษร${staffPrefix()} 🙏` , ["น้ำพริก","รถเข็น","เช็กเอาท์"])]);
      }
    } catch (e) {
      log("event error:", e.message);
      try {
        await lineReply(ev.replyToken, [makeReply(`${dontKnow()} ถ้ายังไม่สะดวก ลองพิมพ์ชื่อสินค้าหรือเลือกหมวดได้เลย${staffPrefix()}`, ["น้ำพริก","รถเข็น"])]);
      } catch {}
    }
  }
});

// boot
const port = PORT || 3000;
app.listen(port, async () => {
  log(`🚀 Server running on port ${port}`);
  try { await ensureDataLoaded(true); } catch(e) { log("initial load error:", e.message); }
});
