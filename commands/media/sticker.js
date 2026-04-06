import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import pino from "pino";
import { downloadMediaMessage } from "@dvyer/baileys";

const logger = pino({ level: "silent" });
const TMP_DIR = path.join(process.cwd(), "tmp");

function ensureTmp() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function randName(ext) {
  return `${Date.now()}_${Math.floor(Math.random() * 99999)}.${ext}`;
}

function buildQuotedWAMessage(msg) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctx?.quotedMessage;
  if (!quoted) return null;

  return {
    key: {
      remoteJid: msg.key.remoteJid,
      fromMe: false,
      id: ctx.stanzaId,
      participant: ctx.participant,
    },
    message: quoted,
  };
}

function ffmpegToWebp(input, output) {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .outputOptions([
        "-vcodec", "libwebp",
        "-vf", "fps=15,scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000",
        "-lossless", "1",
        "-qscale", "50",
        "-preset", "default",
        "-pix_fmt", "yuva420p",
        "-an",
        "-vsync", "0",
      ])
      .toFormat("webp")
      .on("end", resolve)
      .on("error", reject)
      .save(output);
  });
}

export default {
  command: ["sticker", "s"],
  category: "media",
  description: "Imagen/Video a sticker",

  run: async ({ sock, msg, from }) => {
    try {
      ensureTmp();

      const quotedMsg = buildQuotedWAMessage(msg);
      const targetMsg = quotedMsg || msg;

      const hasImage =
        !!targetMsg.message?.imageMessage ||
        !!targetMsg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;

      const hasVideo =
        !!targetMsg.message?.videoMessage ||
        !!targetMsg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.videoMessage;

      if (!hasImage && !hasVideo) {
        return sock.sendMessage(
          from,
          { text: "⚙️ Responde a una *imagen/video* con .sticker", ...global.channelInfo },
          { quoted: msg }
        );
      }

      const buff = await downloadMediaMessage(
        targetMsg,
        "buffer",
        {},
        { logger, reuploadRequest: sock.updateMediaMessage }
      );

      const inFile = path.join(TMP_DIR, randName(hasVideo ? "mp4" : "jpg"));
      const outFile = path.join(TMP_DIR, randName("webp"));

      fs.writeFileSync(inFile, buff);
      await ffmpegToWebp(inFile, outFile);

      const webp = fs.readFileSync(outFile);
      fs.unlinkSync(inFile);
      fs.unlinkSync(outFile);

      return sock.sendMessage(from, { sticker: webp, ...global.channelInfo }, { quoted: msg });
    } catch (e) {
      console.error("sticker error:", e);

      // Si tu server no tiene ffmpeg instalado, este es el error típico
      const tip = String(e?.message || "").toLowerCase().includes("ffmpeg")
        ? "\n\n💡 *Solución:* instala ffmpeg en tu VPS/PC."
        : "";

      return sock.sendMessage(
        from,
        { text: `❌ Error creando sticker.${tip}`, ...global.channelInfo },
        { quoted: msg }
      );
    }
  }
};
