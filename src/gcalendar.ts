import { google } from "googleapis";
import type { calendar_v3 } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const TIMEOUT_MS = 10_000;

let _auth: InstanceType<typeof google.auth.GoogleAuth> | null = null;
function getAuth() {
  if (_auth) return _auth;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON sozlanmagan");
  let creds: unknown;
  try {
    creds = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON base64 yoki JSON formati noto'g'ri");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _auth = new google.auth.GoogleAuth({ credentials: creds as any, scopes: SCOPES });
  return _auth;
}

function getCalendarId(): string {
  return process.env.GOOGLE_CALENDAR_ID ?? "primary";
}

function isAuthError(msg: string): boolean {
  const l = msg.toLowerCase();
  return (
    l.includes("invalid_grant") ||
    l.includes("unauthorized") ||
    l.includes("unauthenticated") ||
    l.includes("forbidden") ||
    l.includes("403") ||
    l.includes("401")
  );
}

function withTimer<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, r) => {
    timer = setTimeout(() => r(new Error("TIMEOUT")), TIMEOUT_MS);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

// ─── Format event ────────────────────────────────────────────────────────────

function formatEvent(ev: calendar_v3.Schema$Event): string {
  const title = ev.summary ?? "(sarlavsiz)";

  let time = "";
  if (ev.start?.dateTime) {
    const s = new Date(ev.start.dateTime);
    const e = new Date(ev.end?.dateTime ?? ev.start.dateTime);
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

    const res = await withTimer(
      calendar.events.list({
        calendarId: getCalendarId(),
        timeMin: now.toISOString(),
        timeMax: maxTime.toISOString(),
        maxResults: 20,
        singleEvents: true,
        orderBy: "startTime",
      })
    );

    const events = res.data.items ?? [];
    if (!events.length)
      return `Keyingi ${days} kunda rejalashtirilgan tadbir yo'q.`;

    const lines = events.map(formatEvent).join("\n\n");
    return `📅 Keyingi ${days} kun (${events.length} ta tadbir):\n\n${lines}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("TIMEOUT")) return "Google Calendar so'rovi vaqt tugadi.";
    if (isAuthError(msg))
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

  const startDate = new Date(startIso);
  const endDate = new Date(endIso);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()))
    return `Noto'g'ri vaqt formati. ISO 8601 kerak (masalan: 2026-05-10T14:00:00+05:00).`;
  if (endDate.getTime() <= startDate.getTime())
    return "Tugash vaqti boshlanish vaqtidan keyin bo'lishi kerak.";

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

    const res = await withTimer(
      calendar.events.insert({ calendarId: getCalendarId(), requestBody: event })
    );

    return `✅ Tadbir qo'shildi: "${res.data.summary}" — ${fmt(startDate)}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("TIMEOUT")) return "Google Calendar so'rovi vaqt tugadi.";
    if (isAuthError(msg)) return "Google Calendar ruxsati yo'q.";
    return `Tadbir qo'shishda xato: ${msg}`;
  }
}
