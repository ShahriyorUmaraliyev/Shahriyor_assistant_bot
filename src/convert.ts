import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";

// WAV → OGG/Opus (GramJS voice note uchun).
// ffmpeg-static paketidan foydalanadi — alohida ffmpeg o'rnatish shart emas.

const FFMPEG_TIMEOUT_MS = 20_000;

export function wavToOgg(wavBuffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const bin = ffmpegPath ?? "ffmpeg";
    const chunks: Buffer[] = [];
    let settled = false;
    const ff = spawn(bin, [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-c:a", "libopus",
      "-b:a", "64k",
      "-f", "ogg",
      "pipe:1",
    ]);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    // ffmpeg osilib qolsa — protsessni o'ldirib, xato qaytaramiz (resurs sizmasin)
    const timer = setTimeout(() => {
      ff.kill("SIGKILL");
      finish(() => reject(new Error("FFMPEG_TIMEOUT")));
    }, FFMPEG_TIMEOUT_MS);

    ff.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ff.stderr.on("data", (d: Buffer) => console.error("[ffmpeg]", d.toString().trim()));
    ff.on("close", (code) => {
      if (code !== 0) finish(() => reject(new Error("FFMPEG_FAILED")));
      else finish(() => resolve(Buffer.concat(chunks)));
    });
    ff.on("error", (err) => finish(() => reject(new Error(`FFMPEG_ERROR: ${err.message}`))));

    // stdin xatosi (EPIPE — ffmpeg erta yopilsa) protsessni qulatmasligi uchun ushlaymiz
    ff.stdin.on("error", (err) => console.error("[ffmpeg stdin]", (err as Error).message));
    ff.stdin.write(wavBuffer);
    ff.stdin.end();
  });
}
