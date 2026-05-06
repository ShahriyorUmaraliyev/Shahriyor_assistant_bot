import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import type { UserMemory, ChatMessage } from "./types";
import { patchMemory, getMemory } from "./memory";
import { scheduleReminder } from "./reminder";
import { getCurrentWeather } from "./weather";
import { sendUserMessage } from "./userclient";

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
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`GEMINI_TIMEOUT: ${ms}ms dan oshib ketdi`)),
        ms
      )
    ),
  ]);
}

function is429(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("429") || msg.toLowerCase().includes("too many requests");
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

export async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // Billing xatolarini qayta urinmaslik — ular hech qachon o'z-o'zidan hal bo'lmaydi
      if (is429(err) && !isBillingError(err) && attempt < retries) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Unreachable");
}

// ─── System Prompt ────────────────────────────────────────────────────────────

function compactMemory(memory: UserMemory): string {
  const parts: string[] = [];
  // Max 30 kontakt, 30 mahsulot, 10 oxirgi yozuv — system prompt portlamasligi uchun
  const contacts = Object.entries(memory.contacts ?? {}).slice(-30);
  const products = Object.entries(memory.products ?? {}).slice(-30);
  const notes    = (memory.notes ?? []).slice(-10);
  if (contacts.length > 0)
    parts.push(`contacts:${JSON.stringify(Object.fromEntries(contacts))}`);
  if (products.length > 0)
    parts.push(`products:${JSON.stringify(Object.fromEntries(products))}`);
  if (notes.length > 0)
    parts.push(`notes:${JSON.stringify(notes)}`);
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
TEXNIK ARXITEKTURA: sen faqat matn yozasan → sistema uni TTS orqali AVTOMATIK ovozga aylantiradi → Telegram ovozli xabar sifatida yuboradi. Bu jarayon har doim ishlaydi.
QOIDA: hech qachon "ovozli xabar yubora olmayman" / "faqat matn" / "imkonim yo'q" dema — bu mutlaqo noto'g'ri.
MISOL: foydalanuvchi "salom deb ovozli xabar yubor" desa → sen shunchaki "Salom!" deb yoz → sistema ovozga aylantiradi.`
    : "JORIY REJIM: MATN — javoblar matn sifatida keladi. /voice buyrug'i bilan ovozli rejimga o'tish mumkin.";

  return `Shahriyor Umaraliyevning shaxsiy AI assistantisman. Parfyumeriya/kosmetika biznesi, Toshkent. Bugun: ${today} (UTC+5).
TIL: O'zbek (foydalanuvchi boshqa tilda yozsa — o'sha tilda). USLUB: qisqa, aniq.
${modeNote}
QOBILIYAT: Matn va ovozli xabarlarni qabul qilaman, javoblarni ovoz yoki matn sifatida yubora olaman. Ob-havo, eslatmalar, kontaktlar va xabar yuborish imkonim bor. Real vaqt ma'lumotlari uchun /search ishlatiladi.
XOTIRA:\n${compactMemory(memory)}
QOIDALAR:
- kontakt/narx/tavsif → update_memory
- vaqtli eslatma → set_reminder (ISO 8601 +05:00) | "ertaga"=ertangi kun | soat yo'q: ertalab=09:00, tush=14:00, kech=18:00 | "soat 1-11" = kechqurun (13:00-23:00), ya'ni "soat 3"=15:00, "soat 9"=21:00
- kontaktga MATNLI xabar yuborish → send_message (xotirada telefon bo'lishi shart; /auth_tg ulanmagan bo'lsa ayta)
- kontaktga OVOZLI xabar yuborish → send_voice_message (xuddi send_message kabi, lekin audio sifatida yetkaziladi)
- MUHIM: eslatmalar (set_reminder) FAQAT Shahriyorning o'ziga keladi. Boshqalarga xabar yuborish uchun send_message yoki send_voice_message ishlatiladi.`;
}

// ─── Tool Declarations ────────────────────────────────────────────────────────

export const updateMemoryTool = {
  name: "update_memory",
  description:
    "Kontakt, mahsulot narxi yoki muhim ma'lumotni doimiy xotiraga yozish. " +
    "Foydalanuvchi ism, telefon, narx, tavsif yoki buyurtma aytganda chaqiring.",
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

export const getWeatherTool = {
  name: "get_weather",
  description:
    "Shahar ob-havosini real vaqtda olish. Foydalanuvchi ob-havo, harorat, " +
    "yog'ingarchlik, shamol haqida so'raganda chaqiring.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      city: {
        type: SchemaType.STRING,
        description: 'Shahar nomi inglizcha. Misol: "Tashkent", "Moscow", "Dubai"',
      },
    },
    required: ["city"],
  },
};

export const sendMessageTool = {
  name: "send_message",
  description:
    "Foydalanuvchi (Shahriyor) nomidan kontaktga Telegram MATNLI xabar yuborish. " +
    "Hisobi /auth_tg orqali ulanган bo'lishi kerak. Kontakt telefon xotirada saqlangan bo'lishi kerak.",
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

export const sendVoiceMessageTool = {
  name: "send_voice_message",
  description:
    "Foydalanuvchi (Shahriyor) nomidan kontaktga Telegram OVOZLI xabar yuborish. " +
    "'X ga ovozli xabar yubor', 'ovozli ayt', 'audio xabar jo'nat' so'rovlarida ishlatiladi. " +
    "Xotirada telefon bo'lishi va /auth_tg orqali hisob ulanган bo'lishi kerak.",
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

// ─── Function Call Handler ────────────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  userId: number
): Promise<string> {
  if (name === "update_memory") {
    const patch: any = { ...args };
    if (typeof patch.contacts === "string") {
      try { patch.contacts = JSON.parse(patch.contacts); } catch (e) { delete patch.contacts; }
    }
    if (typeof patch.products === "string") {
      try { patch.products = JSON.parse(patch.products); } catch (e) { delete patch.products; }
    }
    await patchMemory(userId, patch);
    return "Xotira yangilandi.";
  }
  if (name === "set_reminder") {
    const { text, time } = args as { text: string; time: string };
    const id = await scheduleReminder(userId, text, time);
    return `Eslatma rejalashtirildi (id: ${id}).`;
  }
  if (name === "get_weather") {
    const { city } = args as { city: string };
    return await getCurrentWeather(city);
  }
  if (name === "send_message") {
    const { contact, message } = args as { contact: string; message: string };
    let recipient = contact;
    // Telefon/username bo'lmasa — xotiradan qidirish
    if (!contact.startsWith("+") && !contact.startsWith("@")) {
      const memory = await getMemory(userId);
      const lower = contact.toLowerCase();
      for (const [name, data] of Object.entries(memory.contacts)) {
        if (name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase())) {
          if (data.phone) { recipient = data.phone; break; }
        }
      }
      if (recipient === contact)
        return `"${contact}" kontaktining telefon raqami xotirada topilmadi. Avval kontakt raqamini saqlang.`;
    }
    await sendUserMessage(userId, recipient, message);
    return `Xabar yuborildi.`;
  }
  if (name === "send_voice_message") {
    const { contact, message } = args as { contact: string; message: string };
    let recipient = contact;
    // Telefon/username bo'lmasa — xotiradan qidirish
    if (!contact.startsWith("+") && !contact.startsWith("@")) {
      const memory = await getMemory(userId);
      const lower = contact.toLowerCase();
      for (const [cname, data] of Object.entries(memory.contacts)) {
        if (cname.toLowerCase().includes(lower) || lower.includes(cname.toLowerCase())) {
          if (data.phone) { recipient = data.phone; break; }
        }
      }
      if (recipient === contact)
        return `"${contact}" kontaktining telefon raqami xotirada topilmadi. Avval kontakt raqamini saqlang.`;
    }
    // Dynamic import — audio.ts gemini.ts dan import qiladi, sirkular importni oldini olish
    const { textToSpeech } = await import("./audio");
    const { sendUserVoiceMessage } = await import("./userclient");
    const safeMsg = message.slice(0, 800);
    const audioBuffer = await textToSpeech(safeMsg);
    await sendUserVoiceMessage(userId, recipient, audioBuffer);
    return `Ovozli xabar yuborildi: "${safeMsg.slice(0, 50)}${safeMsg.length > 50 ? "…" : ""}"`;
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

export async function generateWithSearch(
  userText: string,
  history: ChatMessage[],
  memory: UserMemory,
  mode: "text" | "voice" = "text"
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = getGenAI().getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: buildSystemPrompt(memory, mode),
    tools: [{ googleSearch: {} }] as any,
    // Grounding results are already factual — thinking tokens not needed
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } } as any,
  });

  // generateContent (startChat emas) — Google grounding uchun tavsiya etilgan usul.
  // Oxirgi 2 history xabari: search o'zi yangi ma'lumot beradi, ko'p context keraksiz.
  const recentHistory = trimHistory(history).slice(-2);
  const result = await withRetry(() =>
    withTimeout(
      model.generateContent({
        contents: [
          ...recentHistory,
          { role: "user", parts: [{ text: userText }] },
        ],
      } as any),
      GEMINI_TIMEOUT_MS
    )
  );

  logTokenUsage("search", result.response as any);

  const text = result.response.text()?.trim();
  if (!text) return "🔍 Qidiruv natijasi topilmadi. Boshqacha so'rab ko'ring.";
  return text;
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
      { functionDeclarations: [updateMemoryTool, setReminderTool, getWeatherTool, sendMessageTool, sendVoiceMessageTool] },
    ] as any,
    // Tool calls don't benefit from thinking — disable to save tokens
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } } as any,
  });

  // Oxirgi 6 xabar (3 almashuv) — kontekst uchun yetarli, ortiqcha token sarflanmaydi
  const chat = model.startChat({ history: trimHistory(history).slice(-6) });

  let result = await withRetry(() =>
    withTimeout(chat.sendMessage(safeText), GEMINI_TIMEOUT_MS)
  );

  // Tool loop: max 1 marta — shaxsiy assistant uchun 1 tool call yetarli
  const calls = result.response.functionCalls();
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
