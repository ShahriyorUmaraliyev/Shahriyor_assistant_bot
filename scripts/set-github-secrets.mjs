import { readFileSync } from "fs";
import { execSync } from "child_process";
import * as https from "https";

const GITHUB_TOKEN = process.argv[2];
const OWNER = "ShahriyorUmaraliyev";
const REPO = "Shahriyor_assistant_bot";

if (!GITHUB_TOKEN) {
  console.error("Usage: node set-github-secrets.mjs <GITHUB_TOKEN>");
  process.exit(1);
}

// Read .env file
const envContent = readFileSync("D:/Python/Shahriyor_assistant_bot/.env", "utf8");
const secrets = {};
for (const line of envContent.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const idx = trimmed.indexOf("=");
  if (idx === -1) continue;
  const key = trimmed.slice(0, idx).trim();
  const value = trimmed.slice(idx + 1).trim();
  if (key) secrets[key] = value;
}

// Remove APP_URL — Cloud Run sets this automatically
delete secrets.APP_URL;

async function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: "api.github.com",
        path,
        method,
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "set-secrets-script",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode, data: body }); }
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Get repo public key for encryption
const { data: pubKey } = await apiRequest("GET", `/repos/${OWNER}/${REPO}/actions/secrets/public-key`);
console.log("Public key obtained:", pubKey.key_id);

// Install tweetsodium if needed
try {
  await import("tweetsodium");
} catch {
  console.log("Installing tweetsodium...");
  execSync("npm install tweetsodium --no-save", { cwd: "D:/Python/Shahriyor_assistant_bot", stdio: "inherit" });
}

const { default: sodium } = await import("tweetsodium");

function encryptSecret(value, keyBase64) {
  const messageBytes = Buffer.from(value);
  const keyBytes = Buffer.from(keyBase64, "base64");
  const encryptedBytes = sodium.seal(messageBytes, keyBytes);
  return Buffer.from(encryptedBytes).toString("base64");
}

let success = 0;
let failed = 0;

for (const [name, value] of Object.entries(secrets)) {
  const encrypted = encryptSecret(value, pubKey.key);
  const res = await apiRequest("PUT", `/repos/${OWNER}/${REPO}/actions/secrets/${name}`, {
    encrypted_value: encrypted,
    key_id: pubKey.key_id,
  });
  if (res.status === 201 || res.status === 204) {
    console.log(`✅ ${name}`);
    success++;
  } else {
    console.log(`❌ ${name} — ${res.status}: ${JSON.stringify(res.data)}`);
    failed++;
  }
}

console.log(`\nDone: ${success} success, ${failed} failed`);
