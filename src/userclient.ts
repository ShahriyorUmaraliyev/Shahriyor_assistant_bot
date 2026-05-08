import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

// ─── Client ───────────────────────────────────────────────────────────────────

const USERCLIENT_TIMEOUT_MS = 30_000;

function makeClient(): TelegramClient {
  const apiId = parseInt(process.env.TELEGRAM_API_ID ?? "0");
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";
  const session = process.env.TELEGRAM_SESSION ?? "";

  if (!apiId || !apiHash)
    throw new Error("TELEGRAM_API_ID yoki TELEGRAM_API_HASH sozlanmagan");
  if (!session)
    throw new Error("NOT_AUTHENTICATED");

  return new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 3,
    retryDelay: 1000,
  });
}

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
  const client = makeClient();
  let sendError: unknown;
  try {
    await withDeadline(
      (async () => {
        await client.connect();
        await client.sendMessage(to, { message });
      })()
    );
  } catch (err) {
    sendError = err;
  }
  await client.disconnect().catch((e) => console.error("TelegramClient disconnect xatosi:", e));
  if (sendError) throw sendError;
}

// ─── Send voice message ───────────────────────────────────────────────────────

export async function sendUserVoiceMessage(_uid: number, to: string, audioBuffer: Buffer): Promise<void> {
  const client = makeClient();
  let sendError: unknown;
  try {
    await withDeadline(
      (async () => {
        await client.connect();
        // voiceNote: true — Telegram da mikrofon belgisi bilan ko'rinadi
        await client.sendFile(to, {
          file: audioBuffer,
          voiceNote: true,
          forceDocument: false,
        });
      })()
    );
  } catch (err) {
    sendError = err;
  }
  await client.disconnect().catch((e) => console.error("TelegramClient disconnect xatosi:", e));
  if (sendError) throw sendError;
}

export async function hasSession(_uid: number): Promise<boolean> {
  return !!(process.env.TELEGRAM_SESSION);
}
