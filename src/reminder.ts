import { Client } from "@upstash/qstash";

const APP_URL = process.env.APP_URL?.replace(/\/$/, "") ?? null;

// Lazy singleton — har chaqiruvda yangi Client yaratmaslik
let _qstash: Client | null = null;
function getQStash(): Client {
  if (!_qstash) _qstash = new Client({ token: process.env.QSTASH_TOKEN! });
  return _qstash;
}

export async function scheduleReminder(
  userId: number,
  text: string,
  time: string
): Promise<string> {
  if (!APP_URL) throw new Error("APP_URL env o'zgaruvchisi sozlanmagan");

  const notBefore = Math.floor(new Date(time).getTime() / 1000);
  if (isNaN(notBefore)) throw new Error(`Noto'g'ri vaqt formati: ${time}`);

  // O'tgan vaqtni oldini olish — kamida 60 soniya kelajakda bo'lsin
  const minTime = Math.floor(Date.now() / 1000) + 60;
  const safeNotBefore = Math.max(notBefore, minTime);

  const result = await getQStash().publishJSON({
    url: `${APP_URL}/api/remind`,
    body: { userId, text },
    notBefore: safeNotBefore,
  });

  return result.messageId;
}
