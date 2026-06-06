/**
 * GitHub Actions deploy workflow tomonidan avtomatik chaqiriladi.
 * Har kuni ertalab 09:00 da (Tashkent vaqti) AI yangiliklari digestini yuboradigan
 * QStash Cron rejalashtiruvchisini ro'yxatdan o'tkazadi yoki yangilaydi.
 */

// Clean any Unicode BOM (\uFEFF) from process.env to prevent fetch errors
for (const key in process.env) {
  if (typeof process.env[key] === "string") {
    process.env[key] = process.env[key].replace(/^\uFEFF/, "").trim();
  }
}

const token = process.env.QSTASH_TOKEN;
const base = process.env.APP_URL?.replace(/\/$/, "") ?? null;
const userIdsStr = process.env.ALLOWED_USER_IDS ?? "";
const qstashUrlBase = (process.env.QSTASH_URL || "https://qstash-us-east-1.upstash.io").replace(/\/$/, "");

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

const destination = `${base}/api/cron/daily-ai-news`;
const scheduleId = "daily-ai-news-shahriyor";

console.log(`ℹ️ Daily news destination: ${destination}`);
console.log(`ℹ️ Target User ID: ${targetUserId}`);
console.log(`ℹ️ QStash Base URL: ${qstashUrlBase}`);

try {
  // Avval eski cron jadvali bo'lsa uni o'chiramiz, shunda yangi sozlamalar bilan toza yoziladi
  try {
    const delRes = await fetch(`${qstashUrlBase}/v2/schedules/${scheduleId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (delRes.ok) {
      console.log("🧹 Eski cron jadvali o'chirildi.");
    }
  } catch (e) {
    // Topilmasa yoki xato bersa, e'tibor bermaymiz
  }

  // Yangi cron schedule yaratamiz
  const createRes = await fetch(`${qstashUrlBase}/v2/schedules/${destination}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Upstash-Cron": "CRON_TZ=Asia/Tashkent 0 9 * * *",
      "Upstash-Schedule-Id": scheduleId,
    },
    body: JSON.stringify({ userId: targetUserId }),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`QStash xatoligi: ${createRes.status} — ${errText}`);
  }

  const data = await createRes.json();
  console.log(`✅ Daily AI news cron muvaffaqiyatli ro'yxatdan o'tkazildi: ${scheduleId}`, JSON.stringify(data));
} catch (err) {
  console.error("❌ Cron ro'yxatga olishda xatolik:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// ─── Ertalabki brifing cron — har kuni 07:00 (Tashkent) ───────────────────────

const briefingDest = `${base}/api/cron/morning-briefing`;
const briefingId = "morning-briefing-shahriyor";

try {
  try {
    const delRes = await fetch(`${qstashUrlBase}/v2/schedules/${briefingId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (delRes.ok) console.log("🧹 Eski brifing cron jadvali o'chirildi.");
  } catch {
    // Topilmasa e'tibor bermaymiz
  }

  const createRes = await fetch(`${qstashUrlBase}/v2/schedules/${briefingDest}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Upstash-Cron": "CRON_TZ=Asia/Tashkent 0 7 * * *",
      "Upstash-Schedule-Id": briefingId,
    },
    body: JSON.stringify({ userId: targetUserId }),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`QStash xatoligi: ${createRes.status} — ${errText}`);
  }

  const data = await createRes.json();
  console.log(`✅ Ertalabki brifing cron ro'yxatdan o'tkazildi: ${briefingId}`, JSON.stringify(data));
} catch (err) {
  console.error("❌ Brifing cron ro'yxatga olishda xatolik:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
