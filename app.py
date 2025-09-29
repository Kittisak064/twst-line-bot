import os
import json
import logging
from flask import Flask, request, abort
from linebot import LineBotApi, WebhookHandler
from linebot.exceptions import InvalidSignatureError
from linebot.models import MessageEvent, TextMessage, TextSendMessage
import gspread
from google.oauth2.service_account import Credentials
import requests

# -------------------------
# Logging
# -------------------------
logging.basicConfig(level=logging.INFO)

# -------------------------
# Flask App
# -------------------------
app = Flask(__name__)

# -------------------------
# LINE Config
# -------------------------
LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN")
LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET")

line_bot_api = LineBotApi(LINE_CHANNEL_ACCESS_TOKEN)
handler = WebhookHandler(LINE_CHANNEL_SECRET)

# -------------------------
# Google Sheets Config
# -------------------------
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
SERVICE_ACCOUNT_FILE = "google-service-account.json"  # อัปโหลดเป็น Secret File บน Render

credentials = Credentials.from_service_account_file(
    SERVICE_ACCOUNT_FILE, scopes=SCOPES
)
gc = gspread.authorize(credentials)

SPREADSHEET_ID = os.getenv("SPREADSHEET_ID")

# -------------------------
# Load Sheets
# -------------------------
def load_sheet(sheet_name):
    try:
        sh = gc.open_by_key(SPREADSHEET_ID)
        return sh.worksheet(sheet_name)
    except Exception as e:
        logging.error(f"โหลดข้อมูลชีท {sheet_name} ไม่สำเร็จ: {e}")
        return None

# -------------------------
# Basic Routes
# -------------------------
@app.route("/", methods=["GET"])
def home():
    return "LINE Bot with Flask is running!"

@app.route("/callback", methods=["POST"])
def callback():
    signature = request.headers["X-Line-Signature"]
    body = request.get_data(as_text=True)

    try:
        handler.handle(body, signature)
    except InvalidSignatureError:
        abort(400)

    return "OK"

# -------------------------
# Handle Messages
# -------------------------
@handler.add(MessageEvent, message=TextMessage)
def handle_message(event):
    user_message = event.message.text.strip()

    # ดึงข้อมูลสินค้า
    sheet = load_sheet("ข้อมูลสินค้าและราคา")
    reply_text = None

    if sheet:
        try:
            records = sheet.get_all_records()
            for row in records:
                if user_message in row["ชื่อสินค้าที่มักถูกเรียก"]:
                    reply_text = (
                        f"สินค้า: {row['ชื่อสินค้าในระบบขาย']}\n"
                        f"ราคา: {row['ราคาขาย']} บาท\n"
                        f"ขนาด: {row['ขนาด']} {row['หน่วย']}\n"
                        f"หมวดหมู่: {row['หมวดหมู่']}"
                    )
                    break
        except Exception as e:
            logging.error(f"อ่านข้อมูลสินค้า error: {e}")

    # ถ้าไม่เจอ → ดึง FAQ
    if not reply_text:
        faq_sheet = load_sheet("FAQ")
        if faq_sheet:
            faqs = faq_sheet.get_all_records()
            for row in faqs:
                if user_message in row["คีย์เวิร์ด"]:
                    reply_text = row["คำตอบ"]
                    break

    # ถ้าไม่เจอ → ตอบ fallback
    if not reply_text:
        persona_sheet = load_sheet("บุคลิกน้อง AI")
        fallback_text = "รบกวนรอสักครู่นะคะ แอดมินขออนุญาตเช็คข้อมูลแล้วรีบตอบกลับค่ะ 😄"
        if persona_sheet:
            try:
                persona = dict(
                    zip(
                        persona_sheet.col_values(1),
                        persona_sheet.col_values(2)
                    )
                )
                fallback_text = persona.get("หากไม่รู้คำตอบให้ตอบว่า", fallback_text)
            except Exception as e:
                logging.error(f"โหลด persona error: {e}")
        reply_text = fallback_text

    # ส่งกลับ LINE
    line_bot_api.reply_message(
        event.reply_token,
        TextSendMessage(text=reply_text)
    )

# -------------------------
# Run App
# -------------------------
if __name__ == "__main__":
    port = int(os.environ["PORT"])  # ใช้ PORT ที่ Render ส่งมา
    app.run(host="0.0.0.0", port=port)
