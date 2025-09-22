// =============================================================
// LINE Commerce Bot (Production Version)
// Part 1/10: Imports, Env, Google Sheets Setup, Cache
// =============================================================

// ---- Imports ----
import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import { google } from "googleapis";
import fetch from "node-fetch";
import OpenAI from "openai";

// ---- Env Variables ----
// ต้องใส่ใน Render Environment Variables
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

// ปรับ format ของ PRIVATE_KEY (Render จะ escape \n เป็น \\n)
const GOOGLE_PRIVATE_KEY_FIX = GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

// ---- Setup Google Sheets ----
const sheets = google.sheets("v4");
const auth = new google.auth.JWT(
  GOOGLE_CLIENT_EMAIL,
  null,
  GOOGLE_PRIVATE_KEY_FIX,
  ["https://www.googleapis.com/auth/spreadsheets"]
);

// ---- Setup OpenAI ----
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
});

// ---- Global Cache ----
// เก็บข้อมูลจากชีท เพื่อลดการ query บ่อย ๆ
const cache = {
  products: [],
  promotions: [],
  faq: [],
  personality: null,
  payment: [],
  lastLoadedAt: 0
};

// ---- Utility Functions ----

// format ราคาให้เป็น บาท
function priceTHB(num) {
  return `${Number(num).toLocaleString("th-TH")} บาท`;
}

// short random id
function shortId() {
  return Math.random().toString(36).substr(2, 8);
}

// current timestamp
function now() {
  return new Date().toISOString();
}

// logging
function log(...args) {
  console.log("[BOT]", ...args);
}
// =============================================================
// LINE Commerce Bot (Production Version)
// Part 2/10: NLP Parser (สินค้า + จำนวน + ขนาด)
// =============================================================

// ---- Text Normalization ----
function normalizeText(text = "") {
  return text
    .replace(/\s+/g, " ")
    .replace(/[ๆๆ]/g, "ๆ")
    .trim()
    .toLowerCase();
}

// ---- Parse จำนวน ----
// รองรับ "2", "สอง", "3 กระปุก", "4 ขวด", "1 คัน"
function parseQuantity(text) {
  const thaiNumbers = {
    "หนึ่ง": 1, "สอง": 2, "สาม": 3, "สี่": 4, "ห้า": 5,
    "หก": 6, "เจ็ด": 7, "แปด": 8, "เก้า": 9, "สิบ": 10,
  };
  let qty = 1;

  // เลขอารบิก
  const matchDigit = text.match(/(\d+)\s*(ชิ้น|กระปุก|ถุง|คัน|กิโล|กล่อง)?/);
  if (matchDigit) {
    qty = parseInt(matchDigit[1]);
    return qty;
  }

  // เลขไทย
  for (const [word, val] of Object.entries(thaiNumbers)) {
    if (text.includes(word)) {
      qty = val;
      break;
    }
  }

  return qty;
}

// ---- Parse ขนาด ----
// เช่น "80g", "120g", "250 กรัม", "12ah", "20ah"
function parseSize(text) {
  const match = text.match(/(\d+\s?(g|กรัม|ah|กก|ml|ลิตร))/i);
  if (match) return match[1].replace(/\s+/g, "").toLowerCase();
  return "";
}

// ---- Match Product ----
function findProductByText(text) {
  const low = normalizeText(text);

  // match exact alias
  let product = cache.products.find(
    (p) =>
      low.includes(normalizeText(p.name)) ||
      p.aliases.some((a) => low.includes(normalizeText(a)))
  );

  if (!product) return null;

  const size = parseSize(low);
  const qty = parseQuantity(low);

  // ถ้า product มี size แต่ลูกค้าไม่ได้ระบุ → เอา size แรก
  const finalSize = size || (product.sizes.length ? product.sizes[0] : "");

  return {
    product,
    qty,
    size: finalSize
  };
}

// ---- Detect Category ----
function detectCategory(text) {
  const low = normalizeText(text);
  if (low.includes("น้ำพริก")) return "น้ำพริก";
  if (low.includes("รถเข็น")) return "รถเข็นไต่บันได";
  return "";
}
// =============================================================
// LINE Commerce Bot (Production Version)
// Part 3/10: LINE API integration + Signature Verification
// =============================================================

// ---- LINE API ----
async function lineReply(replyToken, messages) {
  const url = "https://api.line.me/v2/bot/message/reply";
  const body = JSON.stringify({ replyToken, messages });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body,
  });
  if (!res.ok) {
    log("LINE reply error", res.status, await res.text());
  }
}

async function linePush(to, messages) {
  const url = "https://api.line.me/v2/bot/message/push";
  const body = JSON.stringify({ to, messages });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body,
  });
  if (!res.ok) {
    log("LINE push error", res.status, await res.text());
  }
}

// ---- LINE helpers ----
function makeReply(text, quick = []) {
  const msg = { type: "text", text };
  if (quick.length > 0) {
    msg.quickReply = {
      items: quick.map((label) => ({
        type: "action",
        action: { type: "message", label, text: label },
      })),
    };
  }
  return msg;
}

// ---- Verify Signature ----
function verifySignature(signature, body) {
  const hmac = crypto
    .createHmac("SHA256", LINE_CHANNEL_SECRET)
    .update(body)
    .digest("base64");
  return signature === hmac;
}
// =============================================================
// LINE Commerce Bot (Production Version)
// Part 4/10: Load Google Sheets Data + Personality
// =============================================================

// ---- Load Google Sheets ----
async function loadSheet(range) {
  const res = await sheets.spreadsheets.values.get({
    auth,
    spreadsheetId: GOOGLE_SHEET_ID,
    range,
  });
  return res.data.values;
}

async function ensureDataLoaded(force = false) {
  if (!force && Date.now() - cache.lastLoadedAt < 5 * 60 * 1000) {
    return; // ใช้ cache ภายใน 5 นาที
  }
  log("Reloading sheets data…");

  const [products, promotions, faq, personality, payment] = await Promise.all([
    loadSheet("Products!A2:G"),
    loadSheet("Promotions!A2:F"),
    loadSheet("FAQ!A2:C"),
    loadSheet("Personality!A2:G"),
    loadSheet("Payment!A2:C"),
  ]);

  // Products
  cache.products = (products || []).map((row) => ({
    code: row[0],
    name: row[1],
    category: row[2],
    price: Number(row[3]),
    aliases: (row[4] || "").split(",").map((s) => s.trim()),
    options: (row[5] || "").split(",").map((s) => s.trim()),
    sizes: (row[6] || "").split(",").map((s) => s.trim()),
  }));

  // Promotions
  cache.promotions = (promotions || []).map((row) => ({
    code: row[0],
    detail: row[1],
    type: row[2],
    condition: row[3],
    products: (row[4] || "").split(",").map((s) => s.trim()),
    categories: (row[5] || "").split(",").map((s) => s.trim()),
  }));

  // FAQ
  cache.faq = (faq || []).map((row) => ({
    q: row[0],
    keyword: row[1],
    a: row[2],
  }));

  // Personality (ดึงแถวแรกเท่านั้น)
  if (personality && personality.length > 0) {
    const p = personality[0];
    cache.personality = {
      staffName: p[0],
      pageName: p[1],
      persona: p[2],
      customerName: p[3],
      adminSelf: p[4],
      dontKnow: p[5],
      gender: p[6],
    };
  }

  // Payment
  cache.payment = (payment || []).map((row) => ({
    category: row[0],
    method: row[1],
    detail: row[2],
  }));

  cache.lastLoadedAt = Date.now();
  log("Sheets reloaded");
}

// ---- Personality Helpers ----
function staffPrefix() {
  return cache.personality?.gender === "หญิง" ? "ค่ะ" : "ครับ";
}

function customerName() {
  return cache.personality?.customerName || "ลูกค้า";
}

function staffName() {
  return cache.personality?.staffName || "ทีมงาน";
}

function pageName() {
  return cache.personality?.pageName || "เพจของเรา";
}

function dontKnow() {
  return cache.personality?.dontKnow || "ขอเช็กข้อมูลให้ก่อนนะ";
}
// =============================================================
// LINE Commerce Bot (Production Version)
// Part 5/10: Intent Detection + FAQ + Product handling
// =============================================================

// ---- FAQ Matcher ----
function matchFAQ(text) {
  const low = text.toLowerCase();
  const f = cache.faq.find((f) => low.includes(f.keyword.toLowerCase()));
  return f ? f.a : null;
}

// ---- Intent Detection ----
function detectIntent(text) {
  const low = text.toLowerCase();

  // FAQ
  const faqAns = matchFAQ(text);
  if (faqAns) return { type: "faq", answer: faqAns };

  // Greetings
  if (/(สวัสดี|hello|hi|เฮลโล)/.test(low)) return { type: "greet" };

  // Ask staff name
  if (/(คุณชื่ออะไร|ชื่ออะไร|ใครคุย|ใครตอบ)/.test(low))
    return { type: "ask_name" };

  // Ask page name
  if (/(เพจอะไร|ร้านอะไร|นี่เพจอะไร|ชื่อเพจ)/.test(low))
    return { type: "ask_page" };

  // Checkout
  if (/(เช็กเอาท์|checkout|จ่ายเงิน|สรุปออเดอร์)/.test(low))
    return { type: "checkout" };

  // Add to cart (สั่งซื้อ)
  if (/เอา|สั่ง|ใส่|อยากได้|รับ/.test(low)) return { type: "add_to_cart" };

  // Browse category
  if (/น้ำพริก/.test(low)) return { type: "browse", category: "น้ำพริก" };
  if (/รถเข็น/.test(low)) return { type: "browse", category: "รถเข็นไต่บันได" };

  return { type: "unknown" };
}

// ---- Product listing ----
function listBriefByCategory(cat) {
  const prods = cache.products.filter(
    (p) => p.category && p.category.toLowerCase() === cat.toLowerCase()
  );
  if (prods.length === 0) return `ยังไม่มีสินค้าในหมวด ${cat} ${staffPrefix()}`;

  const lines = prods.slice(0, 5).map(
    (p) =>
      `• ${p.name} ${
        p.sizes.length ? "(" + p.sizes.join("/") + ")" : ""
      } ${priceTHB(p.price)}`
  );

  let text = `${cat}ที่มีค่ะ:\n${lines.join("\n")}`;
  if (prods.length > 5) text += `\n...ยังมีอีก สนใจดูเพิ่มเติมไหม${staffPrefix()}?`;
  return text;
}

// ---- Find Product by keyword ----
function findProductByKeyword(text) {
  const low = text.toLowerCase();
  return cache.products.find(
    (p) =>
      p.name.toLowerCase().includes(low) ||
      p.aliases.some((a) => a.toLowerCase() === low)
  );
}
// =============================================================
// LINE Commerce Bot (Production Version)
// Part 6/10: Cart Management + Promotions
// =============================================================

// ---- Cart helpers ----
function addToCart(session, product, qty = 1, option = "", size = "") {
  if (!session.cart) session.cart = [];
  const existing = session.cart.find(
    (c) => c.code === product.code && c.option === option && c.size === size
  );
  if (existing) existing.qty += qty;
  else
    session.cart.push({
      code: product.code,
      name: product.name,
      option,
      size,
      qty,
      price: product.price,
      category: product.category,
    });
}

function cartSummary(session) {
  if (!session.cart || session.cart.length === 0)
    return `ตะกร้ายังว่างอยู่${staffPrefix()} 🛒`;
  const lines = session.cart.map(
    (c) =>
      `• ${c.name}${c.option ? " (" + c.option + ")" : ""}${
        c.size ? " " + c.size : ""
      } x${c.qty} = ${priceTHB(c.price * c.qty)}`
  );
  const total = session.cart.reduce(
    (sum, c) => sum + c.price * c.qty,
    0
  );
  return `สรุปตะกร้าค่ะ:\n${lines.join("\n")}\nรวมทั้งหมด ${priceTHB(total)}`;
}

// ---- Promotions ----
function applyPromotions(session) {
  let promos = [];
  if (!session.cart) return promos;

  for (const promo of cache.promotions) {
    if (promo.type === "buyxgety") {
      const matchItems = session.cart.filter((c) =>
        promo.categories.includes(c.category)
      );
      if (matchItems.length > 0) promos.push(promo.detail);
    } else if (promo.type === "discount") {
      const matchItems = session.cart.filter((c) =>
        promo.categories.includes(c.category)
      );
      if (matchItems.length > 0) promos.push(promo.detail);
    }
  }
  return promos;
}

function promotionSummary(session) {
  const promos = applyPromotions(session);
  if (promos.length === 0) return "";
  return `โปรโมชั่นที่ใช้ได้:\n${promos.map((p) => "• " + p).join("\n")}`;
}
// =============================================================
// LINE Commerce Bot (Production Version)
// Part 7/10: Orders + Payment + Admin Notification
// =============================================================

// ---- Orders ----
async function saveOrder(userId, session, nameAddr = "", phone = "") {
  const sheetName = "Orders";
  const orderId = "ORD-" + shortId();

  const rows = session.cart.map((c) => [
    orderId,
    c.code,
    c.name,
    c.option,
    c.qty,
    c.price * c.qty,
    promotionSummary(session),
    nameAddr,
    phone,
    "ใหม่",
  ]);

  try {
    await sheets.spreadsheets.values.append({
      auth,
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${sheetName}!A:J`,
      valueInputOption: "RAW",
      requestBody: { values: rows },
    });
  } catch (e) {
    log("saveOrder error", e.message);
  }

  return orderId;
}

// ---- Payment ----
function getPaymentMethods() {
  return cache.payment.map(
    (p) => `• ${p.category}: ${p.method} (${p.detail})`
  );
}

function paymentReply() {
  const lines = getPaymentMethods();
  return `วิธีชำระเงินที่รองรับค่ะ:\n${lines.join("\n")}`;
}

// ---- Admin Notification ----
async function notifyAdmin(orderId, session) {
  if (!ADMIN_GROUP_ID) return;

  const lines = session.cart.map(
    (c) =>
      `• ${c.name}${c.size ? " " + c.size : ""} x${c.qty} = ${priceTHB(
        c.price * c.qty
      )}`
  );
  const total = session.cart.reduce(
    (sum, c) => sum + c.price * c.qty,
    0
  );

  const msg = [
    { type: "text", text: `🛒 ออเดอร์ใหม่ ${orderId}` },
    {
      type: "text",
      text: `${lines.join("\n")}\nรวมทั้งหมด ${priceTHB(total)}\n${promotionSummary(
        session
      )}`,
    },
  ];

  await linePush(ADMIN_GROUP_ID, msg);
}
// =============================================================
// LINE Commerce Bot (Production Version)
// Part 8/10: Conversation Flow (Intent → Structured Response)
// =============================================================

// ---- Session Manager ----
const sessions = {}; // in-memory (ควรต่อฐานข้อมูลในอนาคต)

function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = { userId, stage: "", cart: [], note: "" };
  }
  return sessions[userId];
}

// ---- Conversation Handler ----
async function handleMessage(userId, replyToken, text) {
  await ensureDataLoaded();
  const session = getSession(userId);
  const intent = detectIntent(text);

  log("intent", intent);

  let structuredMsg = ""; // ข้อความโครงสร้างก่อนส่งให้ OpenAI
  let quick = [];

  switch (intent.type) {
    case "greet": {
      structuredMsg = `สวัสดี ${customerName()} คุณกำลังคุยกับ ${staffName()} จากเพจ ${pageName()} สนใจดูน้ำพริกหรือรถเข็นไฟฟ้าคะ?`;
      quick = ["น้ำพริก", "รถเข็น"];
      break;
    }

    case "ask_name": {
      structuredMsg = `ฉันชื่อ ${staffName()} ค่ะ เป็นพนักงานขายประจำเพจ ${pageName()}`;
      break;
    }

    case "ask_page": {
      structuredMsg = `ตอนนี้คุณกำลังคุยกับเพจ "${pageName()}" ${staffPrefix()}`;
      break;
    }

    case "faq": {
      structuredMsg = intent.answer;
      break;
    }

    case "browse": {
      session.stage = intent.category;
      structuredMsg = listBriefByCategory(intent.category);
      quick = ["เพิ่มลงตะกร้า", "ดูโปร", "เช็กเอาท์"];
      break;
    }

    case "add_to_cart": {
      const parsed = findProductByText(text);
      if (parsed) {
        addToCart(session, parsed.product, parsed.qty, "", parsed.size);
        structuredMsg = `เพิ่ม ${parsed.product.name} ${parsed.size} จำนวน ${parsed.qty} ชิ้น ลงตะกร้าแล้วค่ะ 🛒`;
        quick = ["ดูโปร", "เช็กเอาท์"];
      } else {
        structuredMsg = `ยังไม่เจอสินค้าที่ตรงเลย ${staffPrefix()} ตอนนี้สินค้ายอดนิยมคือ ${cache.products
          .slice(0, 3)
          .map((p) => p.name)
          .join(", ")} สนใจดูอันไหนคะ?`;
        quick = cache.products.slice(0, 3).map((p) => p.name);
      }
      break;
    }

    case "checkout": {
      structuredMsg = cartSummary(session);
      const promos = promotionSummary(session);
      if (promos) structuredMsg += `\n\n${promos}`;
      structuredMsg += `\n\n${paymentReply()}`;
      break;
    }

    case "unknown": {
      // Context switch
      if (/น้ำพริก/.test(text)) {
        session.stage = "น้ำพริก";
        structuredMsg = listBriefByCategory("น้ำพริก");
      } else if (/รถเข็น/.test(text)) {
        session.stage = "รถเข็นไต่บันได";
        structuredMsg = listBriefByCategory("รถเข็นไต่บันได");
      } else {
        structuredMsg = `${dontKnow()} 🙏 แต่ตอนนี้มีน้ำพริกกับรถเข็น สนใจดูอันไหนคะ?`;
        quick = ["น้ำพริก", "รถเข็น"];
      }
      break;
    }
  }

  // ถ้าไม่มีข้อความเลย → fallback
  if (!structuredMsg) {
    structuredMsg = `${dontKnow()} สนใจดูโปรมั้ยคะ?`;
    quick = ["ดูโปร", "น้ำพริก", "รถเข็น"];
  }

  // ส่งข้อความผ่าน OpenAI เพื่อปรับโทนให้เหมือนพนักงานขาย
  const finalMsg = await rewriteWithAI(structuredMsg);

  await lineReply(replyToken, [makeReply(finalMsg, quick)]);
}
// =============================================================
// LINE Commerce Bot (Production Version)
// Part 9/10: OpenAI Integration (rewrite message with Personality)
// =============================================================

// ---- OpenAI Rewriter ----
async function rewriteWithAI(structuredMsg) {
  try {
    const persona = cache.personality?.persona || "เป็นพนักงานขายที่เป็นกันเอง ยิ้มแย้ม ตอบสั้น กระชับ แต่ชวนคุยต่อ";
    const staff = cache.personality?.staffName || "ทีมงาน";
    const customer = cache.personality?.customerName || "ลูกค้า";
    const page = cache.personality?.pageName || "เพจของเรา";

    const prompt = `
คุณคือพนักงานขายชื่อ "${staff}" จาก "${page}" 
บุคลิก: ${persona}
ให้ตอบข้อความต่อไปนี้เหมือนกำลังคุยกับ "${customer}" จริง ๆ
ห้ามตอบยาวเกินไป ให้สั้น กระชับ แต่ต้องมีความเป็นมนุษย์และชวนคุยต่อ

ข้อความที่ต้องปรับโทน:
"${structuredMsg}"
    `;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: "คุณคือพนักงานขายใน LINE OA" }, { role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 200,
    });

    const finalMsg = response.choices[0].message.content.trim();
    return finalMsg;
  } catch (e) {
    log("rewriteWithAI error", e.message);
    return structuredMsg; // fallback ถ้า API error
  }
}
// =============================================================
// LINE Commerce Bot (Production Version)
// Part 10/10: Express App + Endpoints + Server Start
// =============================================================

const app = express();

// Raw body buffer สำหรับ LINE signature verify
app.use("/webhook", bodyParser.raw({ type: "*/*" }));

// JSON body สำหรับ endpoint อื่น ๆ
app.use(bodyParser.json());

// Healthcheck
app.get("/healthz", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Reload cache manually
app.post("/reload", async (req, res) => {
  try {
    await ensureDataLoaded(true);
    res.json({
      reloadedAt: cache.lastLoadedAt,
      personality: cache.personality?.staffName,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug endpoint
app.get("/debug", async (req, res) => {
  try {
    await ensureDataLoaded();
    res.json({
      products: cache.products.slice(0, 5),
      promotions: cache.promotions.slice(0, 3),
      faq: cache.faq.slice(0, 3),
      personality: cache.personality,
      payment: cache.payment,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// LINE webhook
app.post("/webhook", async (req, res) => {
  const signature = req.headers["x-line-signature"];
  if (!verifySignature(signature, req.body)) {
    return res.status(400).send("Invalid signature");
  }
  const body = JSON.parse(req.body.toString("utf8"));
  res.sendStatus(200);

  for (const event of body.events) {
    if (event.type === "message" && event.message.type === "text") {
      const userId = event.source.userId;
      const replyToken = event.replyToken;
      await handleMessage(userId, replyToken, event.message.text);
    }
  }
});

// ---- Start Server ----
const port = PORT || 3000;
app.listen(port, () => {
  log(`🚀 Server running on port ${port}`);
});
