// ─── Google Cloud Translation API v2 ─────────────────────────────────────────

const TRANSLATE_API = "https://translation.googleapis.com/language/translate/v2";
const TRANSLATE_TIMEOUT_MS = 10_000;

export interface LangInfo {
  name: string;
  flag: string;
  code: string;
}

export const TRANSLATE_LANGS: Record<string, LangInfo> = {
  uz: { code: "uz", name: "O'zbek",   flag: "🇺🇿" },
  en: { code: "en", name: "English",  flag: "🇬🇧" },
  ru: { code: "ru", name: "Русский",  flag: "🇷🇺" },
  tr: { code: "tr", name: "Türkçe",   flag: "🇹🇷" },
};

export const TRANSLATE_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "🇺🇿 O'zbek",  callback_data: "tr:uz" },
      { text: "🇬🇧 English", callback_data: "tr:en" },
    ],
    [
      { text: "🇷🇺 Русский", callback_data: "tr:ru" },
      { text: "🇹🇷 Türkçe",  callback_data: "tr:tr" },
    ],
  ],
};

export const CHANGE_LANG_KEYBOARD = {
  inline_keyboard: [
    [{ text: "🔄 Tilni o'zgartirish", callback_data: "tr:change" }],
  ],
};

interface TranslateResponse {
  data: {
    translations: Array<{ translatedText: string }>;
  };
}

export async function translateText(text: string, targetLang: string): Promise<string> {
  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey) throw new Error("TRANSLATE_KEY_MISSING");

  // Google Translate API: maks 5000 belgi per so'rov
  const truncated = text.length > 5000 ? text.slice(0, 5000) : text;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRANSLATE_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${TRANSLATE_API}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: truncated, target: targetLang, format: "text" }),
      signal: ctrl.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("TRANSLATE_TIMEOUT");
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 400) throw new Error("TRANSLATE_INVALID_REQUEST");
    if (res.status === 403) throw new Error("TRANSLATE_KEY_INVALID");
    if (res.status === 429) throw new Error("TRANSLATE_RATE_LIMIT");
    throw new Error(`TRANSLATE_API_ERROR:${res.status}:${body.slice(0, 100)}`);
  }

  const data = (await res.json()) as TranslateResponse;
  const translated = data.data?.translations?.[0]?.translatedText;
  if (!translated) throw new Error("TRANSLATE_EMPTY_RESPONSE");
  return translated;
}

export function translateErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("TRANSLATE_KEY_MISSING"))
    return "⚙️ GOOGLE_TRANSLATE_API_KEY sozlanmagan. Cloud Run Environment Variables ga qo'shing.";
  if (msg.includes("TRANSLATE_KEY_INVALID"))
    return "🔑 Google Translate API key noto'g'ri yoki Translation API yoqilmagan. Cloud Console → APIs & Services da tekshiring.";
  if (msg.includes("TRANSLATE_RATE_LIMIT"))
    return "⚠️ Tarjima so'rovlar chegarasiga yetdi. Bir oz kutib qayta urinib ko'ring.";
  if (msg.includes("TRANSLATE_TIMEOUT"))
    return "⏱ Tarjima so'rovi uzoq ketdi. Qayta urinib ko'ring.";
  if (msg.includes("TRANSLATE_INVALID_REQUEST"))
    return "❌ Noto'g'ri so'rov. Matnni tekshirib qayta yuboring.";
  if (msg.includes("TRANSLATE_EMPTY_RESPONSE"))
    return "❌ Tarjima bo'sh javob qaytardi. Qayta urinib ko'ring.";
  return `❌ Tarjima xatolik: ${msg.slice(0, 80)}`;
}
