import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { CustomFile } from "telegram/client/uploads";

// ─── Persistent singleton client ─────────────────────────────────────────────
// Har yuborishda connect/disconnect qilish gramjs update loop da TIMEOUT
// xatosiga olib keladi. Bir marta ulanib, qayta ishlatish to'g'ri arxitektura.

let _client: TelegramClient | null = null;
let _connectPromise: Promise<unknown> | null = null;

async function getClient(): Promise<TelegramClient> {
  if (_client && _client.connected) return _client;

  const apiId = parseInt(process.env.TELEGRAM_API_ID ?? "0");
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";
  const session = process.env.TELEGRAM_SESSION ?? "";

  if (!apiId || !apiHash)
    throw new Error("TELEGRAM_API_ID yoki TELEGRAM_API_HASH sozlanmagan");
  if (!session)
    throw new Error("NOT_AUTHENTICATED");

  // Parallel chaqiruvlar bir xil clientni kutadi
  if (_connectPromise) {
    await _connectPromise;
    if (_client?.connected) return _client;
  }

  _client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5,
    retryDelay: 1000,
  });

  _connectPromise = _client.connect();
  await _connectPromise;
  _connectPromise = null;
  console.log("[UserClient] Telegram ga ulandi");
  return _client;
}

// ─── Send message ─────────────────────────────────────────────────────────────

export async function sendUserMessage(_uid: number, to: string, message: string): Promise<void> {
  const client = await getClient();
  await client.sendMessage(to, { message });
}

// ─── Send voice message ───────────────────────────────────────────────────────

export async function sendUserVoiceMessage(_uid: number, to: string, audioBuffer: Buffer): Promise<void> {
  const client = await getClient();
  const file = new CustomFile("voice.wav", audioBuffer.length, "", audioBuffer);
  await client.sendFile(to, {
    file,
    voiceNote: true,
    forceDocument: false,
  });
}

// ─── Session mavjudligini tekshirish ──────────────────────────────────────────

export async function hasSession(_uid: number): Promise<boolean> {
  return !!(process.env.TELEGRAM_SESSION);
}
