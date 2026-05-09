import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";

// WAV → OGG/Opus (GramJS voice note uchun).
// ffmpeg-static paketidan foydalanadi — alohida ffmpeg o'rnatish shart emas.

export function wavToOgg(wavBuffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const bin = ffmpegPath ?? "ffmpeg";
    const chunks: Buffer[] = [];
    const ff = spawn(bin, [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-c:a", "libopus",
      "-b:a", "64k",
      "-f", "ogg",
      "pipe:1",
    ]);
    ff.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ff.stderr.on("data", (d: Buffer) => console.error("[ffmpeg]", d.toString().trim()));
    ff.on("close", (code) => {
      if (code !== 0) reject(new Error("FFMPEG_FAILED"));
      else resolve(Buffer.concat(chunks));
    });
    ff.on("error", (err) => reject(new Error(`FFMPEG_ERROR: ${err.message}`)));
    ff.stdin.write(wavBuffer);
    ff.stdin.end();
  });
}
