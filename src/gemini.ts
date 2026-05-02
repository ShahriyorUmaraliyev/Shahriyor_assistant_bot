import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import type { UserMemory, ChatMessage } from "./types";
import { patchMemory } from "./memory";
import { scheduleReminder } from "./reminder";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// Vercel limit 30s — Gemini ga 25s beramiz
const GEMINI_TIMEOUT_MS = 25_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
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

// ─── System Prompt ────────────────────────────────────────────────────────────

export function buildSystemPrompt(memory: UserMemory): string {
  const today = new Date().toLocaleDateString("uz-UZ", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  return `Siz Shahriyor Umaraliyevning shaxsiy AI assistantsiz.

KONTEKST:
- Shahriyor Toshkentda parfyumeriya va kosmetika biznesini yuritadi
- Kontaktlar, narxlar, buyurtmalar, eslatmalar — biznes ma'lumotlari muhim
- Bugun: ${today} (Toshkent vaqti, UTC+5)

TIL:
- Asosan O'ZBEK tilida javob bering
- Foydalanuvchi rus/ingliz yozsa — o'sha tilda javob bering

USLUB:
- Qisqa va aniq, ortiqcha gap yo'q
- Narx hisoblash: chegirma, foiz, solishtirma — barchasini bajaring

JORIY XOTIRA:
${JSON.stringify(memory, null, 2)}

QOIDALAR:
- Kontakt/telefon/narx/tavsif aytilsa → update_memory chaqiring
- "Eslatib qo'y" / vaqt aytilsa → set_reminder chaqiring (ISO 8601, +05:00)
- "Ertaga" = ertangi sana, "Dushanba" = kelayotgan dushanba
- Soat aytilmasa: ertalab = 09:00, tushdan keyin = 14:00, kechqurun = 18:00
- Joriy narx/yangilik/ob-havo → Google Search avtomatik`;
}

// ─── Tool Declarations ────────────────────────────────────────────────────────

const updateMemoryTool = {
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

const setReminderTool = {
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

async function handleTool(
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

export async function generateReply(
  userText: string,
  history: ChatMessage[],
  memory: UserMemory,
  userId: number
): Promise<string> {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: buildSystemPrompt(memory),
    tools: [
      { googleSearch: {} } as never,
      { functionDeclarations: [updateMemoryTool, setReminderTool] },
    ],
  });

  const chat = model.startChat({
    history: history.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
  });

  let result = await withTimeout(
    chat.sendMessage(userText),
    GEMINI_TIMEOUT_MS
  );

  let loopCount = 0;
  while (loopCount < 3) {
    loopCount++;
    const calls = result.response.functionCalls();
    if (!calls?.length) break;

    const toolResults = await Promise.all(
      calls.map(async (call) => ({
        functionResponse: {
          name: call.name,
          response: {
            result: await handleTool(
              call.name,
              call.args as Record<string, unknown>,
              userId
            ),
          },
        },
      }))
    );

    result = await withTimeout(
      chat.sendMessage(toolResults),
      GEMINI_TIMEOUT_MS
    );
  }

  try {
    return result.response.text() || "Bajarildi.";
  } catch (err) {
    return "Vazifa bajarildi, lekin matnli javob yaratilmadi.";
  }
}
