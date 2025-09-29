import os
import json
import openai
import gspread
from flask import Flask, request, abort
from google.oauth2.service_account import Credentials
from linebot import LineBotApi, WebhookHandler
from linebot.exceptions import InvalidSignatureError
from linebot.models import MessageEvent, TextMessage, TextSendMessage

# -------------------------------
# 1. ตั้งค่า ENV จาก Render
# -------------------------------
LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN")
LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
SPREADSHEET_ID = os.getenv("SPREADSHEET_ID")
GOOGLE_CREDENTIALS_FILE = "/etc/secrets/google-service-account.json"  # Secret File บน Render

if not all([LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, OPENAI_API_KEY, SPREADSHEET_ID]):
    raise ValueError("❌ Environment Variables ยังไม่ครบ ตรวจสอบใน Render อีกครั้ง")

# -------------------------------
# 2. Init API Clients
# -------------------------------
line_bot_api = LineBotApi(LINE_CHANNEL_ACCESS_TOKEN)
handler = WebhookHandler(LINE_CHANNEL_SECRET)
openai.api_key = OPENAI_API_KEY

# -------------------------------
# 3. เชื่อม Google Sheets
# -------------------------------
creds = Credentials.from_service_account_file(
    GOOGLE_CREDENTIALS_FILE,
    scopes=["https://www.googleapis.com/auth/spreadsheets"]
)
gs_client = gspread.authorize(creds)

# ตัวอย่าง: โหลดชีทข้อมูลสินค้า
try:
    ws_products = gs_client.open_by_key(SPREADSHEET_ID).worksheet("ข้อมูลสินค้าและราคา")
    product_data = ws_products.get_all_records()
except Exception as e:
    product_data = []
    print("⚠️ โหลดข้อมูลสินค้าไม่สำเร็จ:", e)

# -------------------------------
# 4. Flask App
# -------------------------------
app = Flask(__name__)

@app.route("/")
def home():
    return "LINE Bot ทำงานแล้ว 🚀"

@app.route("/callback", methods=['POST'])
def callback():
    # รับ signature จาก LINE
    signature = request.headers['X-Line-Signature']
    body = request.get_data(as_text=True)

    try:
        handler.handle(body, signature)
    except InvalidSignatureError:
        abort(400)

    return 'OK'

# -------------------------------
# 5. Event Handler
# -------------------------------
@handler.add(MessageEvent, message=TextMessage)
def handle_message(event):
    user_text = event.message.text.strip()
    reply_text = process_user_message(user_text)
    line_bot_api.reply_message(
        event.reply_token,
        TextSendMessage(text=reply_text)
    )

# -------------------------------
# 6. Logic การตอบลูกค้า
# -------------------------------
def process_user_message(user_text: str) -> str:
    """
    - ถ้าเจอชื่อสินค้าที่ตรงกับ Google Sheets → ตอบข้อมูลสินค้า
    - ถ้าไม่เจอ → ส่งข้อความไปที่ OpenAI เพื่อให้ตอบแทน
    """
    # 6.1 เช็คข้อมูลในชีทสินค้า
    for product in product_data:
        if product["ชื่อสินค้าในระบบขาย"] in user_text or product["ชื่อสินค้าที่มักถูกเรียก"] in user_text:
            return (
                f"สินค้า: {product['ชื่อสินค้าในระบบขาย']}\n"
                f"ขนาด: {product['ขนาด']} {product['หน่วย']}\n"
                f"ราคา: {product['ราคาขาย']} บาท\n"
                f"ค่าส่ง: {product['ราคาค่าขนส่ง']} บาท"
            )

    # 6.2 ถ้าไม่เจอสินค้า → ใช้ GPT ตอบ
    try:
        response = openai.ChatCompletion.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "คุณคือน้องฟักแฟง แอดมินเพจน่ารัก สดใส สุภาพ ช่วยตอบลูกค้าเรื่องสินค้า"},
                {"role": "user", "content": user_text}
            ],
            temperature=0.7,
            max_tokens=300
        )
        return response["choices"][0]["message"]["content"].strip()
    except Exception as e:
        return f"ขออภัยค่ะ เกิดข้อผิดพลาดในการตอบ ({e})"

# -------------------------------
# 7. Run local (เวลาเทสในเครื่อง)
# -------------------------------
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", 10000)))
