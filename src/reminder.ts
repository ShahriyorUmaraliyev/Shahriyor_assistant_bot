import { Client } from "@upstash/qstash";
import { saveReminder, deleteReminder, getReminders } from "./redis";
import type { StoredReminder } from "./redis";

const APP_URL = process.env.APP_URL?.replace(/\/$/, "") ?? null;

// Lazy singleton — har chaqiruvda yangi Client yaratmaslik
let _qstash: Client | null = null;
function getQStash(): Client {
  if (!_qstash) {
    _qstash = new Client({
      token: process.env.QSTASH_TOKEN!,
      baseUrl: process.env.QSTASH_URL || "https://qstash-us-east-1.upstash.io",
    });
  }
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

  const result = await Promise.race<{ messageId: string }>([
    getQStash().publishJSON({
      url: `${APP_URL}/api/remind`,
      body: { userId, text },
      notBefore: safeNotBefore,
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("QSTASH_TIMEOUT: 10s")), 10_000)
    ),
  ]);

  const id = result.messageId;

  // Redis'ga saqlaymiz — keyinchalik ro'yxat ko'rsatish va bekor qilish uchun
  await saveReminder(userId, {
    id,
    text,
    timeIso: new Date(safeNotBefore * 1000).toISOString(),
    notBefore: safeNotBefore,
  }).catch((err) => console.warn("[reminder] Redis saqlash xato:", err));

  return id;
}

export async function cancelReminder(userId: number, id: string): Promise<boolean> {
  try {
    await getQStash().messages.delete(id);
  } catch (err) {
    // Allaqachon yuborilgan yoki noto'g'ri ID — Redis'dan baribir o'chiramiz
    console.warn("[cancelReminder] QStash cancel xato (ehtimol allaqachon yuborilgan):", err);
  }
  return deleteReminder(userId, id);
}

export { getReminders };
export type { StoredReminder };
