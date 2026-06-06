import { Redis } from "@upstash/redis";
import type { ChatMessage, UserMode } from "./types";

// ─── Reminder Storage Types ───────────────────────────────────────────────────

export interface StoredReminder {
  id: string;        // QStash message ID
  text: string;
  timeIso: string;   // ISO 8601 (+05:00)
  notBefore: number; // unix timestamp (soniya)
}

// Lazy initialization — instance faqat birinchi chaqiruvda yaratiladi
let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return _redis;
}

// ─── Token usage tracking (AI xarajat hisoboti) ──────────────────────────────
// Shaxsiy bot — global hisoblagich (userId kerak emas). Kunlik va oylik yig'indi.

export interface TokenUsage {
  prompt: number;
  output: number;
  thinking: number;
  total: number;
  calls: number;
}

// Toshkent vaqti bo'yicha sana (YYYY-MM-DD) — en-CA formati shu ko'rinishni beradi
function tashkentDay(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
}
function tashkentMonth(): string {
  return tashkentDay().slice(0, 7); // YYYY-MM
}

const tokenDayKey = () => `tokens:day:${tashkentDay()}`;
const tokenMonthKey = () => `tokens:month:${tashkentMonth()}`;

export async function recordTokenUsage(u: Omit<TokenUsage, "calls">): Promise<void> {
  const r = getRedis();
  const dayK = tokenDayKey();
  const monthK = tokenMonthKey();
  const p = r.pipeline();
  for (const key of [dayK, monthK]) {
    p.hincrby(key, "prompt", u.prompt);
    p.hincrby(key, "output", u.output);
    p.hincrby(key, "thinking", u.thinking);
    p.hincrby(key, "total", u.total);
    p.hincrby(key, "calls", 1);
  }
  p.expire(dayK, 60 * 24 * 60 * 60);    // 60 kun
  p.expire(monthK, 400 * 24 * 60 * 60); // ~13 oy
  await p.exec();
}

export async function getTokenUsage(period: "day" | "month"): Promise<TokenUsage> {
  const key = period === "day" ? tokenDayKey() : tokenMonthKey();
  const data = (await getRedis().hgetall<Record<string, string | number>>(key)) ?? {};
  const num = (v: string | number | undefined) => Number(v ?? 0) || 0;
  return {
    prompt: num(data.prompt),
    output: num(data.output),
    thinking: num(data.thinking),
    total: num(data.total),
    calls: num(data.calls),
  };
}

// ─── Webhook deduplication (Telegram qayta yuborishidan himoya) ───────────────
// Telegram webhook 60s da javob kelmasa xabarni qayta yuboradi. Uzun ovozli
// pipeline (transkripsiya + AI + TTS) shu limitdan oshsa bot bir so'rovga ikki
// marta javob beradi. update_id ni Redis'da NX bilan belgilab, takrorni bloklaymiz.

const updateKey = (updateId: number) => `tg:update:${updateId}`;

export async function markUpdateProcessed(updateId: number): Promise<boolean> {
  // set NX → birinchi marta "OK", takror chaqiruvda null qaytadi
  const res = await getRedis().set(updateKey(updateId), "1", { nx: true, ex: 300 });
  return res === "OK";
}

// ─── Chat History ─────────────────────────────────────────────────────────────

const HISTORY_LIMIT = 10;
const historyKey = (userId: number) => `chat:${userId}:history`;

export async function getHistory(userId: number): Promise<ChatMessage[]> {
  return (await getRedis().get<ChatMessage[]>(historyKey(userId))) ?? [];
}

export async function clearHistory(userId: number): Promise<void> {
  await getRedis().del(historyKey(userId));
}

export async function saveHistory(userId: number, messages: ChatMessage[]): Promise<void> {
  const trimmed = messages.slice(-HISTORY_LIMIT);
  await getRedis().set(historyKey(userId), trimmed, { ex: 60 * 60 * 24 * 7 });
}

// ─── User Mode (voice / text) ─────────────────────────────────────────────────

const modeKey = (userId: number) => `user:${userId}:mode`;

export async function getUserMode(userId: number): Promise<UserMode> {
  return (await getRedis().get<UserMode>(modeKey(userId))) ?? "text";
}

export async function setUserMode(userId: number, mode: UserMode): Promise<void> {
  await getRedis().set(modeKey(userId), mode);
}

// ─── Translate: oxirgi til tanlovi ───────────────────────────────────────────

const translateLangKey = (userId: number) => `user:${userId}:translate_lang`;
const translatePendKey = (userId: number) => `user:${userId}:translate_pending`;

export async function getTranslateLang(userId: number): Promise<string | null> {
  return await getRedis().get<string>(translateLangKey(userId));
}

export async function setTranslateLang(userId: number, lang: string): Promise<void> {
  await getRedis().set(translateLangKey(userId), lang);
}

export async function getTranslatePending(userId: number): Promise<string | null> {
  return await getRedis().get<string>(translatePendKey(userId));
}

export async function setTranslatePending(userId: number, text: string): Promise<void> {
  // 10 daqiqa TTL — foydalanuvchi til tanlashiga yetarli vaqt
  await getRedis().set(translatePendKey(userId), text, { ex: 600 });
}

export async function clearTranslatePending(userId: number): Promise<void> {
  await getRedis().del(translatePendKey(userId));
}

// ─── Reminders ────────────────────────────────────────────────────────────────

const remindersKey = (userId: number) => `reminders:${userId}`;

export async function getReminders(userId: number): Promise<StoredReminder[]> {
  const raw = await getRedis().get<StoredReminder[]>(remindersKey(userId));
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw as unknown as string); } catch { return []; }
}

export async function saveReminder(userId: number, reminder: StoredReminder): Promise<void> {
  const existing = await getReminders(userId);
  existing.push(reminder);
  await getRedis().set(remindersKey(userId), existing.slice(-50));
}

export async function deleteReminder(userId: number, id: string): Promise<boolean> {
  const existing = await getReminders(userId);
  const filtered = existing.filter((r) => r.id !== id);
  if (filtered.length === existing.length) return false;
  await getRedis().set(remindersKey(userId), filtered);
  return true;
}

export async function clearDeliveredReminder(userId: number, id: string): Promise<void> {
  await deleteReminder(userId, id);
}
