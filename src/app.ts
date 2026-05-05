import express, { type Request, type Response } from "express";
import { Receiver } from "@upstash/qstash";
import { handleMessage } from "./bot";
import type { TelegramUpdate, ReminderPayload } from "./types";

const app = express();

// Raw body middleware — QStash signature verification requires raw string
app.use((req: Request, _res: Response, next) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk.toString()));
  req.on("end", () => {
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

async function tgPost(path: string, body: unknown): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TG_TIMEOUT_MS);
  try {
    return await fetch(`${TG}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }) as unknown as Response;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("TELEGRAM_TIMEOUT");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function sendReminderMessage(chatId: number, text: string): Promise<void> {
  let res = await tgPost("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" }) as unknown as globalThis.Response;
  if (!res.ok) {
    res = await tgPost("sendMessage", { chat_id: chatId, text }) as unknown as globalThis.Response;
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
});

// ─── /api/remind — QStash reminder delivery ──────────────────────────────────

app.post("/api/remind", async (req: Request, res: Response) => {
  const rawBody = (req as Request & { rawBody: string }).rawBody;
  const signingKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (signingKey && nextKey) {
    const receiver = new Receiver({
      currentSigningKey: signingKey,
      nextSigningKey: nextKey,
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
  } else {
    console.warn("⚠️ QStash signing keys sozlanmagan — /api/remind himoyasiz!");
  }

  const { userId, text } = req.body as ReminderPayload;
  if (!userId || !text) {
    res.status(400).end("Bad Request");
    return;
  }

  try {
    await sendReminderMessage(userId, `⏰ *Eslatma:*\n${text}`);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Reminder xatosi:", err);
    res.status(500).json({ ok: false });
  }
});

export default app;
