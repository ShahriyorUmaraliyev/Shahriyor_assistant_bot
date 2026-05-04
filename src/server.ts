/**
 * Local development server — faqat test uchun
 * Ishga tushirish: npm run dev
 * Tunnel:         npx localtunnel --port 3000
 */
import "dotenv/config";
import http from "http";
import type { IncomingMessage, ServerResponse } from "http";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import webhookHandler from "./index";

const PORT = Number(process.env.PORT) || 3001;

// ─── VercelRequest / VercelResponse mock ─────────────────────────────────────

function mockVercel(
  req: IncomingMessage,
  body: Buffer,
  res: ServerResponse
): { vReq: VercelRequest; vRes: VercelResponse } {
  // VercelRequest — IncomingMessage + body/query
  const vReq = Object.assign(req, {
    body: body.length
      ? (() => { try { return JSON.parse(body.toString()); } catch { return {}; } })()
      : {},
    query: Object.fromEntries(
      new URLSearchParams(req.url?.split("?")[1] ?? "").entries()
    ),
  }) as unknown as VercelRequest;

  // VercelResponse
  let code = 200;
  const vRes = {
    status(c: number) { code = c; return vRes; },
    end(data?: string) { res.writeHead(code); res.end(data); return vRes; },
    json(data: unknown) {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
      return vRes;
    },
    setHeader(key: string, val: string) { res.setHeader(key, val); return vRes; },
    getHeader: res.getHeader.bind(res),
    removeHeader: res.removeHeader.bind(res),
    redirect(url: string) { res.writeHead(302, { Location: url }); res.end(); return vRes; },
    send(data: unknown) {
      res.writeHead(code);
      res.end(typeof data === "string" ? data : JSON.stringify(data));
      return vRes;
    },
  } as unknown as VercelResponse;

  return { vReq, vRes };
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];

  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    const path = req.url?.split("?")[0] ?? "/";

    try {
      if (path === "/webhook" || path === "/src/index") {
        const { vReq, vRes } = mockVercel(req, body, res);
        await webhookHandler(vReq, vRes);
      } else {
        res.writeHead(404);
        res.end(`Endpoint topilmadi: ${path}\nMavjud: /webhook`);
      }
    } catch (err) {
      console.error("Server xatosi:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    }
  });
});

server.listen(PORT, () => {
  console.log("\n🚀 Local server ishga tushdi:");
  console.log(`   http://localhost:${PORT}/webhook\n`);
  console.log("📡 Tunnel uchun yangi terminalda:");
  console.log(`   npx localtunnel --port ${PORT}\n`);
  console.log("📋 Webhook ro'yxatga olish (tunnel URL bilan):");
  console.log(`   curl -X POST "https://api.telegram.org/bot${
    process.env.TELEGRAM_BOT_TOKEN?.slice(0, 20)
  }.../setWebhook" \\`);
  console.log('     -H "Content-Type: application/json" \\');
  console.log('     -d \'{"url":"https://YOUR-TUNNEL.loca.lt/webhook"}\'\n');
});
