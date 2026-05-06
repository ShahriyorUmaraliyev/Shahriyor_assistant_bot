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
// gemini-2.0-flash: transcription uchun yetarli va arzonroq (2.5-flash thinking
// tokenlari bu yerda keraksiz). generateContent() — startChat()+tools+audio
// kombinatsiyasidan farqli ishonchli. contents explicit — Part[] shorthand bilan
// audio SDK tomonidan o'tkazib yuboriladi.

export async function transcribeVoice(audioBuffer: Buffer): Promise<string> {
  // gemini-2.5-flash: audio input qo'llab-quvvatlaydi; thinkingBudget:0 bilan
  // thinking tokenlar sarflanmaydi — transcription uchun thinking keraksiz
  const model = getGenAI().getGenerativeModel({
    model: "gemini-2.5-flash",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } } as any,
  });
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
                text: "Transcribe this audio message. Return only the spoken words, no explanations.",
              },
            ],
          },
        ],
      }),
      GEMINI_TIMEOUT_MS
    )
  );
  const text = result.response.text().trim();
  if (!text) throw new Error("VOICE_TRANSCRIPTION_FAILED");
  return text;
}

// ─── 3. Audio Output: Matn → Gemini TTS → WAV ────────────────────────────────
// lamejs (MP3) ishlatilmaydi — Node.js da MPEGMode not defined xatosi beradi.
// WAV = 44-byte header + raw PCM16 — hech qanday kutubxona shart emas.
// Telegram sendVoice WAV formatini qabul qiladi.

export async function textToSpeech(text: string): Promise<Buffer> {
  const model = getGenAI().getGenerativeModel({ model: "gemini-2.5-flash-preview-tts" });

  // responseModalities SDK typingda yo'q — any orqali yuboramiz
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const generateFn = model.generateContent.bind(model) as (req: any) => Promise<any>;
  const result = await withRetry(() =>
    withTimeout(
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
    )
  );

  const candidates = result?.response?.candidates;
  const candidate = candidates?.[0];
  const part = candidate?.content?.parts?.[0];
  const data: string | undefined = part?.inlineData?.data;

  if (!data) {
    console.error("[TTS] Audio data yo'q! Sabab:", JSON.stringify({
      candidatesCount: candidates?.length ?? 0,
      finishReason: candidate?.finishReason ?? "candidates bo'sh",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      promptFeedback: (result?.response as any)?.promptFeedback ?? null,
      mimeType: part?.inlineData?.mimeType ?? null,
      hasText: !!part?.text,
      textPreview: part?.text?.slice(0, 200) ?? null,
    }));
    throw new Error("TTS_NO_AUDIO");
  }

  // MIME type "audio/L16;codec=pcm;rate=24000" dan sample rate ni ajratib olamiz
  const mimeType: string = part?.inlineData?.mimeType ?? "audio/pcm";
  const rateMatch = mimeType.match(/rate=(\d+)/i);
  const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24_000;

  return pcm16ToWav(Buffer.from(data, "base64"), sampleRate);
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
