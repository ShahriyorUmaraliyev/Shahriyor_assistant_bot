import { Redis } from "@upstash/redis";
import type { ChatMessage, UserMode } from "./types";

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

const translateLangKey  = (userId: number) => `user:${userId}:translate_lang`;
const translatePendKey  = (userId: number) => `user:${userId}:translate_pending`;

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
