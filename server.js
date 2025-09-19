async function testSheet() {
  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: Buffer.from(process.env.GOOGLE_PRIVATE_KEY_BASE64, "base64").toString("utf-8"),
  });
  await doc.loadInfo();
  console.log("✅ Google Sheet title:", doc.title);
}
testSheet();
