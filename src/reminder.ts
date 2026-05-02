import { addReminder } from "./redis";

/**
 * Eslatmani Redis sorted set ga saqlash.
 * Cron job (api/reminder.ts) har daqiqa tekshirib Telegram ga yuboradi.
 *
 * @param userId  Telegram user ID
 * @param text    Eslatma matni
 * @param time    ISO 8601, masalan: "2026-05-03T15:00:00+05:00"
 */
export async function scheduleReminder(
  userId: number,
  text: string,
  time: string
): Promise<string> {
  return addReminder(userId, text, time);
}
