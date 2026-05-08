interface OWMCurrent {
  name: string;
  sys: { country: string };
  main: { temp: number; feels_like: number; temp_min: number; temp_max: number; humidity: number };
  weather: Array<{ description: string }>;
  wind: { speed: number };
}

interface OWMForecastItem {
  dt: number;
  main: { temp: number; feels_like: number; temp_min: number; temp_max: number; humidity: number };
  weather: Array<{ description: string }>;
  wind: { speed: number };
  dt_txt: string;
}

interface OWMForecast {
  city: { name: string; country: string };
  list: OWMForecastItem[];
}

const OWM_CURRENT = "https://api.openweathermap.org/data/2.5/weather";
const OWM_FORECAST = "https://api.openweathermap.org/data/2.5/forecast";
const TIMEOUT_MS = 5_000;

async function owmFetch(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Current weather ──────────────────────────────────────────────────────────

export async function getCurrentWeather(city: string): Promise<string> {
  const apiKey = process.env.OPENWEATHERMAP_API_KEY;
  if (!apiKey) return "Ob-havo xizmati sozlanmagan (OPENWEATHERMAP_API_KEY yo'q).";

  const url = `${OWM_CURRENT}?${new URLSearchParams({ q: city, appid: apiKey, units: "metric", lang: "uz" })}`;

  let res: Response;
  try {
    res = await owmFetch(url);
  } catch (err) {
    if ((err as Error).name === "AbortError") return "Ob-havo ma'lumoti olishda vaqt tugadi (5s).";
    return "Ob-havo xizmatiga ulanishda tarmoq xatosi. Qayta urinib ko'ring.";
  }

  if (res.status === 404) return `"${city}" shahri topilmadi. Inglizcha to'g'ri nom kiriting (masalan: Tashkent).`;
  if (res.status === 401) return "Ob-havo API kaliti noto'g'ri.";
  if (!res.ok) return `Ob-havo xizmati xatosi: ${res.status}.`;

  const d = (await res.json()) as OWMCurrent;
  return JSON.stringify({
    shahar: `${d.name}, ${d.sys.country}`,
    harorat: `${Math.round(d.main.temp)}°C`,
    seziladi: `${Math.round(d.main.feels_like)}°C`,
    min_max: `${Math.round(d.main.temp_min)}/${Math.round(d.main.temp_max)}°C`,
    namlik: `${d.main.humidity}%`,
    holat: d.weather[0]?.description ?? "noma'lum",
    shamol: `${d.wind.speed} m/s`,
  });
}

// ─── Forecast (1–5 kun) ───────────────────────────────────────────────────────

export async function getForecastWeather(city: string, days = 1): Promise<string> {
  const apiKey = process.env.OPENWEATHERMAP_API_KEY;
  if (!apiKey) return "Ob-havo xizmati sozlanmagan (OPENWEATHERMAP_API_KEY yo'q).";

  // cnt=40 → 5 kun (har 3 soatda 1 ta, 8 ta × 5 kun)
  const url = `${OWM_FORECAST}?${new URLSearchParams({ q: city, appid: apiKey, units: "metric", lang: "uz", cnt: "40" })}`;

  let res: Response;
  try {
    res = await owmFetch(url);
  } catch (err) {
    if ((err as Error).name === "AbortError") return "Ob-havo ma'lumoti olishda vaqt tugadi (5s).";
    return "Ob-havo xizmatiga ulanishda tarmoq xatosi. Qayta urinib ko'ring.";
  }

  if (res.status === 404) return `"${city}" shahri topilmadi.`;
  if (res.status === 401) return "Ob-havo API kaliti noto'g'ri.";
  if (!res.ok) return `Ob-havo xizmati xatosi: ${res.status}.`;

  const data = (await res.json()) as OWMForecast;
  const safeDays = Math.min(Math.max(days, 1), 5);

  // Toshkent vaqtida kunlarni guruhlash
  const byDay: Record<string, OWMForecastItem[]> = {};
  for (const item of data.list) {
    const date = new Date(item.dt * 1000).toLocaleDateString("uz-UZ", { timeZone: "Asia/Tashkent" });
    (byDay[date] ??= []).push(item);
  }

  const today = new Date().toLocaleDateString("uz-UZ", { timeZone: "Asia/Tashkent" });
  const futureDays = Object.keys(byDay).filter((d) => d !== today).slice(0, safeDays);

  if (!futureDays.length) return "Bashorat ma'lumoti topilmadi.";

  const results = futureDays.map((day) => {
    const items = byDay[day];
    const temps = items.map((i) => i.main.temp);
    const minT = Math.round(Math.min(...temps));
    const maxT = Math.round(Math.max(...temps));
    const midday = items.find((i) => i.dt_txt.includes("12:00")) ?? items[Math.floor(items.length / 2)];
    return JSON.stringify({
      kun: day,
      harorat: `${minT}–${maxT}°C`,
      holat: midday.weather[0]?.description ?? "noma'lum",
      namlik: `${midday.main.humidity}%`,
      shamol: `${midday.wind.speed} m/s`,
    });
  });

  return results.join("\n");
}
