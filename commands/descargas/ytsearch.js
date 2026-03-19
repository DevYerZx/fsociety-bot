import ytSearch from "yt-search";
import { prepareWAMessageMedia, generateWAMessageFromContent } from "@whiskeysockets/baileys";

function formatViews(value) {
  const views = Number(value || 0);
  if (!Number.isFinite(views) || views <= 0) return "0";
  return new Intl.NumberFormat("es-PE").format(views);
}

async function makeFakeContact() {
  try {
    const response = await fetch("https://i.postimg.cc/rFfVL8Ps/image.jpg");
    const thumb = Buffer.from(await response.arrayBuffer());

    return {
      key: {
        participants: "0@s.whatsapp.net",
        remoteJid: "status@broadcast",
        fromMe: false,
        id: "Halo",
      },
      message: {
        locationMessage: {
          name: "Tourl",
          jpegThumbnail: thumb,
        },
      },
      participant: "0@s.whatsapp.net",
    };
  } catch {
    return null;
  }
}

export default {
  name: "ytsearch",
  command: ["ytsearch", "yts"],
  category: "descargas",
  description: "Busca en YouTube y muestra una lista interactiva",

  run: async ({ sock, msg, from, args = [], usedPrefix = "." }) => {
    try {
      const query = String(Array.isArray(args) ? args.join(" ") : "").trim();
      if (!query) {
        return sock.sendMessage(
          from,
          {
            text: `Usa: ${usedPrefix}ytsearch <consulta>`,
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      }

      const quoted = (await makeFakeContact()) || msg;
      const result = await ytSearch(query);
      const videos = Array.isArray(result?.videos) ? result.videos.slice(0, 5) : [];

      if (!videos.length) {
        return sock.sendMessage(
          from,
          {
            text: "No se encontraron resultados.",
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      }

      let mediaHeader = null;
      try {
        mediaHeader = await prepareWAMessageMedia(
          { image: { url: videos[0].thumbnail } },
          { upload: sock.waUploadToServer }
        );
      } catch {}

      const rows = videos.map((video) => ({
        title: String(video.title || "Video"),
        description: `Duracion: ${video.timestamp || "?"} | Vistas: ${formatViews(video.views)}`,
        id: `${usedPrefix}play ${video.url}`,
      }));

      console.log(`YTSEARCH SEND chat=${from} query=${query} filas=${rows.length}`);

      const interactiveMessage = {
        body: { text: `Resultados de busqueda para: ${query}` },
        footer: { text: "Selecciona un video para reproducir" },
        header: {
          title: "YouTube Search",
          hasMediaAttachment: Boolean(mediaHeader?.imageMessage),
          imageMessage: mediaHeader?.imageMessage,
        },
        nativeFlowMessage: {
          buttons: [
            {
              name: "single_select",
              buttonParamsJson: JSON.stringify({
                title: "Videos",
                sections: [{ title: "Opciones", rows }],
              }),
            },
          ],
          messageParamsJson: "",
        },
      };

      const generated = generateWAMessageFromContent(
        from,
        {
          viewOnceMessage: {
            message: {
              interactiveMessage,
            },
          },
        },
        {
          userJid: sock.user?.id || sock.user?.jid,
          quoted,
        }
      );

      await sock.relayMessage(from, generated.message, {
        messageId: generated.key.id,
      });

      console.log(`YTSEARCH OK chat=${from}`);
    } catch (error) {
      console.error("YTSEARCH ERROR:", error);
      await sock.sendMessage(
        from,
        {
          text: `No pude mostrar la busqueda interactiva.\n\n${error?.message || error}`,
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }
  },
};
