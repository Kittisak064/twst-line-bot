import express from "express";
import { Client } from "@line/bot-sdk";
import { GoogleSpreadsheet } from "google-spreadsheet";
import OpenAI from "openai";

// ========= ENV (Render) =========
const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  OPENAI_API_KEY,
  GOOGLE_SHEET_ID,
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  ADMIN_GROUP_ID
} = process.env;

// ========= LINE SDK =========
const lineClient = new Client({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
});

// ========= Google Sheets =========
const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID);
await doc.useServiceAccountAuth({
  client_email: GOOGLE_CLIENT_EMAIL,
  private_key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
});
await doc.loadInfo();

// ========= OpenAI =========
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ========= Helper: โหลดชีท =========
async function loadSheetData(sheetName) {
  try {
    const sheet = doc.sheetsByTitle[sheetName];
    if (!sheet) return [];
    const rows = await sheet.getRows();
    return rows.map(r => Object.fromEntries(
      Object.entries(r).filter(([k]) => !k.startsWith("_"))
    ));
  } catch (err) {
    console.error(`โหลดชีท ${sheetName} ล้มเหลว:`, err);
    return [];
  }
}

// ========= Helper: บันทึกลงชีท =========
async function appendToSheet(sheetName, rowObj) {
  try {
    const sheet = doc.sheetsByTitle[sheetName];
    if (!sheet) return;
    await sheet.addRow(rowObj);
  } catch (err) {
    console.error(`บันทึกชีท ${sheetName} ล้มเหลว:`, err);
  }
}

// ========= Webhook =========
const app = express();
app.use(express.json());

app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events;
    for (const e of events) {
      if (e.type === "message" && e.message.type === "text") {
        const userMsg = e.message.text;

        // โหลดข้อมูล
        const products = await loadSheetData("Products");
        const faqs = await loadSheetData("FAQ");
        const promos = await loadSheetData("Promotions");
        const persona = await loadSheetData("personality");

        // รวม context
        const context = `
สินค้า: ${JSON.stringify(products)}
โปรโมชั่น: ${JSON.stringify(promos)}
FAQ: ${JSON.stringify(faqs)}
บุคลิก: ${JSON.stringify(persona)}
        `;

        // เรียก GPT
        const gpt = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "คุณคือพนักงานขายออนไลน์ ทำหน้าที่คุย-ขาย-สรุปยอด ตามบุคลิกในชีท" },
            { role: "system", content: context },
            { role: "user", content: userMsg }
          ],
          temperature: 0.7,
          max_tokens: 400,
        });

        let reply = gpt.choices[0].message.content.trim();

        // ถ้า GPT ไม่ตอบ → ส่งให้แอดมิน
        if (!reply || reply.length < 2) {
          reply = "ขออนุญาตให้แอดมินช่วยตอบแทนนะคะ 😊";
          await lineClient.pushMessage(ADMIN_GROUP_ID, {
            type: "text",
            text: `⚠️ ลูกค้าถาม: "${userMsg}"\n\nAI ตอบไม่ได้ กรุณาเข้ามาช่วยตอบ`,
          });
        }

        // บันทึกลง Logs
        await appendToSheet("Logs", {
          Timestamp: new Date().toISOString(),
          UserId: e.source.userId,
          Message: userMsg,
          Reply: reply
        });

        // ส่งกลับลูกค้า
        await lineClient.replyMessage(e.replyToken, { type: "text", text: reply });

        // ถ้าลูกค้าคอนเฟิร์มออเดอร์ → บันทึกลง Orders
        if (reply.includes("[ORDER_CONFIRM]")) {
          await appendToSheet("Orders", {
            Timestamp: new Date().toISOString(),
            UserId: e.source.userId,
            Order: userMsg,
            Status: "Pending Payment/Delivery"
          });
        }
      }
    }
    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook Error:", err);
    res.status(500).send("Error");
  }
});

// ========= Start Server =========
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
