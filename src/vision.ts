// ─── Rasm yuklab olish (Telegram → Buffer) ───────────────────────────────────
// Tahlil generateReplyWithImage (gemini.ts) ichida tool'lar bilan bajariladi —
// shu sabab chek → "Xarajatlar", mahsulot → "Mahsulotlar" jadvaliga avtomatik yoziladi.

const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB
const DOWNLOAD_TIMEOUT_MS = 12_000;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN sozlanmagan");
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("IMAGE_DOWNLOAD_TIMEOUT");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function mimeFromPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".heic") || lower.endsWith(".heif")) return "image/heic";
  return "image/jpeg"; // Telegram suratlari odatda JPEG
}

export async function downloadTelegramPhoto(
  fileId: string,
  fileSize?: number
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (fileSize && fileSize > MAX_IMAGE_BYTES) throw new Error("IMAGE_TOO_LARGE");

  const infoRes = await fetchWithTimeout(
    `${TG}/getFile?file_id=${encodeURIComponent(fileId)}`,
    DOWNLOAD_TIMEOUT_MS
  );
  if (!infoRes.ok) throw new Error("TELEGRAM_FILE_ERROR");

  const info = (await infoRes.json()) as {
    ok: boolean;
    result?: { file_path?: string; file_size?: number };
  };
  if (!info.ok || !info.result?.file_path) throw new Error("TELEGRAM_FILE_ERROR");
  if (info.result.file_size && info.result.file_size > MAX_IMAGE_BYTES)
    throw new Error("IMAGE_TOO_LARGE");

  const filePath = info.result.file_path;
  const dlRes = await fetchWithTimeout(
    `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`,
    DOWNLOAD_TIMEOUT_MS
  );
  if (!dlRes.ok) throw new Error("TELEGRAM_FILE_ERROR");

  return {
    buffer: Buffer.from(await dlRes.arrayBuffer()),
    mimeType: mimeFromPath(filePath),
  };
}
