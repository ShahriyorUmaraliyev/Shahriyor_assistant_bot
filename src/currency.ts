// ─── Valyuta kursi — O'zbekiston Markaziy banki (cbu.uz) bepul API ────────────
// API kalit kerak emas. Rate = Nominal birlik uchun UZS narxi (masalan JPY: Nominal=100).

interface CbuRate {
  Ccy: string;        // "USD"
  CcyNm_UZ: string;   // "AQSH dollari"
  Nominal: string;    // "1" yoki "100"
  Rate: string;       // "12650.50"
  Date: string;       // "06.06.2026"
}

const CBU_URL = "https://cbu.uz/uz/arkhiv-kursov-valyut/json";
const TIMEOUT_MS = 10_000;
// Ba'zi serverlar Node'ning standart User-Agent'ini rad etadi — browser UA beramiz
const CBU_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; ShahriyorAssist/1.0)",
  Accept: "application/json",
};

// Keng tarqalgan nomlarni ISO kodga moslashtirish
const ALIAS: Record<string, string> = {
  dollar: "USD", доллар: "USD", доллор: "USD", aqsh: "USD",
  yevro: "EUR", evro: "EUR", euro: "EUR", евро: "EUR",
  rubl: "RUB", рубль: "RUB", rubль: "RUB", rossiya: "RUB",
  funt: "GBP", yuan: "CNY", xitoy: "CNY", tenge: "KZT", tenga: "KZT",
  lira: "TRY", turk: "TRY", dirham: "AED",
};

function normalizeCode(input: string): string {
  const lower = input.trim().toLowerCase();
  if (ALIAS[lower]) return ALIAS[lower];
  return input.trim().toUpperCase().slice(0, 3);
}

// Raqamli kurs (1 birlik uchun UZS). Xato bo'lsa null — chaqiruvchi shunga qarab ish ko'radi.
export async function getRateValue(code: string): Promise<number | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${CBU_URL}/${normalizeCode(code)}/`, { signal: ctrl.signal, headers: CBU_HEADERS });
    if (!res.ok) { console.warn(`[currency] getRateValue HTTP ${res.status}`); return null; }
    const data = (await res.json()) as CbuRate[];
    const item = data?.[0];
    if (!item) return null;
    const rate = parseFloat(item.Rate);
    const nominal = parseInt(item.Nominal, 10) || 1;
    return isFinite(rate) ? rate / nominal : null;
  } catch (err) {
    console.warn("[currency] getRateValue xato:", (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getCurrencyRate(currency: string, amount = 1): Promise<string> {
  const code = normalizeCode(currency);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${CBU_URL}/${code}/`, { signal: ctrl.signal, headers: CBU_HEADERS });
  } catch (err) {
    if ((err as Error).name === "AbortError") return "Valyuta kursi olishda vaqt tugadi (8s). Qayta urinib ko'ring.";
    return "Markaziy bank xizmatiga ulanishda tarmoq xatosi. Qayta urinib ko'ring.";
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) return `Valyuta kursi xizmati xatosi: ${res.status}.`;

  const data = (await res.json()) as CbuRate[];
  if (!Array.isArray(data) || !data.length)
    return `"${currency}" valyutasi topilmadi. ISO kod kiriting (USD, EUR, RUB, GBP, CNY, KZT, TRY...).`;

  const item = data[0];
  const rate = parseFloat(item.Rate);
  const nominal = parseInt(item.Nominal, 10) || 1;
  if (!isFinite(rate)) return "Valyuta kursi noto'g'ri formatda qaytdi.";

  const perUnit = rate / nominal;            // 1 birlik uchun UZS
  const total = perUnit * (amount > 0 ? amount : 1);

  const fmtUzs = (n: number) => Math.round(n).toLocaleString("ru-RU"); // bo'sh joy bilan ajratish

  return JSON.stringify({
    valyuta: `${item.Ccy} (${item.CcyNm_UZ})`,
    kurs: `1 ${item.Ccy} = ${fmtUzs(perUnit)} so'm`,
    miqdor: amount > 1 ? `${amount} ${item.Ccy} = ${fmtUzs(total)} so'm` : undefined,
    sana: item.Date,
  });
}
