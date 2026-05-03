import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { TelegramUpdate } from "./types";
import { handleMessage } from "./bot";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return;
  }

  // Webhook secret tekshiruvi
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (
    process.env.TELEGRAM_WEBHOOK_SECRET &&
    secret !== process.env.TELEGRAM_WEBHOOK_SECRET
  ) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  const update = req.body as TelegramUpdate;

  console.log("DBG body_type:", typeof req.body, "has_message:", !!update?.message, "from_id:", update?.message?.from?.id);

  if (update?.message) {
    try {
      await handleMessage(update.message);
    } catch (err) {
      console.error("Critical webhook error:", err);
    }
  }

  res.statusCode = 200;
  res.end("OK");
}
