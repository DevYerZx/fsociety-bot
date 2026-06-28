import fs from "fs";
import path from "path";
import yts from "yt-search";
import { chargeDownloadRequest, refundDownloadCharge } from "../economia/download-access.js";
import { sanitizeProviderMessage } from "./_errorMessages.js";
import {
  buildDownloadCard,
  buildSectionFallbackText,
  buildSelectorCaption,
  buildSelectorPayload,
  buildUsageCard,
  downloadFirstValidImageBuffer,
} from "./_downloadUi.js";

const RESULT_LIMIT = 5;
const DEFAULT_CAROUSEL_COVER = "https://i.ibb.co/5xrnyZhN/fsociety-bot-profile.png";
const BAILEYS_MESSAGES_FILE = path.join(
  process.cwd(),
  "node_modules",
  "@dvyer",
  "baileys",
  "lib",
  "Utils",
  "messages.js"
);

function supportsBaileysCards() {
  try {
    if (!fs.existsSync(BAILEYS_MESSAGES_FILE)) return false;
    const source = fs.readFileSync(BAILEYS_MESSAGES_FILE, "utf8");
    return (
      source.includes("carouselMessage") ||
      source.includes("'cards' in message") ||
      source.includes("\"cards\" in message")
    );
  } catch {
    return false;
  }
}

const SUPPORTS_BAILEYS_CARDS = supportsBaileysCards();

function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }

  return String(settings?.prefix || ".").trim() || ".";
}

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipText(value = "", max = 72) {
  const text = clean(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 3))}...`;
}

function compactNumber(value = 0) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.floor(n));
}

function compactUrl(value = "", max = 95) {
  const text = clean(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 3))}...`;
}

function formatDuration(video = {}) {
  const rawSeconds = Number(video?.seconds || video?.duration?.seconds || 0);

  if (Number.isFinite(rawSeconds) && rawSeconds > 0) {
    const total = Math.floor(rawSeconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  const timestamp = clean(video?.timestamp || "");
  return timestamp || "N/D";
}

function normalizeVideo(video = {}) {
  const url = clean(video?.url || "");
  if (!url) return null;

  return {
    url,
    title: clean(video?.title || "Video YouTube"),
    author: clean(video?.author?.name || video?.author || "Canal desconocido"),
    duration: formatDuration(video),
    views: Number(video?.views || 0),
    ago: clean(video?.ago || ""),
    thumbnail: clean(video?.thumbnail || ""),
  };
}

function buildCommand(prefix, type, videoUrl) {
  const command = clean(type || "").toLowerCase();
  const url = clean(videoUrl || "");
  if (!command) return prefix;
  if (!url) return `${prefix}${command}`.trim();
  return `${prefix}${command} ${url}`.trim();
}

function buildCardBody(item, index, query, prefix, mode = "detailed") {
  const safeUrl = compactUrl(item.url, 95);
  const published = item.ago || "N/D";
  const views = compactNumber(item.views);

  if (mode === "minimal") {
    return (
      `Resultados para: ${clipText(query, 40)}\n` +
      `➠ Video: ${index + 1}\n` +
      `➠ Titulo: ${clipText(item.title, 88)}\n` +
      `➠ Duracion: ${item.duration}\n` +
      `➠ URL: ${safeUrl}`
    );
  }

  if (mode === "compact") {
    return (
      `Resultados para: ${clipText(query, 48)}\n` +
      `YouTube - Resultado\n` +
      `➠ Video: ${index + 1}\n` +
      `➠ Titulo: ${clipText(item.title, 98)}\n` +
      `➠ Canal: ${clipText(item.author, 42)}\n` +
      `➠ Duracion: ${item.duration}\n` +
      `➠ Vistas: ${views}\n` +
      `➠ URL: ${safeUrl}\n\n` +
      `Boton MP3 = descarga directa\n` +
      `Copy = ${prefix}ytmp3 <url>`
    );
  }

  return (
    `Resultados para: ${clipText(query, 60)}\n` +
    `YouTube - Resultado\n` +
    `➠ Video: ${index + 1}\n` +
    `➠ Titulo: ${clipText(item.title, 120)}\n` +
    `➠ Canal: ${clipText(item.author, 56)}\n` +
    `➠ Duracion: ${item.duration}\n` +
    `➠ Vistas: ${views}\n` +
    `➠ Publicado: ${published}\n` +
    `➠ URL: ${safeUrl}\n\n` +
    `MP3 directo: ${prefix}ytmp3 <url>\n` +
    `MP4: ${prefix}ytmp4 <url>`
  );
}

function buildCardButtons(item, prefix, mode = "quick_mp3_mp4") {
  const cmdMp3 = buildCommand(prefix, "ytmp3", item.url);
  const cmdMp4 = buildCommand(prefix, "ytmp4", item.url);

  if (mode === "quick_mp3_mp4") {
    return [
      {
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({
          display_text: "MP3",
          id: cmdMp3,
        }),
      },
      {
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({
          display_text: "MP4",
          id: cmdMp4,
        }),
      },
    ];
  }

  if (mode === "quick_mp3_copy_mp4") {
    return [
      {
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({
          display_text: "MP3",
          id: cmdMp3,
        }),
      },
      {
        name: "cta_copy",
        buttonParamsJson: JSON.stringify({
          display_text: "Copy MP4",
          copy_code: cmdMp4,
        }),
      },
    ];
  }

  return [
    {
      name: "cta_copy",
      buttonParamsJson: JSON.stringify({
        display_text: "Copy MP3",
        copy_code: cmdMp3,
      }),
    },
  ];
}

function buildCarouselCards(results, prefix, query, bodyMode = "detailed", buttonMode = "quick_mp3_mp4") {
  return results.map((item, index) => ({
    image: { url: item.thumbnail || DEFAULT_CAROUSEL_COVER },
    title: "YouTube - Resultado",
    body: buildCardBody(item, index, query, prefix, bodyMode),
    footer: "FSOCIETY BOT",
    buttons: buildCardButtons(item, prefix, buttonMode),
  }));
}

function buildResultRows(results, prefix, format) {
  const normalizedFormat = clean(format).toLowerCase() === "mp4" ? "mp4" : "mp3";
  const command = normalizedFormat === "mp4" ? "ytmp4" : "ytmp3";
  const label = normalizedFormat.toUpperCase();

  return results.map((item, index) => ({
    header: `${index + 1}`,
    title: clipText(item.title || "Sin titulo", 72),
    description: clipText(
      `${label} | ${item.duration || "N/D"} | ${item.author || "Canal"}`,
      72
    ),
    id: buildCommand(prefix, command, item.url),
  }));
}

async function sendCarouselResults(sock, from, quoted, query, results, prefix) {
  if (!SUPPORTS_BAILEYS_CARDS) {
    throw new Error("baileys_cards_not_supported");
  }

  const basePayload = {
    text: "🎬 FSOCIETY YTSEARCH",
    footer: `YouTube • ${clipText(query, 60)}`,
    title: "FSOCIETY DOWNLOAD",
    ...global.channelInfo,
  };

  const attempts = [
    {
      label: "image-detailed-mp3-mp4-quick",
      cards: buildCarouselCards(results, prefix, query, "detailed", "quick_mp3_mp4"),
    },
    {
      label: "image-compact-mp3-quick-mp4-copy",
      cards: buildCarouselCards(results, prefix, query, "compact", "quick_mp3_copy_mp4"),
    },
    {
      label: "image-compact-mp3-copy",
      cards: buildCarouselCards(results, prefix, query, "compact", "single_copy_mp3"),
    },
    {
      label: "image-minimal-mp3-copy",
      cards: buildCarouselCards(results, prefix, query, "minimal", "single_copy_mp3"),
    },
  ];

  let lastError = null;

  for (const attempt of attempts) {
    try {
      await sock.sendMessage(
        from,
        {
          ...basePayload,
          cards: attempt.cards,
        },
        quoted
      );
      return;
    } catch (error) {
      lastError = error;
      console.error(`ytsearch carousel fallback (${attempt.label}):`, error?.message || error);
    }
  }

  throw lastError || new Error("No se pudo enviar carrusel de YouTube.");
}

async function sendFallbackResults(sock, from, quoted, query, results, prefix) {
  const mp3Rows = buildResultRows(results, prefix, "mp3");
  const mp4Rows = buildResultRows(results, prefix, "mp4");
  const sections = [
    { title: "MP3 - Audio", rows: mp3Rows },
    { title: "MP4 - Video", rows: mp4Rows },
  ];
  const cover = await downloadFirstValidImageBuffer(
    [results[0]?.thumbnail, DEFAULT_CAROUSEL_COVER],
    { timeout: 12_000, minBytes: 2_000 }
  );
  const caption = buildSelectorCaption({
    title: "🎬 *YOUTUBE SEARCH*",
    query,
    lead: `🎙️ Canal top: ${clipText(results[0]?.author || "Canal", 42)}`,
    featuredTitle: results[0]?.title || "Sin titulo",
    featuredLines: [
      `⏱️ ${results[0]?.duration || "N/D"}  •  👁️ ${compactNumber(results[0]?.views || 0)}`,
      `📅 ${clipText(results[0]?.ago || "Sin fecha", 26)}`,
    ],
    actionLines: [
      "Elige si quieres descargar en MP3 o MP4.",
    ],
  });

  await sock.sendMessage(
    from,
    buildSelectorPayload({
      imageBuffer: cover,
      caption,
      title: "🎬 YOUTUBE SEARCH",
      subtitle: "MP3 y MP4",
      footer: "YouTube • FSOCIETY",
      selectorTitle: "Elegir descarga",
      sections,
    }),
    quoted
  );
}

export default {
  name: "ytsearch",
  command: ["ytsearch", "yts", "ytbuscar", "buscaryt"],
  category: "busqueda",
  description: "Busca videos de YouTube y envia resultados en carrusel",

  run: async (ctx) => {
    const { sock, from, args, settings } = ctx;
    const msg = ctx.msg || ctx.m || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const prefix = getPrefix(settings);
    const query = Array.isArray(args) ? clean(args.join(" ")) : clean(args || "");

    if (!query) {
      return sock.sendMessage(
        from,
        {
          text: buildUsageCard({
            title: "🎬 *YOUTUBE SEARCH*",
            summary: [
              "Busca videos de YouTube y muestra resultados para descargar.",
              "Puedes escoger audio MP3 o video MP4 desde el selector.",
            ],
            examples: [
              `${prefix}ytsearch ozuna odisea`,
              `${prefix}ytsearch bad bunny monaco`,
              `${prefix}ytsearch believer imagine dragons`,
            ],
            footer: "Si el carrusel no abre, el bot enviará selector normal con portada.",
          }),
          ...global.channelInfo,
        },
        quoted
      );
    }

    let downloadCharge = null;

    try {
      const search = await yts(query);
      const videos = Array.isArray(search?.videos) ? search.videos : [];
      const results = videos
        .map(normalizeVideo)
        .filter(Boolean)
        .slice(0, RESULT_LIMIT);

      if (!results.length) {
        return sock.sendMessage(
          from,
          {
            text: buildDownloadCard("❌ *YOUTUBE SEARCH*", [
              { lines: ["No encontré resultados de YouTube."] },
            ]),
            ...global.channelInfo,
          },
          quoted
        );
      }

      downloadCharge = await chargeDownloadRequest(ctx, {
        commandName: "ytsearch",
        query,
        totalResults: results.length,
      });

      if (!downloadCharge.ok) {
        return null;
      }

      try {
        await sendCarouselResults(sock, from, quoted, query, results, prefix);
      } catch (carouselError) {
        console.error("ytsearch carousel fallback:", carouselError?.message || carouselError);
        await sendFallbackResults(sock, from, quoted, query, results, prefix);
      }
    } catch (error) {
      console.error("YTSEARCH ERROR:", error?.message || error);
      refundDownloadCharge(ctx, downloadCharge, {
        commandName: "ytsearch",
        reason: error?.message || "ytsearch_error",
      });

      await sock.sendMessage(
        from,
        {
          text: buildDownloadCard("❌ *YOUTUBE SEARCH*", [
            {
              lines: [
                `Error al buscar en YouTube: ${clean(sanitizeProviderMessage(error, { kind: "search", fallback: "desconocido" }))}`,
              ],
            },
          ]),
          ...global.channelInfo,
        },
        quoted
      );
    }
  },
};
