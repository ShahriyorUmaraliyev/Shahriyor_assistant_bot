import { Client } from "@upstash/qstash";

const APP_URL =
  process.env.APP_URL?.replace(/\/$/, "") ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);

function getQStash(): Client {
  return new Client({ token: process.env.QSTASH_TOKEN! });
}

/**
 * QStash orqali aniq vaqtda eslatma yuborish.
 * QStash belgilangan vaqtda /api/remind ga POST qiladi.
 */
export async function scheduleReminder(
  userId: number,
  text: string,
  time: string
): Promise<string> {
  if (!APP_URL) throw new Error("APP_URL yoki VERCEL_URL sozlanmagan");

  const notBefore = Math.floor(new Date(time).getTime() / 1000);
  if (isNaN(notBefore)) throw new Error(`Noto'g'ri vaqt formati: ${time}`);

  const result = await getQStash().publishJSON({
    url: `${APP_URL}/api/remind`,
    body: { userId, text },
    notBefore,
  });

  return result.messageId;
}
