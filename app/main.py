import os, json, logging, asyncio, base64
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

# ----------------------------------
# Logging
# ----------------------------------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("app")

# ----------------------------------
# LINE Credentials
# ----------------------------------
LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET", "")
LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "")

if not LINE_CHANNEL_SECRET or not LINE_CHANNEL_ACCESS_TOKEN:
    logger.warning("❌ LINE credentials are not set properly")

line_bot_api = None
handler = None
if LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN:
    line_bot_api = LineBotApi(LINE_CHANNEL_ACCESS_TOKEN)
    handler = WebhookHandler(LINE_CHANNEL_SECRET)
else:
    logger.error("❌ LINE handler not created, check LINE_CHANNEL_SECRET")

# ----------------------------------
# Google Sheets Credentials
# ----------------------------------
SPREADSHEET_ID = os.getenv("GOOGLE_SPREADSHEET_ID", "")
raw_json = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "")

if not raw_json:
    raw_b64 = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON_BASE64", "")
    if raw_b64:
        try:
            raw_json = base64.b64decode(raw_b64).decode("utf-8")
        except Exception as e:
            logger.error("❌ Failed to decode GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: %s", e)

SERVICE_ACCOUNT_JSON = raw_json
sa_dict = {}
try:
    sa_dict = json.loads(SERVICE_ACCOUNT_JSON) if SERVICE_ACCOUNT_JSON else {}
except Exception as e:
    logger.error("❌ Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON: %s", e)

if not SPREADSHEET_ID or not sa_dict:
    logger.warning("❌ Google Sheets env vars missing")

db = SheetsDB(SPREADSHEET_ID, sa_dict, refresh_secs=300)

# ----------------------------------
# FastAPI App
# ----------------------------------
app = FastAPI(title="LINE OA Chatbot", version="1.0.0")

@app.get("/healthz")
async def health():
    return {"ok": True, "time": datetime.now().isoformat()}

# ----------------------------------
# Helpers
# ----------------------------------
def _kv_from_config(df_sys: pd.DataFrame) -> Dict[str, str]:
    kv = {}
    if df_sys is None or df_sys.empty: 
        return kv
    key_col = next((c for c in df_sys.columns if "คีย์" in c), None)
    val_col = next((c for c in df_sys.columns if "ค่า" in c), None)
    if not key_col or not val_col: 
        return kv
    for _, r in df_sys.iterrows():
        k = str(r.get(key_col, "")).strip()
        v = str(r.get(val_col, "")).strip()
        if k:
            kv[k] = v
    return kv

def _parse_products(df: pd.DataFrame):
    items = []
    if df is None or df.empty: 
        return items
    for _, r in df.iterrows():
        p = r.to_dict()
        items.append(p)
    return items

def build_context(kv: Dict[str,str], product: Dict[str,Any], promo: Optional[Dict[str,Any]], extra: Dict[str,Any]) -> Dict[str,Any]:
    ctx: Dict[str,Any] = {}
    ctx.update(kv)
    ctx["product"] = product or {}
    ctx["promo"]   = promo or {}
    ctx["list_products_top3"] = ", ".join([p.get("ชื่อสินค้า","") for p in extra.get("products", [])[:3]])
    return ctx

def render_reply(text: str, tables: Dict[str, pd.DataFrame]) -> str:
    df_sys    = tables.get("System Config")
    df_before = tables.get("Intent Instruction – ก่อนขาย")
    df_after  = tables.get("Intent Instruction – หลังการขาย")
    df_prod   = tables.get("ข้อมูลสินค้าและราคา")

    kv = _kv_from_config(df_sys)
    which, row = choose_intent(text, df_before, df_after)
    template = str(row.get("แม่แบบคำตอบ","")).strip() or "ขออภัยค่ะ ตอนนี้หนูยังไม่มีข้อมูลนี้ในระบบ เดี๋ยวแอดมินช่วยตรวจสอบให้นะคะ 🙏"

    products = _parse_products(df_prod)
    product  = products[0] if products else {}
    ctx = build_context(kv, product, None, {"products": products})
    reply = render_template(template, ctx)
    return reply

# ----------------------------------
# LINE Callback
# ----------------------------------
@app.post("/callback")
async def callback(request: Request):
    if not handler:
        raise HTTPException(status_code=500, detail="LINE handler not initialized")

    signature = request.headers.get("X-Line-Signature", "")
    body = await request.body()
    body_text = body.decode("utf-8")
    try:
        handler.handle(body_text, signature)
    except InvalidSignatureError:
        raise HTTPException(status_code=400, detail="Invalid signature")
    return JSONResponse({"ok": True})

if handler:
    @handler.add(MessageEvent, message=TextMessage)
    def handle_message(event: MessageEvent):
        try:
            tables = db.load()
            user_text = event.message.text or ""
            reply = render_reply(user_text, tables)
            line_bot_api.reply_message(
                event.reply_token, TextSendMessage(text=reply)
            )
        except Exception as e:
            logger.exception("❌ Error handling message: %s", e)
            fallback = "ขออภัยค่ะ ระบบขัดข้องชั่วคราว เดี๋ยวหนูจะส่งต่อให้แอดมินช่วยดูนะคะ 🙏"
            line_bot_api.reply_message(
                event.reply_token, TextSendMessage(text=fallback)
            )
