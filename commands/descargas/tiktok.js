import axios from "axios";

// ================= CONFIG =================
const COOLDOWN_TIME = 10 * 1000;
const cooldowns = new Map();

const BORDER = "⭐════════════════════════⭐";
const LINE = "❒════════════════════════";

const NEXEVO_API = "https://nexevo.onrender.com/download/tiktok?url=";

const MAX_MB = 45;
const MAX_BYTES = MAX_MB * 1024 * 1024;

// ================= HELPERS =================
function normalizeText(str = "") {
  return String(str).replace(/\s+/g, " ").trim();
}
function clip(str = "", max = 90) {
  const s = normalizeText(str);
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}
function isTikTokUrl(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    return host.includes("tiktok.com") || host.includes("vm.tiktok.com") || host.includes("vt.tiktok.com");
  } catch {
    return false;
  }
}
function formatNum(n) {
  return Number(n || 0).toLocaleString("es-ES");
}
function unixToDate(unixSeconds) {
  try {
    if (!unixSeconds) return "—";
    const d = new Date(Number(unixSeconds) * 1000);
    return d.toLocaleString("es-ES", { hour12: false });
  } catch {
    return "—";
  }
}
async function downloadBinary(url) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 60000,
    maxContentLength: MAX_BYTES,
    maxBodyLength: MAX_BYTES,
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "*/*",
    },
    validateStatus: (s) => s >= 200 && s < 400,
  });

  const contentType = String(res.headers?.["content-type"] || "").toLowerCase();
  const buf = Buffer.from(res.data);
  return { buf, contentType, size: buf.length };
}

// ================= COMANDO =================
export default {
  command: ["tiktok", "tt", "tk"],
  category: "descarga",

  run: async ({ sock, from, args, settings, m, msg }) => {
    const quoted = (m?.key || msg?.key) ? { quoted: (m || msg) } : undefined;
    const channelContext = global.channelInfo || {};
    const BOT_NAME = settings?.botName || "DVYER";

    // 🔒 COOLDOWN
    const userId = from;
    const now = Date.now();
    const endsAt = cooldowns.get(userId) || 0;
    const wait = endsAt - now;

    if (wait > 0) {
      return sock.sendMessage(
        from,
        { text: `⚠️ *¡DESPACIO!* ⏳\nEspera *${Math.ceil(wait / 1000)}s* para volver a usar este comando.`, ...channelContext },
        quoted
      );
    }
    cooldowns.set(userId, now + COOLDOWN_TIME);

    // URL
    const videoUrl = args.join(" ").trim();

    if (!videoUrl || !isTikTokUrl(videoUrl)) {
      cooldowns.delete(userId);
      return sock.sendMessage(
        from,
        {
          text:
            `*┏━━━〔 📥 TIKTOK DOWNLOADER 〕━━━┓*\n\n` +
            `❌ *ERROR:* Enlace inválido.\n\n` +
            `📌 *USO:* .tiktok <link>\n\n` +
            `*┗━━━━━━━━━━━━━━━━━━━━┛*`,
          ...channelContext,
        },
        quoted
      );
    }

    // ✅ 1 SOLO MENSAJE DE "DESCARGANDO"
    await sock.sendMessage(
      from,
      {
        text: `⬇️ *DESCARGANDO...*\nEspera un momento, estoy preparando tu TikTok (HD).`,
        ...channelContext,
      },
      { quoted: m || msg }
    );

    try {
      // 1) API
      const apiUrl = NEXEVO_API + encodeURIComponent(videoUrl);
      const { data } = await axios.get(apiUrl, { timeout: 30000, headers: { Accept: "application/json" } });

      if (!data?.status || data?.result?.code !== 0 || !data?.result?.data) {
        throw new Error(data?.result?.msg || "La API no devolvió datos.");
      }

      const info = data.result.data;

      // 2) Selección URL video (prioridad)
      const candidates = [info.hdplay, info.play, info.wmplay].filter(Boolean);
      if (!candidates.length) throw new Error("No hay enlaces de video disponibles.");

      // 3) Descargar video como buffer (evita negro)
      let bin = null;
      for (const u of candidates) {
        try {
          const got = await downloadBinary(u);
          const isProbablyMp4 =
            got.contentType.includes("video") || got.buf.slice(4, 8).toString("ascii") === "ftyp";
          if (!isProbablyMp4) continue;
          if (got.size > MAX_BYTES) throw new Error(`El video supera el límite de ${MAX_MB}MB.`);
          bin = got;
          break;
        } catch {
          // intenta siguiente
        }
      }

      if (!bin) throw new Error("No pude descargar el video como MP4.");

      // Datos caption
      const title = clip(info.title || "Sin descripción", 100);
      const authorName =
        info?.author?.nickname ||
        info?.author?.unique_id ||
        info?.music_info?.author ||
        "TikTok User";

      const caption = `
${BORDER}
🎬 *TIKTOK DOWNLOADER (HD)*
${BORDER}

📝 *Título:* ${title}
👤 *Autor:* ${authorName}
🕒 *Duración:* ${Number(info.duration || 0)}s
🌎 *Región:* ${info.region || "—"}
📅 *Publicado:* ${unixToDate(info.create_time)}

${LINE}
📊 *Stats:* ▶️ ${formatNum(info.play_count)} | ❤️ ${formatNum(info.digg_count)} | 💬 ${formatNum(info.comment_count)} | 🔁 ${formatNum(info.share_count)}

${LINE}
🤖 *Bot:* ${BOT_NAME}
${BORDER}`.trim();

      // ✅ 2) ENVIAR VIDEO (sin mensajes extra)
      try {
        await sock.sendMessage(
          from,
          {
            video: bin.buf,
            mimetype: "video/mp4",
            caption,
            fileName: `tiktok_${info.id || Date.now()}.mp4`,
            ...channelContext,
          },
          quoted
        );
      } catch {
        // fallback documento
        await sock.sendMessage(
          from,
          {
            document: bin.buf,
            mimetype: "video/mp4",
            fileName: `tiktok_${info.id || Date.now()}.mp4`,
            caption,
            ...channelContext,
          },
          quoted
        );
      }

      // ✅ 3) ENVIAR MUSICA (si existe) como audio directo (buffer)
      const audioUrl = info?.music_info?.play || info?.music || null;
      if (audioUrl) {
        try {
          const a = await downloadBinary(audioUrl);
          // si baja demasiado grande, solo manda link
          if (a.size <= MAX_BYTES) {
            await sock.sendMessage(
              from,
              {
                audio: a.buf,
                mimetype: "audio/mpeg",
                ptt: false,
                fileName: `tiktok_audio_${info.id || Date.now()}.mp3`,
                ...channelContext,
              },
              quoted
            );
          } else {
            await sock.sendMessage(
              from,
              { text: `🎵 *Audio:* ${audioUrl}`, ...channelContext },
              quoted
            );
          }
        } catch {
          // fallback link
          await sock.sendMessage(
            from,
            { text: `🎵 *Audio:* ${audioUrl}`, ...channelContext },
            quoted
          );
        }
      }
    } catch (err) {
      console.error("❌ ERROR TIKTOK:", err?.message || err);
      cooldowns.delete(userId);

      await sock.sendMessage(
        from,
        {
          text:
            `❌ *ERROR*\n${LINE}\n` +
            `No se pudo obtener el video.\n` +
            `🧩 *Motivo:* ${clip(err?.message || "Error desconocido", 140)}\n` +
            `${LINE}`,
          ...channelContext,
        },
        quoted
      );
    }
  },
};
