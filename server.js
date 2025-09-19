import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { GoogleSpreadsheet } from "google-spreadsheet";

const app = express();
app.use(bodyParser.json());

// ====== CONFIG ======
const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  OPENAI_API_KEY,
  GOOGLE_SHEET_ID,
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY_BASE64,
} = process.env;

// ====== GOOGLE SHEET SETUP ======
const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID);

async function authSheet() {
  await doc.useServiceAccountAuth({
    client_email: GOOGLE_CLIENT_EMAIL,
    private_key: Buffer.from(GOOGLE_PRIVATE_KEY_BASE64, "base64").toString("utf-8"),
  });
  await doc.loadInfo();
}

// ====== TEST SHEET ======
(async () => {
  try {
    await authSheet();
    console.log("✅ Google Sheet Connected:", doc.title);
  } catch (err) {
    console.error("❌ Google Sheet Error:", err.message);
  }
})();

// ====== LINE Webhook ======
app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events;
    await Promise.all(events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook Error:", err);
    res.sendStatus(500);
  }
});

// ====== Handle Event ======
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userMessage = event.message.text;

  // ตอบด้วย GPT
  const reply = await askGPT(userMessage);

  // ส่งกลับ LINE
  await replyToLine(event.replyToken, reply);

  // บันทึกลงชีท
  try {
    await authSheet();
    const sheet = doc.sheetsByIndex[0];
    await sheet.addRow({
      Timestamp: new Date().toLocaleString("th-TH"),
      UserMessage: userMessage,
      BotReply: reply,
    });
  } catch (err) {
    console.error("❌ Save to Sheet Error:", err.message);
  }
}

// ====== GPT ======
async function askGPT(userMessage) {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "คุณคือแอดมินเพจ ตอบลูกค้าให้สุภาพ ธรรมชาติ มีอีโมจิเล็กน้อย" },
          { role: "user", content: userMessage },
        ],
        temperature: 0.6,
        max_tokens: 200,
      }),
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "ขออภัยค่ะ ตอนนี้ระบบไม่ตอบสนอง 🙏";
  } catch (err) {
    console.error("❌ OpenAI Error:", err.message);
    return "ขออภัยค่ะ ระบบมีปัญหาชั่วคราว 🙏";
  }
}

// ====== Reply LINE ======
async function replyToLine(replyToken, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}

// ====== START SERVER ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
