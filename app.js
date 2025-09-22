/************************************************************
 * LINE Commerce Bot - Full Version (fixed)
 * Author: ChatGPT
 * Description:
 *  - ใช้ข้อมูลจาก Google Sheets เท่านั้น (Products, FAQ, Promotions, Personality)
 *  - ตอบกลับลูกค้าเหมือนพนักงานขาย
 *  - QuickReply labels < 20 characters
 *  - GPT ใช้ปรับโทน แต่ข้อมูลสินค้ามาจากชีทจริง
 ************************************************************/

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { google } from "googleapis";
import OpenAI from "openai";

const app = express();
app.use(bodyParser.json());

/************************************************************
 * ENV VARIABLES
 ************************************************************/
const PORT = process.env.PORT || 10000;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/************************************************************
 * GOOGLE SHEETS
 ************************************************************/
const auth = new google.auth.JWT(
  GOOGLE_CLIENT_EMAIL,
  null,
  GOOGLE_PRIVATE_KEY,
  ["https://www.googleapis.com/auth/spreadsheets.readonly"]
);

const sheets = google.sheets({ version: "v4", auth });

let cache = {
  products: [],
  promotions: [],
  faq: [],
  personality: {}
};

async function loadSheetsData() {
  console.log("[BOT] 🔄 Reloading sheets data…");

  // Products
  const productsRes = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: "Products!A2:G"
  });
  cache.products = (productsRes.data.values || []).map(row => ({
    code: row[0] || "",
    name: row[1] || "",
    category: row[2] || "",
    price: row[3] || "",
    keyword: row[4] || "",
    options: row[5] || "",
    size: row[6] || ""
  }));

  // Promotions
  const promoRes = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: "Promotions!A2:D"
  });
  cache.promotions = (promoRes.data.values || []).map(row => ({
    code: row[0] || "",
    title: row[1] || "",
    desc: row[2] || "",
    until: row[3] || ""
  }));

  // FAQ
  const faqRes = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: "FAQ!A2:B"
  });
  cache.faq = (faqRes.data.values || []).map(row => ({
    keyword: row[0] || "",
    answer: row[1] || ""
  }));

  // Personality
  const persRes = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: "personality!A2:G2"
  });
  const row = persRes.data.values?.[0] || [];
  cache.personality = {
    employeeName: row[0] || "พนักงาน",
    pageName: row[1] || "ร้านค้า",
    style: row[2] || "พูดสุภาพ",
    callCustomer: row[3] || "คุณลูกค้า",
    callYourself: row[4] || "แอดมิน",
    callUnknown: row[5] || "คุณลูกค้า",
    gender: row[6] || "หญิง"
  };

  console.log("[BOT] ✅ Sheets reloaded");
}

/************************************************************
 * OPENAI
 ************************************************************/
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function askGPT(prompt) {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: "คุณคือพนักงานขายที่ตอบลูกค้าอย่างสุภาพ ตรงไปตรงมา" },
                 { role: "user", content: prompt }],
      max_tokens: 200
    });
    return res.choices[0].message.content.trim();
  } catch (err) {
    console.error("[BOT] GPT error:", err.message);
    return "";
  }
}

/************************************************************
 * MATCH FUNCTIONS
 ************************************************************/
function matchProduct(message) {
  const low = message.toLowerCase();
  return cache.products.find(p =>
    low.includes(p.keyword.toLowerCase()) ||
    low.includes(p.name.toLowerCase())
  );
}

function matchFAQ(message) {
  const low = message.toLowerCase();
  return cache.faq.find(f =>
    f.keyword && low.includes(f.keyword.toLowerCase())
  );
}

/************************************************************
 * REPLY FUNCTIONS
 ************************************************************/
async function replyText(replyToken, text, quickItems = []) {
  try {
    await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        replyToken,
        messages: [
          {
            type: "text",
            text,
            quickReply: quickItems.length
              ? {
                  items: quickItems.map(it => ({
                    type: "action",
                    action: {
                      type: "message",
                      label: it.label.substring(0, 20), // LINE limit fix
                      text: it.text
                    }
                  }))
                }
              : undefined
          }
        ]
      })
    });
  } catch (err) {
    console.error("[BOT] LINE reply error", err);
  }
}

/************************************************************
 * INTENT DETECTION
 ************************************************************/
async function detectIntent(message) {
  // 1. FAQ
  const faq = matchFAQ(message);
  if (faq) return faq.answer;

  // 2. Product
  const product = matchProduct(message);
  if (product) {
    return `ตอนนี้มี "${product.name}" ราคา ${product.price} บาทค่ะ สนใจรับกี่ชิ้นดีคะ?`;
  }

  // 3. Fallback → GPT only for tone
  return await askGPT(`ลูกค้าพิมพ์ว่า "${message}" ตอบแบบพนักงานขายสุภาพ ชวนคุยต่อ`);
}

/************************************************************
 * LINE WEBHOOK
 ************************************************************/
app.post("/webhook", async (req, res) => {
  const events = req.body.events || [];
  for (const ev of events) {
    if (ev.type === "message" && ev.message.type === "text") {
      const message = ev.message.text;
      const replyToken = ev.replyToken;

      const answer = await detectIntent(message);

      await replyText(replyToken, answer, [
        { label: "ดูโปร", text: "โปรโมชั่น" },
        { label: "สรุปตะกร้า", text: "สรุปตะกร้า" },
        { label: "เช็กออเดอร์", text: "เช็กออเดอร์" }
      ]);
    }
  }
  res.sendStatus(200);
});

/************************************************************
 * SERVER START
 ************************************************************/
app.listen(PORT, async () => {
  await loadSheetsData();
  console.log(`[BOT] 🚀 Server running on port ${PORT}`);
});
