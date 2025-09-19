import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import OpenAI from "openai";

// ================== LINE CONFIG ==================
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(config);

// ================== OPENAI CONFIG ==================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ================== GOOGLE SHEETS CONFIG ==================
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);

async function loadSheetData() {
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0]; // ใช้ชีทแรก
  const rows = await sheet.getRows();

  let products = {};
  rows.forEach((row) => {
    const code = row["รหัสสินค้า"];
    if (!code) return;

    products[code] = {
      name: row["ชื่อสินค้า (ทางการ)"] || "",
      price: row["ราคา"] || "",
      keywords: (row["คำที่มักถูกเรียก (Alias Keywords)"] || "")
        .split(",")
        .map((k) => k.trim()),
    };
  });

  return { sheet, products };
}

// ================== LINE BOT APP ==================
const app = express();

app.post("/webhook", middleware(config), async (req, res) => {
  try {
    const results = await Promise.all(req.body.events.map(handleEvent));
    res.json(results);
  } catch (err) {
    console.error("❌ Webhook Error:", err);
    res.status(200).end(); // ตอบกลับ 200 เพื่อไม่ให้ LINE ตัด Webhook
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return null;
  }

  const userMessage = event.message.text.trim();
  const { products } = await loadSheetData();

  let replyText;

  // ================== เช็คว่ามีสินค้า ==================
  let matchedProduct = null;
  for (const code in products) {
    if (
      userMessage.includes(code) ||
      products[code].keywords.some((k) => userMessage.includes(k))
    ) {
      matchedProduct = products[code];
      break;
    }
  }

  if (matchedProduct) {
    replyText = `📌 ${matchedProduct.name}\n💰 ราคา: ${matchedProduct.price} บาท\nสนใจสั่งซื้อ แจ้งจำนวนได้เลยครับ`;
  } else {
    // ส่งไปให้ GPT ตอบ
    const systemPrompt = `
คุณคือแอดมินเพจ พูดจากับลูกค้าเหมือนคนจริง
ใช้ข้อมูลจาก Google Sheet (สินค้า, ราคา, โปรโมชัน, FAQ)
ถ้าลูกค้าถามนอกเหนือ ให้ตอบว่า "ขอให้แอดมินช่วยตอบครับ"  
อย่าตอบแข็งเกินไป ให้ใส่อิโมจิเล็กน้อยเป็นกันเอง`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.5,
      max_tokens: 300,
    });

    replyText = completion.choices[0].message.content.trim();
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: replyText,
  });
}

// ================== START SERVER ==================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
