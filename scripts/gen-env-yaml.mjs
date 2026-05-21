import { writeFileSync } from "fs";

const keys = [
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "ALLOWED_USER_IDS",
  "GEMINI_API_KEY", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "QSTASH_TOKEN", "QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY",
  "QSTASH_URL",
  "OPENWEATHERMAP_API_KEY", "GOOGLE_TRANSLATE_API_KEY", "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_SHEET_ID", "GOOGLE_CALENDAR_ID", "TELEGRAM_API_ID", "TELEGRAM_API_HASH",
  "TELEGRAM_SESSION",
];

const lines = keys.map(k => `${k}: ${JSON.stringify(process.env[k] ?? "")}`);
writeFileSync("env.yaml", lines.join("\n") + "\n");
console.log("✅ env.yaml yaratildi");
