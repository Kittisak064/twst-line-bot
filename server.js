// server.js (CommonJS, Node 18)
// LINE + OpenAI + Google Sheets (Dynamic Loader) + Orders + Promotions + Fallback to LINE Group
const express = require("express");
const { middleware, Client } = require("@line/bot-sdk");
const bodyParser = require("body-parser");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const dayjs = require("dayjs");
const OpenAI = require("openai");

// ============ ENV ============
const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  OPENAI_API_KEY,
  GOOGLE_SHEET_ID,
  GOOGLE_APPLICATION_CREDENTIALS,
  LINE_GROUP_ID
} = process.env;

if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET || !OPENAI_API_KEY || !GOOGLE_SHEET_ID) {
  console.error("❌ Missing required environment variables.");
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};

const client = new Client(lineConfig);
const app = express();
app.use(bodyParser.json());

// ============ GOOGLE SHEETS LOADER (Dynamic) ============
async function loadAllSheets() {
  // ใช้ Service Account แบบไฟล์ (Render Secret Files)
  const creds = require(GOOGLE_APPLICATION_CREDENTIALS);
  const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID);
  await doc.useServiceAccountAuth({
    client_email: creds.client_email,
    private_key: creds.private_key,
  });
  await doc.loadInfo();

  const db = {}; // { SheetTitle: [ {col:value,...}, ... ] }
  const sheets = doc.sheetsByIndex;

  for (const sheet of sheets) {
    const rows = await sheet.getRows();
    if (!rows.length) {
      db[sheet.title] = [];
      continue;
    }
    // สร้าง object ตามหัวตารางจริง (ยืดหยุ่น)
    const headers = sheet.headerValues || Object.keys(rows[0] || {});
    const list = rows.map(r => {
      const obj = {};
      headers.forEach(h => { obj[h] = r.get?.(h) ?? r[h]; });
      return obj;
    });
    db[sheet.title] = list;
  }
  return { db, doc };
}

// ============ HELPERS ============
function parseNumber(x, fallback = 0) {
  const n = typeof x === "number" ? x : parseFloat(String(x || "").toString().replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : fallback;
}

function dateInRange(start, end, now = dayjs()) {
  const s = start ? dayjs(start) : null;
  const e = end ? dayjs(end) : null;
  if (s && now.isBefore(s, "day")) return false;
  if (e && now.isAfter(e, "day")) return false;
  return true;
}

function pickProfile(profileRows) {
  if (!profileRows || !profileRows.length) {
    return {
      pageName: "ร้านของเรา",
      agentName: "ทีมงาน",
      selfPronoun: "ทีมงาน",
      customerCall: "คุณลูกค้า",
      tone: "กันเอง สุภาพ มีอีโมจิเล็กน้อย สั้น-กระชับ",
      shipFee: 40,
      codFee: 20,
      unknownReply: "เดี๋ยวให้แอดมินช่วยเช็กให้นะครับ 😊"
    };
  }
  const p = profileRows[0];
  return {
    pageName: p["ชื่อเพจ/ร้าน"] || "ร้านของเรา",
    agentName: p["ชื่อพนักงาน"] || "ทีมงาน",
    selfPronoun: p["สรรพนามตัวเอง"] || "ทีมงาน",
    customerCall: p["คำเรียกลูกค้า"] || "คุณลูกค้า",
    tone: p["โทนการตอบ"] || "กันเอง สุภาพ มีอีโมจิเล็กน้อย สั้น-กระชับ",
    shipFee: parseNumber(p["ค่าส่งปกติ"], 40),
    codFee: parseNumber(p["ค่าธรรมเนียมเก็บปลายทาง"], 20),
    unknownReply: p["คำตอบเมื่อไม่รู้"] || "เดี๋ยวให้แอดมินช่วยเช็กให้นะครับ 😊"
  };
}

// หา product จากข้อความด้วยชื่อ/alias/หมวด
function matchProducts(products, text) {
  const t = (text || "").toLowerCase();
  const hits = [];
  for (const pr of products) {
    const name = String(pr["ชื่อสินค้า"] || "").toLowerCase();
    const code = String(pr["รหัสสินค้า"] || "").toLowerCase();
    const cat  = String(pr["หมวดสินค้า"] || "").toLowerCase();
    const aliases = String(pr["คำที่มักถูกเรียก"] || "")
      .split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);

    if (name && t.includes(name)) hits.push(pr);
    else if (code && t.includes(code)) hits.push(pr);
    else if (cat && t.includes(cat)) hits.push(pr);
    else if (aliases.some(a => a && t.includes(a))) hits.push(pr);
  }
  // unique โดยชื่อสินค้า
  const keyed = {};
  hits.forEach(x => keyed[x["ชื่อสินค้า"]] = x);
  return Object.values(keyed);
}

// คำนวณโปร + ค่าส่ง (แบบง่าย, ครอบคลุมเคสหลัก)
function computeTotals({ product, qty, promos, profile, subtotal }) {
  let discount = 0;
  let freeShip = false;
  let promoNotes = [];

  const now = dayjs();
  (promos || []).forEach(p => {
    const enabled = String(p["เปิดใช้งาน"] || "").toLowerCase() === "true" || p["เปิดใช้งาน"] === true;
    if (!enabled) return;
    if (!dateInRange(p["วันที่เริ่ม"], p["วันที่สิ้นสุด"], now)) return;

    // ใช้กับทั้งหมด / หมวด / รหัส
    const scope = String(p["ใช้กับ"] || "").trim();
    let applies = false;
    if (!scope || scope === "ทั้งหมด") applies = true;
    else if (scope.startsWith("หมวด=")) {
      const cat = (product["หมวดสินค้า"] || "").toString().trim();
      applies = cat && cat === scope.replace("หมวด=","").trim();
    } else if (scope.startsWith("รหัส=")) {
      const list = scope.replace("รหัส=","").split(",").map(s=>s.trim());
      applies = list.includes(String(product["รหัสสินค้า"] || "").trim());
    }

    if (!applies) return;

    const type = String(p["ประเภทโปร"] || "").trim();
    const v1 = parseNumber(p["ค่า1"], 0);
    const v2 = parseNumber(p["ค่า2"], 0);

    if (type === "BUY_X_GET_Y" && v1 > 0 && v2 >= 0) {
      const free = Math.floor(qty / (v1)) * v2;
      if (free > 0) {
        const price = parseNumber(product["ราคา"], 0);
        discount += free * price;
        promoNotes.push(`โปรซื้อ ${v1} แถม ${v2} (แถม ${free})`);
      }
    }

    if (type === "BUY_N_FREE_SHIP" && v1 > 0) {
      if (qty >= v1) {
        freeShip = true;
        promoNotes.push(`ซื้อครบ ${v1} ชิ้น ส่งฟรี`);
      }
    }

    if (type === "PERCENT_OFF" && v1 > 0) {
      const d = Math.round((v1 / 100) * subtotal);
      discount += d;
      promoNotes.push(`ลด ${v1}%`);
    }

    if (type === "AMOUNT_OFF" && v1 > 0) {
      discount += v1;
      promoNotes.push(`ลด ${v1} บาท`);
    }

    if (type === "FREE_SHIP_OVER_AMOUNT" && v1 > 0) {
      if (subtotal >= v1) {
        freeShip = true;
        promoNotes.push(`ส่งฟรีเมื่อครบ ${v1} บาท`);
      }
    }
  });

  let shipping = freeShip ? 0 : profile.shipFee;
  const total = Math.max(0, subtotal - discount) + shipping;

  return {
    discount,
    shipping,
    total,
    promoNotes
  };
}

// สร้าง system prompt แบบอ่าน Profile + บังคับโทนไทยธรรมชาติ
function buildSystemPrompt(profile) {
  return `
คุณเป็นแอดมินร้านชื่อ "${profile.pageName}" ชื่อพนักงาน "${profile.agentName}" ใช้สรรพนาม "${profile.selfPronoun}" เรียกลูกค้าว่า "${profile.customerCall}" โทนการตอบ: ${profile.tone}.
กติกา:
- ตอบสั้น กระชับ อ่านง่าย มีอีโมจิเล็กน้อย
- ถ้าไม่แน่ใจ ห้ามเดา ให้ตอบด้วยประโยคจากร้าน: "${profile.unknownReply}"
- ถ้าลูกค้าถามราคาโดยไม่ระบุสินค้า ให้ถามต่อ 1 คำถาม/ครั้ง (เช่น ต้องการสินค้าตัวไหน/รสอะไร/กี่ชิ้น)
- ถ้าเป็นการสั่งซื้อ: ให้ถามช่องว่างที่ขาดทีละอย่าง (รุ่น/รสชาติ/จำนวน/ชื่อ/เบอร์/ที่อยู่/ชำระแบบไหน)
- ถ้ามีหลายตัวเลือก (เช่น รสชาติ) ให้ยื่นรายการเลือกสั้นๆ
- อย่าพูดยาวเกิน 2–3 ประโยค
`;
}

// ส่งเข้ากรุ๊ปแอดมิน เมื่อบอทตอบไม่ได้
async function notifyAdminGroup(text) {
  try {
    if (!LINE_GROUP_ID) return;
    await client.pushMessage(LINE_GROUP_ID, { type: "text", text });
  } catch (e) { console.error("push to group error:", e.message); }
}

// ============ LINE WEBHOOK ============
app.post("/webhook", middleware(lineConfig), async (req, res) => {
  try {
    const results = await Promise.all(req.body.events.map(handleEvent));
    res.json(results);
  } catch (e) {
    console.error("Webhook error:", e);
    // ตอบ 200 กลับไปให้ LINE เสมอ (กัน 302/4xx)
    res.status(200).end();
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return null;

  const userText = (event.message.text || "").trim();
  let reply = null;

  try {
    const { db, doc } = await loadAllSheets();
    const products = db["Products"] || db["สินค้า"] || [];
    const faqs     = db["FAQ"] || db["คำถามที่พบบ่อย"] || [];
    const promos   = db["Promotions"] || db["โปรโมชัน"] || [];
    const profile  = pickProfile(db["Profile"] || db["โปรไฟล์"] || []);

    // 1) จับสินค้า
    const matches = matchProducts(products, userText);

    // 2) ถ้าระบุ “ราคา” แต่ไม่ระบุสินค้า → ถามกลับ
    const askPrice = /ราคา|เท่าไร|กี่บาท/.test(userText) && matches.length === 0;

    // 3) ถ้าไม่เจอสินค้า ลอง FAQ
    let faqAnswer = null;
    if (!matches.length) {
      for (const f of faqs) {
        const keywords = String(f["คำหลัก"] || "").toLowerCase().split(",").map(s=>s.trim());
        if (keywords.some(k => k && userText.toLowerCase().includes(k))) {
          faqAnswer = f["คำตอบ"];
          break;
        }
      }
    }

    // 4) สร้าง context สำหรับ GPT
    const ctx = {
      profile,
      buyer_text: userText,
      products_preview: products.slice(0, 50), // กัน payload ใหญ่เกิน
      promotions_preview: promos.slice(0, 50),
      faqs_preview: faqs.slice(0, 100)
    };

    // 5) ตรรกะตอบ
    if (matches.length > 0) {
      // ถ้าระบุจำนวน (คร่าวๆ)
      const qtyMatch = userText.match(/(\d+)\s*(ชิ้น|ถุง|กระปุก|ตัว)?/);
      const qty = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;
      const product = matches[0];
      const price = parseNumber(product["ราคา"], 0);
      const subtotal = price * qty;
      const totals = computeTotals({ product, qty, promos, profile, subtotal });

      // ถ้ามี “รสชาติ/รุ่น” ให้ยื่นตัวเลือก
      const variant = product["รสชาติ/รุ่น"] || "";
      const variantList = variant ? String(variant).split(",").map(s=>s.trim()).filter(Boolean) : [];

      let lines = [];
      lines.push(`🛒 ${product["ชื่อสินค้า"]}`);
      lines.push(`💵 ${price.toLocaleString()} บาท/ชิ้น × ${qty}`);
      if (totals.promoNotes.length) lines.push(`🎁 โปร: ${totals.promoNotes.join(", ")}`);
      lines.push(`🚚 ค่าส่ง: ${totals.shipping.toLocaleString()} บาท`);
      lines.push(`✅ ยอดสุทธิ: ${totals.total.toLocaleString()} บาท`);

      if (variantList.length) {
        lines.push(`\nมีตัวเลือก: ${variantList.join(" / ")}`);
        lines.push(`ต้องการรสชาติ/รุ่นไหนครับ?`);
      } else {
        lines.push(`\nถ้าตกลงสั่งซื้อ รบกวนพิมพ์: ชื่อ, เบอร์, ที่อยู่ และวิธีชำระ (โอน/ปลายทาง) ครับ`);
      }
      reply = lines.join("\n");

    } else if (askPrice) {
      reply = `ขอชื่อสินค้าที่ต้องการหน่อยครับ เช่น “น้ำพริกเห็ด ซอง 80g” หรือ “รถเข็นไฟฟ้ารุ่นมาตรฐาน”`;

    } else if (faqAnswer) {
      // FAQ ตอบสั้นเป็นธรรมชาติผ่าน GPT (ให้โทนเป็นมนุษย์)
      const system = buildSystemPrompt(profile);
      const prompt = `นี่คือคำถามลูกค้า: "${userText}". นี่คือคำตอบจากฐาน FAQ: "${faqAnswer}". สรุปตอบลูกค้าแบบสั้น-เป็นกันเอง 1–2 ประโยค ไทย มีอีโมจิเล็กน้อย.`;
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(ctx) },
          { role: "user", content: prompt }
        ],
        temperature: 0.4,
        max_tokens: 120
      });
      reply = resp.choices[0].message.content.trim();

    } else {
      // ไม่รู้จริง ๆ → ไม่ตอบมั่ว → ส่งเข้ากรุ๊ปแอดมิน + บอกลูกค้าว่าจะตามให้
      await notifyAdminGroup(`ลูกค้าถาม → ${userText}\n(บอทไม่มั่นใจ, โปรดช่วยตอบ)`);
      reply = profile.unknownReply;
    }

  } catch (e) {
    console.error("handleEvent error:", e);
    reply = "ขออภัยครับ ระบบขัดข้องเล็กน้อย เดี๋ยวให้แอดมินช่วยเช็กให้นะครับ 🙏";
  }

  // ส่งกลับ LINE
  if (reply) {
    return client.replyMessage(event.replyToken, { type: "text", text: reply });
  } else {
    // กัน LINE error: ต้องตอบ 200 แม้ไม่ส่งข้อความ
    return null;
  }
}

// Health check
app.get("/", (req, res) => res.send("OK"));
app.listen(process.env.PORT || 10000, () => console.log("Server running"));
