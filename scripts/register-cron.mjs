/**
 * GitHub Actions deploy workflow tomonidan avtomatik chaqiriladi.
 * Har kuni ertalab 09:00 da (Tashkent vaqti) AI yangiliklari digestini yuboradigan
 * QStash Cron rejalashtiruvchisini ro'yxatdan o'tkazadi yoki yangilaydi.
 */

import { Client } from "@upstash/qstash";

const token = process.env.QSTASH_TOKEN;
const base = process.env.APP_URL?.replace(/\/$/, "") ?? null;
const userIdsStr = process.env.ALLOWED_USER_IDS ?? "";

if (!token || !base || !userIdsStr) {
  console.warn(
    "⚠️ QSTASH_TOKEN, APP_URL yoki ALLOWED_USER_IDS topilmadi — daily news cron ro'yxatga olinmadi."
  );
  process.exit(0); // exit 0: deploy to'xtatilmaydi
}

// Birinchi ruxsat berilgan foydalanuvchining ID sini olamiz (Shahriyor)
const targetUserId = parseInt(userIdsStr.split(",")[0].trim(), 10);
if (isNaN(targetUserId)) {
  console.error("❌ Xato: ALLOWED_USER_IDS formatida xatolik bor!");
  process.exit(1);
}

const client = new Client({ token });
const destination = `${base}/api/cron/daily-ai-news`;
const scheduleId = "daily-ai-news-shahriyor";

console.log(`ℹ️ Daily news destination: ${destination}`);
console.log(`ℹ️ Target User ID: ${targetUserId}`);

try {
  // Avval eski cron mavjud bo'lsa uni o'chiramiz, shunda yangi sozlamalar bilan toza yoziladi
  try {
    await client.schedules.delete(scheduleId);
    console.log("🧹 Eski cron jadvali o'chirildi.");
  } catch {
    // Topilmasa xato beradi, bu normal holat
  }

  // Yangi cron schedule yaratamiz
  await client.schedules.create({
    scheduleId,
    destination,
    cron: "CRON_TZ=Asia/Tashkent 0 9 * * *", // Har kuni Toshkent vaqti bilan soat 09:00 da
    body: { userId: targetUserId },
  });

  console.log(`✅ Daily AI news cron muvaffaqiyatli ro'yxatdan o'tkazildi: ${scheduleId}`);
} catch (err) {
  console.error("❌ Cron ro'yxatga olishda xatolik:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
