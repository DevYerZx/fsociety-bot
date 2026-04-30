import yts from "yt-search";

const MAX_RESULTS = 5;
const PICK_TOKEN_PATTERN = /^--pick=(\d{1,2})$/i;

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

function buildCommand(prefix, command, value) {
  return `${prefix}${command} ${value}`.trim();
}

function parsePlayArgs(args = []) {
  const rawArgs = Array.isArray(args) ? args : [];
  let pickIndex = 0;
  const queryParts = [];

  for (const token of rawArgs) {
    const text = String(token || "").trim();
    const pickMatch = text.match(PICK_TOKEN_PATTERN);

    if (pickMatch) {
      pickIndex = Math.max(0, Math.min(MAX_RESULTS - 1, Number(pickMatch[1] || 0)));
      continue;
    }

    if (text) {
      queryParts.push(text);
    }
  }

  return {
    pickIndex,
    query: queryParts.join(" ").trim(),
  };
}

function buildPlayButtons(prefix, query, videos, currentIndex) {
  const current = videos[currentIndex];
  const currentUrl = cleanText(current?.url || "");
  const buttons = [
    {
      name: "quick_reply",
      buttonParamsJson: JSON.stringify({
        display_text: "MP3",
        id: buildCommand(prefix, "ytmp3", currentUrl),
      }),
    },
    {
      name: "quick_reply",
      buttonParamsJson: JSON.stringify({
        display_text: "MP4",
        id: buildCommand(prefix, "ytmp4", currentUrl),
      }),
    },
  ];

  if (currentIndex < videos.length - 1 && currentIndex < MAX_RESULTS - 1) {
    buttons.push({
      name: "quick_reply",
      buttonParamsJson: JSON.stringify({
        display_text: "Siguiente",
        id: buildCommand(prefix, "play", `--pick=${currentIndex + 1} ${query}`),
      }),
    });
  }

  return buttons;
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
    "╭━━━〔 ✨ *FSOCIETY PLAY* ✨ 〕━━━⬣",
    "┃",
    "┃ 🎵 *Búsqueda instantánea de YouTube*",
    "┃",
    "┃ Usa:",
    `┃ • ${prefix}play ozuna odisea`,
    `┃ • ${prefix}play enlace o nombre`,
    "┃",
    "┃ Recibirás portada + botones MP3/MP4",
    "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function buildResultCaption(query, video, currentIndex, total) {
  const title = clipText(video?.title || "Sin título", 58);
  const duration = cleanText(video?.timestamp || "??:??");
  const author = clipText(video?.author?.name || video?.author || "Desconocido", 30);
  const views = cleanText(video?.views || video?.viewsText || "");
  const published = clipText(video?.ago || video?.publishedAt || "No definido", 24);

  return [
    "╭━━━〔 🎧 *FSOCIETY PLAY* 🎧 〕━━━⬣",
    "┃",
    `┃ 🔎 *Búsqueda:* ${clipText(query, 48)}`,
    `┃ 🎯 *Resultado:* ${currentIndex + 1}/${total}`,
    "┃",
    `┃ 🎵 *Título:* ${title}`,
    `┃ 👤 *Canal:* ${author}`,
    `┃ ⏱️ *Duración:* ${duration}`,
    `┃ 👁️ *Views:* ${views || "No definido"}`,
    `┃ 🗓️ *Publicado:* ${published}`,
    "┃",
    "┃ ✦ Toca *MP3* o *MP4* para descargar",
    currentIndex < total - 1 ? "┃ ✦ Usa *Siguiente* para ver otro resultado" : "┃ ✦ Este es el último resultado disponible",
    "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

export default {
  name: "play",
  command: ["play"],
  categoria: "descarga",
  category: "descarga",
  description: "Busca en YouTube y muestra hasta 5 resultados con botones MP3/MP4",

  async run(ctx) {
    const { sock, m, from, args, settings } = ctx;
    const prefix = getPrefix(settings);

    try {
      await react(sock, m, "🔎");

      const parsed = parsePlayArgs(args);
      const query = parsed.query;

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
      const videos = Array.isArray(res?.videos)
        ? res.videos.filter((video) => cleanText(video?.url)).slice(0, MAX_RESULTS)
        : [];

      if (!videos.length) {
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

      const currentIndex = Math.max(0, Math.min(parsed.pickIndex, videos.length - 1));
      const currentVideo = videos[currentIndex];
      const payload = {
        image: currentVideo?.thumbnail ? { url: currentVideo.thumbnail } : undefined,
        text: buildResultCaption(query, currentVideo, currentIndex, videos.length),
        caption: buildResultCaption(query, currentVideo, currentIndex, videos.length),
        title: "FSOCIETY PLAY",
        subtitle: `Resultado ${currentIndex + 1} de ${videos.length}`,
        footer: "Descarga rápida YouTube",
        interactiveButtons: buildPlayButtons(prefix, query, videos, currentIndex),
        ...global.channelInfo,
      };

      if (currentVideo?.thumbnail) {
        delete payload.text;
      } else {
        delete payload.image;
        delete payload.caption;
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
