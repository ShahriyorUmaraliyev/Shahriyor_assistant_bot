import express, { type Request, type Response } from "express";
import { Receiver } from "@upstash/qstash";
import { handleMessage, handleCallbackQuery } from "./bot";
import { clearDeliveredReminder } from "./redis";
import type { TelegramUpdate, ReminderPayload } from "./types";

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
  let res = await tgPost("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" });
  if (!res.ok) {
    res = await tgPost("sendMessage", { chat_id: chatId, text });
    if (!res.ok) throw new Error(`Telegram xatosi: ${await res.text()}`);
  }
}

// ─── /webhook — Telegram messages ────────────────────────────────────────────

app.post("/webhook", (req: Request, res: Response) => {
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (
    process.env.TELEGRAM_WEBHOOK_SECRET &&
    secret !== process.env.TELEGRAM_WEBHOOK_SECRET
  ) {
    res.status(403).end("Forbidden");
    return;
  }

  // Respond immediately — Cloud Run keeps running until async work completes
  res.status(200).end("OK");

  const update = req.body as TelegramUpdate;
  if (update?.message) {
    handleMessage(update.message).catch((err) =>
      console.error("handleMessage xatosi:", err)
    );
  }
  if (update?.callback_query) {
    handleCallbackQuery(update.callback_query).catch((err) =>
      console.error("handleCallbackQuery xatosi:", err)
    );
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

  // QStash har doim upstash-message-id headerini yuboradi — Redis'dan o'chirish uchun
  const qstashMsgId = req.headers["upstash-message-id"] as string | undefined;

  try {
    await sendReminderMessage(userId, `⏰ *Eslatma:*\n${text}`);
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

export default app;
