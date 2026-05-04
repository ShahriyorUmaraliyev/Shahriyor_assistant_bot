import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram";
import { Redis } from "@upstash/redis";

// ─── Redis ────────────────────────────────────────────────────────────────────

let _redis: Redis | null = null;
function getRedis(): Redis {
  if (!_redis)
    _redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  return _redis;
}

const SESSION_KEY = (uid: number) => `userclient:session:${uid}`;
const AUTH_KEY = (uid: number) => `userclient:auth:${uid}`;

// ─── Types ────────────────────────────────────────────────────────────────────

export type AuthState =
  | { step: "waiting_phone" }
  | { step: "waiting_code"; phone: string; phoneCodeHash: string }
  | { step: "waiting_2fa"; partialSession: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeClient(session = ""): TelegramClient {
  const apiId = parseInt(process.env.TELEGRAM_API_ID ?? "0");
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";
  if (!apiId || !apiHash)
    throw new Error("TELEGRAM_API_ID yoki TELEGRAM_API_HASH Vercel da sozlanmagan");
  return new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 2,
    retryDelay: 1000,
  });
}

function saveStr(client: TelegramClient): string {
  const s = client.session.save();
  return typeof s === "string" ? s : Buffer.isBuffer(s) ? s.toString("base64") : String(s);
}

// ─── Auth state ───────────────────────────────────────────────────────────────

export async function getAuthState(uid: number): Promise<AuthState | null> {
  return getRedis().get<AuthState>(AUTH_KEY(uid));
}
export async function setAuthState(uid: number, state: AuthState): Promise<void> {
  await getRedis().set(AUTH_KEY(uid), state, { ex: 600 }); // 10 daqiqa
}
export async function clearAuthState(uid: number): Promise<void> {
  await getRedis().del(AUTH_KEY(uid));
}
export async function hasSession(uid: number): Promise<boolean> {
  return (await getRedis().get(SESSION_KEY(uid))) !== null;
}

// ─── Auth flow ────────────────────────────────────────────────────────────────

// 1-qadam: telefon raqam → OTP yuborish
export async function startAuth(uid: number, phone: string): Promise<void> {
  const client = makeClient();
  await client.connect();
  try {
    const result = await client.invoke(
      new Api.auth.SendCode({
        phoneNumber: phone,
        apiId: parseInt(process.env.TELEGRAM_API_ID!),
        apiHash: process.env.TELEGRAM_API_HASH!,
        settings: new Api.CodeSettings({}),
      })
    ) as unknown as { phoneCodeHash: string };
    await setAuthState(uid, {
      step: "waiting_code",
      phone,
      phoneCodeHash: result.phoneCodeHash,
    });
  } finally {
    await client.disconnect();
  }
}

// 2-qadam: OTP kodni tekshirish
export async function verifyCode(
  uid: number,
  phone: string,
  phoneCodeHash: string,
  code: string
): Promise<"done" | "need_2fa"> {
  const client = makeClient();
  await client.connect();
  try {
    await client.invoke(
      new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code.trim() })
    );
    await getRedis().set(SESSION_KEY(uid), saveStr(client));
    await clearAuthState(uid);
    return "done";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("SESSION_PASSWORD_NEEDED") || msg.includes("2FA")) {
      await setAuthState(uid, { step: "waiting_2fa", partialSession: saveStr(client) });
      return "need_2fa";
    }
    throw err;
  } finally {
    await client.disconnect();
  }
}

// 3-qadam (ixtiyoriy): 2FA parol
export async function verify2FA(uid: number, partialSession: string, password: string): Promise<void> {
  const client = makeClient(partialSession);
  await client.connect();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { computeCheck } = require("telegram/Password") as {
      computeCheck: (pwd: unknown, pass: string) => Promise<unknown>;
    };
    const pwdInfo = await client.invoke(new Api.account.GetPassword());
    const check = await computeCheck(pwdInfo, password);
    await client.invoke(new Api.auth.CheckPassword({ password: check as Api.TypeInputCheckPasswordSRP }));
    await getRedis().set(SESSION_KEY(uid), saveStr(client));
    await clearAuthState(uid);
  } finally {
    await client.disconnect();
  }
}

// ─── Send message ─────────────────────────────────────────────────────────────

export async function sendUserMessage(uid: number, to: string, message: string): Promise<void> {
  const session = await getRedis().get<string>(SESSION_KEY(uid));
  if (!session) throw new Error("NOT_AUTHENTICATED");

  const client = makeClient(session);
  await client.connect();
  try {
    await client.sendMessage(to, { message });
    // Yangilangan sessiyani saqlash
    await getRedis().set(SESSION_KEY(uid), saveStr(client));
  } finally {
    await client.disconnect();
  }
}
