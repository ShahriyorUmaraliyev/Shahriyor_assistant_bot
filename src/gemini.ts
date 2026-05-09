import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import type { UserMemory, ChatMessage } from "./types";
import { patchMemory, getMemory } from "./memory";
import { scheduleReminder, cancelReminder, getReminders } from "./reminder";
import { sendUserMessage, sendUserVoiceMessage } from "./userclient";
import { getCalendarEvents, addCalendarEvent } from "./gcalendar";
import { readSheet, appendSheetRow, updateSheetCell } from "./gsheets";
import { getCurrentWeather, getForecastWeather } from "./weather";

// Gemini API client — lazy singleton (audio.ts ham shu instansni ishlatadi)
let _genAI: GoogleGenerativeAI | null = null;
export function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  return _genAI;
}

function logTokenUsage(label: string, response: { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number } }): void {
  const u = response.usageMetadata;
  if (!u) return;
  console.log(
    `[Gemini:${label}] prompt=${u.promptTokenCount ?? 0} output=${u.candidatesTokenCount ?? 0}` +
    (u.thoughtsTokenCount ? ` thinking=${u.thoughtsTokenCount}` : "") +
    ` total=${u.totalTokenCount ?? 0}`
  );
}

// Cloud Run timeout 300s — Gemini ga 50s beramiz (ovozli xabar pipeline uchun yetarli)
export const GEMINI_TIMEOUT_MS = 50_000;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`GEMINI_TIMEOUT: ${ms}ms dan oshib ketdi`)), ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

function isBillingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return lower.includes("prepayment") || lower.includes("credits are depleted") || lower.includes("billing");
}

export function classifyGeminiError(err: unknown): "billing" | "rate_limit" | "timeout" | "safety" | "unknown" {
  const msg = err instanceof Error ? err.message : String(err);
  if (isBillingError(err)) return "billing";
  if (msg.includes("429") || msg.toLowerCase().includes("quota") || msg.toLowerCase().includes("exhausted")) return "rate_limit";
  if (msg.includes("GEMINI_TIMEOUT")) return "timeout";
  if (msg.includes("SAFETY")) return "safety";
  return "unknown";
}

function isRetryable(err: unknown): boolean {
  if (isBillingError(err)) return false;
  const msg = err instanceof Error ? err.message : String(err);
  // GEMINI_TIMEOUT ni retry qilma — "50000ms" ichida "500" bor, false positive beradi
  if (msg.includes("GEMINI_TIMEOUT")) return false;
  return (
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("500") ||
    msg.toLowerCase().includes("too many requests") ||
    msg.toLowerCase().includes("service unavailable") ||
    msg.toLowerCase().includes("socket") ||
    msg.toLowerCase().includes("network")
  );
}

export async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (isRetryable(err) && attempt < retries) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ─── Markdown escape (MarkdownV1: * _ ` [ ) ──────────────────────────────────

function escapeMd(text: string): string {
  return text.replace(/[_*`[]/g, "\\$&");
}

// ─── System Prompt ────────────────────────────────────────────────────────────

function compactMemory(memory: UserMemory): string {
  const parts: string[] = [];
  const contacts    = Object.entries(memory.contacts ?? {}).slice(-30);
  const products    = Object.entries(memory.products ?? {}).slice(-30);
  const notes       = (memory.notes ?? []).slice(-10);
  const preferences = (memory.preferences ?? []).slice(-20);
  if (contacts.length > 0)
    parts.push(`contacts:${JSON.stringify(Object.fromEntries(contacts))}`);
  if (products.length > 0)
    parts.push(`products:${JSON.stringify(Object.fromEntries(products))}`);
  if (notes.length > 0)
    parts.push(`notes:${JSON.stringify(notes)}`);
  if (preferences.length > 0)
    parts.push(`preferences:${JSON.stringify(preferences)}`);
  return parts.length > 0 ? parts.join("\n") : "(bo'sh)";
}

export function buildSystemPrompt(memory: UserMemory, mode: "text" | "voice" = "text"): string {
  const today = new Date().toLocaleDateString("uz-UZ", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  const modeNote = mode === "voice"
    ? `JORIY REJIM: OVOZLI.
TEXNIK ARXITEKTURA: sen faqat matn yozasan → sistema uni TTS orqali AVTOMATIK ovozga aylantiradi → foydalanuvchiga ovozli xabar sifatida yuboradi. Bu jarayon har doim ishlaydi.
QOIDA: hech qachon "ovozli xabar yubora olmayman" / "faqat matn" / "imkonim yo'q" dema — bu mutlaqo noto'g'ri.
FARQ (MUHIM):
• Foydalanuvchi senden savol so'rasa yoki suhbat qilsa → shunchaki matn yoz, sistema ovozga aylantiradi. send_voice_message CHAQIRMA.
• Foydalanuvchi "Azizaga", "Bobonga", "do'stimga" kabi KONTAKT nomini aytib ovozli xabar yuborishni so'rasa → send_voice_message tool chaqir.`
    : "JORIY REJIM: MATN — javoblar matn sifatida keladi. /voice buyrug'i bilan ovozli rejimga o'tish mumkin.";

  return `Shahriyor Umaraliyevning shaxsiy AI assistantisman. Parfyumeriya/kosmetika biznesi, Toshkent. Bugun: ${today} (UTC+5).
TIL: O'zbek (foydalanuvchi boshqa tilda yozsa — o'sha tilda). USLUB: qisqa, aniq.
${modeNote}
QOBILIYAT: Matn/ovoz qabul + yuborish. Ob-havo, eslatmalar, kontaktlar, xabar yuborish, Google Calendar (taqvim), Google Sheets (jadval). Real vaqt yangiliklari uchun /search.
XOTIRA:\n${compactMemory(memory)}
QOIDALAR:
- kontakt/narx/tavsif → update_memory
- vaqtli eslatma → set_reminder (ISO 8601 +05:00) | "ertaga"=ertangi kun | soat yo'q: ertalab=09:00, tush=14:00, kech=18:00 | "soat 1-11" = kechqurun (13:00-23:00), ya'ni "soat 3"=15:00, "soat 9"=21:00
- kontaktga MATNLI xabar yuborish → send_message tool ni DARHOL chaqir, hech qanday tekshiruvsiz
- kontaktga OVOZLI xabar yuborish → send_voice_message tool ni DARHOL chaqir, hech qanday tekshiruvsiz
- MUHIM: "ulanganmi", "imkon bor" kabi savollarni hech qachon berma — tool ni chaqir, natijani ko'r
- MUHIM: tool avval xato bergan bo'lsa ham — QAYTA chaqir, hech qachon "ishlamaydi" deb o'z-o'zidan javob berma
- MUHIM: eslatmalar (set_reminder) FAQAT Shahriyorning o'ziga keladi. Boshqalarga xabar yuborish uchun send_message yoki send_voice_message ishlatiladi.
- taqvim ko'rish/qo'shish → get_calendar / add_calendar_event | end yo'q bo'lsa: start + 1 soat
- jadval o'qish → read_sheet | jadvalga yozish → append_sheet | katak yangilash → update_sheet_cell
- AVTOMATIK JADVAL QOIDALARI (foydalanuvchi "yoz", "saqlа" demasa ham):
  • kunlik xarajat (kafe, restoran, transport, bozor, do'kon, oziq-ovqat, kommunal + summa) → "Xarajatlar" sheetga darhol append_sheet, format: "DD.MM.YYYY|kategoriya|tavsif|summa (raqam)|"
  • mahsulot/tovar narxi (parfyum, kosmetika, kiyim, telefon, texnika, har qanday tovar + narx) → "Mahsulotlar" sheetga darhol append_sheet, format: "DD.MM.YYYY|mahsulot nomi|narxi (raqam)|miqdori (yo'q bo'lsa 1)|jami"
  • kategoriyani o'zing aniqlа: "kafe 30000" → kategoriya="Ovqat", tavsif="kafe"
  • summani raqamga aylantir: "50 ming"→50000, "1.2M"→1200000, "500k"→500000
  • append_sheet dan KEYIN qisqa tasdiqlov: "✅ Xarajatlar ga yozildi: kafe — 30 000 so'm"
- foydalanuvchi xulq-atvor/format ko'rsatmasi bersа ("bunday qil", "shunday yoz") → update_memory preference sifatida saqlа, DARHOL o'sha uslubda davom et
- XOTIRA da preferences bo'lsa — ularni HAR DOIM qat'iy bajar`;
}

// ─── Tool Declarations ────────────────────────────────────────────────────────

export const updateMemoryTool = {
  name: "update_memory",
  description:
    "Kontakt, mahsulot narxi, muhim ma'lumot yoki foydalanuvchi xulq-atvor ko'rsatmasini doimiy xotiraga yozish. " +
    "Foydalanuvchi ism, telefon, narx, tavsif, buyurtma YOKI format/uslub ko'rsatmasi aytganda chaqiring.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      contacts: {
        type: SchemaType.STRING,
        description: 'Kontaktlar JSON formatida: {"Ism": {"phone": "+998...", "notes": "..."}}',
      },
      products: {
        type: SchemaType.STRING,
        description: 'Mahsulotlar JSON formatida: {"Chanel No5": {"price": 450000, "description": "50ml"}}',
      },
      note: {
        type: SchemaType.STRING,
        description: 'Muhim yozuv. Misol: "Akbar 5 dona buyurtma, payshanba yetkazish"',
      },
      preference: {
        type: SchemaType.STRING,
        description: 'Foydalanuvchi xulq-atvor/format ko\'rsatmasi. Misol: "qidiruv natijalarini har birida inline link bilan ko\'rsat", "javoblarni qisqa yoz", "doim o\'zbek tilida javob ber"',
      },
    },
  },
};

export const setReminderTool = {
  name: "set_reminder",
  description:
    "Telegram orqali aniq vaqtda eslatma yuborish. " +
    '"Ertaga soat 10da X", "Dushanbaga Y ni eslatib qo\'y" so\'rovlarida chaqiring.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      text: {
        type: SchemaType.STRING,
        description: "Foydalanuvchiga yuboriladigan eslatma matni",
      },
      time: {
        type: SchemaType.STRING,
        description: "ISO 8601, Toshkent vaqti. Misol: 2026-05-03T15:00:00+05:00",
      },
    },
    required: ["text", "time"],
  },
};


export const sendMessageTool = {
  name: "send_message",
  description:
    "Foydalanuvchi (Shahriyor) nomidan kontaktga Telegram MATNLI xabar yuborish. " +
    "Kontakt ismi yoki telefon raqami kerak. Foydalanuvchi xabar yuborishni so'raganda DARHOL chaqir.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      contact: {
        type: SchemaType.STRING,
        description: "Kontakt ismi (xotiradagidan telefon topiladi), yoki to'g'ridan telefon (+998...) yoki @username",
      },
      message: {
        type: SchemaType.STRING,
        description: "Yuboriladigan xabar matni",
      },
    },
    required: ["contact", "message"],
  },
};

export const getWeatherTool = {
  name: "get_weather",
  description:
    "Shahar ob-havosini olish — bugungi yoki kelgusi kunlar uchun. " +
    "Ob-havo, harorat, yog'ingarchilik, shamol so'rovlarida DARHOL chaqiring. " +
    "\"Ertangi\", \"keyingi 3 kun\", \"5 kunlik\" deyilsa days parametrini bering.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      city: {
        type: SchemaType.STRING,
        description: 'Shahar nomi inglizcha. Misol: "Tashkent", "Moscow", "Dubai"',
      },
      days: {
        type: SchemaType.NUMBER,
        description: "Necha kun bashorat. 0=bugun, 1=ertangi, 2-5=kelgusi kunlar. Standart: 0.",
      },
    },
    required: ["city"],
  },
};

export const sendVoiceMessageTool = {
  name: "send_voice_message",
  description:
    "Foydalanuvchi (Shahriyor) nomidan kontaktga Telegram OVOZLI xabar yuborish. " +
    "'X ga ovozli xabar yubor', 'ovozli ayt', 'audio xabar jo'nat' so'rovlarida DARHOL chaqir. " +
    "Kontakt ismi yoki telefon raqami kerak.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      contact: {
        type: SchemaType.STRING,
        description: "Kontakt ismi (xotiradagidan telefon topiladi), yoki to'g'ridan telefon (+998...) yoki @username",
      },
      message: {
        type: SchemaType.STRING,
        description: "Ovozga aylantirib yuborish uchun matn. Qisqa va aniq bo'lsin (max 800 belgi).",
      },
    },
    required: ["contact", "message"],
  },
};

export const listRemindersTool = {
  name: "list_reminders",
  description:
    "Barcha rejalashtirilgan eslatmalarni ko'rish. " +
    "\"Eslatmalarimni ko'rsat\", \"Qanday eslatmalar bor\", \"Eslatmalar ro'yxati\" so'rovlarida chaqiring.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {},
  },
};

export const cancelReminderTool = {
  name: "cancel_reminder",
  description:
    "Rejalashtirilgan eslatmani bekor qilish. " +
    "\"Eslatmani o'chir\", \"Bekor qil\", \"Ertangi soat 10 dagi eslatmani olib tashla\" so'rovlarida chaqiring. " +
    "Avval list_reminders bilan ro'yxatni oling, keyin ID yoki matn bo'yicha qidiring.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      id: {
        type: SchemaType.STRING,
        description: "Eslatma ID si (list_reminders dan olingan oxirgi 8 belgi yoki to'liq ID)",
      },
      text_hint: {
        type: SchemaType.STRING,
        description: "Eslatma matni bo'yicha qidiruv (ID ma'lum bo'lmasa). Masalan: 'uchrashuv', 'dori'",
      },
    },
  },
};

export const getCalendarTool = {
  name: "get_calendar",
  description:
    "Google Calendar dan kelgusi tadbirlar va eslatmalarni ko'rish. " +
    "\"Bugun nima bor?\", \"Bu hafta nima rejalashtirilgan?\", \"Taqvimim\", \"Uchrashuvlar\", " +
    "\"Calendarda nima bor?\", \"Calendarda eslatma bor?\", \"Rejalarim\" so'rovlarida DARHOL chaqiring. " +
    "Avval xato bergan bo'lsa ham — har doim chaqir, natijani ko'r.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      days: {
        type: SchemaType.NUMBER,
        description: "Necha kunni ko'rish. Standart: 7. Bugun=1, bu hafta=7, bu oy=30.",
      },
    },
  },
};

export const addCalendarEventTool = {
  name: "add_calendar_event",
  description:
    "Google Calendar ga yangi tadbir qo'shish. " +
    "\"Uchrashuv qo'y\", \"Eslatma qo'sh\", \"Kalendarimga qo'sh\" so'rovlarida chaqiring.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      title: {
        type: SchemaType.STRING,
        description: "Tadbir nomi. Misol: \"Sardorbek bilan uchrashuv\"",
      },
      start: {
        type: SchemaType.STRING,
        description: "Boshlanish vaqti ISO 8601 (+05:00). Misol: \"2026-05-10T14:00:00+05:00\"",
      },
      end: {
        type: SchemaType.STRING,
        description: "Tugash vaqti ISO 8601 (+05:00). Misol: \"2026-05-10T15:00:00+05:00\"",
      },
      description: {
        type: SchemaType.STRING,
        description: "Qo'shimcha tavsif (ixtiyoriy).",
      },
      location: {
        type: SchemaType.STRING,
        description: "Manzil (ixtiyoriy). Misol: \"Toshkent, Chilonzor\"",
      },
    },
    required: ["title", "start", "end"],
  },
};

export const readSheetTool = {
  name: "read_sheet",
  description:
    "Google Sheets dan ma'lumot o'qish. " +
    "\"Jadvaldan ko'rsat\", \"Buyurtmalar ro'yxati\", \"Mahsulotlar narxi\" so'rovlarida chaqiring. " +
    "Sheet nomi va diapazon ko'rsating.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      range: {
        type: SchemaType.STRING,
        description: "Diapazon. Misol: \"Buyurtmalar!A1:F20\", \"Sheet1\", \"Mahsulotlar!A:D\"",
      },
    },
    required: ["range"],
  },
};

export const appendSheetTool = {
  name: "append_sheet",
  description:
    "Google Sheets ga yangi qator qo'shish. " +
    "Aniq so'rov bo'lmasa ham AVTOMATIK chaqir: " +
    "kunlik xarajat (kafe/transport/bozor + summa) → sheet=\"Xarajatlar\", values=\"DD.MM.YYYY|kategoriya|tavsif|summa|\"; " +
    "mahsulot narxi (parfyum/kosmetika/tovar + narx) → sheet=\"Mahsulotlar\", values=\"DD.MM.YYYY|nom|narx|miqdor|jami\".",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      sheet: {
        type: SchemaType.STRING,
        description: "Sheet nomi: \"Xarajatlar\" (kunlik harajatlar) | \"Mahsulotlar\" (tovar narxlari) | boshqa sheet nomi",
      },
      values: {
        type: SchemaType.STRING,
        description:
          "Qator qiymatlari | bilan ajratilgan.\n" +
          "Xarajatlar: \"09.05.2026|Ovqat|kafe|30000|\"\n" +
          "Mahsulotlar: \"09.05.2026|Chanel No5|850000|1|850000\"\n" +
          "Summalar faqat raqam (50 ming→50000, 1.2M→1200000).",
      },
    },
    required: ["sheet", "values"],
  },
};

export const updateSheetTool = {
  name: "update_sheet_cell",
  description:
    "Google Sheets dagi bitta katakni yangilash. " +
    "\"5-qatordagi narxni o'zgartir\", \"B5 ni yangilab\" so'rovlarida chaqiring.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      range: {
        type: SchemaType.STRING,
        description: "Katak manzili. Misol: \"Sheet1!B5\", \"Buyurtmalar!D12\"",
      },
      value: {
        type: SchemaType.STRING,
        description: "Yangi qiymat.",
      },
    },
    required: ["range", "value"],
  },
};

// ─── Function Call Handler ────────────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  userId: number
): Promise<string> {
  if (name === "update_memory") {
    const patch: any = { ...args };
    const failures: string[] = [];
    if (typeof patch.contacts === "string") {
      try { patch.contacts = JSON.parse(patch.contacts); }
      catch { delete patch.contacts; failures.push("contacts"); console.warn("[update_memory] contacts JSON parse xato:", patch.contacts); }
    }
    if (typeof patch.products === "string") {
      try { patch.products = JSON.parse(patch.products); }
      catch { delete patch.products; failures.push("products"); console.warn("[update_memory] products JSON parse xato:", patch.products); }
    }
    await patchMemory(userId, patch);
    if (failures.length) return `Xotira qisman yangilandi. Saqlanmadi: ${failures.join(", ")} (format xato).`;
    if (patch.preference) return `Ko'rsatma saqlandi: "${patch.preference}"`;
    return "Xotira yangilandi.";
  }
  if (name === "set_reminder") {
    const { text, time } = args as { text: string; time: string };
    const id = await scheduleReminder(userId, text, time);
    return `Eslatma rejalashtirildi (id: ${id}).`;
  }
  if (name === "send_message") {
    const { contact, message } = args as { contact: string; message: string };
    let recipient = contact;
    // Telefon/username bo'lmasa — xotiradan qidirish
    if (!contact.startsWith("+") && !contact.startsWith("@")) {
      const memory = await getMemory(userId);
      const lower = contact.toLowerCase();
      for (const [cname, data] of Object.entries(memory.contacts)) {
        if (cname.toLowerCase() === lower || (lower.length >= 3 && cname.toLowerCase().includes(lower))) {
          if (data.phone) { recipient = data.phone; break; }
        }
      }
      if (recipient === contact)
        return `"${contact}" kontaktining telefon raqami xotirada topilmadi. Avval kontakt raqamini saqlang.`;
    }
    await sendUserMessage(userId, recipient, message);
    return `Xabar yuborildi.`;
  }
  if (name === "list_reminders") {
    const reminders = await getReminders(userId);
    const now = Math.floor(Date.now() / 1000);
    const upcoming = reminders
      .filter((r) => r.notBefore > now)
      .sort((a, b) => a.notBefore - b.notBefore);
    if (!upcoming.length) return "Rejalashtirilgan eslatma yo'q.";
    return upcoming
      .map((r, i) => {
        const d = new Date(r.notBefore * 1000);
        const fmt = d.toLocaleString("uz-UZ", {
          timeZone: "Asia/Tashkent",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        return `${i + 1}. ${fmt} — "${r.text}" (ID: ${r.id.slice(-8)})`;
      })
      .join("\n");
  }
  if (name === "cancel_reminder") {
    const { id, text_hint } = args as { id?: string; text_hint?: string };
    const reminders = await getReminders(userId);
    const now = Math.floor(Date.now() / 1000);
    const upcoming = reminders.filter((r) => r.notBefore > now);
    let target = upcoming.find((r) => id && (r.id === id || r.id.endsWith(id)));
    if (!target && text_hint) {
      const hint = text_hint.toLowerCase();
      target = upcoming.find((r) => r.text.toLowerCase().includes(hint));
    }
    if (!target) return "Bekor qilinishi kerak bo'lgan eslatma topilmadi. Avval eslatmalar ro'yxatini ko'ring.";
    const ok = await cancelReminder(userId, target.id);
    return ok
      ? `✅ Eslatma bekor qilindi: "${target.text}"`
      : "Eslatma topilmadi yoki allaqachon yuborilgan.";
  }
  if (name === "get_weather") {
    const { city, days } = args as { city: string; days?: number };
    if (days && days > 0) return await getForecastWeather(city, days);
    return await getCurrentWeather(city);
  }
  if (name === "get_calendar") {
    const days = typeof args.days === "number" ? args.days : 7;
    return await getCalendarEvents(Math.min(Math.max(days, 1), 90));
  }
  if (name === "add_calendar_event") {
    const { title, start, description, location } = args as {
      title: string; start: string; description?: string; location?: string;
    };
    // end berilmasa system prompt qoidasiga ko'ra start + 1 soat
    const end = (args.end as string | undefined) ??
      new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString();
    return await addCalendarEvent(title, start, end, description, location);
  }
  if (name === "read_sheet") {
    const { range } = args as { range: string };
    return await readSheet(range);
  }
  if (name === "append_sheet") {
    const { sheet } = args as { sheet: string };
    const rawValues = args.values;
    const cells = Array.isArray(rawValues)
      ? (rawValues as unknown[]).map(String)
      : String(rawValues).split("|").map((v) => v.trim());
    return await appendSheetRow(sheet, cells);
  }
  if (name === "update_sheet_cell") {
    const { range, value } = args as { range: string; value: string };
    return await updateSheetCell(range, value);
  }
  if (name === "send_voice_message") {
    const { contact, message } = args as { contact: string; message: string };
    let recipient = contact;
    // Telefon/username bo'lmasa — xotiradan qidirish
    if (!contact.startsWith("+") && !contact.startsWith("@")) {
      const memory = await getMemory(userId);
      const lower = contact.toLowerCase();
      for (const [cname, data] of Object.entries(memory.contacts)) {
        if (cname.toLowerCase() === lower || (lower.length >= 3 && cname.toLowerCase().includes(lower))) {
          if (data.phone) { recipient = data.phone; break; }
        }
      }
      if (recipient === contact)
        return `"${contact}" kontaktining telefon raqami xotirada topilmadi. Avval kontakt raqamini saqlang.`;
    }
    const { textToSpeech } = await import("./audio");
    const safeMsg = message.slice(0, 800);
    try {
      const audioBuffer = await textToSpeech(safeMsg);
      await sendUserVoiceMessage(userId, recipient, audioBuffer);
      return `Ovozli xabar yuborildi: "${safeMsg.slice(0, 50)}${safeMsg.length > 50 ? "…" : ""}"`;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.error("[send_voice_message] xato:", msg);
      if (msg.includes("TTS_NO_AUDIO"))
        return `Ovozli xabar yaratib bo'lmadi (TTS xato). "${recipient}" ga matnli xabar yuborishni buyuring.`;
      if (msg.includes("USERCLIENT_TIMEOUT"))
        return "Telegram bilan aloqa uzilib qoldi. Qayta urinib ko'ring.";
      return `Ovozli xabar yuborishda xato: ${msg.slice(0, 100)}`;
    }
  }
  return "Noma'lum funksiya.";
}

// ─── generateReply ────────────────────────────────────────────────────────────

// Har bir history xabarini 500 belgiga cheklash — uzun javoblar token isrof qilmasin
function trimHistory(history: ChatMessage[]): { role: string; parts: { text: string }[] }[] {
  return history.map((m) => ({
    role: m.role,
    parts: [{ text: m.text.length > 500 ? m.text.slice(0, 500) + "…" : m.text }],
  }));
}

function buildSearchSystemPrompt(memory: UserMemory): string {
  const base = buildSystemPrompt(memory, "text");
  return `${base}
QIDIRUV FORMATI — QAT'IY QOIDALAR:
1. Har bir yangilik/element ALOHIDA paragraf bo'lsin (ular orasida bo'sh qator).
2. Format: "Sarlavha: tavsif 1-2 jumla." — boshqa narsa yo'q.
3. Seksiya sarlavhalari, bold (**), list belgisi (*/-) ISHLATMA — oddiy matn yoz.
4. MAX 5 ta element.
5. Linklar sistema tomonidan AVTOMATIK qo'shiladi — sen hech qachon link yozma.`
}

export async function generateWithSearch(
  userText: string,
  history: ChatMessage[],
  memory: UserMemory,
  _mode: "text" | "voice" = "text"
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = getGenAI().getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: buildSearchSystemPrompt(memory),
    tools: [{ googleSearch: {} }] as any,
    // Grounding results are already factual — thinking tokens not needed
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } } as any,
  });

  // generateContent — history yuborilmaydi: Google Search o'zi yangi ma'lumot beradi,
  // history = ortiqcha tokenlar sarfi.
  const result = await withRetry(() =>
    withTimeout(
      model.generateContent({
        contents: [
          { role: "user", parts: [{ text: userText }] },
        ],
      } as any),
      GEMINI_TIMEOUT_MS
    )
  );

  logTokenUsage("search", result.response as any);

  const text = result.response.text()?.trim();
  if (!text) return "🔍 Qidiruv natijasi topilmadi. Boshqacha so'rab ko'ring.";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = (result.response as any).candidates?.[0]?.groundingMetadata;
  const chunks: Array<{ web?: { uri?: string; title?: string } }> = meta?.groundingChunks ?? [];
  const supports: Array<{
    groundingChunkIndices?: number[];
    segment?: { endIndex?: number };
  }> = meta?.groundingSupports ?? [];

  if (!chunks.length) return text;

  // Har bir paragrafning oxiriga tegishli manba linkini qo'shish.
  // groundingSupports: text segment (endIndex) → chunk indeks.
  // Paragraflarni ajratib, har biriga eng yaqin support ni topamiz.

  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim());

  // Har bir support uchun: char offset va uri
  type SegLink = { endIndex: number; uri: string; title: string };
  const segLinks: SegLink[] = [];
  for (const s of supports) {
    const idx = s.groundingChunkIndices?.[0];
    if (idx === undefined) continue;
    const web = chunks[idx]?.web;
    if (!web?.uri || !web?.title) continue;
    segLinks.push({
      endIndex: s.segment?.endIndex ?? 0,
      uri: web.uri,
      title: web.title,
    });
  }

  if (!segLinks.length) {
    // Fallback: barcha manbalar pastda
    const all = chunks
      .map((c) => c.web)
      .filter((w): w is { uri: string; title: string } => !!(w?.uri && w?.title))
      .filter((w, i, a) => a.findIndex((x) => x.uri === w.uri) === i)
      .slice(0, 5)
      .map((w) => {
        const uri = w.uri.replace(/_/g, "%5F").replace(/\)/g, "%29");
        return `• [${escapeMd(w.title)}](${uri})`;
      });
    return all.length ? `${text}\n\n📎 *Manbalar:*\n${all.join("\n")}` : text;
  }

  // Har bir paragrafning taxminiy char offset ini hisoblash
  let offset = 0;
  const paraOffsets: number[] = [];
  for (const p of paragraphs) {
    paraOffsets.push(offset);
    offset += p.length + 2; // +2 = "\n\n"
  }

  // Har paragraf uchun: o'sha paragraf ichiga tushadigan segLink lar
  const usedUris = new Set<string>();
  const result2 = paragraphs.map((para, i) => {
    const start = paraOffsets[i];
    const end = start + para.length;
    // Bu paragraf oralig'iga to'g'ri keladigan linklar
    const matched = segLinks.filter(
      (s) => s.endIndex > start && s.endIndex <= end + 50
    );
    const unique = matched.filter((s) => !usedUris.has(s.uri));
    if (!unique.length) return para;
    // Birinchi moslashgan linkni ishlatamiz
    usedUris.add(unique[0].uri);
    const safeUri = unique[0].uri.replace(/_/g, "%5F").replace(/\)/g, "%29");
    return `${para}\n[Havola ↗](${safeUri})`;
  });

  // Ishlatilmagan linklar pastda
  const unused = segLinks
    .filter((s) => !usedUris.has(s.uri))
    .filter((s, i, a) => a.findIndex((x) => x.uri === s.uri) === i)
    .slice(0, 3)
    .map((s) => {
      const uri = s.uri.replace(/_/g, "%5F").replace(/\)/g, "%29");
      return `• [${escapeMd(s.title)}](${uri})`;
    });

  const body = result2.join("\n\n");
  return unused.length ? `${body}\n\n📎 *Boshqa manbalar:*\n${unused.join("\n")}` : body;
}

export async function generateReply(
  userText: string,
  history: ChatMessage[],
  memory: UserMemory,
  userId: number,
  mode: "text" | "voice" = "text"
): Promise<string> {
  const safeText = userText.length > 2000 ? userText.slice(0, 2000) + "…" : userText;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = getGenAI().getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: buildSystemPrompt(memory, mode),
    tools: [
      { functionDeclarations: [
        updateMemoryTool, setReminderTool, listRemindersTool, cancelReminderTool,
        getWeatherTool, sendMessageTool, sendVoiceMessageTool,
        getCalendarTool, addCalendarEventTool,
        readSheetTool, appendSheetTool, updateSheetTool,
      ]},
    ] as any,
    // Tool calls don't benefit from thinking — disable to save tokens
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } } as any,
  });

  // Oxirgi 6 xabar (3 almashuv) — kontekst uchun yetarli, ortiqcha token sarflanmaydi
  // Gemini SDK: history har doim "user" bilan boshlanishi kerak
  const rawHistory = trimHistory(history).slice(-6);
  const safeHistory = rawHistory.length > 0 && rawHistory[0].role !== "user"
    ? rawHistory.slice(1)
    : rawHistory;
  const chat = model.startChat({ history: safeHistory });

  let result = await withRetry(() =>
    withTimeout(chat.sendMessage(safeText), GEMINI_TIMEOUT_MS)
  );

  // Tool loop: max 1 marta — shaxsiy assistant uchun 1 tool call yetarli
  const calls = result.response.functionCalls();
  console.log(`[Gemini:tools] ${calls?.length ? calls.map(c => c.name).join(", ") : "tool chaqirilmadi"}`);
  if (calls?.length) {
    const toolResults = await Promise.all(
      calls.map(async (call) => {
        let toolResult: string;
        try {
          toolResult = await handleTool(call.name, call.args as Record<string, unknown>, userId);
        } catch (err) {
          console.error(`Tool "${call.name}" xatosi:`, err);
          toolResult = `Xatolik: ${err instanceof Error ? err.message : String(err)}`;
        }
        return { functionResponse: { name: call.name, response: { result: toolResult } } };
      })
    );
    result = await withRetry(() =>
      withTimeout(chat.sendMessage(toolResults), GEMINI_TIMEOUT_MS)
    );
  }

  logTokenUsage("reply", result.response as any);
  try {
    return result.response.text() || "Bajarildi.";
  } catch {
    return "Vazifa bajarildi, lekin matnli javob yaratilmadi.";
  }
}
