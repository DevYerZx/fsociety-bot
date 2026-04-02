import { searchTikTokVideosByUser } from "./_searchFallbacks.js";
import { chargeDownloadRequest, refundDownloadCharge } from "../economia/download-access.js";

function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }

  return String(settings?.prefix || ".").trim() || ".";
}

export default {
  name: "tiktokusuario",
  command: ["tiktokusuario", "ttuser", "ttperfil"],
  category: "busqueda",
  description: "Busca videos de un usuario especifico en TikTok",

  run: async (ctx) => {
    const { sock, msg, from, args, settings } = ctx;
    const username = args.join(" ").replace("@", "").trim().toLowerCase();
    const prefix = getPrefix(settings);

    if (!username) {
      return sock.sendMessage(
        from,
        {
          text:
            `Uso correcto:\n` +
            `${prefix}tiktokusuario usuario\n` +
            `${prefix}tiktokusuario @usuario`,
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }

    let downloadCharge = null;

    try {
      const results = await searchTikTokVideosByUser(username, 3);

      if (!results.length) {
        return sock.sendMessage(
          from,
          {
            text: "No encontre videos de ese usuario especifico.",
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      }

      await sock.sendMessage(
        from,
        {
          text: `Resultados del usuario *@${username}*\nEnviando ${results.length} videos...`,
          ...global.channelInfo,
        },
        { quoted: msg }
      );

      downloadCharge = await chargeDownloadRequest(ctx, {
        commandName: "tiktokusuario",
        username,
        totalResults: results.length,
      });

      if (!downloadCharge.ok) {
        return null;
      }

      for (let index = 0; index < results.length; index += 1) {
        const item = results[index];

        await sock.sendMessage(
          from,
          {
            video: { url: item.play },
            caption:
              `*VIDEO ${index + 1}*\n` +
              `${item.title || "Video TikTok"}\n` +
              `@${item.author || username}\n` +
              `Likes: ${item.stats?.likes || 0}\n` +
              `Comentarios: ${item.stats?.comments || 0}\n` +
              `Views: ${item.stats?.views || 0}\n` +
              `Fuente: ${item.source || "tiktok"}`,
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      }
    } catch (error) {
      console.error("Error ejecutando tiktokusuario:", error?.message || error);
      refundDownloadCharge(ctx, downloadCharge, {
        commandName: "tiktokusuario",
        reason: error?.message || "user_search_error",
      });

      await sock.sendMessage(
        from,
        {
          text: "Error obteniendo los videos del usuario.",
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }
  },
};
