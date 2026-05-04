/**
 * Bir marta ishlatish: Telegram session string generatsiya qilish
 * Ishlatish: node scripts/generate-session.mjs
 *
 * Kerak: .env faylida TELEGRAM_API_ID va TELEGRAM_API_HASH bo'lishi kerak
 */

import { createInterface } from "readline";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });

const { TelegramClient } = await import("telegram");
const { StringSession } = await import("telegram/sessions/index.js");
const { Api } = await import("telegram");

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

const apiId = parseInt(process.env.TELEGRAM_API_ID ?? "0");
const apiHash = process.env.TELEGRAM_API_HASH ?? "";

if (!apiId || !apiHash) {
  console.error("❌ TELEGRAM_API_ID yoki TELEGRAM_API_HASH .env da yo'q");
  process.exit(1);
}

console.log("\n🔐 Telegram Session Generator\n");

const phone = await ask("📱 Telefon raqamingiz (+998...): ");

const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 5,
});

await client.connect();

const sendResult = await client.invoke(
  new Api.auth.SendCode({
    phoneNumber: phone.trim(),
    apiId,
    apiHash,
    settings: new Api.CodeSettings({}),
  })
);

const code = await ask("📩 SMS kodini kiriting: ");

let signedIn = false;
try {
  await client.invoke(
    new Api.auth.SignIn({
      phoneNumber: phone.trim(),
      phoneCodeHash: sendResult.phoneCodeHash,
      phoneCode: code.trim(),
    })
  );
  signedIn = true;
} catch (err) {
  if (err.message?.includes("SESSION_PASSWORD_NEEDED") || err.message?.includes("2FA")) {
    const password = await ask("🔐 2FA parolingiz: ");
    const { computeCheck } = await import("telegram/Password.js");
    const pwdInfo = await client.invoke(new Api.account.GetPassword());
    const check = await computeCheck(pwdInfo, password.trim());
    await client.invoke(new Api.auth.CheckPassword({ password: check }));
    signedIn = true;
  } else {
    throw err;
  }
}

if (signedIn) {
  const session = client.session.save();
  console.log("\n✅ Muvaffaqiyatli! Session string:\n");
  console.log("━".repeat(60));
  console.log(session);
  console.log("━".repeat(60));
  console.log("\n📋 Vercel Dashboard → Settings → Environment Variables ga boring:");
  console.log("   Name:  TELEGRAM_SESSION");
  console.log("   Value: yuqoridagi string");
  console.log("\n⚠️  Bu stringni hech kim bilan ulashmang!\n");
}

await client.disconnect();
rl.close();
