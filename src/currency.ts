// ─── Valyuta kursi — ikki manbali (rezerv bilan) ─────────────────────────────
// 1) cbu.uz — O'zbekiston Markaziy banki (rasmiy, aniq). Cloud Run'dan ba'zan
//    yetib bormaydi (geo/sekin), shuning uchun:
// 2) open.er-api.com — global rezerv (kalit yo'q, hamma joydan ishonchli).
// Ikkalasi ham UZS qaytaradi. Asosiy yiqilsa avtomatik rezervga o'tadi.

interface CbuRate {
  Ccy: string;
  CcyNm_UZ: string;
  Nominal: string;
  Rate: string;
  Date: string;
}

const CBU_URL = "https://cbu.uz/uz/arkhiv-kursov-valyut/json";
const ERAPI_URL = "https://open.er-api.com/v6/latest";
const TIMEOUT_MS = 10_000;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; ShahriyorAssist/1.0)",
  Accept: "application/json",
};

const ALIAS: Record<string, string> = {
  dollar: "USD", доллар: "USD", доллор: "USD", aqsh: "USD",
  yevro: "EUR", evro: "EUR", euro: "EUR", евро: "EUR",
  rubl: "RUB", рубль: "RUB", rossiya: "RUB",
  funt: "GBP", yuan: "CNY", xitoy: "CNY", tenge: "KZT", tenga: "KZT",
  lira: "TRY", turk: "TRY", dirham: "AED",
};

function normalizeCode(input: string): string {
  const lower = input.trim().toLowerCase();
  if (ALIAS[lower]) return ALIAS[lower];
  return input.trim().toUpperCase().slice(0, 3);
}

async function fetchJson(url: string): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: HEADERS });
    if (!res.ok) {
      console.warn(`[currency] HTTP ${res.status} — ${url}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[currency] fetch xato (${url}):`, (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface RateInfo {
  perUnit: number; // 1 birlik uchun UZS
  ccy: string;
  name: string;
  date: string;
  source: "cbu" | "erapi";
}

// 1-manba: cbu.uz (rasmiy)
async function fetchCbu(code: string): Promise<RateInfo | null> {
  const data = await fetchJson(`${CBU_URL}/${code}/`);
  if (!Array.isArray(data) || !data.length) return null;
  const item = data[0] as CbuRate;
  const rate = parseFloat(item.Rate);
  const nominal = parseInt(item.Nominal, 10) || 1;
  if (!isFinite(rate)) return null;
  return { perUnit: rate / nominal, ccy: item.Ccy, name: item.CcyNm_UZ, date: item.Date, source: "cbu" };
}

// 2-manba: open.er-api.com (global rezerv)
async function fetchErApi(code: string): Promise<RateInfo | null> {
  const data = (await fetchJson(`${ERAPI_URL}/${code}`)) as
    | { result?: string; rates?: Record<string, number>; time_last_update_utc?: string }
    | null;
  const uzs = data?.rates?.UZS;
  if (!data || data.result !== "success" || typeof uzs !== "number") return null;
  const date = data.time_last_update_utc?.slice(5, 16) ?? "";
  return { perUnit: uzs, ccy: code, name: code, date, source: "erapi" };
}

async function resolveRate(code: string): Promise<RateInfo | null> {
  return (await fetchCbu(code)) ?? (await fetchErApi(code));
}

// Raqamli kurs (1 birlik uchun UZS). Token hisoboti va boshqalar uchun.
export async function getRateValue(code: string): Promise<number | null> {
  const info = await resolveRate(normalizeCode(code));
  return info ? info.perUnit : null;
}

export async function getCurrencyRate(currency: string, amount = 1): Promise<string> {
  const code = normalizeCode(currency);
  const info = await resolveRate(code);
  if (!info)
    return "Valyuta kursini hozir olib bo'lmadi (ikkala manba ham javob bermadi). Birozdan keyin qayta urinib ko'ring.";

  const fmtUzs = (n: number) => Math.round(n).toLocaleString("ru-RU");
  const qty = amount > 0 ? amount : 1;

  return JSON.stringify({
    valyuta: `${info.ccy}${info.name !== info.ccy ? ` (${info.name})` : ""}`,
    kurs: `1 ${info.ccy} = ${fmtUzs(info.perUnit)} so'm`,
    miqdor: qty > 1 ? `${qty} ${info.ccy} = ${fmtUzs(info.perUnit * qty)} so'm` : undefined,
    sana: info.date || undefined,
    manba: info.source === "cbu" ? "Markaziy bank" : "open.er-api.com",
  });
}
