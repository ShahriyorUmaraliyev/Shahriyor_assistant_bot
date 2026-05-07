import { google } from "googleapis";
import type { sheets_v4 } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const TIMEOUT_MS = 10_000;

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON sozlanmagan");
  const creds = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  return new google.auth.GoogleAuth({ credentials: creds, scopes: SCOPES });
}

function getSheetId(): string {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) throw new Error("GOOGLE_SHEET_ID sozlanmagan");
  return id;
}

// ─── Read rows ────────────────────────────────────────────────────────────────

export async function readSheet(
  range: string // "Sheet1!A1:E20" yoki "Sheet1"
): Promise<string> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    return "Google Sheets sozlanmagan (GOOGLE_SERVICE_ACCOUNT_JSON yo'q).";
  if (!process.env.GOOGLE_SHEET_ID)
    return "GOOGLE_SHEET_ID sozlanmagan.";

  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const res = await Promise.race([
      sheets.spreadsheets.values.get({
        spreadsheetId: getSheetId(),
        range,
      }),
      new Promise<never>((_, r) => setTimeout(() => r(new Error("TIMEOUT")), TIMEOUT_MS)),
    ]);

    const rows: string[][] = (res.data.values as string[][]) ?? [];
    if (!rows.length) return `"${range}" da ma'lumot yo'q.`;

    // Jadval ko'rinishida formatlash
    const maxCols = Math.max(...rows.map((r) => r.length));
    const colWidths = Array.from({ length: maxCols }, (_, ci) =>
      Math.min(
        20,
        Math.max(...rows.map((r) => (r[ci] ?? "").toString().length), 1)
      )
    );

    const lines = rows.slice(0, 50).map((row) =>
      row.map((cell, ci) =>
        (cell ?? "").toString().slice(0, 20).padEnd(colWidths[ci])
      ).join(" | ")
    );

    const header = `📊 ${range} (${rows.length} qator):\n`;
    return header + "```\n" + lines.join("\n") + "\n```";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("TIMEOUT")) return "Google Sheets so'rovi vaqt tugadi.";
    if (msg.includes("Unable to parse range"))
      return `Noto'g'ri diapazon: "${range}". Misol: "Sheet1!A1:D10"`;
    if (msg.includes("invalid_grant") || msg.includes("unauthorized"))
      return "Google Sheets ruxsati yo'q. Service account elektron jadvalga Editor sifatida qo'shilganligini tekshiring.";
    return `Sheets o'qish xatosi: ${msg}`;
  }
}

// ─── Append row ───────────────────────────────────────────────────────────────

export async function appendSheetRow(
  sheetName: string,
  values: string[]
): Promise<string> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    return "Google Sheets sozlanmagan (GOOGLE_SERVICE_ACCOUNT_JSON yo'q).";
  if (!process.env.GOOGLE_SHEET_ID)
    return "GOOGLE_SHEET_ID sozlanmagan.";

  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const range = `${sheetName}!A:A`;

    const res = await Promise.race([
      sheets.spreadsheets.values.append({
        spreadsheetId: getSheetId(),
        range,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [values] },
      }),
      new Promise<never>((_, r) => setTimeout(() => r(new Error("TIMEOUT")), TIMEOUT_MS)),
    ]);

    const updates = res.data.updates;
    const updatedRange = updates?.updatedRange ?? range;
    return `✅ Qator qo'shildi: ${updatedRange} | ${values.join(" | ")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("TIMEOUT")) return "Google Sheets so'rovi vaqt tugadi.";
    if (msg.includes("invalid_grant") || msg.includes("unauthorized"))
      return "Google Sheets ruxsati yo'q.";
    return `Sheets yozish xatosi: ${msg}`;
  }
}

// ─── Update cell ──────────────────────────────────────────────────────────────

export async function updateSheetCell(
  range: string, // "Sheet1!B5"
  value: string
): Promise<string> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    return "Google Sheets sozlanmagan (GOOGLE_SERVICE_ACCOUNT_JSON yo'q).";
  if (!process.env.GOOGLE_SHEET_ID)
    return "GOOGLE_SHEET_ID sozlanmagan.";

  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    await Promise.race([
      sheets.spreadsheets.values.update({
        spreadsheetId: getSheetId(),
        range,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[value]] },
      }),
      new Promise<never>((_, r) => setTimeout(() => r(new Error("TIMEOUT")), TIMEOUT_MS)),
    ]);

    return `✅ ${range} yangilandi: "${value}"`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("TIMEOUT")) return "Google Sheets so'rovi vaqt tugadi.";
    if (msg.includes("invalid_grant") || msg.includes("unauthorized"))
      return "Google Sheets ruxsati yo'q.";
    return `Sheets yangilash xatosi: ${msg}`;
  }
}
