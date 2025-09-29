import os
import logging
from flask import Flask, request, abort
from linebot import LineBotApi, WebhookHandler
from linebot.exceptions import InvalidSignatureError
from linebot.models import MessageEvent, TextMessage, TextSendMessage
import gspread
from google.oauth2.service_account import Credentials
from openai import OpenAI

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
SERVICE_ACCOUNT_FILE = "google-service-account.json"  # ใช้ Secret File ของ Render

credentials = Credentials.from_service_account_file(
    SERVICE_ACCOUNT_FILE, scopes=SCOPES
)
gc = gspread.authorize(credentials)

SPREADSHEET_ID = os.getenv("SPREADSHEET_ID")

# -------------------------
# OpenAI Config
# -------------------------
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
client = OpenAI(api_key=OPENAI_API_KEY)

# -------------------------
# Helper Functions
# -------------------------
def load_sheet(sheet_name):
    try:
        sh = gc.open_by_key(SPREADSHEET_ID)
        return sh.worksheet(sheet_name)
    except Exception as e:
        logging.error(f"โหลดข้อมูลชีท {sheet_name} ไม่สำเร็จ: {e}")
        return None


def get_persona():
    persona_sheet = load_sheet("บุคลิกน้อง AI")
    if not persona_sheet:
        return {"เรียกลูกค้าว่า": "คุณลูกค้า", "เรียกแทนตัวเองว่า": "แอดมิน"}
    try:
        return dict(
            zip(
                persona_sheet.col_values(1),
                persona_sheet.col_values(2)
            )
        )
    except Exception as e:
        logging.error(f"โหลด persona error: {e}")
        return {"เรียกลูกค้าว่า": "คุณลูกค้า", "เรียกแทนตัวเองว่า": "แอดมิน"}


def ai_fallback(user_message, persona):
    try:
        completion = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": f"""
                คุณคือน้องฟักแฟง พนักงานขายของร้านน้ำพริกย่าขอ 
                บุคลิก: {persona.get('บุคลิก และการตอบกลับลูกค้า', 'น่ารัก สดใส')}
                เรียกลูกค้าว่า: {persona.get('เรียกลูกค้าว่า', 'คุณลูกค้า')}
                เรียกแทนตัวเองว่า: {persona.get('เรียกแทนตัวเองว่า', 'แอดมิน')}
                ถ้าไม่รู้คำตอบให้ตอบ: {persona.get('หากไม่รู้คำตอบให้ตอบว่า', 'รบกวนรอสักครู่นะคะ')}
                """},
                {"role": "user", "content": user_message}
            ]
        )
        return completion.choices[0].message.content
    except Exception as e:
        logging.error(f"OpenAI error: {e}")
        return "รบกวนรอสักครู่ค่ะ ระบบขัดข้องเล็กน้อย"


# -------------------------
# Routes
# -------------------------
@app.route("/", methods=["GET"])
def home():
    return "Bot is running!"


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
# LINE Message Handler
# -------------------------
@handler.add(MessageEvent, message=TextMessage)
def handle_message(event):
    user_message = event.message.text.strip()
    persona = get_persona()
    reply_text = None

    # 1. เช็คสินค้า
    sheet = load_sheet("ข้อมูลสินค้าและราคา")
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

    # 2. ถ้าไม่เจอ → FAQ
    if not reply_text:
        faq_sheet = load_sheet("FAQ")
        if faq_sheet:
            try:
                faqs = faq_sheet.get_all_records()
                for row in faqs:
                    if user_message in row["คีย์เวิร์ด"]:
                        reply_text = row["คำตอบ"]
                        break
            except Exception as e:
                logging.error(f"FAQ error: {e}")

    # 3. ถ้าไม่เจอ → AI Fallback
    if not reply_text:
        reply_text = ai_fallback(user_message, persona)

    # ส่งกลับ LINE
    line_bot_api.reply_message(
        event.reply_token,
        TextSendMessage(text=reply_text)
    )


# -------------------------
# Run App
# -------------------------
if __name__ == "__main__":
    port = int(os.environ["PORT"])  # ใช้ PORT จาก Render
    app.run(host="0.0.0.0", port=port)
