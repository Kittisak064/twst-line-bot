import express from "express";
import { middleware, Client } from "@line/bot-sdk";
import { GoogleSpreadsheet } from "google-spreadsheet";
import fs from "fs";
import OpenAI from "openai";

// ================== CONFIG ==================
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// โหลด Service Account จาก Secret File
const creds = JSON.parse(
  fs.readFileSync("google-service-account.json", "utf8")
);

// Google Sheet
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const doc = new GoogleSpreadsheet(SHEET_ID);

async function loadSheetData() {
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();

  const sheet = doc.sheetsByIndex[0]; // ชีทแรก
  const rows = await sheet.getRows();

  let products = [];
  rows.forEach((row) => {
    products.push({
      name: row["ชื่อสินค้า"] || "",
      price: row["ราคา"] || "",
      keywords: row["คำค้นหา"] ? row["คำค้นหา"].split(",").map(k => k.trim()) : []
    });
  });

  return products;
}

// ================== LINE BOT ==================
const app = express();
const client = new Client(config);

app.post("/webhook", middleware(config), async (req, res) => {
  try {
    const results = await Promise.all(req.body.events.map(handleEvent));
    res.json(results);
  } catch (err) {
    console.error("❌ Webhook Error:", err);
    res.status(200).end(); // ตอบ 200 กลับให้ LINE เสมอ
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userMessage = event.message.text.trim();
  const products = await loadSheetData();

  // หา match จากสินค้า
  let matched = products.find(
    (p) =>
      userMessage.includes(p.name) ||
      p.keywords.some((k) => userMessage.includes(k))
  );

  let replyText = "";

  if (matched) {
    replyText = `📌 ${matched.name}\n💰 ราคา: ${matched.price} บาท\nสนใจสั่งซื้อได้เลยครับ ✅`;
  } else {
    // ใช้ GPT ช่วยตอบ
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "คุณคือแอดมินเพจขายของ ตอบเป็นธรรมชาติ ใส่อีโมจิให้น่าอ่าน ตอบสั้นกระชับ ไม่แข็งกระด้าง",
        },
        { role: "user", content: userMessage },
      ],
      temperature: 0.5,
      max_tokens: 200,
    });

    replyText = completion.choices[0].message.content.trim();
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: replyText,
  });
}

// ================== START SERVER ==================
app.listen(process.env.PORT || 10000, () => {
  console.log("✅ Server is running on Render");
});
