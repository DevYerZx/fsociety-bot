import axios from "axios";

export default {
  name: "play",
  command: ["play", "music"],
  category: "descargas",
  desc: "Descarga música de YouTube y la envía. Uso: .play <link>",

  run: async ({ sock, msg, from, args, settings }) => {

    const url = args[0];

    if (!url) {
      return sock.sendMessage(
        from,
        { text: `❌ Uso correcto:\n${settings.prefix}play <link de YouTube>`, ...global.channelInfo },
        { quoted: msg }
      );
    }

    try {

      await sock.sendMessage(
        from,
        { text: "🎵 Buscando música...", ...global.channelInfo },
        { quoted: msg }
      );

      const { data } = await axios.post(
        "https://api-sky.ultraplus.click/youtube/resolve",
        {
          url,
          type: "audio",
          quality: "mp3"
        },
        {
          headers: {
            "Content-Type": "application/json",
            apikey: "DvYer159"
          }
        }
      );

      if (!data.status) {
        return sock.sendMessage(
          from,
          { text: "❌ No se pudo obtener la música.", ...global.channelInfo },
          { quoted: msg }
        );
      }

      const res = data.result;

      const titulo = res.title;
      const autor = res.author?.name || "Desconocido";
      const thumb = res.thumbnail;
      const source = res.source?.url;

      const texto = `🎧 *${titulo}*\n👤 ${autor}`;

      await sock.sendMessage(
        from,
        {
          image: { url: thumb },
          caption: texto,
          ...global.channelInfo
        },
        { quoted: msg }
      );

      await sock.sendMessage(
        from,
        {
          audio: { url: source },
          mimetype: "audio/mpeg",
          fileName: `${titulo}.mp3`,
          ...global.channelInfo
        },
        { quoted: msg }
      );

    } catch (e) {
      console.error("Error en play:", e);

      await sock.sendMessage(
        from,
        { text: "❌ Error descargando la música.", ...global.channelInfo },
        { quoted: msg }
      );
    }
  }
};
