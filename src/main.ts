import "dotenv/config";
import app from "./app";
import { setupBotCommands } from "./bot";

// GramJS _updateLoop TIMEOUT spamini bosish (webhook mode)
function isGramjsNoise(reason: unknown): boolean {
  const stack = (reason as Error)?.stack ?? String(reason);
  const msg   = (reason as Error)?.message ?? String(reason);
  return (
    stack.includes("updates.js") ||
    stack.includes("node_modules/telegram") ||
    msg === "TIMEOUT" ||
    msg.includes("TIMEOUT") ||
    msg.includes("ECONNRESET") ||
    msg.includes("socket hang up") ||
    msg.includes("connection closed")
  );
}
process.on("unhandledRejection", (reason) => {
  if (isGramjsNoise(reason)) return;
  console.error("❌ Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  if (isGramjsNoise(err)) return;
  console.error("❌ Uncaught exception:", err);
});

// ─── Startup validation — kerakli tokenlar yo'q bo'lsa darhol to'xtat ────────

const REQUIRED_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "GEMINI_API_KEY",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
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
if (!process.env.GOOGLE_TRANSLATE_API_KEY) {
  console.warn("ℹ️  GOOGLE_TRANSLATE_API_KEY yo'q — /translate komandasi ishlamaydi!");
}
if (!process.env.OPENWEATHERMAP_API_KEY) {
  console.warn("ℹ️  OPENWEATHERMAP_API_KEY yo'q — ob-havo tool ishlamaydi!");
}
if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  console.warn("ℹ️  GOOGLE_SERVICE_ACCOUNT_JSON yo'q — Calendar/Sheets toollar ishlamaydi!");
}

// ─── Server ───────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 8080;

app.listen(PORT, () => {
  console.log(`✅ Server port ${PORT} da ishlamoqda`);
  setupBotCommands().then(() => console.log("✅ Bot komandalar ro'yxatga olindi"));
});
