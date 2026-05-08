import type { TelegramMessage, TelegramCallbackQuery } from "./types";
import {
  getHistory, saveHistory, clearHistory, getUserMode, setUserMode,
  getTranslateLang, setTranslateLang, getTranslatePending, setTranslatePending, clearTranslatePending,
} from "./redis";
import { getMemory } from "./memory";
import { generateReply, generateWithSearch, classifyGeminiError } from "./gemini";
import { downloadVoice, transcribeVoice, textToSpeech } from "./audio";
import { hasSession } from "./userclient";
import {
  translateText, translateErrorMessage, langListText,
  TRANSLATE_LANGS, TRANSLATE_KEYBOARD, CHANGE_LANG_KEYBOARD,
} from "./translate";
import { getReminders } from "./reminder";

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

// ─── Doimiy klaviatura (reply keyboard) ──────────────────────────────────────

const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: "🔍 /search"    }, { text: "📦 /memory"   }],
    [{ text: "🌐 /translate" }, { text: "🔊 /voice"    }],
    [{ text: "⏰ /reminders" }, { text: "💬 /text"     }],
    [{ text: "🗑 /clear" }],
  ],
  resize_keyboard: true,
  persistent: true,
};

// ─── Bot komandalarini Telegram ga ro'yxatdan o'tkazish ───────────────────────

export async function setupBotCommands(): Promise<void> {
  await tgFetch(`${TG}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commands: [
        { command: "start",     description: "🤖 Botni ishga tushirish / menyu"              },
        { command: "search",    description: "🔍 Google orqali real vaqt qidiruv"          },
        { command: "translate", description: "🌐 Matnni tarjima qilish"                    },
        { command: "voice",     description: "🔊 Ovozli javob rejimini yoqish"             },
        { command: "text",      description: "💬 Matnli javob rejimini yoqish"             },
        { command: "memory",    description: "📦 Saqlangan xotirani ko'rish"               },
        { command: "clear",     description: "🗑 Suhbat tarixini tozalash"                 },
        { command: "reminders", description: "⏰ Rejalashtirilgan eslatmalarni ko'rish"    },
      ],
    }),
  }).catch((err) => console.error("[setupBotCommands] xato:", err));
}

export async function sendMessage(
  chatId: number,
  text: string,
  extra?: Record<string, unknown>
): Promise<void> {
  const base = { chat_id: chatId, text, parse_mode: "Markdown", ...extra };
  let res = await tgFetch(`${TG}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(base),
  });
  if (!res.ok) {
    // parse_mode xatosi bo'lsa — markdown'siz qayta urinish
    const plain = { chat_id: chatId, text, ...extra };
    res = await tgFetch(`${TG}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plain),
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

  // Tugma matnlarini komandaga aylantirish (masalan "🔍 /search" → "/search")
  const rawText = message.text?.trim();
  const text = rawText?.replace(/^[\p{Emoji}\s]+\//u, "/") ?? rawText;
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
      "Quyidagi tugmalar yoki komandalar orqali boshqaring:",
      { reply_markup: MAIN_KEYBOARD }
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

  if (text === "/reminders") {
    const reminders = await getReminders(userId);
    const now = Math.floor(Date.now() / 1000);
    const upcoming = reminders
      .filter((r) => r.notBefore > now)
      .sort((a, b) => a.notBefore - b.notBefore);
    if (!upcoming.length) {
      await sendMessage(chatId, "📭 Rejalashtirilgan eslatma yo'q.\n\nEslatma qo'shish: \"Ertaga soat 10 da Alibek bilan uchrashuv\"");
      return;
    }
    const lines = upcoming.map((r, i) => {
      const d = new Date(r.notBefore * 1000);
      const fmt = d.toLocaleString("uz-UZ", {
        timeZone: "Asia/Tashkent",
        month: "short",
        day: "numeric",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      return `${i + 1}. 🕐 *${fmt}*\n   ${r.text}`;
    });
    await sendMessage(
      chatId,
      `⏰ *Eslatmalar (${upcoming.length} ta):*\n\n${lines.join("\n\n")}\n\n_Bekor qilish: "Birinchi eslatmani o'chir"_`
    );
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

    // Search natijalari (link, markdown, citation) ovoz sifatida mantiqsiz — har doim matn
    await deliverReply(chatId, reply, "text", userId);
    return;
  }

  if (text === "/clear") {
    await clearHistory(userId);
    await sendMessage(chatId, "✅ Suhbat tarixi tozalandi. Xotira saqlanib qoldi.");
    return;
  }

  if (text === "/memory") {
    const memory = await getMemory(userId);
    const lines: string[] = ["📦 *Joriy xotira:*\n"];

    // Kontaktlar
    const contacts = Object.entries(memory.contacts ?? {});
    if (contacts.length > 0) {
      lines.push("👥 *Kontaktlar:*");
      for (const [name, data] of contacts) {
        const phone = data.phone ? `📞 ${data.phone}` : "";
        const notes = data.notes ? ` — ${data.notes}` : "";
        lines.push(`• ${name}${phone ? ": " + phone : ""}${notes}`);
      }
    } else {
      lines.push("👥 *Kontaktlar:* yo'q");
    }

    // Mahsulotlar
    const products = Object.entries(memory.products ?? {});
    if (products.length > 0) {
      lines.push("\n🛍 *Mahsulotlar:*");
      for (const [name, data] of products) {
        const price = data.price ? `${data.price.toLocaleString()} so'm` : "";
        const desc = data.description ? ` — ${data.description}` : "";
        lines.push(`• ${name}${price ? ": " + price : ""}${desc}`);
      }
    } else {
      lines.push("\n🛍 *Mahsulotlar:* yo'q");
    }

    // Yozuvlar
    const notes = memory.notes ?? [];
    if (notes.length > 0) {
      lines.push("\n📝 *Yozuvlar:*");
      notes.slice(-10).forEach((n, i) => lines.push(`${i + 1}. ${n}`));
    } else {
      lines.push("\n📝 *Yozuvlar:* yo'q");
    }

    // Ko'rsatmalar
    const prefs = memory.preferences ?? [];
    if (prefs.length > 0) {
      lines.push("\n⚙️ *Ko'rsatmalar:*");
      prefs.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
    } else {
      lines.push("\n⚙️ *Ko'rsatmalar:* yo'q");
    }

    let result = lines.join("\n");
    if (result.length > 4000) result = result.slice(0, 4000) + "\n...";
    await sendMessage(chatId, result);
    return;
  }

  if (text === "/translate" || text?.startsWith("/translate ")) {
    const after = text.slice("/translate".length).trim();

    // Yordam: /translate tillar
    if (after === "tillar" || after === "langs" || after === "list") {
      await sendMessage(
        chatId,
        `🌐 *Mavjud tillar:*\n\n${langListText()}\n\n` +
        `_Ishlatish: \`/translate [kod] matn\`_\n` +
        `_Misol: \`/translate fr Bonjour le monde\`_`
      );
      return;
    }

    if (!after) {
      await sendMessage(
        chatId,
        "🌐 *Tarjima qilish:*\n\n" +
        "`/translate matn` — oxirgi tilga tarjima\n" +
        "`/translate [kod] matn` — muayyan tilga tarjima\n\n" +
        "_Misol:_\n" +
        "`/translate Hello world` — oxirgi tanlangan tilga\n" +
        "`/translate fr Hello world` — fransuzchaga\n" +
        "`/translate ja こんにちは` — yaponchaga\n\n" +
        "Barcha tillar: `/translate tillar`"
      );
      return;
    }

    // Birinchi so'z til kodi bo'lishi mumkin (2-3 harf)
    const firstWord = after.split(" ")[0].toLowerCase();
    let targetLangCode: string | null = null;
    let inputText: string;

    if (/^[a-z]{2,3}$/.test(firstWord) && TRANSLATE_LANGS[firstWord]) {
      targetLangCode = firstWord;
      inputText = after.slice(firstWord.length).trim();
      if (!inputText) {
        await sendMessage(chatId, `🌐 \`${firstWord}\` tilga tarjima qilish uchun matn kiriting:\n\`/translate ${firstWord} Salom dunyo\``);
        return;
      }
    } else {
      inputText = after;
    }

    await setTranslatePending(userId, inputText);

    // Til kodi berilgan bo'lsa — to'g'ridan tarjima
    if (targetLangCode) {
      await sendTyping(chatId);
      let translated: string;
      try {
        translated = await translateText(inputText, targetLangCode);
      } catch (err) {
        console.error("translateText xatosi:", err);
        await sendMessage(chatId, translateErrorMessage(err));
        return;
      }
      const lang = TRANSLATE_LANGS[targetLangCode];
      const preview = inputText.length > 120 ? inputText.slice(0, 120) + "…" : inputText;
      await setTranslateLang(userId, targetLangCode);
      await sendMessage(
        chatId,
        `${lang.flag} *${lang.name}:*\n${translated}\n\n_Asl:_ ${preview}`,
        { reply_markup: CHANGE_LANG_KEYBOARD }
      );
      return;
    }

    // Til kodi yo'q — oxirgi tilni ishlatamiz yoki keyboard ko'rsatamiz
    const lastLang = await getTranslateLang(userId);
    if (lastLang && TRANSLATE_LANGS[lastLang]) {
      await sendTyping(chatId);
      let translated: string;
      try {
        translated = await translateText(inputText, lastLang);
      } catch (err) {
        console.error("translateText xatosi:", err);
        await sendMessage(chatId, translateErrorMessage(err));
        return;
      }
      const lang = TRANSLATE_LANGS[lastLang];
      const preview = inputText.length > 120 ? inputText.slice(0, 120) + "…" : inputText;
      await sendMessage(
        chatId,
        `${lang.flag} *${lang.name}:*\n${translated}\n\n_Asl:_ ${preview}`,
        { reply_markup: CHANGE_LANG_KEYBOARD }
      );
    } else {
      await sendMessage(chatId, "🌐 Qaysi tilga tarjima qilsin?", {
        reply_markup: TRANSLATE_KEYBOARD,
      });
    }
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

// ─── Ovozli rejim uchun AI disclaimer filtri ─────────────────────────────────
// AI training datasi "men ovozli xabar yubora olmayman" deydi — bu noto'g'ri.
// System prompt yetarli bo'lmasa — kod darajasida ushlaydi.

function filterVoiceDisclaimers(text: string): string {
  const low = text.toLowerCase();
  const hasDisclaimer =
    (low.includes("ovozli") && (low.includes("olmayman") || low.includes("imkonim yo") || low.includes("yuborolmayman"))) ||
    (low.includes("faqat matn") && low.includes("yubor")) ||
    (low.includes("voice") && (low.includes("cannot") || low.includes("unable") || low.includes("can't")));

  if (!hasDisclaimer) return text;

  console.warn("[VoiceFilter] AI disclaimer aniqlandi, filtrlanyapti");

  // Disclaimer o'z ichiga olgan gaplarni o'chiramiz
  const cleaned = text
    .split(/(?<=[.!?])\s+/)
    .filter(sentence => {
      const s = sentence.toLowerCase();
      return !(
        (s.includes("ovozli") && (s.includes("olmayman") || s.includes("imkonim yo") || s.includes("yuborolmayman"))) ||
        (s.includes("faqat matn") && s.includes("yubor")) ||
        (s.includes("voice") && (s.includes("cannot") || s.includes("unable") || s.includes("can't")))
      );
    })
    .join(" ")
    .trim();

  return cleaned || "Bajarildi.";
}

// ─── answerCallbackQuery — Telegram loading animatsiyasini to'xtatadi ────────

async function answerCallback(callbackId: string, text?: string): Promise<void> {
  await tgFetch(`${TG}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text: text ?? "" }),
  }).catch(() => {}); // kritik emas
}

// ─── Inline keyboard callback handler (tarjima til tanlovi) ──────────────────

export async function handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
  const userId = query.from.id;
  const chatId = query.message?.chat.id;
  const data   = query.data;

  if (!chatId || !data) {
    await answerCallback(query.id);
    return;
  }
  if (!isAllowed(userId)) {
    await answerCallback(query.id, "❌ Ruxsat yo'q");
    return;
  }

  // "tr:change" — til o'zgartirish tugmasi
  if (data === "tr:change") {
    const pending = await getTranslatePending(userId);
    if (!pending) {
      await answerCallback(query.id, "⚠️ Matn topilmadi");
      await sendMessage(chatId, "⚠️ Tarjima matni topilmadi. Qayta `/translate matn` yuboring.");
      return;
    }
    await answerCallback(query.id);
    await sendMessage(chatId, "🌐 Qaysi tilga tarjima qilsin?", {
      reply_markup: TRANSLATE_KEYBOARD,
    });
    return;
  }

  // "tr:{lang}" — til tanlandi
  if (data.startsWith("tr:")) {
    const langCode = data.slice(3);
    const langInfo = TRANSLATE_LANGS[langCode];
    if (!langInfo) {
      await answerCallback(query.id, "❌ Noma'lum til");
      return;
    }

    const pending = await getTranslatePending(userId);
    if (!pending) {
      await answerCallback(query.id, "⚠️ Matn topilmadi");
      await sendMessage(chatId, "⚠️ Tarjima matni topilmadi. Qayta `/translate matn` yuboring.");
      return;
    }

    await answerCallback(query.id, `${langInfo.flag} Tarjima qilinmoqda…`);
    await sendTyping(chatId);

    let translated: string;
    try {
      translated = await translateText(pending, langCode);
    } catch (err) {
      console.error("handleCallbackQuery translateText xatosi:", err);
      await sendMessage(chatId, translateErrorMessage(err));
      return;
    }

    await setTranslateLang(userId, langCode);

    const preview = pending.length > 120 ? pending.slice(0, 120) + "…" : pending;
    await sendMessage(
      chatId,
      `${langInfo.flag} *${langInfo.name}:*\n${translated}\n\n_Asl:_ ${preview}`,
      { reply_markup: CHANGE_LANG_KEYBOARD }
    );
    return;
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

  // 1: AI disclaimer filtri — "yubora olmayman" kabi noto'g'ri gaplarni o'chirish
  text = filterVoiceDisclaimers(text);

  // 2: TTS uchun markdown belgilarini tozalaymiz — aks holda "yulduzcha yulduzcha
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
