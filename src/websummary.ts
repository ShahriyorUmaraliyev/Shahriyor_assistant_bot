// ─── URL xulosa — havola sahifasini olib, tozalab, Gemini bilan qisqartirish ──
import { getGenAI, withTimeout, withRetry, GEMINI_TIMEOUT_MS } from "./gemini";

const FETCH_TIMEOUT_MS = 12_000;
const MAX_CHARS = 12_000; // Gemini'ga yuboriladigan matn cheklovi — token tejash

// HTML'dan o'qiladigan matnni ajratib olish (kutubxonasiz)
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export async function summarizeUrl(url: string): Promise<string> {
  // URL validatsiyasi
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("bad protocol");
  } catch {
    return "Noto'g'ri havola. To'liq URL yuboring (https://...).";
  }

  // Sahifani olish
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(parsed.toString(), {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ShahriyorAssist/1.0)" },
      redirect: "follow",
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") return "Sahifani yuklab olishda vaqt tugadi (12s).";
    return "Havolaga ulanib bo'lmadi. Manzilni tekshirib qayta yuboring.";
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) return `Sahifa ochilmadi (HTTP ${res.status}). Havola ishlayotganini tekshiring.`;

  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.includes("text/html") && !ctype.includes("text/plain") && !ctype.includes("xml"))
    return `Bu havolani o'qib bo'lmadi (tur: ${ctype.split(";")[0] || "noma'lum"}). Faqat veb-sahifalarni qisqartira olaman.`;

  const raw = await res.text();
  const text = htmlToText(raw).slice(0, MAX_CHARS);
  if (text.length < 200) return "Sahifada o'qiladigan matn topilmadi (ehtimol JavaScript bilan yuklanadi).";

  // Gemini bilan xulosa
  const model = getGenAI().getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction:
      "Sen veb-sahifa matnini O'zbek tilida qisqa va aniq xulosa qiluvchi yordamchisan. " +
      "Asosiy fikrlarni 3-6 ta qisqa bandda ber. Ortiqcha gap, takror yoki reklama matnini tashlab yubor. " +
      "Sarlavha bilan boshlа, keyin bandlar.",
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } } as never,
  });

  const result = await withRetry(() =>
    withTimeout(
      model.generateContent(
        `Quyidagi veb-sahifa matnini xulosa qil:\n\nManba: ${parsed.hostname}\n\n${text}`
      ),
      GEMINI_TIMEOUT_MS
    )
  );

  const summary = result.response.text()?.trim();
  if (!summary) return "Sahifani xulosa qilib bo'lmadi. Qayta urinib ko'ring.";
  return `🔗 ${parsed.hostname}\n\n${summary}`;
}
