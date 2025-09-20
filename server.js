/********************************************************************
 * LINE BOT x Google Sheets x OpenAI (THA) — PRODUCTION-READY
 * Author: (คุณ)
 * Notes:
 * - ใช้ Service Account (env) ไม่ใช้ base64
 * - รองรับชีท: Products, FAQ, Promotions, Persona, Orders
 * - หัวตารางภาษาไทย ยืดหยุ่น: ใช้ฟังก์ชันจับชื่อคอลัมน์ใกล้เคียง
 * - ฟีเจอร์: คุย-ขาย-ถามรสชาติ-คำนวณโปร-สรุปยอด-ปิดการขาย
 *             แจ้งแอดมิน (LINE Group), COD/โอน, QR, Log ครบ
 ********************************************************************/

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { GoogleSpreadsheet } from "google-spreadsheet";

/* =====================[ ENV REQUIRED ]=====================
   (ใส่ใน Render → Environment → Add Environment Variable)
   ----------------------------------------------------------
   LINE_CHANNEL_ACCESS_TOKEN  : <ช่องทาง LINE OA ของคุณ>
   LINE_CHANNEL_SECRET        : <(ถ้าใช้ middleware LINE SDK — ตอนนี้เราเรียก REST ตรง)>
   LINE_GROUP_ID              : <GroupID สำหรับแจ้งแอดมิน>   (optional)
   GOOGLE_SHEET_ID            : <ID ของ Spreadsheet>
   GOOGLE_CLIENT_EMAIL        : <Service Account client_email>
   GOOGLE_PRIVATE_KEY         : <-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n>  (มี \n)
   OPENAI_API_KEY             : <คีย์ OpenAI>
   PAYMENT_QR_URL             : <ลิงก์รูป QR พร้อมเพย์>      (optional — ถ้าไม่มีจะไม่แนบ)
   ========================================================= */

const app = express();
app.use(bodyParser.json({ limit: "2mb" }));

/* =====================[ GLOBAL CONFIG ]==================== */
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_GROUP_ID = process.env.LINE_GROUP_ID || ""; // แจ้งแอดมิน (optional)
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PAYMENT_QR_URL = process.env.PAYMENT_QR_URL || "";

// Google Sheets doc instance (3.3.0)
const doc = new GoogleSpreadsheet(SHEET_ID);

// In-memory user sessions (ถามต่อเนื่อง เช่น รสชาติ/จำนวน/ที่อยู่ ฯลฯ)
const sessions = new Map();
// session state keys
const ST = {
  IDLE: "IDLE",
  AWAIT_FLAVOR: "AWAIT_FLAVOR",
  AWAIT_QTY: "AWAIT_QTY",
  AWAIT_CONTACT: "AWAIT_CONTACT",
  AWAIT_PAYMENT_METHOD: "AWAIT_PAYMENT_METHOD",
  AWAIT_TRANSFER_PROOF: "AWAIT_TRANSFER_PROOF",
  AWAIT_ADDRESS: "AWAIT_ADDRESS"
};

/* =====================[ HELPERS ]========================== */

// แปลงข้อความไทย → lower + ตัดเว้นวรรคเพื่อ matching เบื้องต้น
const norm = (s = "") =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

// หาชื่อคอลัมน์แบบยืดหยุ่น (รองรับสะกด/วรรค/ใกล้เคียง)
function pickCol(row, candidates = []) {
  const keys = Object.keys(row || {});
  const normKeys = keys.map((k) => norm(k));
  for (const want of candidates) {
    const nw = norm(want);
    // ตรงตัว
    let idx = normKeys.indexOf(nw);
    if (idx !== -1) return keys[idx];
    // ใกล้เคียงบางส่วน (เช่น 'รหัส' vs 'รหัสสินค้า')
    idx = normKeys.findIndex((k) => k.includes(nw) || nw.includes(k));
    if (idx !== -1) return keys[idx];
  }
  // กลับค่าแรก (กันพัง)
  return candidates[0] || keys[0];
}

// แยกรายการ alias ด้วย , / 、ฯลฯ
function splitList(s) {
  if (!s) return [];
  return String(s)
    .split(/[,/|;、\n]/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

// คำนวนราคา format 1,234.00
const money = (n) =>
  (Number(n) || 0).toLocaleString("th-TH", { minimumFractionDigits: 2 });

// ส่งข้อความไป LINE Reply
async function lineReply(replyToken, text) {
  try {
    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      { replyToken, messages: [{ type: "text", text }] },
      { headers: { Authorization: `Bearer ${LINE_TOKEN}` } }
    );
  } catch (err) {
    console.error("❌ LINE Reply Error:", err.response?.data || err.message);
  }
}

// ส่งข้อความไป Group
async function linePushToGroup(text) {
  if (!LINE_GROUP_ID) return;
  try {
    await axios.post(
      "https://api.line.me/v2/bot/message/push",
      { to: LINE_GROUP_ID, messages: [{ type: "text", text }] },
      { headers: { Authorization: `Bearer ${LINE_TOKEN}` } }
    );
  } catch (err) {
    console.error("❌ LINE Push Error:", err.response?.data || err.message);
  }
}

// ส่งภาพ (QR)
async function lineReplyImage(replyToken, originalUrl, previewUrl) {
  try {
    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      {
        replyToken,
        messages: [{ type: "image", originalContentUrl: originalUrl, previewImageUrl: previewUrl }]
      },
      { headers: { Authorization: `Bearer ${LINE_TOKEN}` } }
    );
  } catch (err) {
    console.error("❌ LINE Reply Image Error:", err.response?.data || err.message);
  }
}

/* =====================[ GOOGLE SHEETS ]==================== */

// Auth + load doc
async function loadDoc() {
  try {
    await doc.useServiceAccountAuth({
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: String(process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n")
    });
    await doc.loadInfo();
    console.log(`✅ Google Sheet connected: ${doc.title}`);
  } catch (e) {
    console.error("❌ Google Sheet Error:", e.message);
    throw e;
  }
}

// ดึงข้อมูลชีทต่าง ๆ
async function getSheetRows(title) {
  const sheet = doc.sheetsByTitle[title];
  if (!sheet) return [];
  const rows = await sheet.getRows();
  return rows;
}

// อ่าน Persona (กำหนดโทน +ชื่อพนักงาน+คำเรียกลูกค้า+คำเรียกตัวเอง)
async function readPersona() {
  const rows = await getSheetRows("Persona");
  if (!rows.length) {
    return {
      staffName: "แอดมิน",
      gender: "ไม่ระบุ",
      personaStyle: "สุภาพ เป็นกันเอง มืออาชีพ",
      callCustomer: "ลูกค้า",
      callSelf: "แอดมิน",
      shopName: "ร้านของเรา",
      paymentInfo: "",
      codSupported: "ใช่"
    };
  }
  const r = rows[0];
  const staffName = r[pickCol(r, ["ชื่อพนักงาน", "พนักงาน", "staff", "พนักงานชื่อ"])] || "แอดมิน";
  const gender = r[pickCol(r, ["เพศ", "gender"])] || "ไม่ระบุ";
  const personaStyle = r[pickCol(r, ["บุคลิกการตอบกลับ", "สไตล์การตอบ", "สไตล์"])] || "สุภาพ";
  const callCustomer = r[pickCol(r, ["คำเรียกลูกค้า", "เรียกลูกค้า"])] || "ลูกค้า";
  const callSelf = r[pickCol(r, ["คำเรียกตัวเอง", "แทนตัวเอง"])] || "แอดมิน";
  const shopName = r[pickCol(r, ["ชื่อเพจ", "ชื่อร้าน", "เพจ"])] || "ร้านของเรา";
  const paymentInfo = r[pickCol(r, ["ช่องทางชำระเงิน", "การชำระเงิน", "โอน", "พร้อมเพย์"])] || "";
  const codSupported = r[pickCol(r, ["ปลายทาง", "cod", "เก็บเงินปลายทาง"])] || "ใช่";
  return { staffName, gender, personaStyle, callCustomer, callSelf, shopName, paymentInfo, codSupported };
}

// อ่านสินค้า
async function readProducts() {
  const rows = await getSheetRows("Products");
  const list = [];
  for (const r of rows) {
    const code = r[pickCol(r, ["รหัสสินค้า", "รหัส", "SKU", "code"])];
    const name = r[pickCol(r, ["ชื่อสินค้า (ทางการ)", "ชื่อสินค้า", "ชื่อ", "name"])];
    const price = Number(r[pickCol(r, ["ราคา", "price", "ราคาขาย"])] || 0);
    const flavorStr = r[pickCol(r, ["รสชาติที่มี", "รสชาติ", "flavors"])] || "";
    const aliases = splitList(r[pickCol(r, ["คำที่มักถูกเรียก (Alias Keywords)", "alias", "คีย์เวิร์ด"])] || "");
    const category = r[pickCol(r, ["หมวดหมู่", "หมวด", "category"])] || "";
    const unit = r[pickCol(r, ["หน่วย", "ขนาด", "แพ็ก", "unit"])] || "";
    const stock = r[pickCol(r, ["สต๊อก", "จำนวนคงเหลือ", "stock"])] || "";
    const flavors = splitList(flavorStr);
    list.push({ code, name, price, flavors, aliases, category, unit, stock });
  }
  return list;
}

// อ่าน FAQ
async function readFAQ() {
  const rows = await getSheetRows("FAQ");
  const list = [];
  for (const r of rows) {
    const q = r[pickCol(r, ["คำถาม", "ถาม", "Q", "question"])];
    const a = r[pickCol(r, ["คำตอบ", "ตอบ", "A", "answer"])];
    if (q && a) list.push({ q, a });
  }
  return list;
}

// อ่าน Promotions
async function readPromotions() {
  const rows = await getSheetRows("Promotions");
  const list = [];
  for (const r of rows) {
    const name = r[pickCol(r, ["ชื่อโปรโมชั่น", "โปร", "promotion"])];
    const type = r[pickCol(r, ["ประเภทโปร", "ประเภท", "type"])];
    const appliesTo = r[pickCol(r, ["ใช้กับ", "ใช้กับสินค้า", "ใช้กับหมวดหมู่", "appliesTo"])];
    const x = Number(r[pickCol(r, ["X", "ซื้อ", "buyX"])] || 0);    // สำหรับ ซื้อ X แถม Y
    const y = Number(r[pickCol(r, ["Y", "แถม", "getY"])] || 0);
    const discountPct = Number(r[pickCol(r, ["ลดเปอร์เซ็นต์", "%", "discount%"])] || 0);
    const discountAmount = Number(r[pickCol(r, ["ลดบาท", "ส่วนลด", "discount"])] || 0);
    const freeShipMin = Number(r[pickCol(r, ["ยอดขั้นต่ำส่งฟรี", "ส่งฟรี", "freeShipMin"])] || 0);
    const details = r[pickCol(r, ["รายละเอียด", "เงื่อนไข", "notes"])] || "";
    list.push({ name, type, appliesTo, x, y, discountPct, discountAmount, freeShipMin, details });
  }
  return list;
}

// บันทึก Orders
async function appendOrderRow(order) {
  try {
    const sheet = doc.sheetsByTitle["Orders"];
    if (!sheet) {
      console.warn("⚠️ ไม่พบชีท Orders — ข้ามการบันทึก");
      return;
    }
    await sheet.addRow({
      วันที่: new Date().toLocaleString("th-TH"),
      ไลน์ไอดี: order.userId || "",
      ชื่อลูกค้า: order.customerName || "",
      เบอร์โทร: order.phone || "",
      ที่อยู่: order.address || "",
      วิธีชำระเงิน: order.paymentMethod || "",
      รายการสั่งซื้อ: order.itemsText || "",
      ยอดก่อนลด: order.subtotal || 0,
      ส่วนลด: order.discount || 0,
      ค่าส่ง: order.shippingFee || 0,
      ยอดสุทธิ: order.total || 0,
      สถานะ: order.status || "รอยืนยัน",
      หมายเหตุ: order.note || ""
    });
    console.log("✅ บันทึก Orders เรียบร้อย");
  } catch (e) {
    console.error("❌ บันทึก Orders ล้มเหลว:", e.message);
  }
}

/* =====================[ PROMOTION ENGINE ]================= */

// ตรวจสอบว่าโปรนี้ใช้กับสินค้าชิ้นนี้ได้ไหม
function promoAppliesToItem(promo, product) {
  const ap = (promo.appliesTo || "").trim();
  if (!ap) return true; // ว่าง = ใช้ได้กับทั้งหมด
  const tokens = splitList(ap).map(norm);
  const nameN = norm(product.name);
  const codeN = norm(product.code);
  const catN = norm(product.category);
  return tokens.some((t) => nameN.includes(t) || codeN.includes(t) || catN.includes(t));
}

// คำนวณโปรทั้งหมด (ง่าย/ชัดเจน)
function applyPromotions(cart, promos) {
  // cart: [{product, qty, flavor}]
  let subtotal = 0;
  cart.forEach((c) => (subtotal += c.product.price * c.qty));

  let discount = 0;
  let shippingFee = 0; // ถ้าส่งฟรีตามโปร → 0

  for (const p of promos) {
    switch (norm(p.type)) {
      case "ซื้อxแถมy":
      case "buyxgety":
        // นับเฉพาะรายการที่ apply ได้
        cart.forEach((c) => {
          if (promoAppliesToItem(p, c.product) && p.x > 0 && p.y > 0) {
            // แถมแบบคูณรอบได้ เช่น ซื้อ 5 แถม 1 (5→1), ถ้าซื้อ 10 แถม 2
            const times = Math.floor(c.qty / p.x);
            const freeUnits = times * p.y;
            const freeValue = freeUnits * c.product.price;
            discount += freeValue;
          }
        });
        break;
      case "ลดเปอร์เซ็นต์":
      case "percent":
        // ทั้งบิล / หรือเฉพาะสินค้าใน appliesTo
        let base = 0;
        if ((p.appliesTo || "").trim()) {
          cart.forEach((c) => {
            if (promoAppliesToItem(p, c.product)) base += c.product.price * c.qty;
          });
        } else {
          base = subtotal;
        }
        discount += (base * (p.discountPct || 0)) / 100;
        break;
      case "ลดบาท":
      case "amount":
        if ((p.appliesTo || "").trim()) {
          let base = 0;
          cart.forEach((c) => {
            if (promoAppliesToItem(p, c.product)) base += c.product.price * c.qty;
          });
          const d = Math.min(p.discountAmount || 0, base);
          discount += d;
        } else {
          const d = Math.min(p.discountAmount || 0, subtotal);
          discount += d;
        }
        break;
      case "ส่งฟรี":
      case "freeship":
        if (subtotal >= (p.freeShipMin || 0)) {
          shippingFee = 0;
        }
        break;
      default:
        // รองรับอนาคต
        break;
    }
  }

  // ค่าส่ง (ถ้าไม่มีโปรส่งฟรี กำหนดเอง: สมมติ 40 บาท)
  if (shippingFee === 0) {
    // จากโปรส่งฟรี
  } else {
    shippingFee = subtotal >= 500 ? 0 : 40; // ตัวอย่างกติกาพื้นฐาน
  }

  const total = Math.max(0, subtotal - discount) + shippingFee;

  return { subtotal, discount, shippingFee, total };
}

/* =====================[ PRODUCT / INTENT ]================ */

// จับสินค้าที่ลูกค้าพิมพ์ (ชื่อ/alias/sku/หมวด)
function matchProduct(userText, products) {
  const t = norm(userText);
  // 1) sku
  let found = products.find((p) => t.includes(norm(p.code)));
  if (found) return found;

  // 2) alias
  for (const p of products) {
    if (p.aliases && p.aliases.some((a) => t.includes(norm(a)))) return p;
  }

  // 3) ชื่อสินค้า
  found = products.find((p) => t.includes(norm(p.name)));
  if (found) return found;

  // 4) หมวดหมู่
  found = products.find((p) => t.includes(norm(p.category)));
  if (found) return found;

  return null;
}

// จับเจตนาคร่าว ๆ
function detectIntent(text) {
  const t = norm(text);
  if (/สวัสดี|hello|hi/.test(t)) return "GREETING";
  if (/ราคา|เท่าไร|กี่บาท/.test(t)) return "ASK_PRICE";
  if (/สั่งซื้อ|เอา|อยากได้|จ่าย|สรุป/.test(t)) return "ORDER";
  if (/ชำระ|โอน|พร้อมเพย์|ปลายทาง|cod/.test(t)) return "PAYMENT";
  if (/ที่อยู่|จัดส่ง|ส่ง/.test(t)) return "ADDRESS";
  if (/วิธี/.test(t)) return "HOWTO";
  return "CHAT";
}

/* =====================[ OPENAI ]========================== */

async function askGPT({ persona, context, userMsg }) {
  const system = `
คุณคือ "${persona.callSelf}" ของร้าน "${persona.shopName}" โทน: ${persona.personaStyle}
- ตอบแบบคนจริง สุภาพ กระชับ ไม่ยาวเกินไป มีอีโมจิพอดี ๆ
- ใช้เฉพาะข้อมูลในบริบทเท่านั้น ห้ามเดาเกินจริง
- ถ้าไม่มีข้อมูล ให้บอกว่าจะส่งให้แอดมินตอบ และไม่ต้องยัดคำขอโทษซ้ำ ๆ
- ถ้าลูกค้าถามราคาโดยไม่ระบุรุ่น/รส ให้ถามต่อ (สอบถามให้ครบ)
- ถ้าถามเรื่องรถเข็นไฟฟ้า/น้ำพริก ให้ใช้สเปค/ราคา/โปรจากบริบท
- เวลาเสนอปิดการขาย ควรถามจำนวน และวิธีชำระ (โอน/ปลายทาง)
  หากโอน ให้แสดงลิงก์/QR ถ้ามี
`.trim();

  const prompt = `
[ข้อมูลจากชีท]
${context}

[ข้อความลูกค้า]
${userMsg}
`.trim();

  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt }
        ],
        temperature: 0.6,
        max_tokens: 320
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    return resp.data.choices[0].message.content.trim();
  } catch (e) {
    console.error("❌ OpenAI Error:", e.response?.data || e.message);
    return `${persona.callSelf}ขอส่งให้แอดมินช่วยตอบให้นะคะ 🙏`;
  }
}

/* =====================[ CONTEXT BUILDER ]================= */

function buildContext({ persona, products, faqs, promos }) {
  let ctx = `ร้าน: ${persona.shopName}\nพนักงาน: ${persona.staffName} (${persona.gender})\nโทน: ${persona.personaStyle}\nคำเรียกลูกค้า: ${persona.callCustomer} / คำเรียกตัวเอง: ${persona.callSelf}\n\n`;

  // สินค้า
  ctx += `# สินค้า\n`;
  products.forEach((p) => {
    const fl = p.flavors?.length ? `รส: ${p.flavors.join(", ")}` : "";
    ctx += `- [${p.code}] ${p.name} ราคา ${money(p.price)} (${p.category} ${p.unit}) ${fl}\n`;
  });

  // โปร
  if (promos?.length) {
    ctx += `\n# โปรโมชัน\n`;
    promos.forEach((pr) => {
      ctx += `• ${pr.name}: ประเภท ${pr.type} เงื่อนไข(${pr.details || "-"}) ใช้กับ: ${pr.appliesTo || "ทั้งหมด"}\n`;
    });
  }

  // FAQ
  if (faqs?.length) {
    ctx += `\n# FAQ ตัวอย่าง\n`;
    faqs.slice(0, 8).forEach((f, i) => {
      ctx += `${i + 1}) ถาม: ${f.q}\n   ตอบ: ${f.a}\n`;
    });
  }

  // QR
  if (PAYMENT_QR_URL) {
    ctx += `\n# ช่องทางโอน\nQR: ${PAYMENT_QR_URL}\n`;
  }

  return ctx;
}

/* =====================[ MAIN WORKFLOW ]=================== */

// สรุปคำสั่งซื้อเป็นข้อความ
function cartSummary(cart) {
  return cart
    .map(
      (c, i) =>
        `${i + 1}) ${c.product.name}${c.flavor ? ` (${c.flavor})` : ""} x ${c.qty} = ${money(
          c.product.price * c.qty
        )}`
    )
    .join("\n");
}

async function processMessage(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const userMsg = event.message.text || "";
  const uid = event.source.userId || event.source.groupId || "unknown";
  const replyToken = event.replyToken;

  // Load Sheets (safe)
  await loadDoc();
  const [persona, products, faqs, promos] = await Promise.all([
    readPersona(),
    readProducts(),
    readFAQ(),
    readPromotions()
  ]);

  // Session
  if (!sessions.has(uid)) {
    sessions.set(uid, { state: ST.IDLE, cart: [] });
  }
  const ses = sessions.get(uid);

  // INTENT
  const intent = detectIntent(userMsg);
  console.log(`ℹ️ Intent=${intent} | State=${ses.state} | Msg="${userMsg}"`);

  // ตรวจจับสินค้า
  const product = matchProduct(userMsg, products);

  /* ====== STATE MACHINE ====== */

  // ถ้ารอรสชาติ
  if (ses.state === ST.AWAIT_FLAVOR) {
    const chosen = norm(userMsg);
    const ok = ses.pendingProduct.flavors.find((f) => norm(f) === chosen) || ses.pendingProduct.flavors.find((f) => norm(f).includes(chosen));
    if (!ok) {
      return lineReply(
        replyToken,
        `รส "${userMsg}" ไม่มีในรายการค่ะ มีรส: ${ses.pendingProduct.flavors.join(", ")}\nพิมพ์ชื่อรสชาติที่ต้องการได้เลยค่ะ`
      );
    }
    ses.pendingFlavor = ok;
    ses.state = ST.AWAIT_QTY;
    return lineReply(replyToken, `ต้องการจำนวนกี่ชิ้นคะ?`);
  }

  // ถ้ารอจำนวน
  if (ses.state === ST.AWAIT_QTY) {
    const qty = parseInt(userMsg.replace(/[^\d]/g, ""), 10);
    if (!qty || qty <= 0) return lineReply(replyToken, `พิมพ์เป็นตัวเลขจำนวนชิ้นนะคะ เช่น 2, 5`);
    // เพิ่มลงตะกร้า
    ses.cart.push({ product: ses.pendingProduct, flavor: ses.pendingFlavor || "", qty });
    ses.pendingProduct = null;
    ses.pendingFlavor = "";
    ses.state = ST.IDLE;

    // สรุป+เสนอปิดการขาย
    const { subtotal, discount, shippingFee, total } = applyPromotions(ses.cart, promos);
    const itemsText = cartSummary(ses.cart);
    return lineReply(
      replyToken,
      `บันทึกรายการเรียบร้อยค่ะ 🧾\n${itemsText}\n\nยอดก่อนลด: ${money(subtotal)}\nส่วนลด: ${money(
        discount
      )}\nค่าส่ง: ${money(shippingFee)}\nยอดสุทธิ: ${money(
        total
      )}\n\nต้องการชำระแบบ "โอน" หรือ "ปลายทาง" คะ?`
    );
  }

  // ถ้ารอวิธีชำระเงิน
  if (ses.state === ST.AWAIT_PAYMENT_METHOD) {
    const t = norm(userMsg);
    if (/ปลายทาง|cod/.test(t)) {
      ses.paymentMethod = "เก็บเงินปลายทาง";
      ses.state = ST.AWAIT_ADDRESS;
      return lineReply(replyToken, `รับทราบค่า COD ✅\nขอชื่อ-ที่อยู่จัดส่ง + เบอร์โทร ด้วยค่ะ`);
    } else if (/โอน|transfer|พร้อมเพย์|promptpay|ชำระ/.test(t)) {
      ses.paymentMethod = "โอนเงิน";
      ses.state = ST.AWAIT_TRANSFER_PROOF;
      if (PAYMENT_QR_URL) {
        await lineReply(replyToken, `รับทราบการโอนค่ะ ✅\nสแกน QR เพื่อชำระได้เลย แล้วส่งสลิปกลับมาในแชทนะคะ`);
        await lineReplyImage(replyToken, PAYMENT_QR_URL, PAYMENT_QR_URL);
        return;
      }
      return lineReply(replyToken, `รับทราบการโอนค่ะ ✅\nกรุณาโอนตามเลขบัญชี/พร้อมเพย์ที่ให้ไว้ แล้วส่งสลิปกลับมาในแชทนะคะ`);
    } else {
      return lineReply(replyToken, `ขอเลือกวิธีชำระเป็น "โอน" หรือ "ปลายทาง" ค่ะ`);
    }
  }

  // ถ้ารอแนบสลิป (สำหรับโอน)
  if (ses.state === ST.AWAIT_TRANSFER_PROOF) {
    // ตรงนี้ถ้ารับรูปได้ (rich) เราจะตรวจ type === image
    // ตอนนี้รับเป็นข้อความลิงก์สลิป
    ses.transferProof = userMsg;
    ses.state = ST.AWAIT_ADDRESS;
    return lineReply(replyToken, `ขอบคุณค่ะ ✅\nขอชื่อ-ที่อยู่จัดส่ง + เบอร์โทร เพื่อออกใบส่งของค่ะ`);
  }

  // ถ้ารอที่อยู่
  if (ses.state === ST.AWAIT_ADDRESS) {
    // บันทึกออเดอร์
    const { subtotal, discount, shippingFee, total } = applyPromotions(ses.cart, promos);
    const itemsText = cartSummary(ses.cart);
    const order = {
      userId: uid,
      customerName: "", // สามารถพาร์สเพิ่มภายหลังได้
      phone: "",
      address: userMsg,
      paymentMethod: ses.paymentMethod || "ไม่ระบุ",
      itemsText,
      subtotal,
      discount,
      shippingFee,
      total,
      status: ses.paymentMethod === "เก็บเงินปลายทาง" ? "เตรียมจัดส่ง (COD)" : "รอตรวจสลิป"
    };
    await appendOrderRow(order);

    // แจ้งแอดมิน
    await linePushToGroup(
      `🆕 ออเดอร์ใหม่จาก LINE\nวิธีชำระ: ${order.paymentMethod}\nรายการ:\n${itemsText}\nยอดสุทธิ: ${money(
        total
      )}\nที่อยู่:\n${order.address}`
    );

    // เคลียร์ session
    sessions.set(uid, { state: ST.IDLE, cart: [] });

    return lineReply(
      replyToken,
      `รับออเดอร์เรียบร้อยค่ะ ขอบคุณมากค่ะ 🧡\nสรุปยอด: ${money(total)}\n${order.paymentMethod === "เก็บเงินปลายทาง" ? "ชำระปลายทางกับไรเดอร์ได้เลยค่ะ" : "หากชำระแล้ว ทางเราจะตรวจสอบสลิปและจัดส่งทันทีค่ะ"}`
    );
  }

  /* ====== FRESH INTENT ====== */

  // ถ้าระบุสินค้าแล้ว
  if (product) {
    if (product.flavors?.length) {
      // ต้องเลือกรสก่อน
      sessions.set(uid, { ...ses, state: ST.AWAIT_FLAVOR, pendingProduct: product, pendingFlavor: "" });
      return lineReply(
        replyToken,
        `ต้องการ "${product.name}" รบกวนเลือก "รสชาติ" ด้วยค่ะ: ${product.flavors.join(", ")}`
      );
    } else {
      // ไม่มีรส → ถามจำนวน
      sessions.set(uid, { ...ses, state: ST.AWAIT_QTY, pendingProduct: product, pendingFlavor: "" });
      return lineReply(replyToken, `ต้องการ "${product.name}" จำนวนกี่ชิ้นคะ?`);
    }
  }

  // คำทักทาย
  if (intent === "GREETING") {
    return lineReply(replyToken, `สวัสดีค่ะ ยินดีต้อนรับสู่ร้านของเรา 🧡 สนใจสินค้าไหนสอบถามได้เลยค่ะ`);
  }

  // เริ่มสั่งซื้อแต่ไม่ระบุสินค้า
  if (intent === "ORDER") {
    return lineReply(replyToken, `สนใจสินค้ารายการไหนคะ? เช่น "น้ำพริกเห็ดสามสหาย 80g" หรือ "รถเข็นไฟฟ้ารุ่นมาตรฐาน"`);
  }

  // ถามราคาแต่ไม่ระบุสินค้า
  if (intent === "ASK_PRICE") {
    return lineReply(
      replyToken,
      `รบกวนระบุชื่อสินค้า/รุ่น/ขนาด (และรสชาติถ้ามี) ด้วยนะคะ จะได้แจ้งราคาให้ถูกต้องค่ะ ✨`
    );
  }

  // กรณีทั่วไป → ส่งให้ GPT (แต่เราให้คอนเท็กซ์แน่นจากชีท)
  const context = buildContext({ persona, products, faqs, promos });
  const aiText = await askGPT({ persona, context, userMsg });

  // ถ้า GPT ไม่มั่นใจ ให้แจ้งแอดมิน
  if (/แอดมิน/.test(aiText) || /ขอส่งให้แอดมิน/.test(aiText)) {
    await linePushToGroup(`❗ ลูกค้าถาม: ${userMsg}`);
  }

  // ถ้าดูเหมือนไปต่อเพื่อปิดการขาย → set state ชำระเงิน
  if (/สั่งซื้อ|สรุป|ยืนยัน/.test(userMsg) || /พร้อมสั่ง/.test(aiText)) {
    sessions.set(uid, { ...ses, state: ST.AWAIT_PAYMENT_METHOD });
    return lineReply(
      replyToken,
      `${aiText}\n\nต้องการชำระแบบ "โอน" หรือ "ปลายทาง" คะ?`
    );
  }

  return lineReply(replyToken, aiText);
}

/* =====================[ WEBHOOK ]========================= */

app.post("/webhook", async (req, res) => {
  try {
    const events = req.body?.events || [];
    if (!events.length) return res.sendStatus(200);
    for (const ev of events) {
      await processMessage(ev);
    }
    return res.sendStatus(200);
  } catch (e) {
    console.error("❌ Webhook Error:", e.message);
    return res.sendStatus(200); // LINE ต้องได้ 200 เสมอ
  }
});

// พิ้ง-ทดสอบ
app.get("/", (_req, res) => res.send("OK: LINE BOT + Sheets running"));

/* =====================[ START SERVER ]==================== */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

/********************************************************************
 * จบไฟล์ server.js — ขยายเพิ่มฟังก์ชันได้ โดยไม่ต้องแก้หัวตารางเดิม
 * (ฟิกแค่ชื่อชีทตามที่คุณใช้อยู่: Products, FAQ, Promotions, Persona, Orders)
 ********************************************************************/
