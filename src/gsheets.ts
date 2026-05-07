import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const TIMEOUT_MS = 10_000;

let _auth: InstanceType<typeof google.auth.GoogleAuth> | null = null;
function getAuth() {
  if (_auth) return _auth;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON sozlanmagan");
  const creds = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  _auth = new google.auth.GoogleAuth({ credentials: creds, scopes: SCOPES });
  return _auth;
}

function getSheetId(): string {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) throw new Error("GOOGLE_SHEET_ID sozlanmagan");
  return id;
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

// ─── Read rows ────────────────────────────────────────────────────────────────

export async function readSheet(range: string): Promise<string> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    return "Google Sheets sozlanmagan (GOOGLE_SERVICE_ACCOUNT_JSON yo'q).";
  if (!process.env.GOOGLE_SHEET_ID)
    return "GOOGLE_SHEET_ID sozlanmagan.";

  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const res = await withTimer(
      sheets.spreadsheets.values.get({ spreadsheetId: getSheetId(), range })
    );

    const rows: string[][] = (res.data.values as string[][] | null) ?? [];
    if (!rows.length) return `"${range}" da ma'lumot yo'q.`;

    const maxCols = Math.max(...rows.map((r) => r.length));
    const colWidths = Array.from({ length: maxCols }, (_, ci) =>
      Math.min(20, Math.max(...rows.map((r) => (r[ci] ?? "").toString().length), 1))
    );

    const lines = rows.slice(0, 50).map((row) =>
      row.map((cell, ci) =>
        (cell ?? "").toString().slice(0, 20).padEnd(colWidths[ci])
      ).join(" | ")
    );

    return `📊 ${range} (${rows.length} qator):\n\`\`\`\n${lines.join("\n")}\n\`\`\``;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("TIMEOUT")) return "Google Sheets so'rovi vaqt tugadi.";
    if (msg.includes("Unable to parse range"))
      return `Noto'g'ri diapazon: "${range}". Misol: "Sheet1!A1:D10"`;
    if (isAuthError(msg))
      return "Google Sheets ruxsati yo'q. Service account jadvalga Editor sifatida qo'shilganligini tekshiring.";
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

    const res = await withTimer(
      sheets.spreadsheets.values.append({
        spreadsheetId: getSheetId(),
        range: `${sheetName}!A:A`,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [values] },
      })
    );

    const updatedRange = res.data.updates?.updatedRange ?? sheetName;
    return `✅ Qator qo'shildi: ${updatedRange} | ${values.join(" | ")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("TIMEOUT")) return "Google Sheets so'rovi vaqt tugadi.";
    if (isAuthError(msg)) return "Google Sheets ruxsati yo'q.";
    return `Sheets yozish xatosi: ${msg}`;
  }
}

// ─── Update cell ──────────────────────────────────────────────────────────────

export async function updateSheetCell(range: string, value: string): Promise<string> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    return "Google Sheets sozlanmagan (GOOGLE_SERVICE_ACCOUNT_JSON yo'q).";
  if (!process.env.GOOGLE_SHEET_ID)
    return "GOOGLE_SHEET_ID sozlanmagan.";

  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    await withTimer(
      sheets.spreadsheets.values.update({
        spreadsheetId: getSheetId(),
        range,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[value]] },
      })
    );

    return `✅ ${range} yangilandi: "${value}"`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("TIMEOUT")) return "Google Sheets so'rovi vaqt tugadi.";
    if (isAuthError(msg)) return "Google Sheets ruxsati yo'q.";
    return `Sheets yangilash xatosi: ${msg}`;
  }
}
