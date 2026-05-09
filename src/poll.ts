/**
 * Local dev entry point — long polling rejimi.
 * Webhook, ngrok, APP_URL, QStash kerak emas.
 *
 * Ishlatish:
 *   npm run dev:poll
 *
 * Minimal .env:
 *   TELEGRAM_BOT_TOKEN, GEMINI_API_KEY,
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
 *   ALLOWED_USER_IDS
 */

import "dotenv/config";
import { handleMessage, handleCallbackQuery, setupBotCommands } from "./bot";
import type { TelegramUpdate } from "./types";

// GramJS _updateLoop TIMEOUT spamini to'liq o'chirish
// (console.error, unhandledRejection, uncaughtException — hammasi shu yerda filtrlanadi)
const _ce = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const s = args.map(String).join(" ");
  if (
    (s.includes("TIMEOUT") || s.includes("ECONNRESET") || s.includes("socket hang up") || s.includes("connection closed")) &&
    (s.includes("updates.js") || s.includes("node_modules") || s.includes("telegram"))
  ) return;
  _ce(...args);
};

// ─── Env validation (faqat polling uchun keraklilari) ────────────────────────

const POLL_REQUIRED = [
  "TELEGRAM_BOT_TOKEN",
  "GEMINI_API_KEY",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
];
const missing = POLL_REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`❌ .env da yo'q: ${missing.join(", ")}`);
  process.exit(1);
}
if (!process.env.ALLOWED_USER_IDS) {
  console.warn("⚠️  ALLOWED_USER_IDS yo'q — hech kim botdan foydalana olmaydi!");
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

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── Webhookni o'chirish — polling bilan bir vaqtda webhook bo'lmasligi kerak ─

async function deleteWebhook(): Promise<void> {
  const res = await fetch(`${TG}/deleteWebhook?drop_pending_updates=true`);
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (data.ok) {
    console.log("✅ Webhook o'chirildi — polling boshlaydi");
  } else {
    console.warn("⚠️  Webhook o'chirishda muammo:", data.description);
  }
}

// ─── Long polling loop ────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  let offset = 0;
  let errorCount = 0;

  console.log("🤖 Bot ishlamoqda (polling rejimi)...");
  console.log("   Ctrl+C bilan to'xtatish mumkin\n");

  while (true) {
    try {
      const res = await fetch(
        `${TG}/getUpdates?offset=${offset}&timeout=25&allowed_updates=["message","callback_query"]`,
        { signal: AbortSignal.timeout(35_000) }
      );

      if (!res.ok) {
        console.error(`[getUpdates] HTTP ${res.status}: ${await res.text()}`);
        await sleep(5_000);
        continue;
      }

      const data = (await res.json()) as { ok: boolean; result: TelegramUpdate[] };

      if (!data.ok) {
        console.error("[getUpdates] Telegram xatosi:", data);
        await sleep(5_000);
        continue;
      }

      errorCount = 0;

      for (const update of data.result) {
        offset = update.update_id + 1;
        if (update.message) {
          const msg = update.message;
          const who = msg.from?.username ?? msg.from?.first_name ?? msg.from?.id;
          const preview = msg.text?.slice(0, 60) ?? (msg.voice ? "[ovozli xabar]" : "[boshqa]");
          console.log(`📩 ${who}: ${preview}`);

          handleMessage(msg).catch((err) =>
            console.error("❌ handleMessage xatosi:", err)
          );
        }
        if (update.callback_query) {
          const cb = update.callback_query;
          const who = cb.from?.username ?? cb.from?.first_name ?? cb.from?.id;
          console.log(`🔘 ${who}: [callback] ${cb.data}`);

          handleCallbackQuery(cb).catch((err) =>
            console.error("❌ handleCallbackQuery xatosi:", err)
          );
        }
      }
    } catch (err) {
      errorCount++;
      const wait = Math.min(errorCount * 2_000, 15_000);
      console.error(`[polling] Xatolik (${errorCount}x), ${wait / 1000}s kutilmoqda:`, err);
      await sleep(wait);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Start ────────────────────────────────────────────────────────────────────

// gramjs _updateLoop fon da TIMEOUT tashlaydi disconnect dan keyin — buni bosamiz
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

deleteWebhook()
  .then(() => setupBotCommands())
  .then(poll)
  .catch((err) => {
    console.error("❌ Start xatosi:", err);
    process.exit(1);
  });
