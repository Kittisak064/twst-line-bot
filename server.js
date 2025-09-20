// =============== BOOTSTRAP ===============
import express from "express";
import { middleware, Client } from "@line/bot-sdk";
import OpenAI from "openai";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

// ---- ENV (Render) ----
const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  OPENAI_API_KEY,
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  GOOGLE_SHEET_ID,
  ADMIN_GROUP_ID
} = process.env;

// ---- LINE SDK ----
const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET
};
const lineClient = new Client(lineConfig);

// ---- OpenAI ----
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---- Google Sheets (v3.x) ----
const googleAuth = new JWT({
  email: GOOGLE_CLIENT_EMAIL,
  // Render เก็บกุญแจแบบหลายบรรทัดได้ ให้แน่ใจว่าเป็นคีย์จริง มี -----BEGIN PRIVATE KEY----- และ \n ครบ
  key: GOOGLE_PRIVATE_KEY,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});
const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID);

// =============== HELPERS: SHEETS LOADER ===============
async function loadDoc() {
  await doc.useServiceAccountAuth(googleAuth);
  await doc.loadInfo();
  return doc;
}

// แปลงแถวเป็นออบเจ็กต์ด้วยหัวคอลัมน์ภาษาไทย
function rowsToObjects(rows) {
  return rows.map(r => {
    const o = {};
    Object.keys(r).forEach(k => {
      if (!k.startsWith('_')) o[k] = (r[k] ?? "").toString().trim();
    });
    return o;
  });
}

// โหลดข้อมูลทุกชีทตามหัวภาษาไทยของคุณ
async function getCatalog() {
  await loadDoc();

  const products = rowsToObjects(await doc.sheetsByTitle["Products"].getRows());     // รหัสสินค้า, ชื่อสินค้า, หมวดหมู่, ราคา, คีย์เวิร์ด/alias, ตัวเลือก, หมายเหตุ
  const promos   = rowsToObjects(await doc.sheetsByTitle["Promotions"].getRows());   // รหัสโปรโมชั่น, รายละเอียดโปรโมชั่น, ประเภทจำนวน, เงื่อนไข, ใช้กับสินค้า, ใช้กับหมวดหมู่
  const faq      = rowsToObjects(await doc.sheetsByTitle["FAQ"].getRows());          // คำถาม, คำตอบ, คำหลัก
  const persona  = rowsToObjects(await doc.sheetsByTitle["personality"].getRows());  // ชื่อพนักงาน, ชื่อเพจ, บุคลิก, คำเรียกลูกค้า, คำเรียกตัวเอง, คำตอบเมื่อไม่รู้, เพศ
  const payment  = rowsToObjects(await doc.sheetsByTitle["Payment"].getRows());      // category, method, detail
  const orders   = doc.sheetsByTitle["Orders"];                                       // เขียนลง
  const sessions = doc.sheetsByTitle["Sessions"];                                     // เก็บบริบท
  const logs     = doc.sheetsByTitle["Logs"];                                         // เก็บ log

  const style = persona[0] || {
    "ชื่อพนักงาน": "แอดมิน",
    "ชื่อเพจ": "",
    "บุคลิก": "เป็นกันเอง สุภาพ กระชับ",
    "คำเรียกลูกค้า": "ลูกค้า",
    "คำเรียกตัวเอง": "แอดมิน",
    "คำตอบเมื่อไม่รู้": "ขออนุญาตสอบถามเพิ่มเติม/ส่งให้แอดมินช่วยเช็กนะคะ",
    "เพศ": "หญิง"
  };

  return { products, promos, faq, persona: style, payment, orders, sessions, logs };
}

// ช่วยหาทางจ่ายเงินตามหมวดหมู่สินค้าที่สั่ง
function pickPaymentForCategory(payment, category) {
  // หา exact หมวดหมู่ก่อน ไม่เจอใช้ all
  const exact = payment.find(p => (p.category || "").toLowerCase() === (category || "").toLowerCase());
  const fallback = payment.find(p => (p.category || "").toLowerCase() === "all");
  return exact || fallback || payment[0] || null;
}

// แยกตัวเลือกที่รองรับของสินค้า
function getOptions(item) {
  const raw = item["ตัวเลือก"] || "";
  return raw
    .split(/[,\n]/).map(s => s.trim()).filter(Boolean);
}

// หา SKU จากข้อความ โดยจับจาก "คีย์เวิร์ด/alias" หรือชื่อสินค้า
function matchProduct(products, text) {
  const t = text.toLowerCase();
  // จับจากคีย์เวิร์ดก่อน
  let hit = products.find(p => (p["คีย์เวิร์ด/alias"] || "").toLowerCase().split(/[,\n]/).map(s=>s.trim()).includes(t));
  if (hit) return hit;

  // contains alias
  hit = products.find(p =>
    (p["คีย์เวิร์ด/alias"] || "").toLowerCase().split(/[,\n]/).some(k => t.includes(k))
  );
  if (hit) return hit;

  // จับชื่อสินค้า
  hit = products.find(p => (p["ชื่อสินค้า"] || "").toLowerCase().includes(t));
  if (hit) return hit;

  // จับรหัสสินค้า
  hit = products.find(p => (p["รหัสสินค้า"] || "").toLowerCase() === t);
  return hit || null;
}

// คำนวณโปรพื้นฐาน: ลดจำนวนเงิน/เปอร์เซ็นต์, ซื้อ X ฟรี Y, ส่งฟรี
function applyPromotions(lineItems, promos) {
  // โครงสร้างเข้า: [{sku, name, category, price, option, qty}]
  let subtotal = 0;
  for (const it of lineItems) subtotal += Number(it.price || 0) * Number(it.qty || 1);

  let discount = 0;
  let freeShipping = false;
  const used = [];

  for (const promo of promos) {
    const text = `${promo["รายละเอียดโปรโมชั่น"]||""} ${promo["ประเภทจำนวน"]||""} ${promo["เงื่อนไข"]||""}`.toLowerCase();

    // ลด X บาท
    const mFlat = text.match(/ลด\s*(\d+)\s*บาท/);
    if (mFlat) {
      discount += Number(mFlat[1]);
      used.push(promo["รหัสโปรโมชั่น"] || "");
      continue;
    }

    // ลด X%
    const mPct = text.match(/ลด\s*(\d+)\s*%/);
    if (mPct) {
      discount += Math.round(subtotal * (Number(mPct[1]) / 100));
      used.push(promo["รหัสโปรโมชั่น"] || "");
      continue;
    }

    // ซื้อ X แถม Y (แบบรวมทั้งบิล)
    const mBy = text.match(/ซื้อ\s*(\d+)\s*แถม\s*(\d+)/);
    if (mBy) {
      const need = Number(mBy[1]);
      const free = Number(mBy[2]);
      const totalQty = lineItems.reduce((a, b) => a + Number(b.qty || 0), 0);
      if (totalQty >= need) {
        // ให้ส่วนลดเท่าราคาเฉลี่ย * จำนวนแถม
        const avgPrice = subtotal / totalQty;
        discount += Math.round(avgPrice * free);
        used.push(promo["รหัสโปรโมชั่น"] || "");
      }
      continue;
    }

    // ส่งฟรีเมื่อซื้อ >= X บาท
    const mShip = text.match(/ส่งฟรี.*(?:\>=|มากกว่า|เกิน)\s*(\d+)/);
    if (mShip) {
      const th = Number(mShip[1]);
      if (subtotal >= th) {
        freeShipping = true;
        used.push(promo["รหัสโปรโมชั่น"] || "");
      }
      continue;
    }
  }

  if (discount > subtotal) discount = subtotal;
  return { subtotal, discount, used, freeShipping };
}

// บันทึกออเดอร์ลงชีท Orders
async function appendOrderSheet(ordersSheet, order) {
  // order: { no, sku, name, option, qty, total, promos, address, phone, status }
  await ordersSheet.addRow({
    "เลขที่ออเดอร์": order.no,
    "รหัสสินค้า": order.sku,
    "ชื่อสินค้า": order.name,
    "ตัวเลือก": order.option || "",
    "จำนวน": String(order.qty),
    "ราคารวม": String(order.total),
    "โปรโมชั่นที่ใช้": (order.promos || []).join(", "),
    "ชื่อ-ที่อยู่": order.address || "",
    "เบอร์โทร": order.phone || "",
    "สถานะ": order.status || "รอชำระเงิน"
  });
}

// เก็บ sessions/Logs แบบเติมต่อ
async function appendLog(logsSheet, userId, text) {
  const ts = new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });
  await logsSheet.addRow({ time: ts, user: userId, text });
}

async function saveSession(sessionsSheet, userId, state) {
  await sessionsSheet.addRow({ userId, state: JSON.stringify(state), ts: Date.now() });
}

// สร้างเลขออเดอร์
function newOrderNo() {
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth()+1).padStart(2,"0");
  const d = String(now.getDate()).padStart(2,"0");
  const n = Math.floor(Math.random()*9000+1000);
  return `ORD${y}${m}${d}-${n}`;
}

// =============== CONVERSATION ENGINE ===============
const mem = new Map(); // session in-memory: { items:[], step, address, phone, payment, ... }

function summarizeItems(items){
  return items.map(it => `• ${it.name}${it.option?` (${it.option})`:""} x${it.qty} = ${Number(it.price)*Number(it.qty)}฿`).join("\n");
}

async function aiAnswer(persona, context, catalog, userText) {
  const sys = `
คุณคือพนักงานชื่อ "${persona["ชื่อพนักงาน"]||"แอดมิน"}" ของเพจ "${persona["ชื่อเพจ"]||""}" 
บุคลิก: ${persona["บุคลิก"]||"เป็นกันเอง สุภาพ กระชับ"} 
เรียกลูกค้าว่า "${persona["คำเรียกลูกค้า"]||"ลูกค้า"}" และเรียกตัวเองว่า "${persona["คำเรียกตัวเอง"]||"แอดมิน"}".
ถ้าไม่แน่ใจให้ตอบตาม "คำตอบเมื่อไม่รู้": ${persona["คำตอบเมื่อไม่รู้"]||"ขออนุญาตสอบถามเพิ่มเติมนะคะ"} 
รูปแบบการตอบ: ภาษาธรรมชาติ ใส่ emoji ได้เล็กน้อย แต่ไม่เวิ่นเว้อเกินไป
ห้ามเปิดเผยรหัสสินค้าให้ลูกค้าเห็นโดยตรง
ข้อมูลสินค้า/ราคา/ตัวเลือกอ้างอิงจากรายการที่ให้ (ภาษาไทย)
`;

  // ย่อแคตาล็อกให้พอเป็นพื้นหลัง (ไม่เกิน ๆ)
  const sampleProducts = catalog.products.slice(0, 50).map(p => ({
    ชื่อสินค้า: p["ชื่อสินค้า"], ราคา: p["ราคา"], หมวดหมู่: p["หมวดหมู่"],
    ตัวเลือก: p["ตัวเลือก"], คีย์เวิร์ด: p["คีย์เวิร์ด/alias"]
  }));

  const sampleFAQ = catalog.faq.slice(0,50);
  const prompt = `
บริบทก่อนหน้า (ย่อ): ${context||"-"}

รายการสินค้า (ย่อ): ${JSON.stringify(sampleProducts)}
FAQ ที่พบบ่อย: ${JSON.stringify(sampleFAQ)}

งานของคุณ:
1) ถ้าลูกค้าถามสินค้า ให้แนะนำแบบกระชับ พร้อมราคาต่อหน่วย
2) ถ้าสินค้ามี "ตัวเลือก" แต่ลูกค้ายังไม่ระบุ ให้ถามกลับเพื่อเลือก (เช่น รสชาติ/ขนาด)
3) ถ้าลูกค้าพิมพ์ว่า "เอา" หรือ "สั่ง" ให้ถามจำนวน และสรุปรายการ
4) ห้ามแสดงรหัสสินค้า ให้พูดชื่อสินค้าแทน
5) ถ้าคำถามไม่ตรงกับสินค้า ให้ตอบสุภาพและเสนอความช่วยเหลือ

ตอบเป็นภาษาไทยล้วน ๆ:
ข้อความลูกค้า: """${userText}"""`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.5,
    max_tokens: 250,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: prompt }
    ]
  });

  return res.choices[0].message.content.trim();
}

// =============== EXPRESS WEBHOOK ===============
const app = express();
app.post("/webhook", middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook Error:", e);
    res.sendStatus(200); // ตอบ 200 เสมอเพื่อไม่ให้ LINE แจ้ง 302/timeout
  }
});

app.get("/", (_, res) => res.status(200).send("OK"));

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const userId = event.source.userId || "unknown";
  const text = (event.message.text || "").trim();

  const catalog = await getCatalog();
  await appendLog(catalog.logs, userId, text);

  // ดึง/สร้าง session
  const s = mem.get(userId) || { items: [], step: "idle" };

  // 1) จับสินค้าจากข้อความ
  const guess = matchProduct(catalog.products, text);

  // 2) คำสั่งพื้นฐาน
  if (/ยกเลิก|ล้าง/.test(text)) {
    mem.set(userId, { items: [], step: "idle" });
    await lineClient.replyMessage(event.replyToken, { type:"text", text: "แอดมินล้างรายการให้แล้วนะคะ 🧼" });
    return;
  }

  // 3) ถ้ามีสินค้า แต่ยังไม่มีตัวเลือก → ถามตัวเลือกก่อน
  if (guess) {
    const price = Number(guess["ราคา"]||0);
    const options = getOptions(guess);

    if (options.length && !options.some(o => text.includes(o))) {
      mem.set(userId, { ...s, step: "ask_option", pending: { product: guess } });
      await lineClient.replyMessage(event.replyToken, {
        type:"text",
        text: `สินค้า: ${guess["ชื่อสินค้า"]}\nมีตัวเลือก: ${options.join(", ")}\nลูกค้าต้องการแบบไหนคะ?`
      });
      return;
    }

    // ไม่มีตัวเลือก หรือระบุมาแล้ว
    const pickedOption = options.find(o => text.includes(o)) || "";
    mem.set(userId, {
      ...s,
      step: "ask_qty",
      pending: { product: guess, option: pickedOption }
    });
    await lineClient.replyMessage(event.replyToken, {
      type:"text",
      text: `ต้องการ "${guess["ชื่อสินค้า"]}${pickedOption ? ` (${pickedOption})`:""}" กี่ชิ้นดีคะ?`
    });
    return;
  }

  // 4) ถ้าอยู่ขั้นถามตัวเลือก
  if (s.step === "ask_option") {
    const prod = s.pending.product;
    const options = getOptions(prod);
    const chosen = options.find(o => text.includes(o));
    if (!chosen) {
      await lineClient.replyMessage(event.replyToken, { type:"text", text:`เลือกไม่ถูกต้องนิดนึงค่ะ 😅\nมี: ${options.join(", ")}` });
      return;
    }
    mem.set(userId, { ...s, step: "ask_qty", pending: { product: prod, option: chosen } });
    await lineClient.replyMessage(event.replyToken, { type:"text", text:`รับ ${prod["ชื่อสินค้า"]} (${chosen}) กี่ชิ้นดีคะ?` });
    return;
  }

  // 5) ถ้าอยู่ขั้นถามจำนวน
  if (s.step === "ask_qty") {
    const n = parseInt(text.replace(/[^\d]/g,""), 10);
    if (!n || n <= 0) {
      await lineClient.replyMessage(event.replyToken, { type:"text", text:"พิมพ์จำนวนเป็นตัวเลขนะคะ เช่น 2" });
      return;
    }
    const { product, option } = s.pending;
    const price = Number(product["ราคา"]||0);
    const item = { sku: product["รหัสสินค้า"], name: product["ชื่อสินค้า"], category: product["หมวดหมู่"], price, option, qty: n };
    const items = [...s.items, item];

    // คำนวณโปร
    const promoCalc = applyPromotions(items, catalog.promos);
    const lines = summarizeItems(items);
    const sum = promoCalc.subtotal - promoCalc.discount;

    mem.set(userId, { ...s, items, step: "confirm_items" });

    await lineClient.replyMessage(event.replyToken, {
      type:"text",
      text: `สรุปรายการชั่วคราวค่ะ\n${lines}\n\nส่วนลดโปรฯ: -${promoCalc.discount}฿\nยอดรวม: ${sum}฿\n\nยืนยันรายการหรือเพิ่มสินค้าได้เลยค่ะ`
    });
    return;
  }

  // 6) ยืนยันรายการ → ขอที่อยู่ / เบอร์ / ชำระเงิน
  if (s.step === "confirm_items" && /ยืนยัน|สรุป|ตกลง|โอเค/.test(text)) {
    mem.set(userId, { ...s, step: "ask_address" });
    await lineClient.replyMessage(event.replyToken, { type:"text", text:"รบกวนแจ้งชื่อ-ที่อยู่ สำหรับจัดส่งด้วยค่ะ 📝" });
    return;
  }

  if (s.step === "ask_address") {
    mem.set(userId, { ...s, address: text, step: "ask_phone" });
    await lineClient.replyMessage(event.replyToken, { type:"text", text:"รับเบอร์ติดต่อหน่อยได้ไหมคะ 📱" });
    return;
  }

  if (s.step === "ask_phone") {
    const phone = text.replace(/[^\d]/g, "");
    if (phone.length < 8) {
      await lineClient.replyMessage(event.replyToken, { type:"text", text:"ขอเป็นเบอร์โทรที่ติดต่อได้จริง ๆ นิดนึงนะคะ" });
      return;
    }
    mem.set(userId, { ...s, phone, step: "ask_payment" });

    // เสนอช่องทางชำระเงินตามหมวดหมู่ชิ้นแรก
    const firstCat = (s.items[0] || {}).category || "all";
    const pay = pickPaymentForCategory(catalog.payment, firstCat);
    const msg = pay ? `ช่องทางชำระเงินแนะนำ (${pay.category}):\n• ${pay.method}\n${pay.detail || ""}\n\nต้องการชำระแบบไหนคะ (เช่น โอน/พร้อมเพย์/COD)?`
                     : "ต้องการชำระแบบไหนคะ (โอน/พร้อมเพย์/COD)?";
    await lineClient.replyMessage(event.replyToken, { type:"text", text: msg });

    // ส่งรูป QR ถ้าใน detail มีลิงก์ (ตัวเลือก)
    if (pay && /https?:\/\/.*\.(png|jpg|jpeg|gif)/i.test(pay.detail || "")) {
      const url = (pay.detail.match(/https?:\/\/\S+/) || [])[0];
      await lineClient.pushMessage(userId, {
        type: "image",
        originalContentUrl: url,
        previewImageUrl: url
      });
    }
    return;
  }

  if (s.step === "ask_payment") {
    const method = /cod/i.test(text) ? "COD" : (/พร้อมเพย์|promptpay|พร้อมเพย/i.test(text) ? "พร้อมเพย์" : "โอน");
    const orderNo = newOrderNo();

    // คำนวณยอดสุดท้าย
    const promoCalc = applyPromotions(s.items, catalog.promos);
    const amount = promoCalc.subtotal - promoCalc.discount;

    // บันทึก Orders
    await appendOrderSheet(catalog.orders, {
      no: orderNo,
      sku: s.items.map(i=>i.sku).join(","),
      name: s.items.map(i=>i.name).join(","),
      option: s.items.map(i=>i.option).filter(Boolean).join(","),
      qty: s.items.reduce((a,b)=>a+Number(b.qty),0),
      total: amount,
      promos: promoCalc.used,
      address: s.address,
      phone: s.phone,
      status: method === "COD" ? "เก็บเงินปลายทาง" : "รอชำระเงิน"
    });

    // สรุปให้ลูกค้า
    const lines = summarizeItems(s.items);
    const confirmMsg = `เลขที่ออเดอร์: ${orderNo}\n${lines}\n\nส่วนลดโปรฯ: -${promoCalc.discount}฿\nยอดโอน/ชำระ: ${amount}฿\nวิธีชำระ: ${method}\n\nขอบคุณมากค่ะ ❤ หากมีหลักฐานการโอนสามารถแจ้งในแชทนี้ได้เลย`;

    await lineClient.replyMessage(event.replyToken, { type:"text", text: confirmMsg });

    // แจ้งแอดมินในกรุ๊ป (ถ้าตั้งค่าไว้)
    if (ADMIN_GROUP_ID) {
      await lineClient.pushMessage(ADMIN_GROUP_ID, {
        type: "text",
        text: `🆕 ออเดอร์ใหม่ ${orderNo}\nลูกค้า: ${s.address}\nโทร: ${s.phone}\n${lines}\nยอดสุทธิ: ${amount}฿\nวิธีชำระ: ${method}\nโปรที่ใช้: ${ (promoCalc.used||[]).join(", ") || "-" }`
      });
    }

    // เคลียร์ session
    mem.delete(userId);
    await saveSession(catalog.sessions, userId, { closed: true, orderNo });
    return;
  }

  // 7) FAQ ตรงคำหลัก
  const hitFAQ = catalog.faq.find(f =>
    (f["คำหลัก"] || "").split(/[,\n]/).map(s=>s.trim()).some(k => k && text.includes(k))
  );
  if (hitFAQ) {
    await lineClient.replyMessage(event.replyToken, { type:"text", text: hitFAQ["คำตอบ"] || "" });
    return;
  }

  // 8) ใช้ AI ทำให้เป็นธรรมชาติ / ถ้าไม่มั่นใจก็ถามต่อ
  try {
    const context = s.items.length ? `มีรายการชั่วคราว: ${summarizeItems(s.items)}` : "";
    const reply = await aiAnswer(catalog.persona, context, catalog, text);
    await lineClient.replyMessage(event.replyToken, { type:"text", text: reply });
  } catch (err) {
    console.error("AI error", err);
    // ถ้า AI ใช้ไม่ได้ ให้ส่งเข้ากลุ่มแอดมิน
    if (ADMIN_GROUP_ID) {
      await lineClient.pushMessage(ADMIN_GROUP_ID, {
        type: "text",
        text: `⚠️ ต้องการความช่วยเหลือจากแอดมิน\nจากผู้ใช้: ${userId}\nข้อความ: ${text}`
      });
    }
    await lineClient.replyMessage(event.replyToken, { type:"text", text: catalog.persona["คำตอบเมื่อไม่รู้"] || "ขออนุญาตให้แอดมินช่วยตรวจสอบนะคะ" });
  }
}

// =============== START SERVER ===============
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
