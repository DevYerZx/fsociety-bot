import axios from "axios";
import yts from "yt-search";

const API_URL = "https://nexevo-api.vercel.app/download/y2";
const COOLDOWN_TIME = 15000; // 15 segundos
const MAX_MB = 85; // límite seguro para WhatsApp

const cooldowns = new Map();

export default {
  command: ["ytmp4"],
  category: "descarga",

  run: async (ctx) => {
    const { sock, from, args } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const messageKey = msg?.key || null;

    const userId = from;
    const now = Date.now();

    // 🔒 Cooldown
    const cooldown = cooldowns.get(userId);
    if (cooldown && cooldown > now) {
      return sock.sendMessage(from, {
        text: `⏳ Espera ${Math.ceil((cooldown - now) / 1000)}s`,
      });
    }
    cooldowns.set(userId, now + COOLDOWN_TIME);

    try {
      if (!args.length) {
        cooldowns.delete(userId);
        return sock.sendMessage(from, {
          text:
            "❌ Uso correcto:\n\n" +
            "• .ytmp4 https://youtube.com/...\n" +
            "• .ytmp4 nombre del video",
        });
      }

      if (messageKey) {
        await sock.sendMessage(from, {
          react: { text: "⏳", key: messageKey },
        });
      }

      let query = args.join(" ").trim();
      let videoUrl = query;

      // 🔎 Buscar si no es enlace
      if (!/^https?:\/\//i.test(query)) {
        const search = await yts(query);
        if (!search?.videos?.length) {
          throw new Error("No se encontraron resultados.");
        }
        videoUrl = search.videos[0].url;
      }

      // 🔥 Llamada a tu API
      const { data } = await axios.get(
        `${API_URL}?url=${encodeURIComponent(videoUrl)}`,
        { timeout: 25000 }
      );

      if (!data?.status || !data?.result?.url) {
        throw new Error("La API no devolvió un enlace válido.");
      }

      const mp4Url = data.result.url;

      // 🚀 Abrir stream correctamente
      const videoResponse = await axios.get(mp4Url, {
        responseType: "stream",
        timeout: 120000,
        maxRedirects: 5,
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "*/*",
          "Connection": "keep-alive",
        },
      });

      const contentLength = Number(
        videoResponse.headers["content-length"] || 0
      );

      if (contentLength && contentLength > MAX_MB * 1024 * 1024) {
        throw new Error(
          `El video pesa ${Math.ceil(
            contentLength / (1024 * 1024)
          )}MB y supera el límite permitido (${MAX_MB}MB).`
        );
      }

      // 📤 Enviar como STREAM correcto
      await sock.sendMessage(
        from,
        {
          video: { stream: videoResponse.data },
          mimetype: "video/mp4",
          caption: `🎬 Calidad: ${data.result.quality || "360p"}`,
        },
        msg?.key ? { quoted: msg } : undefined
      );

      if (messageKey) {
        await sock.sendMessage(from, {
          react: { text: "✅", key: messageKey },
        });
      }

    } catch (err) {
      console.error("YTMP4 ERROR:", err?.message || err);
      cooldowns.delete(userId);

      await sock.sendMessage(from, {
        text:
          "❌ Error al descargar el video.\n\n" +
          (err?.message || "Intenta nuevamente."),
      });
    }
  },
};

// 🔥 Protección extra
process.on("uncaughtException", (e) => console.error("Uncaught:", e));
process.on("unhandledRejection", (e) => console.error("Unhandled:", e));
