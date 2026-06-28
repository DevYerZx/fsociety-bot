import axios from "axios";
import yts from "yt-search";
import { sanitizeProviderMessage } from "./_errorMessages.js";

const MAX_RESULTS = 5;
const PLAY_SOURCE_URL = "https://dv-yer-api.online";
const COVER_TIMEOUT_MS = 12_000;

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
    "╭━━━〔 ✦ 🎧 *ＦＳＯＣＩＥＴＹ ＰＬＡＹ* 🎧 ✦ 〕━━━⬣",
    "┃",
    "┃ ✨ *Búsqueda instantánea de YouTube*",
    "┃ ⚡ Música • Videos • Descargas rápidas",
    "┃",
    "┣━━━〔 🔎 USO DEL COMANDO 🔎 〕━━━⬣",
    `┃ ➤ ${prefix}play ozuna odisea`,
    `┃ ➤ ${prefix}play bad bunny`,
    `┃ ➤ ${prefix}play enlace o nombre`,
    "┃",
    "┣━━━〔 📥 SELECTOR DE DESCARGA 📥 〕━━━⬣",
    "┃ 🎧 Cinco resultados en *MP3*",
    "┃ 🎬 Cinco resultados en *MP4*",
    "┃ 🖼️ Portada HD incluida",
    "┃ ⚡ Selección y descarga directa",
    "┃",
    "┣━━━━━━━━━━━━━━━━━━━━━━⬣",
    "┃ 🌙 Powered By *DVYER API*",
    "╰━━━〔 ⚡ ✦ ⚡ ✦ ⚡ 〕━━━⬣",
  ].join("\n");
}

function formatViews(value) {
  const views = Number(value || 0);
  if (!Number.isFinite(views) || views <= 0) return "Sin datos";

  return new Intl.NumberFormat("es", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(views);
}

function getVideoAuthor(video = {}) {
  return cleanText(video?.author?.name || video?.author || "Canal desconocido");
}

function buildResultRows(videos, prefix, format) {
  const isVideo = format === "mp4";
  const command = isVideo ? "ytmp4" : "ytmp3";
  const label = isVideo ? "MP4" : "MP3";

  return videos.map((video, index) => ({
    header: `${index + 1} • ${label}`,
    title: clipText(video?.title || "Sin título", 72),
    description: clipText(
      `${video?.timestamp || "??:??"} • ${getVideoAuthor(video)}`,
      72
    ),
    id: buildCommand(prefix, command, cleanText(video?.url || "")),
  }));
}

function buildPlaySections(videos, prefix) {
  return [
    {
      title: "🎧 AUDIO • MP3",
      highlight_label: "MÚSICA",
      rows: buildResultRows(videos, prefix, "mp3"),
    },
    {
      title: "🎬 VIDEO • MP4",
      highlight_label: "VIDEO",
      rows: buildResultRows(videos, prefix, "mp4"),
    },
  ];
}

function buildResultCaption(query, videos) {
  const featured = videos[0] || {};
  const title = clipText(featured?.title || "Sin título", 66);
  const author = clipText(getVideoAuthor(featured), 38);
  const duration = cleanText(featured?.timestamp || "??:??");
  const published = clipText(featured?.ago || featured?.publishedAt || "Sin datos", 24);

  return [
    "╭━━〔 🎧 *FSOCIETY PLAY* 〕━━⬣",
    `┃ 🔎 *Búsqueda:* ${clipText(query, 52)}`,
    `┃ 🎼 *Resultados:* ${videos.length} canciones`,
    "┣━━〔 ⭐ DESTACADO 〕━━⬣",
    `┃ 🎵 *${title}*`,
    `┃ 🎙️ ${author}`,
    `┃ ⏱️ ${duration}  •  👁️ ${formatViews(featured?.views)}`,
    `┃ 📅 ${published}`,
    "┣━━〔 📥 DESCARGAR 〕━━⬣",
    "┃ Abre el selector y elige:",
    "┃ • La canción que deseas",
    "┃ • Audio MP3 o Video MP4",
    "╰━━〔 ⚡ DVYER MUSIC ENGINE 〕━━⬣",
  ].join("\n");
}

async function downloadCover(video = {}) {
  const videoId = cleanText(video?.videoId || video?.video_id || "");
  const candidates = [
    videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : "",
    videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "",
    cleanText(video?.thumbnail || video?.image || ""),
  ].filter(Boolean);

  for (const url of [...new Set(candidates)]) {
    try {
      const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: COVER_TIMEOUT_MS,
        maxRedirects: 4,
        validateStatus: () => true,
      });
      const contentType = cleanText(response?.headers?.["content-type"]);
      const buffer = Buffer.from(response?.data || []);

      if (
        Number(response?.status || 0) < 400 &&
        contentType.toLowerCase().startsWith("image/") &&
        buffer.length > 1_000
      ) {
        return buffer;
      }
    } catch {}
  }

  return null;
}

function buildFallbackText(query, videos, prefix) {
  const commands = videos
    .map((video, index) => {
      const title = clipText(video?.title || "Sin título", 58);
      const url = cleanText(video?.url || "");
      return [
        `*${index + 1}. ${title}*`,
        `🎧 ${buildCommand(prefix, "ytmp3", url)}`,
        `🎬 ${buildCommand(prefix, "ytmp4", url)}`,
      ].join("\n");
    })
    .join("\n\n");

  return `${buildResultCaption(query, videos)}\n\n${commands}`;
}

async function sendPlayPicker(sock, from, quoted, query, videos, prefix) {
  const caption = buildResultCaption(query, videos);
  const cover = await downloadCover(videos[0]);
  const payload = {
    ...(cover ? { image: cover, caption } : { text: caption }),
    media: Boolean(cover),
    title: "🎶 FSOCIETY PLAY",
    subtitle: `${videos.length} resultados encontrados`,
    footer: `YouTube • ${PLAY_SOURCE_URL}`,
    interactiveButtons: [
      {
        name: "single_select",
        buttonParamsJson: JSON.stringify({
          title: "🎵 Elegir canción y formato",
          sections: buildPlaySections(videos, prefix),
        }),
      },
    ],
    ...global.channelInfo,
  };

  try {
    await sock.sendMessage(from, payload, quoted);
    return true;
  } catch (error) {
    console.warn("PLAY selector no disponible:", error?.message || error);
    const fallbackText = buildFallbackText(query, videos, prefix);

    await sock.sendMessage(
      from,
      {
        ...(cover ? { image: cover, caption: fallbackText } : { text: fallbackText }),
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
  description: "Busca en YouTube y muestra un selector de resultados MP3/MP4",

  async run(ctx) {
    const { sock, m, from, args, settings } = ctx;
    const prefix = getPrefix(settings);

    try {
      await react(sock, m, "🔎");

      const query = Array.isArray(args)
        ? cleanText(args.join(" "))
        : cleanText(args || "");

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

      await sendPlayPicker(
        sock,
        from,
        { quoted: m },
        query,
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
