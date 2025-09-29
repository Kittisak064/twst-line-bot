import os
import gspread
from flask import Flask, request, abort
from linebot import LineBotApi, WebhookHandler
from linebot.exceptions import InvalidSignatureError
from linebot.models import MessageEvent, TextMessage, TextSendMessage
from google.oauth2.service_account import Credentials
from openai import OpenAI

# -------------------------------
# ตั้งค่า Flask
# -------------------------------
app = Flask(__name__)

# -------------------------------
# ตั้งค่า LINE
# -------------------------------
LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET")
LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN")

line_bot_api = LineBotApi(LINE_CHANNEL_ACCESS_TOKEN)
handler = WebhookHandler(LINE_CHANNEL_SECRET)

# -------------------------------
# ตั้งค่า OpenAI
# -------------------------------
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# -------------------------------
# ตั้งค่า Google Sheets
# -------------------------------
# ใช้ Secret File (google-service-account.json) ที่อัปโหลดเข้า Render
SERVICE_ACCOUNT_FILE = "google-service-account.json"

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
creds = Credentials.from_service_account_file(SERVICE_ACCOUNT_FILE, scopes=SCOPES)

gc = gspread.authorize(creds)

# ใส่ Spreadsheet ID ของคุณ
SPREADSHEET_ID = os.getenv("SPREADSHEET_ID")

def read_sheet(sheet_name):
    """อ่านข้อมูลจาก Google Sheets"""
    try:
        sh = gc.open_by_key(SPREADSHEET_ID)
        worksheet = sh.worksheet(sheet_name)
        records = worksheet.get_all_records()
        return records
    except Exception as e:
        print(f"⚠️ โหลดข้อมูลไม่สำเร็จจาก {sheet_name}: {e}")
        return []

# -------------------------------
# ฟังก์ชันถาม GPT
# -------------------------------
def ask_gpt(user_message):
    """ส่งข้อความไปหา GPT"""
    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "คุณคือน้องฟักแฟง แอดมินร้านน้ำพริกและรถเข็นไฟฟ้า บุคลิกน่ารัก สดใส เป็นกันเอง"},
                {"role": "user", "content": user_message}
            ]
        )
        return response.choices[0].message.content
    except Exception as e:
        print("❌ OpenAI Error:", e)
        return "ขออภัยค่ะ เกิดข้อผิดพลาดในการตอบ 😅"

# -------------------------------
# LINE Webhook
# -------------------------------
@app.route("/webhook", methods=["POST"])
def webhook():
    signature = request.headers["X-Line-Signature"]
    body = request.get_data(as_text=True)

    try:
        handler.handle(body, signature)
    except InvalidSignatureError:
        abort(400)

    return "OK"

# -------------------------------
# จัดการข้อความจากลูกค้า
# -------------------------------
@handler.add(MessageEvent, message=TextMessage)
def handle_message(event):
    user_message = event.message.text
    print(f"📩 ข้อความจากลูกค้า: {user_message}")

    reply_text = ask_gpt(user_message)

    line_bot_api.reply_message(
        event.reply_token,
        TextSendMessage(text=reply_text)
    )

# -------------------------------
# Run local (Render จะใช้ gunicorn)
# -------------------------------
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=10000)
