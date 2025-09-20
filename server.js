import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { GoogleAuth } from "google-auth-library";
import fs from "fs";
import OpenAI from "openai";

// ---------------------- ENV & CONFIG ----------------------
const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  OPENAI_API_KEY,
  GOOGLE_CREDENTIALS_FILE,
  GOOGLE_SHEET_ID,
  LINE_GROUP_ID // ใส่เองใน Render
} = process.env;

if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET) {
  console.error("Missing LINE credentials");
}
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
}
if (!GOOGLE_CREDENTIALS_FILE || !fs.existsSync(GOOGLE_CREDENTIALS_FILE)) {
  console.error("Missing GOOGLE_CREDENTIALS_FILE or file not found");
}
if (!GOOGLE_SHEET_ID) {
  console.error("Missing GOOGLE_SHEET_ID");
}

const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET
};

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------------------- GOOGLE SHEETS ----------------------
// ใช้ GoogleAuth แทน useServiceAccountAuth เพื่อหลีกเลี่ยง error รุ่นไลบรารี
const creds = JSON.parse(fs.readFileSync(GOOGLE_CREDENTIALS_FILE, "utf-8"));
const auth = new GoogleAuth({
  credentials: creds,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, auth);

// โครงสร้างชีทที่รองรับ
const SHEETS = {
  PRODUCTS: "Products",
  PROMOTIONS: "Promotions",
  PROFILE: "AI_Profile",
  FAQ: "FAQ",
  ORDERS: "Orders"
};

// Cache ง่าย ๆ เพื่อลดโหลดชีทบ่อย
let cache = {
  loadedAt: 0,
  products: [],
  promotions: [],
  profile: {},
  faq: [],
};
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 นาที

async function loadSheets() {
  const now = Date.now();
  if (now - cache.loadedAt < CACHE_TTL_MS && cache.products.length) return cache;

  await doc.loadInfo();

  // helper get sheet by name
  const getSheet = (name) => {
    const sh = Object.values(doc.sheetsById).find(s => s.title === name);
    return sh || null;
  };

  // Products
  const shProducts = getSheet(SHEETS.PRODUCTS);
  const products = [];
  if (shProducts) {
    const rows = await shProducts.getRows();
    rows.forEach(r => {
      products.push({
        code: (r["รหัสสินค้า"] || "").toString().trim(),
        name: (r["ชื่อสินค้า"] || "").toString().trim(),
        category: (r["หมวดหมู่"] || "").toString().trim(),
        price: Number(r["ราคา"] || 0),
        alias: (r["คำที่ลูกค้าเรียก"] || "")
          .toString()
          .split(",")
          .map(s => s.trim())
          .filter(Boolean),
        options: (r["ตัวเลือก"] || "")
          .toString()
          .split(",")
          .map(s => s.trim())
          .filter(Boolean),
        extra: r._rawData // เก็บไว้ใช้เสริม
      });
    });
  }

  // Promotions
  const shPromos = getSheet(SHEETS.PROMOTIONS);
  const promotions = [];
  if (shPromos) {
    const rows = await shPromos.getRows();
    rows.forEach(r => {
      promotions.push({
        id: (r["รหัสโปรโมชัน"] || "").toString().trim(),
        description: (r["รายละเอียดโปรโมชัน"] || "").toString().trim(),
        calcType: (r["ประเภทคำนวณ"] || "").toString().trim(), // จำนวน | ค่าขนส่ง | ส่วนลด | ส่วนลดคงที่
        condition: (r["เงื่อนไข"] || "").toString().trim(), // เช่น ซื้อครบ 5
        appliesProducts: (r["ใช้กับสินค้า"] || "")
          .toString()
          .split(",")
          .map(s => s.trim().toUpperCase())
          .filter(Boolean),
        appliesCategories: (r["ใช้กับหมวดหมู่"] || "")
          .toString()
          .split(",")
          .map(s => s.trim())
          .filter(Boolean),
        extra: r._rawData
      });
    });
  }

  // AI Profile
  const shProfile = getSheet(SHEETS.PROFILE);
  let profile = {
    agentName: "แอดมิน",
    pageName: "ร้านของเรา",
    productType: "สินค้า",
    persona: "สุภาพ เป็นกันเอง มีอีโมจิพอดี ไม่เวิ่น",
    gender: "neutral",
    callCustomer: "พี่",
    callSelf: "แอดมิน",
    unknownReply: "ขอให้แอดมินตัวจริงช่วยตอบนะครับ",
  };
  if (shProfile) {
    const rows = await shProfile.getRows();
    if (rows.length) {
      const r = rows[0];
      profile = {
        agentName: (r["ชื่อพนักงาน"] || profile.agentName).toString().trim(),
        pageName: (r["ชื่อเพจ"] || profile.pageName).toString().trim(),
        productType: (r["ประเภทสินค้า"] || profile.productType).toString().trim(),
        persona: (r["บุคลิก"] || profile.persona).toString().trim(),
        gender: (r["เพศ"] || profile.gender).toString().trim(),
        callCustomer: (r["วิธีเรียกลูกค้า"] || profile.callCustomer).toString().trim(),
        callSelf: (r["วิธีเรียกตัวเอง"] || profile.callSelf).toString().trim(),
        unknownReply: (r["ข้อความตอบเมื่อไม่รู้"] || profile.unknownReply).toString().trim(),
      };
    }
  }

  // FAQ (ถ้ามี)
  const shFaq = getSheet(SHEETS.FAQ);
  const faq = [];
  if (shFaq) {
    const rows = await shFaq.getRows();
    rows.forEach(r => {
      faq.push({
        q: (r["คำถาม"] || "").toString().trim(),
        a: (r["คำตอบ"] || "").toString().trim(),
        keys: (r["คำหลัก"] || "")
          .toString()
          .split(",")
          .map(s => s.trim())
          .filter(Boolean)
      });
    });
  }

  cache = {
    loadedAt: Date.now(),
    products,
    promotions,
    profile,
    faq
  };
  return cache;
}

// ---------------------- HELPERS ----------------------
function findProductByText(products, text) {
  const t = text.toLowerCase();
  // หาโดย code ก่อน
  let best = null;
  for (const p of products) {
    if (p.code && t.includes(p.code.toLowerCase())) return p;
  }
  // หาโดยชื่อ/alias
  for (const p of products) {
    if (p.name && t.includes(p.name.toLowerCase())) {
      best = p;
      break;
    }
    if (p.alias && p.alias.some(a => a && t.includes(a.toLowerCase()))) {
      best = p;
      break;
    }
  }
  return best;
}

function extractQuantity(text) {
  // หาเลขจำนวนง่าย ๆ เช่น "เอา 3", "3 กระปุก"
  const m = text.match(/(\d{1,3})/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return isNaN(n) ? null : n;
}

function extractOption(text, product) {
  if (!product || !product.options || product.options.length === 0) return null;
  const t = text.toLowerCase();
  const hit = product.options.find(opt => t.includes(opt.toLowerCase()));
  return hit || null;
}

function promoAppliesToProduct(promo, product) {
  if (!promo || !product) return false;
  // ใช้กับสินค้า
  if (promo.appliesProducts && promo.appliesProducts.length) {
    if (promo.appliesProducts.includes("ALL")) return true;
    if (promo.appliesProducts.includes(product.code.toUpperCase())) return true;
  }
  // ใช้กับหมวดหมู่
  if (promo.appliesCategories && promo.appliesCategories.length) {
    if (promo.appliesCategories.includes("ALL")) return true;
    if (promo.appliesCategories.includes(product.category)) return true;
  }
  return false;
}

function evaluatePromotions(promotions, product, qty, basePrice) {
  let total = basePrice * qty;
  let summary = [];
  let shippingDiscount = 0;
  let freeItems = 0;

  for (const promo of promotions) {
    if (!promoAppliesToProduct(promo, product)) continue;

    const cond = promo.condition || "";
    const calc = (promo.calcType || "").trim();

    // ตัวอย่างเงื่อนไขพื้นฐาน: "ซื้อครบ 5" / "ซื้อครบ 3"
    let threshold = null;
    const m = cond.match(/ซื้อครบ\s*(\d+)/);
    if (m) threshold = parseInt(m[1], 10);

    if (calc === "จำนวน" && threshold && qty >= threshold) {
      // ซื้อ N ฟรี 1
      freeItems += Math.floor(qty / threshold);
      summary.push(`${promo.id}: ${promo.description} (แถม ${freeItems})`);
    } else if (calc === "ค่าขนส่ง" && threshold && qty >= threshold) {
      // ซื้อ N ส่งฟรี
      shippingDiscount = "FREE"; // ให้ฝั่ง fulfillment ไปตีความ
      summary.push(`${promo.id}: ${promo.description} (ค่าส่งฟรี)`);
    } else if (calc === "ส่วนลด") {
      // ลด % เช่น "ลด 10% ทุกสินค้า"
      const perc = (cond.match(/(\d+)\s*%/) || [])[1];
      if (perc) {
        const discount = (total * parseInt(perc, 10)) / 100;
        total -= discount;
        summary.push(`${promo.id}: ${promo.description} (-${discount.toFixed(2)})`);
      } else if (cond === "ไม่มีเงื่อนไข") {
        // ถ้าไม่ได้ใส่ % แต่บอกไม่มีเงื่อนไข จะไม่ทำอะไรเพิ่มเติม
        summary.push(`${promo.id}: ${promo.description}`);
      }
    } else if (calc === "ส่วนลดคงที่") {
      // ลดคงที่ เช่น 500 บาท
      const fix = (cond.match(/(\d+)/) || [])[1];
      if (fix) {
        total -= parseInt(fix, 10);
        if (total < 0) total = 0;
        summary.push(`${promo.id}: ${promo.description} (-${parseInt(fix,10)})`);
      }
    }
  }

  const effectiveQty = qty + freeItems;
  return {
    total: Math.max(0, Math.round(total)),
    freeItems,
    shippingDiscount,
    summary
  };
}

function buildSystemPrompt(profile, products, promotions, faq) {
  const persona = `
คุณคือ "${profile.agentName}" จาก "${profile.pageName}" บุคลิก: ${profile.persona}.
เรียกลูกค้าว่า "${profile.callCustomer}" เรียกตัวเองว่า "${profile.callSelf}".
ห้ามเดาข้อมูล ถ้าไม่พบในฐานข้อมูลให้ตอบสั้น ๆ: "${profile.unknownReply}" และส่งแจ้งเตือนแอดมิน.
ตอบให้กระชับ ชัดเจน มีอีโมจินิด ๆ อ่านง่ายเป็นข้อ ๆ เมื่อเหมาะสม
`;

  // ให้ context ย่อ ๆ เพื่อช่วยให้ตอบไม่แข็ง
  const productHints = products.slice(0, 30).map(p => `- ${p.name} (${p.category}) ราคา ${p.price} บาท${p.options?.length ? ` | ตัวเลือก: ${p.options.join(", ")}` : ""}`).join("\n");
  const promoHints = promotions.slice(0, 30).map(pr => `- ${pr.id}: ${pr.description} [${pr.calcType}] ${pr.condition ? `เงื่อนไข: ${pr.condition}` : ""}`).join("\n");
  const faqHints = (faq || []).slice(0, 30).map(f => `Q: ${f.q}\nA: ${f.a}`).join("\n");

  return `${persona}

ข้อมูลสินค้า (ย่อ):
${productHints}

โปรโมชัน (ย่อ):
${promoHints}

FAQ (ย่อ):
${faqHints}

หลักการตอบ:
- ถ้าลูกค้าพูดถึงสินค้าแต่ไม่บอก "ตัวเลือก" (เช่น รสชาติ/รุ่น/ขนาด) ให้ถามต่อด้วยตัวเลือกที่มี
- ถ้าลูกค้าพูดถึง "ราคา" แบบกว้าง ให้ถามย้ำว่าสินค้าไหน
- ถ้าลูกค้าสั่งซื้อ ให้สรุปสั้น ๆ: สินค้า, ตัวเลือก, จำนวน, ราคารวมคร่าว ๆ (ยังไม่รวมค่าส่งถ้าไม่แน่ชัด)
- โทนมนุษย์ เป็นกันเอง ไม่บังคับขาย
- ใช้เฉพาะข้อมูลที่ให้มาเท่านั้น
`;
}

// ---------------------- LINE APP ----------------------
const app = express();
const client = new Client(lineConfig);

// health check สำหรับ verify
app.get("/health", (_req, res) => {
  res.status(200).send("OK");
});

// Webhook: ตอบ 200 ทันที แล้วค่อยประมวลผล
app.post("/webhook", middleware(lineConfig), async (req, res) => {
  res.status(200).end();
  try {
    const events = req.body.events || [];
    for (const ev of events) {
      handleEvent(ev).catch(err => {
        console.error("handleEvent error:", err);
        // แจ้งแอดมิน
        if (LINE_GROUP_ID) {
          client.pushMessage(LINE_GROUP_ID, { type: "text", text: `❌ Webhook Error: ${err.message}` }).catch(()=>{});
        }
      });
    }
  } catch (e) {
    console.error("Webhook outer error:", e);
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const { products, promotions, profile, faq } = await loadSheets();
  const userText = (event.message.text || "").trim();

  // พยายามเข้าใจ intent เบื้องต้น
  const product = findProductByText(products, userText);
  const qty = extractQuantity(userText) || 1;
  const opt = extractOption(userText, product);

  // ถ้าจับสินค้าพบ แต่ยังไม่ครบ option -> ถามต่อด้วย Quick Reply
  if (product && product.options && product.options.length && !opt) {
    const quickItems = product.options.slice(0, 12).map(o => ({
      type: "action",
      action: { type: "message", label: o, text: `${product.name} ${o} จำนวน ${qty}` }
    }));
    const reply = {
      type: "text",
      text: `รับทราบค่ะ ${profile.callCustomer} เลือกตัวเลือกสำหรับ “${product.name}” ก่อนนะคะ เช่น: ${product.options.join(", ")}`,
      quickReply: { items: quickItems }
    };
    return client.replyMessage(event.replyToken, reply);
  }

  // ถ้าจับสินค้าได้ครบ -> สรุปราคา+โปร
  if (product) {
    const { total, freeItems, shippingDiscount, summary } =
      evaluatePromotions(promotions, product, qty, product.price);

    // ให้ GPT ช่วยแต่งสรุปให้นุ่มนวล + มนุษย์
    const sys = buildSystemPrompt(profile, products, promotions, faq);
    const prompt = `
ลูกค้าพูดว่า: "${userText}"
ตีความว่า: สินค้า=${product.name}, ตัวเลือก=${opt || "-"}, จำนวน=${qty}, โปรที่เข้าเงื่อนไข=${summary.join(" | ") || "-"}, ของแถม=${freeItems || 0}, ค่าส่งส่วนลด=${shippingDiscount || "-"}, ราคารวมโดยประมาณ=${total} บาท
ช่วยตอบกลับแบบเป็นกันเอง กระชับ มีอีโมจิเล็กน้อย และชวนปิดการขายสุภาพ ๆ
`;

    let aiText = "";
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.6,
        max_tokens: 240,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: prompt }
        ],
      });
      aiText = completion.choices?.[0]?.message?.content?.trim() || "";
    } catch (err) {
      // หาก OpenAI error → แจ้งแอดมิน แล้วตอบ fallback
      console.error("OpenAI error:", err.message);
      if (LINE_GROUP_ID) {
        await client.pushMessage(LINE_GROUP_ID, {
          type: "text",
          text: `❌ OpenAI Error: ${err.message}\nUser: ${userText}`
        }).catch(()=>{});
      }
      aiText = `${profile.unknownReply}`;
    }

    // ตอบลูกค้า
    await client.replyMessage(event.replyToken, { type: "text", text: aiText });

    // เก็บ state ชั่วคราวไว้ (ถ้าอยากต่อยอดทำ confirm การชำระ/ปลายทาง)
    // *** จุดนี้สามารถต่อยอดบันทึก Orders เมื่อลูกค้ายืนยันรูปแบบชำระเงิน ***
    return;
  }

  // ไม่ระบุสินค้า → ให้ GPT ตอบนำทางแบบนุ่มนวล (ถามว่าสนใจสินค้าตัวไหน)
  // ถามราคาแบบกว้าง → ขอชื่อสินค้า
  const askForProduct = /ราคา|เท่าไหร่|กี่บาท/.test(userText);

  const sys = buildSystemPrompt(profile, products, promotions, faq);
  const prompt = askForProduct
    ? `ลูกค้าถามราคา แต่ยังไม่บอกชื่อสินค้า ขอสรุปแบบสั้นๆ ชวนให้ระบุสินค้า พร้อมตัวอย่าง 1-2 ชื่อ`
    : `ลูกค้าถามทั่วไป: "${userText}" ช่วยตอบให้เป็นกันเอง ใช้ข้อมูลในชีท ถ้าไม่เจอให้ใช้ unknownReply และแจ้งแอดมิน`;

  let aiText = "";
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.6,
      max_tokens: 180,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: prompt }
      ],
    });
    aiText = completion.choices?.[0]?.message?.content?.trim() || "";
  } catch (err) {
    console.error("OpenAI error:", err.message);
    if (LINE_GROUP_ID) {
      await client.pushMessage(LINE_GROUP_ID, {
        type: "text",
        text: `❌ OpenAI Error: ${err.message}\nUser: ${userText}`
      }).catch(()=>{});
    }
    aiText = `${profile.unknownReply}`;
  }

  // ถ้า GPT ยังว่าง → ส่งให้แอดมิน
  if (!aiText || aiText === profile.unknownReply) {
    if (LINE_GROUP_ID) {
      await client.pushMessage(LINE_GROUP_ID, {
        type: "text",
        text: `🆘 ต้องการแอดมินช่วยตอบ\nข้อความลูกค้า: "${userText}"`
      }).catch(()=>{});
    }
  }

  return client.replyMessage(event.replyToken, { type: "text", text: aiText });
}

// ---------------------- START ----------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  try {
    await doc.loadInfo(); // test connect sheets
    console.log(`🚀 Server running on port ${PORT}`);
  } catch (e) {
    console.error("❌ Google Sheet Error:", e.message);
  }
});
