import fs from "fs";
import path from "path";
import axios from "axios";
import yts from "yt-search";

const API_URL = "https://mayapi.ooguy.com/ytdl";
const API_KEY = "may-5d597e52";

const COOLDOWN_TIME = 15 * 1000;
const TMP_DIR = path.join(process.cwd(), "tmp");

// LIMITES
const MAX_VIDEO_BYTES = 70 * 1024 * 1024; // 70MB video normal
const MAX_DOC_BYTES = 500 * 1024 * 1024;  // 500MB documento

const DEFAULT_QUALITY = "360p";
const cooldowns = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

function safeFileName(name) {
  return String(name || "video")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "video";
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

function getYoutubeId(url) {
  try {
    const u = new URL(url);
    // youtu.be/<id>
    if (u.hostname.includes("youtu.be")) return u.pathname.replace("/", "").trim();
    // youtube.com/watch?v=<id>
    const v = u.searchParams.get("v");
    if (v) return v.trim();
    // /shorts/<id> or /embed/<id>
    const parts = u.pathname.split("/").filter(Boolean);
    const idxShorts = parts.indexOf("shorts");
    if (idxShorts >= 0 && parts[idxShorts + 1]) return parts[idxShorts + 1].trim();
    const idxEmbed = parts.indexOf("embed");
    if (idxEmbed >= 0 && parts[idxEmbed + 1]) return parts[idxEmbed + 1].trim();
    return null;
  } catch {
    return null;
  }
}

function getCooldownRemaining(msUntil) {
  return Math.max(0, Math.ceil((msUntil - Date.now()) / 1000));
}

// API
async function fetchDirectMediaUrl({ videoUrl, quality }) {
  const { data } = await axios.get(API_URL, {
    timeout: 20000,
    params: { url: videoUrl, quality, apikey: API_KEY },
    validateStatus: (s) => s >= 200 && s < 500,
  });

  if (!data?.status || !data?.result?.url) {
    const msg = data?.message || "API inválida";
    throw new Error(msg);
  }

  return {
    title: data?.result?.title || "video",
    directUrl: data.result.url,
  };
}

/**
 * Descarga un stream a disco:
 * - escribe a .part
 * - corta si supera maxBytes
 * - renombra a destino al terminar
 * Retorna el tamaño final.
 */
async function downloadToFileWithLimit(directUrl, outPath, maxBytes) {
  const partPath = `${outPath}.part`;

  // asegúrate de no pisar basura previa
  try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch {}
  try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}

  for (let attempt = 1; attempt <= 3; attempt++) {
    let writer = null;
    let downloaded = 0;

    try {
      const res = await axios.get(directUrl, {
        responseType: "stream",
        timeout: 60000,
        headers: { "User-Agent": "Mozilla/5.0" },
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 400,
      });

      writer = fs.createWriteStream(partPath);

      const done = new Promise((resolve, reject) => {
        res.data.on("data", (chunk) => {
          downloaded += chunk.length;
          if (downloaded > maxBytes) {
            res.data.destroy(new Error("Archivo supera el límite permitido"));
          }
        });

        res.data.on("error", reject);
        writer.on("error", reject);
        writer.on("finish", resolve);

        res.data.pipe(writer);
      });

      await done;

      // Validación mínima
      const size = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
      if (size < 300000) throw new Error("Archivo incompleto o demasiado pequeño");

      fs.renameSync(partPath, outPath);
      return size;

    } catch (err) {
      // limpiar streams/archivos parciales
      try { writer?.close?.(); } catch {}
      try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch {}

      if (attempt === 3) throw err;
      await sleep(1200 * attempt);
    }
  }
}

async function resolveVideoInfo(queryOrUrl) {
  // Si no es URL => búsqueda normal
  if (!isHttpUrl(queryOrUrl)) {
    const search = await yts(queryOrUrl);
    const first = search?.videos?.[0];
    if (!first) return null;
    return {
      videoUrl: first.url,
      title: safeFileName(first.title),
      thumbnail: first.thumbnail || null,
    };
  }

  // Si es URL, intenta extraer ID y usar yts(videoId) (más exacto)
  const vid = getYoutubeId(queryOrUrl);
  if (vid) {
    try {
      const info = await yts({ videoId: vid });
      if (info) {
        return {
          videoUrl: info.url || queryOrUrl,
          title: safeFileName(info.title),
          thumbnail: info.thumbnail || null,
        };
      }
    } catch {}
  }

  // Fallback: yts(url) a veces funciona, si no, deja el URL sin thumbnail
  try {
    const search = await yts(queryOrUrl);
    const first = search?.videos?.[0];
    if (first) {
      return {
        videoUrl: first.url || queryOrUrl,
        title: safeFileName(first.title),
        thumbnail: first.thumbnail || null,
      };
    }
  } catch {}

  return {
    videoUrl: queryOrUrl,
    title: "video",
    thumbnail: null,
  };
}

export default {
  command: ["ytmp4"],
  category: "descarga",

  run: async (ctx) => {
    const { sock, from, args } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const userId = from;

    let finalMp4 = null;

    // COOLDOWN
    const until = cooldowns.get(userId);
    if (until && until > Date.now()) {
      return sock.sendMessage(from, {
        text: `⏳ Espera ${getCooldownRemaining(until)}s`,
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
      const query = withoutQuality(args).join(" ").trim();
      if (!query) {
        cooldowns.delete(userId);
        return sock.sendMessage(from, {
          text: "❌ Debes poner un nombre o link.",
          ...global.channelInfo,
        });
      }

      // Resolver URL + metadata
      const meta = await resolveVideoInfo(query);
      if (!meta) {
        cooldowns.delete(userId);
        return sock.sendMessage(from, {
          text: "❌ No se encontró el video.",
          ...global.channelInfo,
        });
      }

      let { videoUrl, title, thumbnail } = meta;

      // ruta final
      finalMp4 = path.join(TMP_DIR, `${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`);

      // Mensaje "descargando" con miniatura si existe
      if (thumbnail) {
        await sock.sendMessage(
          from,
          {
            image: { url: thumbnail },
            caption: `⬇️ Descargando...\n\n🎬 ${title}\n🎚️ Calidad: ${quality}\n⏳ Espera por favor...`,
            ...global.channelInfo,
          },
          quoted
        );
      } else {
        await sock.sendMessage(
          from,
          {
            text: `⬇️ Descargando...\n\n🎬 ${title}\n🎚️ Calidad: ${quality}\n⏳ Espera por favor...`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      // API: obtener link directo
      const info = await fetchDirectMediaUrl({ videoUrl, quality });
      title = safeFileName(info.title || title);

      // Descargar con límite REAL (500MB)
      const size = await downloadToFileWithLimit(info.directUrl, finalMp4, MAX_DOC_BYTES);

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

      const msgErr =
        String(err?.message || "")
          .replace(/axios.*?/gi, "")
          .trim() || "Error al procesar el video.";

      await sock.sendMessage(from, {
        text: `❌ ${msgErr}`,
        ...global.channelInfo,
      });

    } finally {
      // Limpieza archivos
      try { if (finalMp4 && fs.existsSync(finalMp4)) fs.unlinkSync(finalMp4); } catch {}
      try { if (finalMp4 && fs.existsSync(`${finalMp4}.part`)) fs.unlinkSync(`${finalMp4}.part`); } catch {}
    }
  },
};
