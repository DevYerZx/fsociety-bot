import yts from "yt-search";

// Guarda la última búsqueda por chat (jid)
const lastSearchByChat = new Map();

// Limpieza automática cada minuto (borra búsquedas viejas)
setInterval(() => {
  const now = Date.now();
  for (const [jid, data] of lastSearchByChat.entries()) {
    if (!data || (now - data.ts) > 10 * 60 * 1000) { // 10 min
      lastSearchByChat.delete(jid);
    }
  }
}, 60 * 1000);

export default {
  name: "play",
  command: ["play"],
  category: "music",

  run: async ({ sock, msg, from, args = [], comandos }) => {
    try {
      if (!sock || !from) return;

      const input = Array.isArray(args) ? args.join(" ").trim() : String(args ?? "").trim();
      const text = input.replace(/\s+/g, " ");

      // ✅ Ayuda
      if (!text) {
        return await sock.sendMessage(
          from,
          {
            text:
              "🎵 *PLAY*\n\n" +
              "Busca en YouTube y descarga *audio MP3* al elegir.\n\n" +
              "✅ Buscar:\n" +
              "• *.play <canción o artista>*\n" +
              "Ej: *.play yellow coldplay*\n\n" +
              "✅ Elegir (descarga MP3):\n" +
              "• *.play 1* / *.play 2* ...\n\n" +
              "✅ Elegir video (MP4):\n" +
              "• *.play video 1*\n",
          },
          { quoted: msg }
        );
      }

      // ✅ Modo: "video 1" para mp4
      const parts = text.split(/\s+/);
      const isVideoMode = ["video", "mp4"].includes((parts[0] || "").toLowerCase());
      const maybeNumber = isVideoMode ? parts[1] : parts[0];

      // ✅ Si el usuario eligió un número: descarga usando ytmp3/ytmp4
      if (/^\d+$/.test(maybeNumber || "")) {
        const pick = parseInt(maybeNumber, 10);
        const data = lastSearchByChat.get(from);

        if (!data || !Array.isArray(data.results) || data.results.length === 0) {
          return await sock.sendMessage(
            from,
            { text: "⚠️ No tengo una búsqueda guardada. Usa *.play <texto>* primero." },
            { quoted: msg }
          );
        }

        if (pick < 1 || pick > data.results.length) {
          return await sock.sendMessage(
            from,
            { text: `⚠️ Elige un número entre 1 y ${data.results.length}.` },
            { quoted: msg }
          );
        }

        const chosen = data.results[pick - 1];

        // Busca el comando real en tu bot
        const cmdName = isVideoMode ? "ytmp4" : "ytmp3";
        const cmd = comandos?.get?.(cmdName);

        if (!cmd || typeof cmd.run !== "function") {
          // Fallback: si no existe, al menos manda el link
          return await sock.sendMessage(
            from,
            {
              text:
                `✅ Elegiste: *${chosen.title}*\n` +
                `🔗 ${chosen.url}\n\n` +
                `⚠️ No encontré el comando *${cmdName}* en tu bot.\n` +
                `Revisa que exista un archivo de comando para *${cmdName}*.\n` +
                `Mientras tanto puedes usar:\n• *.ytmp3 ${chosen.url}*`,
            },
            { quoted: msg }
          );
        }

        // Aviso antes de descargar
        await sock.sendMessage(
          from,
          {
            text:
              `✅ Elegiste: *${chosen.title}*\n` +
              `⏱ ${chosen.timestamp || chosen.duration?.timestamp || "N/A"}\n` +
              `🔗 ${chosen.url}\n\n` +
              (isVideoMode ? "📥 Descargando *MP4*..." : "🎧 Descargando *MP3*..."),
          },
          { quoted: msg }
        );

        // Ejecuta el comando ytmp3/ytmp4 internamente
        // Tu comando ytmp3 normalmente espera args con el link
        await cmd.run({
          sock,
          msg,
          from,
          args: [chosen.url],
          comandos,
        });

        return;
      }

      // ✅ Protección: query demasiado larga
      if (text.length > 120) {
        return await sock.sendMessage(
          from,
          { text: "⚠️ Tu búsqueda es muy larga. Máx 120 caracteres." },
          { quoted: msg }
        );
      }

      // ✅ Buscar en YouTube
      await sock.sendMessage(from, { text: `🔎 Buscando: *${text}* ...` }, { quoted: msg });

      const res = await yts(text);
      const videos = (res?.videos || []).slice(0, 5);

      if (!videos.length) {
        return await sock.sendMessage(
          from,
          { text: "❌ No encontré resultados. Prueba con otro texto." },
          { quoted: msg }
        );
      }

      // Guardar resultados por chat
      lastSearchByChat.set(from, { ts: Date.now(), query: text, results: videos });

      // Mostrar lista con numeritos
      const lines = videos
        .map((v, i) => {
          const dur = v.timestamp || v.duration?.timestamp || "N/A";
          const chan = v.author?.name || "N/A";
          return `*${i + 1}.* ${v.title}\n⏱ ${dur} | 👤 ${chan}`;
        })
        .join("\n\n");

      await sock.sendMessage(
        from,
        {
          text:
            `🎵 *Resultados para:* _${text}_\n\n` +
            `${lines}\n\n` +
            `✅ Descarga MP3 con: *.play 1* / *.play 2* ...\n` +
            `✅ Descarga MP4 con: *.play video 1*`,
        },
        { quoted: msg }
      );
    } catch (err) {
      console.error("[PLAY] Error:", err);
      try {
        await sock.sendMessage(from, { text: "❌ Error en *play*. Revisa consola." }, { quoted: msg });
      } catch {}
    }
  },
};

