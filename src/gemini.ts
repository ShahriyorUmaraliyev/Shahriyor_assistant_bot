import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import type { UserMemory, ChatMessage } from "./types";
import { patchMemory } from "./memory";
import { scheduleReminder } from "./reminder";

// Gemini API client — lazy
function getGenAI(): GoogleGenerativeAI {
  return new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
}

// Vercel limit 30s — Gemini ga 25s beramiz
export const GEMINI_TIMEOUT_MS = 25_000;

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
  if (memory.contacts && Object.keys(memory.contacts).length > 0)
    parts.push(`contacts:${JSON.stringify(memory.contacts)}`);
  if (memory.products && Object.keys(memory.products).length > 0)
    parts.push(`products:${JSON.stringify(memory.products)}`);
  if (memory.notes && (Array.isArray(memory.notes) ? memory.notes.length > 0 : true))
    parts.push(`notes:${JSON.stringify(memory.notes)}`);
  return parts.length > 0 ? parts.join("\n") : "(bo'sh)";
}

export function buildSystemPrompt(memory: UserMemory): string {
  const today = new Date().toLocaleDateString("uz-UZ", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  return `Shahriyor Umaraliyevning shaxsiy AI assistantisman. Parfyumeriya/kosmetika biznesi, Toshkent. Bugun: ${today} (UTC+5).
TIL: O'zbek (foydalanuvchi boshqa tilda yozsa — o'sha tilda). USLUB: qisqa, aniq.
XOTIRA:\n${compactMemory(memory)}
QOIDALAR: kontakt/narx/tavsif → update_memory | vaqtli eslatma → set_reminder (ISO 8601 +05:00) | "ertaga"=ertangi kun | soat yo'q: ertalab=09:00, tush=14:00, kech=18:00`;
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

export async function generateReply(
  userText: string,
  history: ChatMessage[],
  memory: UserMemory,
  userId: number
): Promise<string> {
  // Xabar uzunligini cheklash — 2000 belgidan oshsa qisqartirish
  const safeText = userText.length > 2000 ? userText.slice(0, 2000) + "…" : userText;

  const model = getGenAI().getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: buildSystemPrompt(memory),
    // googleSearch olib tashlandi — qidiruv har so'rovda $35/1000 qo'shimcha narx qo'shadi
    tools: [{ functionDeclarations: [updateMemoryTool, setReminderTool] }],
  });

  const chat = model.startChat({ history: trimHistory(history) });

  let result = await withRetry(() =>
    withTimeout(chat.sendMessage(safeText), GEMINI_TIMEOUT_MS)
  );

  // Tool loop: max 1 marta — shaxsiy assistant uchun 1 tool call yetarli
  const calls = result.response.functionCalls();
  if (calls?.length) {
    const toolResults = await Promise.all(
      calls.map(async (call) => ({
        functionResponse: {
          name: call.name,
          response: { result: await handleTool(call.name, call.args as Record<string, unknown>, userId) },
        },
      }))
    );
    result = await withRetry(() =>
      withTimeout(chat.sendMessage(toolResults), GEMINI_TIMEOUT_MS)
    );
  }

  try {
    return result.response.text() || "Bajarildi.";
  } catch {
    return "Vazifa bajarildi, lekin matnli javob yaratilmadi.";
  }
}
