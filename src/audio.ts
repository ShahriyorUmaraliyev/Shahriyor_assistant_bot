import { getGenAI, withTimeout, withRetry, GEMINI_TIMEOUT_MS } from "./gemini";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // 20 MB
const DOWNLOAD_TIMEOUT_MS = 10_000;       // 10 sekund

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN sozlanmagan");
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

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

// ─── 2. Audio Input: OGG → matn (transcription) ──────────────────────────────

// Transkripsiya odatda 2-5s oladi. Voice pipeline (transkripsiya + AI + TTS) Cloud Run
// 300s limitiga sig'ishi uchun bu bosqichni cheklaymiz: 30s timeout + 1 retry.
const TRANSCRIBE_TIMEOUT_MS = 30_000;

export async function transcribeVoice(audioBuffer: Buffer): Promise<string> {
  const model = getGenAI().getGenerativeModel({ model: "gemini-2.5-flash" });
  const result = await withRetry(() =>
    withTimeout(
      model.generateContent({
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: "audio/ogg",
                  data: audioBuffer.toString("base64"),
                },
              },
              {
                text: "Transcribe this audio exactly as spoken. Auto-detect the language (Uzbek, Russian, English, or any other). Return only the transcribed words — no explanations, no translations.",
              },
            ],
          },
        ],
      }),
      TRANSCRIBE_TIMEOUT_MS
    ),
    1 // faqat 1 marta qayta urinish — kechikishni cheklash uchun
  );
  const text = result.response.text().trim();
  if (!text) throw new Error("VOICE_TRANSCRIPTION_FAILED");
  return text;
}

// ─── 3. Audio Output: Matn → Gemini TTS → WAV ────────────────────────────────
// SDK (@google/generative-ai) responseModalities/speechConfig ni ishonchsiz o'tkazadi.
// Shuning uchun to'g'ridan REST API ishlatamiz — parametrlar aniq JSON da ketadi.
// WAV = 44-byte RIFF header + raw PCM16 — hech qanday kutubxona shart emas.

const TTS_MODEL = "gemini-2.5-flash-preview-tts";

export async function textToSpeech(text: string): Promise<Buffer> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY yo'q");

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${TTS_MODEL}:generateContent?key=${apiKey}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
    },
  });

  // Umumiy TTS deadline — retry'lar Cloud Run 300s limitini yeb qo'ymasligi uchun.
  // Transkripsiya (50s) + generateReply (50s) dan keyin TTS ga ~60s qoladi.
  const TTS_TOTAL_BUDGET_MS = 60_000;
  const ttsStart = Date.now();

  // finishReason:OTHER vaqtinchalik Gemini xatosi — to'liq tsikl 3 marta retry
  for (let attempt = 0; attempt <= 3; attempt++) {
    // Byudjet tugagan bo'lsa — boshqa retry qilmaymiz
    if (Date.now() - ttsStart > TTS_TOTAL_BUDGET_MS) {
      console.error(`[TTS] Umumiy byudjet (${TTS_TOTAL_BUDGET_MS}ms) tugadi, to'xtatildi`);
      throw new Error("TTS_NO_AUDIO");
    }
    // Qolgan byudjetga moslab har urinishga timeout beramiz
    const remaining = Math.max(5_000, TTS_TOTAL_BUDGET_MS - (Date.now() - ttsStart));
    const attemptTimeout = Math.min(GEMINI_TIMEOUT_MS, remaining);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: any;
    try {
      json = await withTimeout(
        (async () => {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });
          if (!res.ok) {
            const errBody = await res.text().catch(() => "");
            console.error(`[TTS] HTTP ${res.status}:`, errBody.slice(0, 300));
            throw new Error(`${res.status} TTS_HTTP`);
          }
          return res.json();
        })(),
        attemptTimeout
      );
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("GEMINI_TIMEOUT")) throw new Error("GEMINI_TIMEOUT");
      // 429/503 → retry
      if ((msg.includes("429") || msg.includes("503")) && attempt < 3) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 2_000));
        continue;
      }
      throw err;
    }

    const candidate = json?.candidates?.[0];
    const part      = candidate?.content?.parts?.[0];
    const data: string | undefined = part?.inlineData?.data;

    if (!data) {
      console.error(`[TTS] Audio yo'q (attempt ${attempt + 1}):`, JSON.stringify({
        finishReason: candidate?.finishReason ?? "yo'q",
        mimeType    : part?.inlineData?.mimeType ?? null,
      }));
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 2_000));
        continue;
      }
      throw new Error("TTS_NO_AUDIO");
    }

    const mimeType   = (part?.inlineData?.mimeType as string) ?? "audio/pcm";
    const rateMatch  = mimeType.match(/rate=(\d+)/i);
    const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24_000;
    return pcm16ToWav(Buffer.from(data, "base64"), sampleRate);
  }

  throw new Error("TTS_NO_AUDIO");
}

// ─── PCM16 → WAV (kutubxonasiz, faqat header + data) ─────────────────────────
// Gemini TTS "audio/L16;codec=pcm;rate=24000" formatida PCM16 qaytaradi.
// WAV = RIFF header (44 bayt) + raw PCM16 ma'lumot.

function pcm16ToWav(pcmBuffer: Buffer, sampleRate: number = 24_000): Buffer {
  const CHANNELS    = 1;
  const BITS        = 16;
  const byteRate    = sampleRate * CHANNELS * BITS / 8;
  const blockAlign  = CHANNELS * BITS / 8;
  const dataSize    = pcmBuffer.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);              // fmt chunk size
  header.writeUInt16LE(1, 20);               // PCM = 1
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  const wav = Buffer.concat([header, pcmBuffer]);
  if (wav.length <= 44) throw new Error("TTS_NO_AUDIO");
  return wav;
}
