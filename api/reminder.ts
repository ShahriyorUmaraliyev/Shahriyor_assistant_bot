import type { VercelRequest, VercelResponse } from "@vercel/node";

// Eski Redis polling endpoint — QStash ga ko'childi, /api/remind ishlatiladi
export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.status(410).end("Gone. Use /api/remind (QStash)");
}
