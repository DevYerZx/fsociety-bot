import axios from "axios";
import yts from "yt-search";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";

const API_URL = "https://nexevo-api.vercel.app/download/y";
const COOLDOWN = 8000;
const cooldowns = new Map();

/** Evita llenar disco: limita tamaño máximo (ajusta si quieres) */
const MAX_BYTES = 25 * 1024 * 1024; // 25MB

/** Evita reventar el sistema: 1 envío/descarga a la vez */
let busy = false;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withGlobalLock(fn) {
  while (busy) await wait(400);
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

/** TMP propio para el bot */
const TMP_DIR = path.join(process.cwd(), "tmp");
function initTmpDir() {
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    // Node/Baileys usan os.tmpdir() y variables TMP* en varios sitios
    process.env.TMPDIR = TMP_DIR;
    process.env.TMP = TMP_DIR;
    process.env.TEMP = TMP_DIR;
  } catch {}
}
initTmpDir();

async function cleanTmp(dir, maxAgeMs = 60 * 60 * 1000) {
  // Borra archivos > 1 hora dentro de tu ./tmp
  const now = Date.now();
  let files = [];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const name of files) {
    const p = path.join(dir, name);
    try {
      const st = await fsp.stat(p);
      if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
        await fsp.unlink(p);
      }
    } catch {}
  }
}

// Limpieza cada 10 minutos
setInterval(() => cleanTmp(TMP_DIR).catch(() => {}), 10 * 60 * 1000);

function safeFileName(name) {
  return String(name || "audio")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

async function axiosGetWithRetry(url, opts, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await axios.get(url, opts);
    } catch (e) {
      lastErr = e;
      const code = e?.response?.status;
      const isRetryable =
        !code ||
        code >= 500 ||
        code === 429 ||
        e?.code === "ECONNRESET" ||
        e?.code === "ETIMEDOUT" ||
        e?.code === "ECONNABORTED";

      if (!isRetryable || i === retries) throw lastErr;
      await wait(400 * (i + 1));
    }
  }
  throw lastErr;
}

async function axiosHeadWithRetry(url, opts, retries = 1) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await axios.head(url, opts);
    } catch (e) {
      lastErr = e;
      const code = e?.response?.status;
      const isRetryable = !code || code >= 500 || code === 429;
      if (!isRetryable || i === retries) throw lastErr;
      await wait(300 * (i + 1));
    }
  }
  throw lastErr;
}

function isENOSPC(err) {
  return (
    err?.code === "ENOSPC" ||
    err?.errno === -28 ||
    String(err?.message || "").includes("ENOSPC")
  );
}

export default {
  command: ["ytmp3"],
  category: "descarga",

  run: async (ctx) => {
    const { sock, from, args } = ctx;

    const msg = ctx.m || ctx.message || ctx.msg || null;
    const messageKey = msg?.key || null;

    const now = Date.now();
    const userCooldown = cooldowns.get(from);

    if (userCooldown && now < userCooldown) {
      return sock.sendMessage(from, {
        text: `⏳ Espera ${Math.ceil((userCooldown - now) / 1000)}s`,
      });
    }

    cooldowns.set(from, now + COOLDOWN);

    try {
      if (!args || !args.length) {
        cooldowns.delete(from);
        return sock.sendMessage(
          from,
          { text: "🎧 Uso: .ytmp3 <nombre o link>" },
          msg ? { quoted: msg } : undefined
        );
      }

      // reacción al inicio
      if (messageKey) {
        await sock.sendMessage(from, { react: { text: "⏳", key: messageKey } });
      }

      // Limpia tmp antes de empezar
      await cleanTmp(TMP_DIR).catch(() => {});

      let query = args.join(" ").trim();
      let videoUrl = query;
      let title = "YouTube Audio";
      let thumbnail = "";
      let duration = "??";

      // Si no es link, busca en YouTube
      if (!/^https?:\/\//i.test(query)) {
        const { videos } = await yts(query);
        if (!videos?.length) throw new Error("Sin resultados");

        // evita lives o muy largos (30 min)
        const v = videos.find((x) => x.seconds && x.seconds < 1800) || videos[0];

        videoUrl = v.url;
        title = v.title;
        thumbnail = v.thumbnail;
        duration = v.timestamp;
      }

      // 1) pedir URL directa a la API
      const apiRes = await axiosGetWithRetry(
        `${API_URL}?url=${encodeURIComponent(videoUrl)}`,
        { timeout: 25000 },
        2
      );

      const directUrl = apiRes?.data?.result?.url;

      if (
        !directUrl ||
        typeof directUrl !== "string" ||
        !directUrl.startsWith("http")
      ) {
        throw new Error("API inválida: directUrl vacío");
      }

      // 2) chequeo de tamaño (evita descargar/subir audios enormes que llenen disco)
      // Si el servidor no da content-length, igual seguimos (pero con cola global)
      try {
        const head = await axiosHeadWithRetry(directUrl, { timeout: 15000 }, 1);
        const len = Number(head?.headers?.["content-length"] || 0);
        if (len && len > MAX_BYTES) {
          throw new Error(
            `Archivo demasiado grande (${Math.ceil(len / (1024 * 1024))}MB).`
          );
        }
      } catch (e) {
        // Si HEAD falla por CORS/redirect/etc, no bloqueamos; seguimos.
        // Si fue "demasiado grande", sí bloquea:
        if (String(e?.message || "").includes("demasiado grande")) throw e;
      }

      const fileName = `${safeFileName(title)}.mp3`;

      // 3) Envío con cola global (1 a la vez) para no llenar /tmp/disco con varios a la vez
      await withGlobalLock(async () => {
        await sock.sendMessage(
          from,
          {
            audio: { url: directUrl },
            mimetype: "audio/mpeg",
            fileName,
            contextInfo: thumbnail
              ? {
                  externalAdReply: {
                    title,
                    body: `⏱ ${duration}`,
                    thumbnailUrl: thumbnail,
                    sourceUrl: videoUrl,
                    mediaType: 1,
                    renderLargerThumbnail: true,
                  },
                }
              : undefined,
          },
          msg ? { quoted: msg } : undefined
        );
      });

      // Limpia tmp después del envío también
      await cleanTmp(TMP_DIR).catch(() => {});

      // reacción final
      if (messageKey) {
        await sock.sendMessage(from, { react: { text: "✅", key: messageKey } });
      }
    } catch (err) {
      cooldowns.delete(from);
      console.error("❌ YTMP3 ERROR:", err?.message || err);

      if (messageKey) {
        try {
          await sock.sendMessage(from, { react: { text: "❌", key: messageKey } });
        } catch {}
      }

      if (isENOSPC(err)) {
        // Intenta limpiar tmp y avisa claramente
        await cleanTmp(TMP_DIR, 0).catch(() => {});
        return sock.sendMessage(
          from,
          { text: "❌ Sin espacio en el servidor (/tmp lleno). Ya limpié temporales. Reinicia el bot o libera almacenamiento." },
          msg ? { quoted: msg } : undefined
        );
      }

      await sock.sendMessage(
        from,
        { text: "❌ No se pudo descargar el audio" },
        msg ? { quoted: msg } : undefined
      );
    }
  },
};

// Parche extra: evita que el proceso muera si algo se escapa
process.on("uncaughtException", (e) => console.error("Uncaught:", e));
process.on("unhandledRejection", (e) => console.error("Unhandled:", e));
