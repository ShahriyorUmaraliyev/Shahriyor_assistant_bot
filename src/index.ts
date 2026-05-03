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

  let update: TelegramUpdate;
  if (req.body !== undefined && req.body !== null) {
    update = req.body as TelegramUpdate;
  } else {
    const rawBody = await new Promise<string>((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk.toString()));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
    try {
      update = JSON.parse(rawBody) as TelegramUpdate;
    } catch {
      update = {} as TelegramUpdate;
    }
  }

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
