
import os, json, logging, asyncio
from datetime import datetime, date
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

# Optional OpenAI polishing
OPENAI_ENABLED = False
try:
    from openai import OpenAI
    _client = OpenAI(api_key=os.getenv("OPENAI_API_KEY", ""))
    OPENAI_ENABLED = bool(os.getenv("OPENAI_API_KEY"))
except Exception:
    OPENAI_ENABLED = False
    _client = None

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("app")

LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET", "")
LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "")

if not LINE_CHANNEL_SECRET or not LINE_CHANNEL_ACCESS_TOKEN:
    logger.warning("LINE credentials are not set. Please configure LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN.")

line_bot_api = LineBotApi(LINE_CHANNEL_ACCESS_TOKEN)
handler = WebhookHandler(LINE_CHANNEL_SECRET)

# Google Sheets
SPREADSHEET_ID = os.getenv("GOOGLE_SPREADSHEET_ID", "")
SERVICE_ACCOUNT_JSON = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "")

if not SPREADSHEET_ID or not SERVICE_ACCOUNT_JSON:
    logger.warning("Google Sheets env vars not set. Please set GOOGLE_SPREADSHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON.")

try:
    sa_dict = json.loads(SERVICE_ACCOUNT_JSON) if SERVICE_ACCOUNT_JSON else {}
except Exception:
    sa_dict = {}

db = SheetsDB(SPREADSHEET_ID, sa_dict, refresh_secs=300)

app = FastAPI(title="LINE OA Chatbot", version="1.0.0")

@app.get("/healthz")
async def health():
    return {"ok": True, "time": datetime.now().isoformat()}

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
        # Parse JSON field if present
        attr_key = None
        for k in list(p.keys()):
            if "คุณสมบัติ" in k and "JSON" in k:
                attr_key = k
                break
        if attr_key:
            import json
            try:
                p["คุณสมบัติ"] = json.loads(p.get(attr_key) or "{}")
            except Exception:
                p["คุณสมบัติ"] = {}
        items.append(p)
    return items

def _active_promo(df_promos: pd.DataFrame) -> Optional[Dict[str, Any]]:
    if df_promos is None or df_promos.empty:
        return None
    today = datetime.utcnow().date()
    def parse_date(s):
        try:
            return datetime.fromisoformat(str(s)).date()
        except Exception:
            # attempt simple YYYY-MM-DD only
            try:
                return datetime.strptime(str(s)[:10], "%Y-%m-%d").date()
            except Exception:
                return None
    for _, r in df_promos.iterrows():
        start = parse_date(r.get("วันที่เริ่ม",""))
        end = parse_date(r.get("วันหมดอายุ",""))
        ok = True
        if start and today < start: ok = False
        if end and today > end: ok = False
        if ok:
            promo = r.to_dict()
            title = str(promo.get("ชื่อโปรโมชัน","")).strip()
            short = str(promo.get("คำอธิบายสั้น","")).strip()
            promo["one_line"] = f"{title} — {short}" if title or short else ""
            return promo
    return None

def _pick_product(text: str, products: list) -> Dict[str, Any]:
    if not products:
        return {}
    t = (text or "").lower()
    # Try by exact SKU first
    for p in products:
        sku = str(p.get("รหัสสินค้า (SKU)","")).lower()
        if sku and sku in t:
            return p
    # Try by name keyword
    for p in products:
        name = str(p.get("ชื่อสินค้า","")).lower()
        if name and any(token in t for token in name.split()):
            return p
    # fallback: first product
    return products[0]

def _polish(text: str, persona: str) -> str:
    if not OPENAI_ENABLED or not _client:
        return text
    try:
        sys = f"คุณเป็นแอดมินชื่อฟักแฟง บุคลิก: {persona}. ปรับข้อความให้สุภาพ กระชับ อ่านง่าย สำหรับลูกค้าคนไทย และคงความหมายเดิม."
        resp = _client.chat.completions.create(
            model=os.getenv("OPENAI_MODEL","gpt-4o-mini"),
            messages=[
                {"role":"system","content":sys},
                {"role":"user","content":text}
            ],
            temperature=0.4,
            max_tokens=400
        )
        return resp.choices[0].message.content.strip()
    except Exception:
        return text

def _list_products_top3(products: list) -> str:
    names = [p.get("ชื่อสินค้า","") for p in products[:3]]
    return ", ".join([n for n in names if n])

def build_context(kv: Dict[str,str], product: Dict[str,Any], promo: Optional[Dict[str,Any]], extra: Dict[str,Any]) -> Dict[str,Any]:
    ctx: Dict[str,Any] = {}
    # System config KVs
    ctx.update(kv)
    # Product/promo
    ctx["product"] = product or {}
    ctx["promo"]   = promo or {}
    # Convenience helpers
    ctx["list_products_top3"] = _list_products_top3(extra.get("products", []))
    return ctx

def render_reply(text: str, tables: Dict[str, pd.DataFrame]) -> str:
    # Extract tables
    df_sys    = tables.get("System Config")
    df_before = tables.get("Intent Instruction – ก่อนขาย")
    df_after  = tables.get("Intent Instruction – หลังการขาย")
    df_prod   = tables.get("ข้อมูลสินค้าและราคา")
    df_promo  = tables.get("Promotions")
    df_persona= tables.get("บุคลิกน้อง A.I.")

    kv = _kv_from_config(df_sys)
    persona = kv.get("บุคลิกบอท", "ฟักแฟง แอดมินใจดี พูดสุภาพ กระชับ ใช้อีโมจิบางคำ 🙂🙏✨")

    which, row = choose_intent(text, df_before, df_after)
    template = str(row.get("แม่แบบคำตอบ","")).strip() or kv.get("ข้อความเมื่อหาไม่พบ (Fallback)", "ขออภัยค่ะ ตอนนี้หนูยังไม่มีข้อมูลนี้ในระบบ เดี๋ยวแอดมินช่วยตรวจสอบให้นะคะ 🙏")

    products = _parse_products(df_prod)
    product  = _pick_product(text, products)
    promo    = _active_promo(df_promo)

    ctx = build_context(kv, product, promo, {"products": products})
    reply = render_template(template, ctx)
    reply = _polish(reply, persona)
    return reply

@app.post("/callback")
async def callback(request: Request):
    signature = request.headers.get("X-Line-Signature", "")
    body = await request.body()
    body_text = body.decode("utf-8")
    try:
        handler.handle(body_text, signature)
    except InvalidSignatureError:
        raise HTTPException(status_code=400, detail="Invalid signature")
    return JSONResponse({"ok": True})

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
        logger.exception("Error handling message: %s", e)
        fallback = "ขออภัยค่ะ ระบบขัดข้องชั่วคราว เดี๋ยวหนูจะส่งต่อให้แอดมินช่วยดูนะคะ 🙏"
        line_bot_api.reply_message(
            event.reply_token, TextSendMessage(text=fallback)
        )
