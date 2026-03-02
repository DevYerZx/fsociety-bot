import axios from "axios";

export default {
  name: "ttsearch",
  command: ["ttsearch", "tts"],
  category: "descargas",
  desc: "Busca videos de TikTok y envía 2 resultados",

  run: async ({ sock, msg, from, args, settings }) => {

    const q = args.join(" ").trim();

    if (!q) {
      return sock.sendMessage(
        from,
        { text: `❌ Uso:\n${settings.prefix}ttsearch <texto>\nEj: ${settings.prefix}ttsearch edit goku`, ...global.channelInfo },
        { quoted: msg }
      );
    }

    try {

      const api = `https://nexevo.onrender.com/search/tiktok?q=${encodeURIComponent(q)}`;

      const { data } = await axios.get(api);

      if (!data?.status || !data?.result?.length) {
        return sock.sendMessage(
          from,
          { text: "❌ No encontré resultados.", ...global.channelInfo },
          { quoted: msg }
        );
      }

      const results = data.result.slice(0, 2); // solo 2 videos

      for (const v of results) {

        const title = v.title || "Video TikTok";
        const author = v?.author?.unique_id || "usuario";

        await sock.sendMessage(
          from,
          {
            video: { url: v.play },
            caption: `🎬 *${title}*\n👤 @${author}`,
            ...global.channelInfo
          },
          { quoted: msg }
        );

      }

    } catch (e) {

      console.error("Error ejecutando ttsearch:", e);

      await sock.sendMessage(
        from,
        { text: "❌ Error obteniendo videos de TikTok.", ...global.channelInfo },
        { quoted: msg }
      );
    }
  }
};
