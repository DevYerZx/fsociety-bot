import yts from "yt-search";
import { sanitizeProviderMessage } from "./_errorMessages.js";

const MAX_RESULTS = 5;
const PICK_TOKEN_PATTERN = /^--pick=(\d{1,2})$/i;
const PLAY_SOURCE_URL = "https://dv-yer-api.online";

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
      buttonId: buildCommand(prefix, "ytmp3", currentUrl),
      buttonText: { displayText: "🎵 YTMP3" },
      type: 1,
    },
    {
      buttonId: buildCommand(prefix, "ytmp4", currentUrl),
      buttonText: { displayText: "🎬 YTMP4" },
      type: 1,
    },
  ];

  if (currentIndex < videos.length - 1 && currentIndex < MAX_RESULTS - 1) {
    buttons.push({
      buttonId: buildCommand(prefix, "play", `--pick=${currentIndex + 1} ${query}`),
      buttonText: { displayText: "➡️ Siguiente" },
      type: 1,
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
    `┃ 🌐 *API:* ${PLAY_SOURCE_URL}`,
    "┃",
    "┃ ✦ Toca *MP3* o *MP4* para descargar",
    currentIndex < total - 1 ? "┃ ✦ Usa *Siguiente* para ver otro resultado" : "┃ ✦ Este es el último resultado disponible",
    "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function buildButtonPanel(query, video, currentIndex, total) {
  const title = clipText(video?.title || "Sin título", 54);
  const duration = cleanText(video?.timestamp || "??:??");

  return [
    "╭━━━〔 ⚡ *FSOCIETY PLAY* ⚡ 〕━━━⬣",
    `┃ 🎵 *${title}*`,
    `┃ ⏱️ ${duration} | Resultado ${currentIndex + 1}/${total}`,
    "┃",
    "┃ • MP3 = audio",
    "┃ • MP4 = video",
    currentIndex < total - 1 ? "┃ • Siguiente = próximo resultado" : "┃ • Último resultado disponible",
    "┃",
    `┃ 🔎 ${clipText(query, 44)}`,
    `┃ 🌐 ${PLAY_SOURCE_URL}`,
    "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

async function sendPlayCard(sock, from, quoted, query, video, currentIndex, videos, prefix) {
  const caption = buildResultCaption(query, video, currentIndex, videos.length);
  const buttons = buildPlayButtons(prefix, query, videos, currentIndex);

  if (video?.thumbnail) {
    try {
      await sock.sendMessage(
        from,
        {
          image: { url: video.thumbnail },
          caption,
          buttons,
          footer: "FSOCIETY BOT • YouTube • dv-yer-api.online",
          headerType: 4,
          ...global.channelInfo,
        },
        quoted
      );
      return true;
    } catch {}
  }

  try {
    await sock.sendMessage(
      from,
      {
        text: buildButtonPanel(query, video, currentIndex, videos.length),
        buttons,
        footer: "FSOCIETY BOT • YouTube • dv-yer-api.online",
        headerType: 1,
        ...global.channelInfo,
      },
      quoted
    );
    return true;
  } catch {
    try {
      await sock.sendMessage(
        from,
        {
          text: caption,
          ...global.channelInfo,
        },
        quoted
      );
    } catch {}

    const currentUrl = cleanText(video?.url || "");
    const fallbackLines = [
      buildButtonPanel(query, video, currentIndex, videos.length),
      "",
      `MP3: ${buildCommand(prefix, "ytmp3", currentUrl)}`,
      `MP4: ${buildCommand(prefix, "ytmp4", currentUrl)}`,
    ];

    if (currentIndex < videos.length - 1 && currentIndex < MAX_RESULTS - 1) {
      fallbackLines.push(
        `Siguiente: ${buildCommand(prefix, "play", `--pick=${currentIndex + 1} ${query}`)}`
      );
    }

    await sock.sendMessage(
      from,
      {
        text: fallbackLines.join("\n"),
        ...global.channelInfo,
      },
      quoted
    );
    return false;
  }
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
      await sendPlayCard(
        sock,
        from,
        { quoted: m },
        query,
        currentVideo,
        currentIndex,
        videos,
        prefix
      );
      await react(sock, m, "✅");
    } catch (error) {
      console.error("Error en play:", error);
      await react(sock, m, "❌");

      return await sock.sendMessage(
        from,
        {
          text: `Error en play:\n${sanitizeProviderMessage(error, { kind: "search", fallback: "No se pudo completar la busqueda." })}`,
          ...global.channelInfo,
        },
        { quoted: m }
      );
    }
  },
};
