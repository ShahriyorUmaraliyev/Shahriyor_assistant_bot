import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ChatMessage, UserMemory } from "./types";
import { updateMemoryTool, setReminderTool, getWeatherTool, sendMessageTool, handleTool, withTimeout, withRetry, GEMINI_TIMEOUT_MS } from "./gemini";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // 20 MB
const DOWNLOAD_TIMEOUT_MS = 10_000;       // 10 sekund

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN sozlanmagan");
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── Lazy Gemini ──────────────────────────────────────────────────────────────

let _genAI: GoogleGenerativeAI | null = null;
function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  return _genAI;
}

// ─── Fetch with timeout ───────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("AUDIO_DOWNLOAD_TIMEOUT");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── 1. Audio Input: Telegram → Buffer ───────────────────────────────────────

export async function downloadVoice(
  fileId: string,
  fileSize?: number
): Promise<Buffer> {
  if (fileSize && fileSize > MAX_AUDIO_BYTES) throw new Error("AUDIO_TOO_LARGE");

  const infoRes = await fetchWithTimeout(
    `${TG}/getFile?file_id=${encodeURIComponent(fileId)}`,
    DOWNLOAD_TIMEOUT_MS
  );

  if (!infoRes.ok) throw new Error("TELEGRAM_FILE_ERROR");

  const info = (await infoRes.json()) as {
    ok: boolean;
    result: { file_path: string; file_size?: number };
  };

  if (!info.ok) throw new Error("TELEGRAM_FILE_ERROR");
  if (info.result.file_size && info.result.file_size > MAX_AUDIO_BYTES)
    throw new Error("AUDIO_TOO_LARGE");

  const dlRes = await fetchWithTimeout(
    `https://api.telegram.org/file/bot${BOT_TOKEN}/${info.result.file_path}`,
    DOWNLOAD_TIMEOUT_MS
  );

  if (!dlRes.ok) throw new Error("TELEGRAM_FILE_ERROR");

  return Buffer.from(await dlRes.arrayBuffer());
}

// ─── 2. Audio Input: OGG → Gemini multimodal → javob ─────────────────────────

export async function replyToVoice(
  audioBuffer: Buffer,
  history: ChatMessage[],
  memory: UserMemory,
  systemPrompt: string,
  userId: number
): Promise<string> {
  // Audio qayta ishlash uchun thinkingBudget o'chirilmaydi —
  // thinkingBudget:0 multimodal audio ni tushunishga to'sqinlik qiladi
  const model = getGenAI().getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: systemPrompt,
    tools: [{ functionDeclarations: [updateMemoryTool, setReminderTool, getWeatherTool, sendMessageTool] }],
  });

  // Ovozli xabar o'zi kontekst beradi — oxirgi 4 xabar yetarli (token tejash)
  const trimmedHistory = history.slice(-4).map((m) => ({
    role: m.role,
    parts: [{ text: m.text.length > 500 ? m.text.slice(0, 500) + "…" : m.text }],
  }));
  const chat = model.startChat({ history: trimmedHistory });

  let result = await withRetry(() =>
    withTimeout(
      chat.sendMessage([
        { inlineData: { mimeType: "audio/ogg", data: audioBuffer.toString("base64") } },
        { text: "Foydalanuvchi ovozli xabar yubordi. Ovozni eshit, tushun va javob ber. Hech qachon 'ovozni tushuna olmayman' dema — ovozli xabarlarni qayta ishlash qobiliyating bor. Foydalanuvchi qaysi tilda gapirgan bo'lsa o'sha tilda javob ber." },
      ]),
      GEMINI_TIMEOUT_MS
    )
  );

  // Tool loop: max 1 marta
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

  try {
    return result.response.text() || "Bajarildi.";
  } catch {
    return "Vazifa bajarildi, lekin matnli javob yaratilmadi.";
  }
}

// ─── 3. Audio Output: Matn → Gemini TTS → MP3 ────────────────────────────────

export async function textToSpeech(text: string): Promise<Buffer> {
  const model = getGenAI().getGenerativeModel({ model: "gemini-2.5-flash-preview-tts" });

  // responseModalities SDK typingda yo'q — any orqali yuboramiz
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const generateFn = model.generateContent.bind(model) as (req: any) => Promise<any>;
  const result = await withTimeout(
    generateFn({
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
        },
      },
    }),
    GEMINI_TIMEOUT_MS
  );

  const data: string | undefined =
    result?.response?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!data) throw new Error("TTS_NO_AUDIO");

  return pcm16ToMp3(Buffer.from(data, "base64"));
}

// ─── PCM16 → MP3 (lamejs, pure JS) ───────────────────────────────────────────

function pcm16ToMp3(pcmBuffer: Buffer): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const lamejs = require("lamejs") as {
    Mp3Encoder: new (
      channels: number,
      sampleRate: number,
      kbps: number
    ) => {
      encodeBuffer(left: Int16Array): Int8Array;
      flush(): Int8Array;
    };
  };

  const SAMPLE_RATE = 24_000; // Gemini TTS: 24 kHz
  const BLOCK = 1152;          // lamejs chunk size

  const encoder = new lamejs.Mp3Encoder(1, SAMPLE_RATE, 64);
  const samples = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    pcmBuffer.byteLength / 2
  );
  const chunks: Buffer[] = [];

  for (let i = 0; i < samples.length; i += BLOCK) {
    const buf = encoder.encodeBuffer(samples.subarray(i, Math.min(i + BLOCK, samples.length)));
    if (buf.length > 0) chunks.push(Buffer.from(buf));
  }

  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(Buffer.from(tail));

  return Buffer.concat(chunks);
}
