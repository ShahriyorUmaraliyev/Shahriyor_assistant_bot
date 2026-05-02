import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { TelegramUpdate } from "./types";
import { handleMessage } from "./bot";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).end("Method Not Allowed");
    return;
  }

  // Webhook secret tekshiruvi
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (
    process.env.TELEGRAM_WEBHOOK_SECRET &&
    secret !== process.env.TELEGRAM_WEBHOOK_SECRET
  ) {
    res.status(403).end("Forbidden");
    return;
  }

  const update = req.body as TelegramUpdate;

  if (update?.message) {
    try {
      await handleMessage(update.message);
    } catch (err) {
      console.error("Critical webhook error:", err);
    }
  }

  res.status(200).end("OK");
}
