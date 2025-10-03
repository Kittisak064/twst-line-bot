import os, json, logging
from datetime import datetime
from typing import Dict, Any, Optional

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse

from linebot import LineBotApi, WebhookHandler
from linebot.exceptions import InvalidSignatureError
from linebot.models import MessageEvent, TextMessage, TextSendMessage

import pandas as pd

from app.sheets import SheetsDB
from app.intent import choose_intent
from app.template_engine import render as render_template

# ---------------- DEBUG ENV ----------------
print("========== DEBUG ENV START ==========")
print("ENV KEYS:", list(os.environ.keys()))
print("LINE_CHANNEL_SECRET:", os.getenv("LINE_CHANNEL_SECRET"))
print("LINE_CHANNEL_ACCESS_TOKEN:", os.getenv("LINE_CHANNEL_ACCESS_TOKEN"))
print("GOOGLE_SPREADSHEET_ID:", os.getenv("GOOGLE_SPREADSHEET_ID"))
print("GOOGLE_SERVICE_ACCOUNT_JSON length:", len(os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON") or ""))
print("========== DEBUG ENV END ==========")

# ---------------- LOGGING ----------------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("app")

# ---------------- LINE CONFIG ----------------
LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET", "")
LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "")

if not LINE_CHANNEL_SECRET or not LINE_CHANNEL_ACCESS_TOKEN:
    logger.warning("❌ LINE credentials are not set properly")

line_bot_api = LineBotApi(LINE_CHANNEL_ACCESS_TOKEN) if LINE_CHANNEL_ACCESS_TOKEN else None
handler = WebhookHandler(LINE_CHANNEL_SECRET) if LINE_CHANNEL_SECRET else None

# ---------------- GOOGLE SHEETS CONFIG ----------------
SPREADSHEET_ID = os.getenv("GOOGLE_SPREADSHEET_ID", "")
SERVICE_ACCOUNT_JSON = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "")

if not SPREADSHEET_ID or not SERVICE_ACCOUNT_JSON:
    logger.warning("❌ Google Sheets env vars missing")

try:
    sa_dict = json.loads(SERVICE_ACCOUNT_JSON) if SERVICE_ACCOUNT_JSON else {}
except Exception as e:
    logger.error(f"Google Service Account JSON parse error: {e}")
    sa_dict = {}

db = SheetsDB(SPREADSHEET_ID, sa_dict, refresh_secs=300)

# ---------------- FASTAPI ----------------
app = FastAPI(title="LINE OA Chatbot", version="1.0.0")

@app.get("/healthz")
async def health():
    return {"ok": True, "time": datetime.now().isoformat()}

# ---------------- HELPER FUNCTIONS ----------------
def render_reply(text: str, tables: Dict[str, pd.DataFrame]) -> str:
    # ลองโหลด intent
    df_before = tables.get("Intent Instruction – ก่อนขาย")
    df_after  = tables.get("Intent Instruction – หลังการขาย")
    which, row = choose_intent(text, df_before, df_after)
    template = str(row.get("แม่แบบคำตอบ", "")).strip() or "ขออภัยค่ะ ตอนนี้ยังไม่มีข้อมูลนี้ 🙏"
    return render_template(template, {"text": text})

# ---------------- CALLBACK ----------------
@app.post("/callback")
async def callback(request: Request):
    signature = request.headers.get("X-Line-Signature", "")
    body = await request.body()
    body_text = body.decode("utf-8")

    if not handler:
        raise HTTPException(status_code=500, detail="LINE handler not initialized")

    try:
        handler.handle(body_text, signature)
    except InvalidSignatureError:
        raise HTTPException(status_code=400, detail="Invalid signature")
    return JSONResponse({"ok": True})

# ---------------- LINE HANDLER ----------------
if handler:
    @handler.add(MessageEvent, message=TextMessage)
    def handle_message(event: MessageEvent):
        try:
            tables = db.load()
            user_text = event.message.text or ""
            reply = render_reply(user_text, tables)
            if line_bot_api:
                line_bot_api.reply_message(event.reply_token, TextSendMessage(text=reply))
        except Exception as e:
            logger.exception("Error handling message: %s", e)
            fallback = "❌ ขอโทษค่ะ ระบบขัดข้อง เดี๋ยวแอดมินจะตรวจสอบให้นะคะ 🙏"
            if line_bot_api:
                line_bot_api.reply_message(event.reply_token, TextSendMessage(text=fallback))
else:
    logger.error("❌ LINE handler not created, check LINE_CHANNEL_SECRET")
