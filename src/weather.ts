interface OWMResponse {
  name: string;
  sys: { country: string };
  main: {
    temp: number;
    feels_like: number;
    temp_min: number;
    temp_max: number;
    humidity: number;
  };
  weather: Array<{ description: string }>;
  wind: { speed: number };
}

const OWM_URL = "https://api.openweathermap.org/data/2.5/weather";
const TIMEOUT_MS = 5_000;

export async function getCurrentWeather(city: string): Promise<string> {
  const apiKey = process.env.OPENWEATHERMAP_API_KEY;
  if (!apiKey) return "Ob-havo xizmati sozlanmagan (OPENWEATHERMAP_API_KEY yo'q).";

  const url = `${OWM_URL}?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric&lang=uz`;

  let res: Response;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      res = await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    if ((err as Error).name === "AbortError")
      return "Ob-havo ma'lumoti olishda vaqt tugadi (5s).";
    throw err;
  }

  if (res.status === 404)
    return `"${city}" shahri topilmadi. Inglizcha to'g'ri nom kiriting (masalan: Tashkent).`;
  if (res.status === 401) return "Ob-havo API kaliti noto'g'ri.";
  if (!res.ok) return `Ob-havo xizmati xatosi: ${res.status}.`;

  const d = (await res.json()) as OWMResponse;

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
