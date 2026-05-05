/**
 * GitHub Actions deploy workflow tomonidan avtomatik chaqiriladi.
 * Telegram webhook ni Cloud Run URL ga ro'yxatdan o'tkazadi.
 */

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

const res = await fetch(
  `https://api.telegram.org/bot${token}/setWebhook`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: ["message"],
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
