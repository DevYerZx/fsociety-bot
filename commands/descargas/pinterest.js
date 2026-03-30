import { searchPinterestImages } from "./_searchFallbacks.js";
import { chargeDownloadRequest, refundDownloadCharge } from "../economia/download-access.js";

const COOLDOWN_TIME = 0;
const cooldowns = new Map();

function clean(str = "") {
  return String(str).replace(/\s+/g, " ").trim();
}

function clip(str = "", max = 60) {
  const s = clean(str);
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

function pickRandom(arr = []) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default {
  name: "pinterest",
  command: ["pinterest", "pin", "pint", "psearch"],
  category: "busqueda",
  description: "Busca imagenes estilo Pinterest",

  run: async (ctx) => {
    const { sock, from, args, msg } = ctx;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const userId = from;
    if (COOLDOWN_TIME > 0) {
      const now = Date.now();
      const wait = (cooldowns.get(userId) || 0) - now;

      if (wait > 0) {
        return sock.sendMessage(
          from,
          {
            text: `Espera ${Math.ceil(wait / 1000)}s para volver a buscar.`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      cooldowns.set(userId, now + COOLDOWN_TIME);
    }

    const query = clean(args.join(" "));
    if (!query) {
      return sock.sendMessage(
        from,
        {
          text: "Uso:\n.pin goku\n.pinterest wallpaper anime",
          ...global.channelInfo,
        },
        quoted
      );
    }

    await sock.sendMessage(
      from,
      {
        text: `Buscando imagenes para *${clip(query, 40)}*...`,
        ...global.channelInfo,
      },
      quoted
    );

    let downloadCharge = null;

    try {
      const results = await searchPinterestImages(query, 8);

      if (!results.length) {
        cooldowns.delete(userId);
        return sock.sendMessage(
          from,
          {
            text: "No encontre imagenes para esa busqueda.",
            ...global.channelInfo,
          },
          quoted
        );
      }

      const item = pickRandom(results);
      const imageUrl =
        item.image_large_url || item.image_medium_url || item.image_small_url;

      downloadCharge = await chargeDownloadRequest(ctx, {
        commandName: "pinterest",
        query,
        totalResults: results.length,
      });

      if (!downloadCharge.ok) {
        return null;
      }

      await sock.sendMessage(
        from,
        {
          image: { url: imageUrl },
          caption:
            `*Pinterest Result*\n` +
            `Busqueda: *${clip(query, 40)}*\n` +
            `Titulo: *${clip(item.title || query, 70)}*\n` +
            `Fuente: ${item.source || "pinterest"}`,
          ...global.channelInfo,
        },
        quoted
      );
    } catch (error) {
      console.error("ERROR PIN:", error?.message || error);
      cooldowns.delete(userId);
      refundDownloadCharge(ctx, downloadCharge, {
        commandName: "pinterest",
        reason: error?.message || "pinterest_error",
      });

      await sock.sendMessage(
        from,
        {
          text: `No pude buscar imagenes: ${clean(error?.message || "error desconocido")}`,
          ...global.channelInfo,
        },
        quoted
      );
    }
  },
};
