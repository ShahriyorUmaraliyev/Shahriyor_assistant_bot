import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { CustomFile } from "telegram/client/uploads";
import { wavToOgg } from "./convert";

// ─── Client ───────────────────────────────────────────────────────────────────

const USERCLIENT_TIMEOUT_MS = 60_000;

function makeClient(): TelegramClient {
  const apiId = parseInt(process.env.TELEGRAM_API_ID ?? "0");
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";
  const session = process.env.TELEGRAM_SESSION ?? "";

  if (!apiId || !apiHash)
    throw new Error("TELEGRAM_API_ID yoki TELEGRAM_API_HASH sozlanmagan");
  if (!session)
    throw new Error("NOT_AUTHENTICATED");

  return new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 2,
    retryDelay: 500,
    autoReconnect: false,
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
        const oggBuffer = await wavToOgg(audioBuffer);
        const file = new CustomFile("voice.ogg", oggBuffer.length, "", oggBuffer);
        await client.sendFile(to, {
          file,
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
