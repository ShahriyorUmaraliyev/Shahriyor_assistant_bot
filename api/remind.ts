// QStash remind endpoint — hozir ishlatilmayapti (reminder.ts simplified)
import type { VercelRequest, VercelResponse } from "@vercel/node";
export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.status(410).end("Gone");
}
