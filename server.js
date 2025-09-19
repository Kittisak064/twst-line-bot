import express from "express";
import { middleware } from "@line/bot-sdk";

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();

// LINE Webhook
app.post("/webhook", middleware(config), (req, res) => {
  res.status(200).send("OK ✅"); // ตอบกลับเสมอ 200
});

// หน้า default เช็กว่า server online
app.get("/", (req, res) => {
  res.send("Server is running 🚀");
});

app.listen(process.env.PORT || 10000, () => {
  console.log("Server started");
});
