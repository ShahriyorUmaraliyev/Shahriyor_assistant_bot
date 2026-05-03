import { Redis } from "@upstash/redis";
import type { ChatMessage, UserMode } from "./types";

// Lazy initialization — instance faqat birinchi chaqiruvda yaratiladi
let _redis: Redis | null = null;

function getRedis(): Redis {
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

export async function appendHistory(
  userId: number,
  message: ChatMessage
): Promise<void> {
  const history = await getHistory(userId);
  const trimmed = [...history, message].slice(-HISTORY_LIMIT);
  await getRedis().set(historyKey(userId), trimmed, { ex: 60 * 60 * 24 * 7 });
}

export async function clearHistory(userId: number): Promise<void> {
  await getRedis().del(historyKey(userId));
}

// ─── User Mode (voice / text) ─────────────────────────────────────────────────

const modeKey = (userId: number) => `user:${userId}:mode`;

export async function getUserMode(userId: number): Promise<UserMode> {
  return (await getRedis().get<UserMode>(modeKey(userId))) ?? "text";
}

export async function setUserMode(userId: number, mode: UserMode): Promise<void> {
  await getRedis().set(modeKey(userId), mode);
}
