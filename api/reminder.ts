import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDueReminders, removeReminder } from "../src/redis";

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
    if (!res.ok) {
      throw new Error(`Telegram xatosi: ${await res.text()}`);
    }
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const due = await getDueReminders();

  if (!due.length) {
    res.status(200).json({ sent: 0 });
    return;
  }

  let sent = 0;
  for (const reminder of due) {
    try {
      await sendMessage(reminder.userId, `⏰ *Eslatma:*\n${reminder.text}`);
      await removeReminder(reminder.id);
      sent++;
    } catch (err) {
      console.error(`Reminder ${reminder.id} xatosi:`, err);
    }
  }

  res.status(200).json({ sent, total: due.length });
}
