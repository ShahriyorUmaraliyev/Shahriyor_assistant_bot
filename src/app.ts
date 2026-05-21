import express, { type Request, type Response } from "express";
import { Receiver } from "@upstash/qstash";
import { handleMessage, handleCallbackQuery, isAllowed, balanceMarkdown, sendMessage } from "./bot";
import { clearDeliveredReminder } from "./redis";
import type { TelegramUpdate, ReminderPayload } from "./types";
import { generateDailyAINews } from "./gemini";
import { getMemory } from "./memory";

const app = express();

// Raw body middleware — QStash signature verification requires raw string
app.use((req: Request, _res: Response, next) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    (req as Request & { rawBody: string }).rawBody = raw;
    try {
      req.body = raw ? JSON.parse(raw) : {};
    } catch {
      req.body = {};
    }
    next();
  });
});

// ─── Telegram helpers ─────────────────────────────────────────────────────────

const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const TG_TIMEOUT_MS = 8_000;

async function tgPost(path: string, body: unknown): Promise<globalThis.Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TG_TIMEOUT_MS);
  try {
    return await fetch(`${TG}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("TELEGRAM_TIMEOUT");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function sendReminderMessage(chatId: number, text: string): Promise<void> {
  const balanced = balanceMarkdown(text);
  let res = await tgPost("sendMessage", { chat_id: chatId, text: balanced, parse_mode: "Markdown" });
  if (!res.ok) {
    res = await tgPost("sendMessage", { chat_id: chatId, text });
    if (!res.ok) throw new Error(`Telegram xatosi: ${await res.text()}`);
  }
}

// ─── /webhook — Telegram messages ────────────────────────────────────────────

app.post("/webhook", async (req: Request, res: Response) => {
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  const isProd = process.env.NODE_ENV === "production";

  if (isProd && !process.env.TELEGRAM_WEBHOOK_SECRET) {
    res.status(500).end("Webhook secret not configured in production");
    return;
  }

  if (
    process.env.TELEGRAM_WEBHOOK_SECRET &&
    secret !== process.env.TELEGRAM_WEBHOOK_SECRET
  ) {
    res.status(403).end("Forbidden");
    return;
  }

  const update = req.body as TelegramUpdate;
  
  try {
    if (update?.message) {
      await handleMessage(update.message);
    }
    if (update?.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }
  } catch (err) {
    console.error("Webhook processing error:", err);
  } finally {
    // Respond AFTER work is done so Cloud Run doesn't freeze the CPU
    if (!res.headersSent) {
      res.status(200).end("OK");
    }
  }
});

// ─── /api/remind — QStash reminder delivery ──────────────────────────────────

app.post("/api/remind", async (req: Request, res: Response) => {
  const rawBody = (req as Request & { rawBody: string }).rawBody;

  // Signing keys startup da tekshirilgan — har doim majburiy
  const receiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY!,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY!,
  });
  try {
    await receiver.verify({
      signature: req.headers["upstash-signature"] as string,
      body: rawBody,
    });
  } catch {
    res.status(401).end("Unauthorized");
    return;
  }

  const { userId, text } = req.body as ReminderPayload;
  if (!userId || !text) {
    res.status(400).end("Bad Request");
    return;
  }

  if (!isAllowed(userId)) {
    console.warn(`[remind] Unauthorized reminder delivery request blocked for user: ${userId}`);
    res.status(403).end("Forbidden");
    return;
  }

  // QStash har doim upstash-message-id headerini yuboradi — Redis'dan o'chirish uchun
  const qstashMsgId = req.headers["upstash-message-id"] as string | undefined;

  try {
    const safeText = text.replace(/[_*`[]/g, "\\$&");
    await sendReminderMessage(userId, `⏰ *Eslatib o'taman:*\n${safeText}`);
    if (qstashMsgId) {
      clearDeliveredReminder(userId, qstashMsgId).catch((err) =>
        console.warn("[remind] Redis o'chirish xato:", err)
      );
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Reminder xatosi:", err);
    res.status(500).json({ ok: false });
  }
});

// ─── /api/cron/daily-ai-news — QStash daily cron trigger ──────────────────────

app.post("/api/cron/daily-ai-news", async (req: Request, res: Response) => {
  const rawBody = (req as Request & { rawBody: string }).rawBody;

  // QStash signing keys tekshiruvi
  const receiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY!,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY!,
  });
  try {
    await receiver.verify({
      signature: req.headers["upstash-signature"] as string,
      body: rawBody,
    });
  } catch {
    res.status(401).end("Unauthorized");
    return;
  }

  const { userId } = req.body as { userId?: number };
  if (!userId) {
    res.status(400).end("Bad Request: userId is required");
    return;
  }

  if (!isAllowed(userId)) {
    console.warn(`[cron:daily-news] Unauthorized access blocked for user: ${userId}`);
    res.status(403).end("Forbidden");
    return;
  }

  console.log(`[cron:daily-news] Triggered AI news digest generation for user: ${userId}`);

  try {
    const memory = await getMemory(userId);
    const digest = await generateDailyAINews(memory);

    await sendMessage(userId, digest);
    console.log(`[cron:daily-news] Successfully delivered daily AI news to user: ${userId}`);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[cron:daily-news] Xatolik yuz berdi:", err);
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

export default app;

