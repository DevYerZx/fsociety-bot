import fs from "fs";
import path from "path";
import axios from "axios";
import yts from "yt-search";

const API_URL = "https://mayapi.ooguy.com/ytdl";
const API_KEY = "may-5d597e52";

const COOLDOWN_TIME = 15 * 1000;
const TMP_DIR = path.join(process.cwd(), "tmp");

// LIMITES
const MAX_VIDEO_BYTES = 70 * 1024 * 1024;     // 70MB video normal
const MAX_DOC_BYTES = 500 * 1024 * 1024;      // 500MB documento

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

// API
async function fetchDirectMediaUrl({ videoUrl, quality }) {
  const { data } = await axios.get(API_URL, {
    timeout: 20000,
    params: {
      url: videoUrl,
      quality,
      apikey: API_KEY,
    },
  });

  if (!data?.status || !data?.result?.url) {
    throw new Error("API inválida");
  }

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

export default {
  command: ["ytmp4"],
  category: "descarga",

  run: async (ctx) => {
    const { sock, from, args } = ctx;
    const msg = ctx.m || ctx.msg || null;

    const userId = from;
    let finalMp4;

    // COOLDOWN
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
          text: "❌ Uso: .ytmp4 (360p) <nombre o link>",
          ...global.channelInfo,
        });
      }

      const quality = parseQuality(args);
      const cleanedArgs = withoutQuality(args);
      const query = cleanedArgs.join(" ").trim();

      let videoUrl = query;
      let title = "video";
      let thumbnail = null;

      finalMp4 = path.join(TMP_DIR, `${Date.now()}.mp4`);

      // Buscar si no es link
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
        thumbnail = first.thumbnail;
      }

      // Si es link directo
      if (!thumbnail) {
        const search = await yts(videoUrl);
        const first = search?.videos?.[0];
        if (first) {
          title = safeFileName(first.title);
          thumbnail = first.thumbnail;
        }
      }

      // Mensaje único con miniatura
      await sock.sendMessage(
        from,
        {
          image: { url: thumbnail },
          caption: `⬇️ Descargando...\n\n🎬 ${title}\n🎚️ Calidad: ${quality}\n⏳ Espera por favor...`,
          ...global.channelInfo,
        },
        quoted
      );

      // API
      const info = await fetchDirectMediaUrl({ videoUrl, quality });
      title = safeFileName(info.title);

      // Descargar directo al archivo final (SIN DUPLICAR)
      await downloadToFile(info.directUrl, finalMp4);

      const size = fs.existsSync(finalMp4)
        ? fs.statSync(finalMp4).size
        : 0;

      if (!size || size < 300000)
        throw new Error("Archivo inválido");

      if (size > MAX_DOC_BYTES)
        throw new Error("Supera 500MB");

      // Envío final
      if (size <= MAX_VIDEO_BYTES) {
        await sock.sendMessage(
          from,
          {
            video: { url: finalMp4 },
            mimetype: "video/mp4",
            caption: `🎬 ${title}`,
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
            caption: `📄 Enviado como documento\n🎬 ${title}`,
            ...global.channelInfo,
          },
          quoted
        );
      }

    } catch (err) {
      console.error("YTMP4 ERROR:", err?.message || err);
      cooldowns.delete(userId);

      await sock.sendMessage(from, {
        text: "❌ Error al procesar el video.",
        ...global.channelInfo,
      });
    } finally {
      try {
        if (finalMp4 && fs.existsSync(finalMp4)) {
          fs.unlinkSync(finalMp4);
        }
      } catch {}
    }
  },
};
