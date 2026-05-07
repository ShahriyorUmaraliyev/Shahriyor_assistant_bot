import { google } from "googleapis";
import type { calendar_v3 } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const TIMEOUT_MS = 10_000;

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON sozlanmagan");
  const creds = JSON.parse(
    Buffer.from(raw, "base64").toString("utf8")
  );
  return new google.auth.GoogleAuth({ credentials: creds, scopes: SCOPES });
}

function getCalendarId(): string {
  return process.env.GOOGLE_CALENDAR_ID ?? "primary";
}

// ─── Format event for display ────────────────────────────────────────────────

function formatEvent(ev: calendar_v3.Schema$Event): string {
  const title = ev.summary ?? "(sarlavsiz)";
  const start = ev.start?.dateTime ?? ev.start?.date ?? "";
  const end = ev.end?.dateTime ?? ev.end?.date ?? "";

  let time = "";
  if (ev.start?.dateTime) {
    const s = new Date(ev.start.dateTime);
    const e = new Date(ev.end?.dateTime ?? ev.end?.date ?? start);
    time = `${fmt(s)} – ${fmtTime(e)}`;
  } else if (ev.start?.date) {
    time = `${ev.start.date} (kun bo'yi)`;
  }

  const loc = ev.location ? ` | 📍 ${ev.location}` : "";
  const desc = ev.description ? `\n   ${ev.description.slice(0, 100)}` : "";
  return `• ${title}\n  🕐 ${time}${loc}${desc}`;
}

function fmt(d: Date): string {
  return d.toLocaleString("uz-UZ", {
    timeZone: "Asia/Tashkent",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtTime(d: Date): string {
  return d.toLocaleString("uz-UZ", {
    timeZone: "Asia/Tashkent",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── Get upcoming events ─────────────────────────────────────────────────────

export async function getCalendarEvents(days = 7): Promise<string> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    return "Google Calendar sozlanmagan (GOOGLE_SERVICE_ACCOUNT_JSON yo'q).";

  try {
    const auth = getAuth();
    const calendar = google.calendar({ version: "v3", auth });
    const now = new Date();
    const maxTime = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const res = await Promise.race([
      calendar.events.list({
        calendarId: getCalendarId(),
        timeMin: now.toISOString(),
        timeMax: maxTime.toISOString(),
        maxResults: 20,
        singleEvents: true,
        orderBy: "startTime",
      }),
      new Promise<never>((_, r) => setTimeout(() => r(new Error("TIMEOUT")), TIMEOUT_MS)),
    ]);

    const events = res.data.items ?? [];
    if (!events.length)
      return `Keyingi ${days} kunda rejalashtirilgan tadbir yo'q.`;

    const lines = events.map(formatEvent).join("\n\n");
    return `📅 Keyingi ${days} kun (${events.length} ta tadbir):\n\n${lines}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("TIMEOUT")) return "Google Calendar so'rovi vaqt tugadi.";
    if (msg.includes("invalid_grant") || msg.includes("unauthorized"))
      return "Google Calendar ruxsati yo'q. Service account kalendarni ulashganligini tekshiring.";
    return `Calendar xatosi: ${msg}`;
  }
}

// ─── Add event ────────────────────────────────────────────────────────────────

export async function addCalendarEvent(
  title: string,
  startIso: string,
  endIso: string,
  description?: string,
  location?: string
): Promise<string> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    return "Google Calendar sozlanmagan (GOOGLE_SERVICE_ACCOUNT_JSON yo'q).";

  try {
    const auth = getAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const event: calendar_v3.Schema$Event = {
      summary: title,
      start: { dateTime: startIso, timeZone: "Asia/Tashkent" },
      end: { dateTime: endIso, timeZone: "Asia/Tashkent" },
    };
    if (description) event.description = description;
    if (location) event.location = location;

    const res = await Promise.race([
      calendar.events.insert({
        calendarId: getCalendarId(),
        requestBody: event,
      }),
      new Promise<never>((_, r) => setTimeout(() => r(new Error("TIMEOUT")), TIMEOUT_MS)),
    ]);

    const created = res.data;
    const start = new Date(startIso);
    return `✅ Tadbir qo'shildi: "${created.summary}" — ${fmt(start)}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("TIMEOUT")) return "Google Calendar so'rovi vaqt tugadi.";
    if (msg.includes("invalid_grant") || msg.includes("unauthorized"))
      return "Google Calendar ruxsati yo'q.";
    return `Tadbir qo'shishda xato: ${msg}`;
  }
}
