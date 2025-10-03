
# LINE OA Chatbot (Google Sheets KB) — Thai, Ready for Render + GitHub

ระบบแชตบอทสำหรับ **LINE Official Account** ที่อ่านฐานข้อมูลจาก **Google Sheets** (ชื่อชีทภาษาไทย) พร้อมไฟล์ดีพลอยลง **Render** และใช้งานกับ **GitHub** ได้ทันที

## คุณสมบัติ
- FastAPI + LINE Messaging API (Webhook)
- อ่านชีทภาษาไทย: `ข้อมูลสินค้าและราคา`, `บุคลิกน้อง A.I.`, `FAQ`, `Intent Instruction – ก่อนขาย`, `Intent Instruction – หลังการขาย`, `Training Data`, `System Config`, `Promotions`, `Payment`, `Orders`
- จับ Intent จากคอลัมน์ **กฎการตรวจจับ** (เช่น `keyword_any:ราคา,กี่บาท|llm`, `always:*`)
- เรนเดอร์คำตอบด้วยตัวแปรใน `แม่แบบคำตอบ` เช่น `{{product.ชื่อสินค้า}}`, `{{product.คุณสมบัติ.max_load_kg}}`, `{{promo.one_line}}`, `{{ข้อความเมื่อหาไม่พบ (Fallback)}}`
- เลือกสินค้าอัตโนมัติจากข้อความ (SKU/ชื่อรุ่น) หรือใช้ตัวแรกเป็นค่าเริ่มต้น
- (ออปชัน) ใช้ OpenAI **ปรับสำนวน** ตามบุคลิกบอทใน `System Config`

## โครงสร้างโปรเจกต์
```
app/
  main.py
  sheets.py
  intent.py
  template_engine.py
requirements.txt
render.yaml
runtime.txt
Procfile
.env.example
README.md
```

## วิธีใช้งาน (Render)
1. **สร้าง GitHub Repo** แล้วอัปโหลดโค้ดนี้ทั้งหมด
2. ที่ **Render** เลือก **New > Web Service** → เชื่อมกับ GitHub → เลือก repo
3. Render จะอ่าน `render.yaml` อัตโนมัติ
4. ตั้งค่า Environment Variables:
   - `LINE_CHANNEL_SECRET`
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `GOOGLE_SPREADSHEET_ID`
   - `GOOGLE_SERVICE_ACCOUNT_JSON` (ใส่ JSON ทั้งก้อน)
   - (ออปชัน) `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-4o-mini`
5. ใน **Google Sheets**: กด Share ให้กับ **`client_email`** จาก Service Account (ใน JSON) เป็น **Viewer/Editor**
6. ที่ **LINE Developers Console**:
   - Messaging API → ใส่ `Channel secret`, `Channel access token` ตามที่ตั้งไว้
   - Webhook URL = `https://<render-service-url>/callback`
   - เปิด Use Webhook และ Verify
7. ทดสอบส่งข้อความใน LINE OA

## วิธีใช้งาน (Local)
```
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env  # เติมค่าให้ครบ
uvicorn app.main:app --reload --port 8000
```
ทดสอบ Health: http://localhost:8000/healthz

## หมายเหตุสำคัญ
- ต้องสร้างชีทด้วย **หัวคอลัมน์ภาษาไทย** ตามตัวอย่างในไฟล์ Master ของคุณ
- ถ้าอยากปรับตรรกะการจับ Intent → ปรับคอลัมน์ **กฎการตรวจจับ** ในชีท `Intent Instruction – ก่อนขาย/หลังการขาย`
- ถ้าไม่ตั้งค่า OpenAI ระบบจะตอบด้วยแม่แบบตรง ๆ (ยังอ่านง่ายและสุภาพ)
- โปรดแชร์สิทธิ์ชีทให้ Service Account ก่อนทุกครั้ง ไม่งั้นบอทจะอ่านชีทไม่ได้
