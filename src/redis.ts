import { Redis } from "@upstash/redis";
import type { ChatMessage, UserMode } from "./types";
import crypto from "node:crypto";

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

const HISTORY_LIMIT = 20;
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

// ─── Reminders (sorted set, score = Unix ms) ─────────────────────────────────

export interface Reminder {
  id: string;
  userId: number;
  text: string;
  time: string; // ISO 8601
}

const reminderKey = (id: string) => `reminder:${id}`;
const PENDING_KEY = "reminders:pending";

export async function addReminder(
  userId: number,
  text: string,
  time: string
): Promise<string> {
  const id = crypto.randomUUID();
  const score = new Date(time).getTime();
  if (isNaN(score)) throw new Error(`Invalid date format from AI: ${time}`);

  await Promise.all([
    getRedis().set(reminderKey(id), { id, userId, text, time } satisfies Reminder),
    getRedis().zadd(PENDING_KEY, { score, member: id }),
  ]);

  return id;
}

export async function getDueReminders(): Promise<Reminder[]> {
  const now = Date.now();
  const ids = await getRedis().zrange<string[]>(PENDING_KEY, 0, now, {
    byScore: true,
  });
  if (!ids.length) return [];

  const items = await Promise.all(
    ids.map((id) => getRedis().get<Reminder>(reminderKey(id)))
  );
  return items.filter((r): r is Reminder => r !== null);
}

export async function removeReminder(id: string): Promise<void> {
  await Promise.all([
    getRedis().del(reminderKey(id)),
    getRedis().zrem(PENDING_KEY, id),
  ]);
}

// ─── User Mode (voice / text) ─────────────────────────────────────────────────

const modeKey = (userId: number) => `user:${userId}:mode`;

export async function getUserMode(userId: number): Promise<UserMode> {
  return (await getRedis().get<UserMode>(modeKey(userId))) ?? "text";
}

export async function setUserMode(userId: number, mode: UserMode): Promise<void> {
  await getRedis().set(modeKey(userId), mode);
}
