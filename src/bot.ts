import type { TelegramMessage } from "./types";
import { getHistory, saveHistory, clearHistory, getUserMode, setUserMode } from "./redis";
import { getMemory } from "./memory";
import { generateReply, buildSystemPrompt, classifyGeminiError } from "./gemini";
import { downloadVoice, replyToVoice, textToSpeech } from "./audio";
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
    new Blob([mp3Buffer], { type: "audio/mpeg" }),
    "reply.mp3"
  );
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000); // fayl yuklash uchun 15 sek
  try {
    const res = await fetch(`${TG}/sendVoice`, {
      method: "POST",
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Telegram sendVoice xatosi: ${res.status}`);
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
  if (msg.includes("AUDIO_TOO_LARGE"))
    return "📦 Audio fayl 20 MB dan katta. Qisqaroq xabar yuboring.";
  if (msg.includes("AUDIO_DOWNLOAD_TIMEOUT"))
    return "⏱ Audio yuklab olishda vaqt tugadi (10 sek). Qayta urinib ko'ring.";
  if (msg.includes("TELEGRAM_FILE_ERROR"))
    return "❌ Telegram faylni topib bo'lmadi. Qayta yuboring.";
  if (msg.includes("TTS_NO_AUDIO"))
    return "🔇 Ovozli javob yaratib bo'lmadi. Matn rejimiga o'tildi.";
  return "❌ Audio qayta ishlashda xatolik. Qayta urinib ko'ring.";
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
        "Keyin chiqgan session stringni Vercel → Settings → Environment Variables ga\n" +
        "`TELEGRAM_SESSION` nomi bilan qo'shing va redeploy qiling."
      );
    }
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

    let reply: string;
    try {
      reply = await replyToVoice(
        audioBuffer,
        history,
        memory,
        buildSystemPrompt(memory),
        userId
      );
    } catch (err) {
      console.error("replyToVoice xatosi:", err);
      await sendMessage(chatId, geminiErrorMessage(err));
      return;
    }

    await saveHistory(userId, [
      ...history,
      { role: "user", text: "[Ovozli xabar]", timestamp: Date.now() },
      { role: "model", text: reply, timestamp: Date.now() },
    ]).catch(console.error);

    await deliverReply(chatId, reply, mode);
    return;
  }

  // ── Matnli xabar ──────────────────────────────────────────────────────────

  if (text) {
    let reply: string;
    try {
      reply = await generateReply(text, history, memory, userId);
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

    await deliverReply(chatId, reply, mode);
  }
}

// ─── Reply delivery: matn yoki ovoz ──────────────────────────────────────────

async function deliverReply(
  chatId: number,
  text: string,
  mode: "text" | "voice"
): Promise<void> {
  if (text.length > 4000) {
    text = text.slice(0, 4000) + "\n\n... [Xabar uzunligi sababli qisqartirildi]";
  }

  if (mode !== "voice") {
    await sendMessage(chatId, text);
    return;
  }

  const ttsText = text.length > 800 ? text.slice(0, 800) + "…" : text;
  try {
    const mp3 = await textToSpeech(ttsText);
    await sendVoiceMessage(chatId, mp3);
  } catch (err) {
    console.error("TTS xatosi:", err);
    await sendMessage(
      chatId,
      `🔇 _Ovozli javob yaratib bo'lmadi — matn sifatida:_\n\n${text}`
    );
  }
}
