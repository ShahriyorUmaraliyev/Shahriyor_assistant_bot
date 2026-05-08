// ─── Google Cloud Translation API v2 ─────────────────────────────────────────

const TRANSLATE_API = "https://translation.googleapis.com/language/translate/v2";
const TRANSLATE_TIMEOUT_MS = 10_000;

export interface LangInfo {
  name: string;
  flag: string;
  code: string;
}

// Barcha qo'llab-quvvatlanadigan tillar
export const TRANSLATE_LANGS: Record<string, LangInfo> = {
  uz: { code: "uz", name: "O'zbek",     flag: "🇺🇿" },
  en: { code: "en", name: "English",    flag: "🇬🇧" },
  ru: { code: "ru", name: "Русский",    flag: "🇷🇺" },
  tr: { code: "tr", name: "Türkçe",     flag: "🇹🇷" },
  ar: { code: "ar", name: "العربية",    flag: "🇸🇦" },
  zh: { code: "zh", name: "中文",        flag: "🇨🇳" },
  fr: { code: "fr", name: "Français",   flag: "🇫🇷" },
  de: { code: "de", name: "Deutsch",    flag: "🇩🇪" },
  es: { code: "es", name: "Español",    flag: "🇪🇸" },
  it: { code: "it", name: "Italiano",   flag: "🇮🇹" },
  ko: { code: "ko", name: "한국어",      flag: "🇰🇷" },
  ja: { code: "ja", name: "日本語",      flag: "🇯🇵" },
  hi: { code: "hi", name: "हिन्दी",     flag: "🇮🇳" },
  fa: { code: "fa", name: "فارسی",      flag: "🇮🇷" },
  pt: { code: "pt", name: "Português",  flag: "🇧🇷" },
  pl: { code: "pl", name: "Polski",     flag: "🇵🇱" },
  uk: { code: "uk", name: "Українська", flag: "🇺🇦" },
  nl: { code: "nl", name: "Nederlands", flag: "🇳🇱" },
  sv: { code: "sv", name: "Svenska",    flag: "🇸🇪" },
  ro: { code: "ro", name: "Română",     flag: "🇷🇴" },
};

// Asosiy 6 til uchun inline keyboard (tez kirish)
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
    [
      { text: "🇸🇦 العربية", callback_data: "tr:ar" },
      { text: "🇨🇳 中文",     callback_data: "tr:zh" },
    ],
  ],
};

export const CHANGE_LANG_KEYBOARD = {
  inline_keyboard: [
    [{ text: "🔄 Tilni o'zgartirish", callback_data: "tr:change" }],
  ],
};

// Barcha til kodlarini qisqa ro'yxat sifatida qaytaradi (yordam uchun)
export function langListText(): string {
  return Object.entries(TRANSLATE_LANGS)
    .map(([code, l]) => `${l.flag} \`${code}\` — ${l.name}`)
    .join("\n");
}

interface TranslateResponse {
  data: {
    translations: Array<{ translatedText: string }>;
  };
}

export async function translateText(text: string, targetLang: string): Promise<string> {
  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey) throw new Error("TRANSLATE_KEY_MISSING");

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
  return data.data.translations[0].translatedText;
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
  return `❌ Tarjima xatolik: ${msg.slice(0, 80)}`;
}
