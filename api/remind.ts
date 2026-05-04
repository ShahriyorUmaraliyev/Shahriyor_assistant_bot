import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Receiver } from "@upstash/qstash";
import type { ReminderPayload } from "../src/types";

const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function sendMessage(chatId: number, text: string): Promise<void> {
  let res = await fetch(`${TG}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  if (!res.ok) {
    res = await fetch(`${TG}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) throw new Error(`Telegram xatosi: ${await res.text()}`);
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).end("Method Not Allowed");
    return;
  }

  // @vercel/node v5: req.body undefined bo'lishi mumkin — raw stream o'qish
  let rawBody: string;
  if (req.body !== undefined && req.body !== null) {
    rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  } else {
    rawBody = await new Promise<string>((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk.toString()));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }

  // QStash signature tekshiruvi — raw body bilan (parse qilmasdan oldin)
  const signingKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (signingKey && nextKey) {
    const receiver = new Receiver({ currentSigningKey: signingKey, nextSigningKey: nextKey });
    const signature = req.headers["upstash-signature"] as string;
    try {
      await receiver.verify({ signature, body: rawBody });
    } catch {
      res.status(401).end("Unauthorized");
      return;
    }
  } else {
    console.warn("⚠️ QSTASH_CURRENT_SIGNING_KEY yoki QSTASH_NEXT_SIGNING_KEY sozlanmagan — /api/remind himoyasiz!");
  }

  let payload: ReminderPayload;
  try {
    payload = JSON.parse(rawBody) as ReminderPayload;
  } catch {
    res.status(400).end("Bad Request: invalid JSON");
    return;
  }

  const { userId, text } = payload;

  if (!userId || !text) {
    res.status(400).end("Bad Request");
    return;
  }

  try {
    await sendMessage(userId, `⏰ *Eslatma:*\n${text}`);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Reminder yuborish xatosi:", err);
    res.status(500).json({ ok: false });
  }
}
