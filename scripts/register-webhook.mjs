/**
 * GitHub Actions deploy workflow tomonidan avtomatik chaqiriladi.
 * Telegram webhook ni Cloud Run URL ga ro'yxatdan o'tkazadi.
 */

// Clean any Unicode BOM (\uFEFF) from process.env to prevent fetch errors
for (const key in process.env) {
  if (typeof process.env[key] === "string") {
    process.env[key] = process.env[key].replace(/^\uFEFF/, "").trim();
  }
}

const token  = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

// APP_URL — Cloud Run service URL (deploy workflow da avtomatik to'ldiriladi)
const base = process.env.APP_URL?.replace(/\/$/, "") ?? null;

if (!token || !base) {
  console.warn(
    "⚠️  TELEGRAM_BOT_TOKEN yoki APP_URL topilmadi — webhook ro'yxatga olinmadi."
  );
  process.exit(0); // exit 0: deploy to'xtatilmaydi
}

const webhookUrl = `${base}/webhook`;

// Debug: token formatini tekshirish (faqat boshlanishi ko'rinadi)
console.log(`ℹ️  Token prefix: ${token.slice(0, 10)}... (uzunlik: ${token.length})`);
console.log(`ℹ️  Webhook URL: ${webhookUrl}`);

const res = await fetch(
  `https://api.telegram.org/bot${token}/setWebhook`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    }),
  }
);

const data = await res.json();

if (data.ok) {
  console.log(`✅ Webhook ro'yxatga olindi: ${webhookUrl}`);
} else {
  console.error("❌ Webhook xatosi:", JSON.stringify(data));
  process.exit(1);
}
