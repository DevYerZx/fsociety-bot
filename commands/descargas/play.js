import yts from "yt-search";

function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }

  return String(settings?.prefix || ".").trim() || ".";
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipText(value = "", max = 72) {
  const text = cleanText(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 3))}...`;
}

function buildCommand(prefix, command, url) {
  return `${prefix}${command} ${url}`.trim();
}

function buildPlayButtons(prefix, video) {
  const url = cleanText(video?.url || "");
  const mp3Command = buildCommand(prefix, "ytmp3", url);
  const mp4Command = buildCommand(prefix, "ytmp4", url);

  return [
    {
      name: "quick_reply",
      buttonParamsJson: JSON.stringify({
        display_text: "MP3",
        id: mp3Command,
      }),
    },
    {
      name: "quick_reply",
      buttonParamsJson: JSON.stringify({
        display_text: "MP4",
        id: mp4Command,
      }),
    },
  ];
}

async function react(sock, msg, emoji) {
  try {
    if (!msg?.key) return;
    await sock.sendMessage(msg.key.remoteJid, {
      react: {
        text: emoji,
        key: msg.key,
      },
    });
  } catch {}
}

function buildUsageMessage(prefix) {
  return [
    "╭━━━〔 🎵 *PLAY* 〕━━━⬣",
    "┃",
    "┃ ✦ *USO DEL COMANDO*",
    "┃",
    `┃ 📌 ${prefix}play ozuna odisea`,
    `┃ 📌 ${prefix}play enlace o nombre`,
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function buildResultCaption(query, video) {
  return [
    "╭━━━〔 🎧 *FSOCIETY PLAY* 〕━━━⬣",
    "┃",
    `┃ 🔎 *Búsqueda:* ${clipText(query, 55)}`,
    `┃ 🎵 *Resultado:* ${clipText(video?.title || "Sin título", 55)}`,
    `┃ ⏱️ *Duración:* ${cleanText(video?.timestamp || "??:??")}`,
    `┃ 👤 *Canal:* ${clipText(video?.author?.name || video?.author || "Desconocido", 32)}`,
    "┃",
    "┃ ✦ Elige si quieres *MP3* o *MP4*",
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

export default {
  name: "play",
  command: ["play"],
  categoria: "descarga",
  category: "descarga",
  description: "Busca en YouTube y ofrece MP3 o MP4 del primer resultado",

  async run(ctx) {
    const { sock, m, from, args, settings } = ctx;
    const prefix = getPrefix(settings);

    try {
      await react(sock, m, "🔎");

      const query = Array.isArray(args) ? args.join(" ").trim() : "";

      if (!query) {
        await react(sock, m, "❌");
        return await sock.sendMessage(
          from,
          {
            text: buildUsageMessage(prefix),
            ...global.channelInfo,
          },
          { quoted: m }
        );
      }

      const res = await yts(query);
      const first = Array.isArray(res?.videos)
        ? res.videos.find((video) => cleanText(video?.url))
        : null;

      if (!first?.url) {
        await react(sock, m, "❌");
        return await sock.sendMessage(
          from,
          {
            text: "No encontré resultados en YouTube.",
            ...global.channelInfo,
          },
          { quoted: m }
        );
      }

      const payload = {
        text: buildResultCaption(query, first),
        title: "FSOCIETY BOT",
        subtitle: "YouTube MP3 / MP4",
        footer: "Primer resultado encontrado",
        interactiveButtons: buildPlayButtons(prefix, first),
        ...global.channelInfo,
      };

      if (first.thumbnail) {
        payload.image = { url: first.thumbnail };
      }

      await sock.sendMessage(from, payload, { quoted: m });
      await react(sock, m, "✅");
    } catch (error) {
      console.error("Error en play:", error);
      await react(sock, m, "❌");

      return await sock.sendMessage(
        from,
        {
          text: `Error en play:\n${error?.message || error}`,
          ...global.channelInfo,
        },
        { quoted: m }
      );
    }
  },
};
