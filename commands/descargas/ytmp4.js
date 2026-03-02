import fs from "fs";
import path from "path";
import axios from "axios";
import yts from "yt-search";
import { exec } from "child_process";

// ✅ TU API (LEGAL) + APIKEY (hardcode si así lo quieres)
const API_URL = "https://mayapi.ooguy.com/ytdl";
const API_KEY = "may-5d597e52";

const COOLDOWN_TIME = 15 * 1000;
const TMP_DIR = path.join(process.cwd(), "tmp");

const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
const MAX_DOC_BYTES = 100 * 1024 * 1024;

const DEFAULT_QUALITY = "360p";
const cooldowns = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

function safeFileName(name) {
  return String(name || "video")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function isHttpUrl(s) {
  return /^https?:\/\//i.test(String(s || ""));
}

function parseQuality(args) {
  const q = args.find((a) => /^\d{3,4}p$/i.test(a));
  return (q || DEFAULT_QUALITY).toLowerCase();
}

function withoutQuality(args) {
  return args.filter((a) => !/^\d{3,4}p$/i.test(a));
}

// ✅ Solo arma el request. Tu API debe responder con { status:true, result:{ url } }
async function fetchDirectMediaUrl({ videoUrl, quality }) {
  const { data } = await axios.get(API_URL, {
    timeout: 20000,
    params: {
      url: videoUrl,
      quality,           // "360p"
      apikey: API_KEY,   // ✅ hardcode
      // type: "video"    // si tu API lo exige, descomenta
    },
  });

  if (!data?.status || !data?.result?.url) throw new Error("API inválida");
  return {
    title: data?.result?.title || "video",
    directUrl: data.result.url,
  };
}

async function downloadToFile(directUrl, outPath) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await axios.get(directUrl, {
        responseType: "stream",
        timeout: 60000,
        headers: { "User-Agent": "Mozilla/5.0" },
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 400,
      });

      await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(outPath);
        res.data.pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      const size = fs.statSync(outPath).size;
      if (size < 300000) throw new Error("Archivo incompleto");
      return size;
    } catch (e) {
      if (i === 2) throw e;
      await sleep(1200);
    }
  }
}

async function ffmpegFaststart(inPath, outPath) {
  await new Promise((resolve, reject) => {
    exec(
      `ffmpeg -y -loglevel error -i "${inPath}" -map 0:v -map 0:a? -movflags +faststart -c:v copy -c:a copy "${outPath}"`,
      (err) => (err ? reject(err) : resolve())
    );
  });
}

export default {
  command: ["ytmp4"],
  category: "descarga",

  run: async (ctx) => {
    const { sock, from, args } = ctx;
    const msg = ctx.m || ctx.msg || null;

    const userId = from;
    let rawMp4, finalMp4;

    const until = cooldowns.get(userId);
    if (until && until > Date.now()) {
      return sock.sendMessage(from, {
        text: `⏳ Espera ${Math.ceil((until - Date.now()) / 1000)}s`,
        ...global.channelInfo,
      });
    }
    cooldowns.set(userId, Date.now() + COOLDOWN_TIME);

    const quoted = msg?.key ? { quoted: msg } : undefined;

    try {
      if (!args?.length) {
        cooldowns.delete(userId);
        return sock.sendMessage(from, {
          text:
            "❌ Uso:\n" +
            "• .ytmp4 <nombre o link>\n" +
            "• .ytmp4 360p <nombre o link>",
          ...global.channelInfo,
        });
      }

      const quality = parseQuality(args);
      const cleanedArgs = withoutQuality(args);
      const query = cleanedArgs.join(" ").trim();

      let videoUrl = query;
      let title = "video";

      rawMp4 = path.join(TMP_DIR, `${Date.now()}_raw.mp4`);
      finalMp4 = path.join(TMP_DIR, `${Date.now()}_final.mp4`);

      if (!isHttpUrl(query)) {
        const search = await yts(query);
        const first = search?.videos?.[0];
        if (!first) {
          cooldowns.delete(userId);
          return sock.sendMessage(from, {
            text: "❌ No se encontró el video.",
            ...global.channelInfo,
          });
        }
        videoUrl = first.url;
        title = safeFileName(first.title);
      }

      await sock.sendMessage(
        from,
        {
          text:
            `🎬 *VIDEO*\n` +
            `📹 ${title}\n` +
            `🎚️ Calidad: ${quality}\n` +
            `⏳ Preparando…`,
          ...global.channelInfo,
        },
        quoted
      );

      // 🔥 API call
      const info = await fetchDirectMediaUrl({ videoUrl, quality });
      title = safeFileName(info.title);
      const directUrl = info.directUrl;

      await sock.sendMessage(from, { text: "⬇️ Descargando…", ...global.channelInfo }, quoted);
      await downloadToFile(directUrl, rawMp4);

      await sock.sendMessage(from, { text: "🎞️ Optimizando (ffmpeg)…", ...global.channelInfo }, quoted);
      await ffmpegFaststart(rawMp4, finalMp4);

      const size = fs.existsSync(finalMp4) ? fs.statSync(finalMp4).size : 0;
      if (!size || size < 300000) throw new Error("Archivo final inválido");
      if (size > MAX_DOC_BYTES) throw new Error("Archivo demasiado grande para enviar.");

      if (size <= MAX_VIDEO_BYTES) {
        await sock.sendMessage(
          from,
          {
            video: { url: finalMp4 },
            mimetype: "video/mp4",
            caption: `🎬 ${title}\n🎚️ ${quality}`,
            ...global.channelInfo,
          },
          quoted
        );
      } else {
        await sock.sendMessage(
          from,
          {
            document: { url: finalMp4 },
            mimetype: "video/mp4",
            fileName: `${title}.mp4`,
            caption:
              `📄 Video pesado. Enviado como documento.\n` +
              `🎬 ${title}\n🎚️ ${quality}`,
            ...global.channelInfo,
          },
          quoted
        );
      }
    } catch (err) {
      console.error("YTMP4 ERROR:", err?.message || err);
      cooldowns.delete(userId);

      await sock.sendMessage(from, {
        text: "❌ Error al procesar (API caída / enlace inválido / archivo pesado).",
        ...global.channelInfo,
      });
    } finally {
      try {
        if (rawMp4 && fs.existsSync(rawMp4)) fs.unlinkSync(rawMp4);
        if (finalMp4 && fs.existsSync(finalMp4)) fs.unlinkSync(finalMp4);
      } catch {}
    }
  },
};
