import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram";

// ─── Client ───────────────────────────────────────────────────────────────────

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

// ─── Send message ─────────────────────────────────────────────────────────────

export async function sendUserMessage(uid: number, to: string, message: string): Promise<void> {
  const client = makeClient();
  await client.connect();
  // disconnect in finally — but don't let disconnect error mask the original
  let sendError: unknown;
  try {
    await client.sendMessage(to, { message });
  } catch (err) {
    sendError = err;
  }
  await client.disconnect().catch((e) => console.error("TelegramClient disconnect xatosi:", e));
  if (sendError) throw sendError;
}

export async function hasSession(_uid: number): Promise<boolean> {
  return !!(process.env.TELEGRAM_SESSION);
}
