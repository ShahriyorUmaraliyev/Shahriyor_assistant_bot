import type { TelegramMessage } from "./types";
import { getHistory, saveHistory, clearHistory, getUserMode, setUserMode } from "./redis";
import { getMemory } from "./memory";
import { generateReply, generateWithSearch, classifyGeminiError } from "./gemini";
import { downloadVoice, transcribeVoice, textToSpeech } from "./audio";
import { hasSession } from "./userclient";

// ─── Auth ─────────────────────────────────────────────────────────────────────

const allowedIds = new Set<number>(
  (process.env.ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => !isNaN(n) && n > 0)
);

function isAllowed(userId: number): boolean {
  return allowedIds.has(userId);
}

// ─── Telegram API helpers ─────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN sozlanmagan");
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

const TG_TIMEOUT_MS = 8_000; // Telegram API uchun 8 soniya yetarli

async function tgFetch(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TG_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("TELEGRAM_TIMEOUT");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function sendMessage(chatId: number, text: string): Promise<void> {
  let res = await tgFetch(`${TG}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  if (!res.ok) {
    res = await tgFetch(`${TG}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      console.error(`Telegram xatosi: ${await res.text()}`);
    }
  }
}

async function sendTyping(chatId: number): Promise<void> {
  await tgFetch(`${TG}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {}); // typing xatosi kritik emas
}

async function sendVoiceMessage(chatId: number, mp3Buffer: Buffer): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(
    "voice",
    new Blob([mp3Buffer], { type: "audio/wav" }),
    "reply.wav"
  );
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000); // fayl yuklash uchun 15 sek
  try {
    const res = await fetch(`${TG}/sendVoice`, {
      method: "POST",
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // VOICE_MESSAGES_FORBIDDEN — Telegram sozlamalarida ovozli xabarlar o'chirilgan
      if (body.includes("VOICE_MESSAGES_FORBIDDEN")) throw new Error("VOICE_MESSAGES_FORBIDDEN");
      throw new Error(`Telegram sendVoice xatosi: ${res.status} — ${body.slice(0, 200)}`);
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("TELEGRAM_TIMEOUT");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Error messages (O'zbek tili) ─────────────────────────────────────────────

function geminiErrorMessage(err: unknown): string {
  switch (classifyGeminiError(err)) {
    case "billing":
      return "💳 Gemini API kredit tugagan. Google AI Studio da kredit qo'shing: aistudio.google.com";
    case "rate_limit":
      return "⚠️ AI so'rovlar chegarasiga yetdi. 10-15 soniyadan keyin qayta urinib ko'ring.";
    case "timeout":
      return "⏱ Javob olish uzoq vaqt ketdi. Iltimos, qayta yuboring.";
    case "safety":
      return "🚫 Bu so'rovni bajarib bo'lmadi. Boshqacha so'rab ko'ring.";
    default:
      return "❌ Texnik xatolik yuz berdi. Qayta urinib ko'ring.";
  }
}

function audioErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[audioError] raw:", msg);
  if (msg.includes("AUDIO_TOO_LARGE"))
    return "📦 Audio fayl 20 MB dan katta. Qisqaroq xabar yuboring.";
  if (msg.includes("AUDIO_DOWNLOAD_TIMEOUT"))
    return "⏱ Audio yuklab olishda vaqt tugadi. Qayta urinib ko'ring.";
  if (msg.includes("TELEGRAM_FILE_ERROR"))
    return "❌ Telegram faylni topib bo'lmadi. Qayta yuboring.";
  if (msg.includes("VOICE_TRANSCRIPTION_FAILED"))
    return "🎤 Ovozni matnga aylantirib bo'lmadi. Qayta urinib ko'ring.";
  if (msg.includes("TTS_NO_AUDIO"))
    return "🔇 Ovozli javob yaratib bo'lmadi. Matn rejimiga o'tildi.";
  if (msg.includes("GEMINI_TIMEOUT"))
    return "⏱ AI javob berishda vaqt tugadi (25 sek). Qayta urinib ko'ring.";
  if (msg.includes("404") || msg.includes("not found") || msg.includes("NOT_FOUND"))
    return "❌ AI modeli topilmadi. Dastur xatoligi — admin xabardor qilindi.";
  if (msg.includes("429") || msg.includes("quota") || msg.includes("RESOURCE_EXHAUSTED"))
    return "⚠️ AI so'rovlar chegarasiga yetdi. 10-15 soniyadan keyin qayta urinib ko'ring.";
  if (msg.includes("TELEGRAM_TIMEOUT"))
    return "⏱ Telegram server javob bermadi. Qayta urinib ko'ring.";
  return `❌ Audio xatolik: ${msg.slice(0, 80)}`;
}

// ─── Message Handler ──────────────────────────────────────────────────────────

export async function handleMessage(message: TelegramMessage): Promise<void> {
  const userId = message.from?.id;
  const chatId = message.chat.id;

  if (!userId) return;
  if (!isAllowed(userId)) {
    console.log(`⚠️ Bloklangan/Ruxsatsiz foydalanuvchi yozdi: ID=${userId}`);
    return;
  }

  const text = message.text?.trim();
  const voice = message.voice;

  if (!text && !voice) {
    await sendMessage(chatId, "Bunday turni tushunmayman. Hozircha faqat matn va ovozli xabarlarga javob bera olaman.");
    return;
  }

  // ── Komandalar ──────────────────────────────────────────────────────────────

  if (text === "/start") {
    await sendMessage(
      chatId,
      "Salom! Men *Shahriyor Assist* — sizning shaxsiy AI assistantingizman 🤖\n\n" +
        "• Ovozli xabar yuboring — tushunib javob beraman\n" +
        "• /search \\<so'rov\\> — Google orqali real vaqt qidiruv\n" +
        "• /voice — ovozli javob rejimi\n" +
        "• /text — matn javob rejimi\n" +
        "• /clear — suhbat tarixini tozalash\n" +
        "• /memory — joriy xotirani ko'rish\n" +
        "• /auth\\_tg — Telegram hisobi holati\n\n" +
        "Savolingizni yozing yoki ovozli xabar yuboring!"
    );
    return;
  }

  if (text === "/auth_tg") {
    const connected = await hasSession(userId);
    if (connected) {
      await sendMessage(chatId, "✅ Telegram hisobingiz ulangan. Kontaktlarga xabar yuborishim mumkin.");
    } else {
      await sendMessage(
        chatId,
        "❌ Telegram hisobi ulanmagan.\n\n" +
        "Ulanish uchun lokal kompyuterda quyidagini bajaring:\n" +
        "```\nnode scripts/generate-session.mjs\n```\n" +
        "Keyin chiqgan session stringni Cloud Run → Edit & Deploy → Environment Variables ga\n" +
        "`TELEGRAM_SESSION` nomi bilan qo'shing va redeploy qiling."
      );
    }
    return;
  }

  if (text === "/search" || text?.startsWith("/search ")) {
    const query = text.slice("/search".length).trim();
    if (!query) {
      await sendMessage(chatId, "🔍 Qidiruv so'rovini kiriting.\nMisol: `/search bugungi AI yangiliklari`");
      return;
    }

    const [, history, memory, mode] = await Promise.all([
      sendTyping(chatId),
      getHistory(userId),
      getMemory(userId),
      getUserMode(userId),
    ]);

    // Telegram typing 5s da o'chadi — search 10-30s oladi, har 4s da yangilaymiz
    const typingTimer = setInterval(() => sendTyping(chatId).catch(() => {}), 4_000);

    let reply: string;
    try {
      reply = await generateWithSearch(query, history, memory, mode);
    } catch (err) {
      console.error("generateWithSearch xatosi:", err);
      await sendMessage(chatId, geminiErrorMessage(err));
      return;
    } finally {
      clearInterval(typingTimer);
    }

    await saveHistory(userId, [
      ...history,
      { role: "user", text: query, timestamp: Date.now() },
      { role: "model", text: reply, timestamp: Date.now() },
    ]).catch(console.error);

    await deliverReply(chatId, reply, mode, userId);
    return;
  }

  if (text === "/clear") {
    await clearHistory(userId);
    await sendMessage(chatId, "✅ Suhbat tarixi tozalandi. Xotira saqlanib qoldi.");
    return;
  }

  if (text === "/memory") {
    const memory = await getMemory(userId);
    let json = JSON.stringify(memory, null, 2);
    if (json.length > 4000) json = json.slice(0, 4000) + "\n... (qisqartirildi)";
    await sendMessage(chatId, `📦 *Joriy xotira:*\n\`\`\`json\n${json}\n\`\`\``);
    return;
  }

  if (text === "/voice") {
    await setUserMode(userId, "voice");
    await sendMessage(chatId, "🔊 Ovozli javob rejimi yoqildi. /text — matn rejimine qaytish.");
    return;
  }

  if (text === "/text") {
    await setUserMode(userId, "text");
    await sendMessage(chatId, "💬 Matn javob rejimi yoqildi.");
    return;
  }

  // ── Ma'lumotlarni parallel yuklash ─────────────────────────────────────────

  await sendTyping(chatId);

  const [history, memory, mode] = await Promise.all([
    getHistory(userId),
    getMemory(userId),
    getUserMode(userId),
  ]);

  // ── Ovozli xabar (INPUT) ───────────────────────────────────────────────────

  if (voice) {
    let audioBuffer: Buffer;
    try {
      audioBuffer = await downloadVoice(voice.file_id, voice.file_size);
    } catch (err) {
      console.error("Voice download xatosi:", err);
      await sendMessage(chatId, audioErrorMessage(err));
      return;
    }

    // 1-qadam: audio → matn (tools yo'q, oddiy generateContent)
    let transcribed: string;
    try {
      transcribed = await transcribeVoice(audioBuffer);
    } catch (err) {
      console.error("Transcription xatosi:", err);
      await sendMessage(chatId, audioErrorMessage(err));
      return;
    }

    // 2-qadam: transcribed matn → javob (xuddi matnli xabar kabi, tools bilan)
    let reply: string;
    try {
      reply = await generateReply(transcribed, history, memory, userId, mode);
    } catch (err) {
      console.error("generateReply (voice) xatosi:", err);
      await sendMessage(chatId, geminiErrorMessage(err));
      return;
    }

    // Tarixda actual matn saqlanadi — keyingi suhbatda context to'g'ri bo'ladi
    await saveHistory(userId, [
      ...history,
      { role: "user", text: `🎤 ${transcribed}`, timestamp: Date.now() },
      { role: "model", text: reply, timestamp: Date.now() },
    ]).catch(console.error);

    await deliverReply(chatId, reply, mode, userId);
    return;
  }

  // ── Matnli xabar ──────────────────────────────────────────────────────────

  if (text) {
    let reply: string;
    try {
      reply = await generateReply(text, history, memory, userId, mode);
    } catch (err) {
      console.error("generateReply xatosi:", err);
      await sendMessage(chatId, geminiErrorMessage(err));
      return;
    }

    await saveHistory(userId, [
      ...history,
      { role: "user", text, timestamp: Date.now() },
      { role: "model", text: reply, timestamp: Date.now() },
    ]).catch(console.error);

    await deliverReply(chatId, reply, mode, userId);
  }
}

// ─── Reply delivery: matn yoki ovoz ──────────────────────────────────────────

async function deliverReply(
  chatId: number,
  text: string,
  mode: "text" | "voice",
  userId?: number
): Promise<void> {
  if (text.length > 4000) {
    text = text.slice(0, 4000) + "\n\n... [Xabar uzunligi sababli qisqartirildi]";
  }

  if (mode !== "voice") {
    await sendMessage(chatId, text);
    return;
  }

  // TTS uchun markdown belgilarini tozalaymiz — aks holda "yulduzcha yulduzcha
  // matn yulduzcha yulduzcha" deb o'qiladi
  const cleaned = text
    .replace(/\*\*(.+?)\*\*/g, "$1")         // **bold** → bold
    .replace(/\*(.+?)\*/g, "$1")             // *italic* → italic
    .replace(/`{1,3}[^`]*`{1,3}/g, "")      // `code` va ```block``` → o'chirish
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [text](url) → text
    .replace(/_{1,2}(.+?)_{1,2}/g, "$1")     // _italic_ → italic
    .replace(/#+\s*/g, "")                    // # Heading → Heading
    .replace(/\n{3,}/g, "\n\n")              // 3+ qator bo'shliq → 2
    .trim();

  const ttsText = cleaned.length > 800 ? cleaned.slice(0, 800) + "…" : cleaned;
  try {
    const mp3 = await textToSpeech(ttsText);
    await sendVoiceMessage(chatId, mp3);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[TTS] FAILED (${errMsg}) — falling back to text`);

    // Telegram ovozli xabarlarni taqiqlagan — avtomatik matn rejimiga o'tish
    if (errMsg.includes("VOICE_MESSAGES_FORBIDDEN") && userId) {
      await setUserMode(userId, "text");
      await sendMessage(
        chatId,
        "⚠️ Telegram ovozli xabarlar yuborishga ruxsat bermadi.\n" +
        "💬 Matn rejimiga o'tkazildi.\n\n" +
        "_Telegram → Settings → Privacy → Voice Messages → Everyone_"
      );
    }
    await sendMessage(chatId, text);
  }
}
