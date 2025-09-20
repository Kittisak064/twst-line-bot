import express from "express";
import { middleware, Client } from "@line/bot-sdk";
import { GoogleSpreadsheet } from "google-spreadsheet";
import OpenAI from "openai";

// ================== ENV ==================
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const doc = new GoogleSpreadsheet(SHEET_ID);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
const client = new Client(config);

// ================== GOOGLE SHEET AUTH ==================
async function authGoogle() {
  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  });
  await doc.loadInfo();
}

// ================== LOAD SHEET DATA ==================
async function loadData() {
  await authGoogle();

  const sheets = {};
  for (let title of ["Products", "FAQ", "Promotions", "Orders", "บุคลิกAI"]) {
    const sheet = doc.sheetsByTitle[title];
    if (sheet) {
      sheets[title] = await sheet.getRows();
    }
  }
  return sheets;
}

// ================== ORDER HELPER ==================
async function saveOrder(order) {
  const sheet = doc.sheetsByTitle["Orders"];
  await sheet.addRow(order);
}

// ================== LINE HANDLER ==================
app.post("/webhook", middleware(config), async (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error("❌ Webhook Error:", err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text.trim();
  const { Products, FAQ, Promotions, บุคลิกAI } = await loadData();

  // โหลดบุคลิก AI
  let persona = {};
  if (บุคลิกAI && บุคลิกAI[0]) {
    persona = {
      name: บุคลิกAI[0]["ชื่อพนักงาน"] || "แอดมิน",
      page: บุคลิกAI[0]["ชื่อเพจ"] || "ร้านค้า",
      style: บุคลิกAI[0]["บุคลิก"] || "สุภาพ อัธยาศัยดี",
      customer: บุคลิกAI[0]["คำเรียกลูกค้า"] || "คุณลูกค้า",
      self: บุคลิกAI[0]["คำเรียกตัวเอง"] || "แอดมิน",
      fallback: บุคลิกAI[0]["ถ้าไม่รู้คำตอบ"] || "ขอให้แอดมินช่วยตอบครับ 🙏",
    };
  }

  // เตรียมข้อมูลสินค้า
  let productData = Products.map((p) => ({
    name: p["ชื่อสินค้า"],
    price: p["ราคา"],
    category: p["หมวดหมู่"],
    options: p["ตัวเลือก"] ? p["ตัวเลือก"].split(",") : [],
  }));

  // เตรียม FAQ
  let faqData = FAQ.map((f) => ({
    q: f["คำถาม"],
    a: f["คำตอบ"],
  }));

  // เตรียม Promotions
  let promoData = Promotions.map((pr) => ({
    title: pr["ชื่อโปรโมชัน"],
    type: pr["ประเภท"], // ส่วนลด/แถม/ส่งฟรี
    value: pr["มูลค่า"],
    condition: pr["เงื่อนไข"],
    target: pr["ใช้กับ"],
  }));

  // ================== GPT SYSTEM PROMPT ==================
  const sysPrompt = `
คุณคือ ${persona.name} จากเพจ ${persona.page} 
บุคลิก: ${persona.style}
เรียกลูกค้าว่า "${persona.customer}" และเรียกตัวเองว่า "${persona.self}"
ตอบแบบเป็นธรรมชาติ ใช้อิโมจิได้ ไม่แข็งกระด้าง
ใช้ข้อมูลต่อไปนี้ในการตอบ:
สินค้า: ${JSON.stringify(productData)}
FAQ: ${JSON.stringify(faqData)}
โปรโมชัน: ${JSON.stringify(promoData)}

ห้ามตอบรหัสสินค้า  
ห้ามตอบเรื่องที่ไม่เกี่ยวข้อง  
ถ้าไม่รู้คำตอบให้ตอบว่า: "${persona.fallback}"
`;

  let replyText = "";

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: sysPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.5,
      max_tokens: 300,
    });

    replyText = completion.choices[0].message.content.trim();
  } catch (err) {
    console.error("❌ GPT Error:", err);

    // แจ้งไปที่ LINE Group ถ้า GPT ล้มเหลว
    if (process.env.LINE_GROUP_ID) {
      await client.pushMessage(process.env.LINE_GROUP_ID, {
        type: "text",
        text: `⚠️ BOT ตอบไม่ได้:\n"${userMessage}"`,
      });
    }

    replyText = persona.fallback;
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: replyText,
  });
}

// ================== START SERVER ==================
app.listen(process.env.PORT || 10000, () => {
  console.log("🚀 Server running on port 10000");
});
