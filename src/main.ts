import "dotenv/config";
import app from "./app";
import { setupBotCommands } from "./bot";

// ─── Startup validation — kerakli tokenlar yo'q bo'lsa darhol to'xtat ────────

const REQUIRED_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "GEMINI_API_KEY",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "APP_URL",
  "QSTASH_TOKEN",
  "QSTASH_CURRENT_SIGNING_KEY",
  "QSTASH_NEXT_SIGNING_KEY",
];

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`❌ Majburiy env o'zgaruvchilar yo'q: ${missing.join(", ")}`);
  process.exit(1);
}

if (!process.env.ALLOWED_USER_IDS) {
  console.warn("⚠️  ALLOWED_USER_IDS sozlanmagan — hech kim botdan foydalana olmaydi!");
}
if (!process.env.TELEGRAM_WEBHOOK_SECRET) {
  console.warn("⚠️  TELEGRAM_WEBHOOK_SECRET sozlanmagan — /webhook endpoint himoyasiz!");
}

// ─── Server ───────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 8080;

app.listen(PORT, () => {
  console.log(`✅ Server port ${PORT} da ishlamoqda`);
  setupBotCommands().then(() => console.log("✅ Bot komandalar ro'yxatga olindi"));
});
