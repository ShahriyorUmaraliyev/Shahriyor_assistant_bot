import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { CustomFile } from "telegram/client/uploads";
import { wavToOgg } from "./convert";

// ─── Client ───────────────────────────────────────────────────────────────────

const USERCLIENT_TIMEOUT_MS = 60_000;

let _client: TelegramClient | null = null;

async function getClientInstance(): Promise<TelegramClient> {
  if (!_client) {
    const apiId = parseInt(process.env.TELEGRAM_API_ID ?? "0");
    const apiHash = process.env.TELEGRAM_API_HASH ?? "";
    const session = process.env.TELEGRAM_SESSION ?? "";

    if (!apiId || !apiHash)
      throw new Error("TELEGRAM_API_ID yoki TELEGRAM_API_HASH sozlanmagan");
    if (!session)
      throw new Error("NOT_AUTHENTICATED");

    _client = new TelegramClient(new StringSession(session), apiId, apiHash, {
      connectionRetries: 5,
      retryDelay: 1000,
      autoReconnect: true,
    });
  }

  if (!_client.connected) {
    await _client.connect();
  }
  return _client;
}

// Graceful shutdown hooks to disconnect client session on process exit
const gracefulShutdown = async (): Promise<void> => {
  if (_client && _client.connected) {
    console.log("🔌 Disconnecting Telegram client session...");
    await _client.disconnect().catch((e) => console.error("TelegramClient disconnect xato:", e));
  }
};
process.on("SIGINT", () => gracefulShutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => gracefulShutdown().finally(() => process.exit(0)));

function withDeadline<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("USERCLIENT_TIMEOUT")), USERCLIENT_TIMEOUT_MS)
    ),
  ]);
}

// ─── Send message ─────────────────────────────────────────────────────────────

export async function sendUserMessage(_uid: number, to: string, message: string): Promise<void> {
  const client = await getClientInstance();
  await withDeadline(
    client.sendMessage(to, { message })
  );
}

// ─── Send voice message ───────────────────────────────────────────────────────

export async function sendUserVoiceMessage(_uid: number, to: string, audioBuffer: Buffer): Promise<void> {
  const client = await getClientInstance();
  await withDeadline(
    (async () => {
      const oggBuffer = await wavToOgg(audioBuffer);
      const file = new CustomFile("voice.ogg", oggBuffer.length, "", oggBuffer);
      await client.sendFile(to, {
        file,
        voiceNote: true,
        forceDocument: false,
      });
    })()
  );
}

export async function hasSession(_uid: number): Promise<boolean> {
  return !!(process.env.TELEGRAM_SESSION);
}

