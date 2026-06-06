// ─── Ertalabki brifing — kalendar + bugungi eslatmalar + ob-havo ──────────────
// Gemini chaqiruvisiz, to'g'ridan yig'iladi (bepul, tez, ishonchli).
import { getCalendarEvents } from "./gcalendar";
import { getReminders } from "./reminder";
import { getCurrentWeather } from "./weather";

function tashkentDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
}

export async function generateMorningBriefing(userId: number): Promise<string> {
  const city = process.env.BRIEFING_CITY || "Tashkent";

  const [calendarRaw, reminders, weatherRaw] = await Promise.all([
    getCalendarEvents(1).catch(() => ""),
    getReminders(userId).catch(() => []),
    getCurrentWeather(city).catch(() => ""),
  ]);

  const today = new Date().toLocaleDateString("uz-UZ", {
    timeZone: "Asia/Tashkent",
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  const lines: string[] = [`🌅 *Xayrli tong, Shahriyor!*`, `📅 ${today}`, ""];

  // Ob-havo — getCurrentWeather JSON yoki xato jumla qaytaradi
  try {
    const w = JSON.parse(weatherRaw) as {
      shahar: string; harorat: string; holat: string; namlik: string;
    };
    lines.push(`🌤 *Ob-havo (${w.shahar}):* ${w.harorat}, ${w.holat}, namlik ${w.namlik}`);
  } catch {
    /* ob-havo yo'q yoki xato — tashlab ketamiz */
  }

  lines.push("");

  // Taqvim — getCalendarEvents o'z sarlavhasi bilan keladi, uni olib tashlaymiz
  lines.push("📋 *Bugungi taqvim:*");
  if (calendarRaw && !calendarRaw.includes("sozlanmagan")) {
    const body = calendarRaw.includes("\n\n")
      ? calendarRaw.slice(calendarRaw.indexOf("\n\n") + 2)
      : calendarRaw;
    lines.push(body.trim());
  } else {
    lines.push("• Ma'lumot yo'q");
  }

  lines.push("");

  // Bugungi eslatmalar (Toshkent kuni bo'yicha)
  lines.push("⏰ *Bugungi eslatmalar:*");
  const now = Math.floor(Date.now() / 1000);
  const todayStr = tashkentDay(Date.now());
  const todays = reminders
    .filter((r) => r.notBefore > now && tashkentDay(r.notBefore * 1000) === todayStr)
    .sort((a, b) => a.notBefore - b.notBefore);
  if (todays.length) {
    for (const r of todays) {
      const t = new Date(r.notBefore * 1000).toLocaleTimeString("uz-UZ", {
        timeZone: "Asia/Tashkent",
        hour: "2-digit",
        minute: "2-digit",
      });
      lines.push(`• ${t} — ${r.text}`);
    }
  } else {
    lines.push("• Bugunga eslatma yo'q");
  }

  lines.push("");
  lines.push("_Kuningiz barakali o'tsin!_ 🚀");

  return lines.join("\n");
}
