import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { CustomFile } from "telegram/client/uploads";
import bigInt from "big-integer";
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

// ─── Qabul qiluvchini hal qilish ──────────────────────────────────────────────
// GramJS telefon raqamini faqat u akkaunt kontaktlarida bo'lsa hal qiladi.
// Username'siz odamlarga ham yuborish uchun: avval getEntity (kontaktda bo'lsa),
// bo'lmasa raqamni ism bilan IMPORT qilamiz — entity ishonchli hal bo'ladi.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveRecipient(client: TelegramClient, to: string, name?: string): Promise<any> {
  // @username yoki son ID — GramJS o'zi hal qiladi
  if (!to.startsWith("+")) return to;

  // Telefon raqami — avval mavjud entity'ni qidiramiz (ortiqcha import qilmaslik uchun)
  try {
    return await client.getEntity(to);
  } catch {
    // Kontaktda yo'q — import qilamiz
  }

  try {
    const res = await client.invoke(
      new Api.contacts.ImportContacts({
        contacts: [
          new Api.InputPhoneContact({
            clientId: bigInt(Date.now()),
            phone: to,
            firstName: name?.trim() || to,
            lastName: "",
          }),
        ],
      })
    );
    const user = res.users?.[0];
    if (user) return user;
  } catch (err) {
    console.warn("[resolveRecipient] importContacts xato:", (err as Error).message);
  }

  // Oxirgi chora — raqamni to'g'ridan beramiz (GramJS o'zi urinib ko'radi)
  return to;
}

// ─── Send message ─────────────────────────────────────────────────────────────

export async function sendUserMessage(_uid: number, to: string, message: string, name?: string): Promise<void> {
  const client = await getClientInstance();
  await withDeadline(
    (async () => {
      const peer = await resolveRecipient(client, to, name);
      await client.sendMessage(peer, { message });
    })()
  );
}

// ─── Send voice message ───────────────────────────────────────────────────────

export async function sendUserVoiceMessage(_uid: number, to: string, audioBuffer: Buffer, name?: string): Promise<void> {
  const client = await getClientInstance();
  await withDeadline(
    (async () => {
      const peer = await resolveRecipient(client, to, name);
      const oggBuffer = await wavToOgg(audioBuffer);
      const file = new CustomFile("voice.ogg", oggBuffer.length, "", oggBuffer);
      await client.sendFile(peer, {
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

