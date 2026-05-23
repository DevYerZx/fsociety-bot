import fs from "fs";
import path from "path";
import { searchTikTokVideos } from "./_searchFallbacks.js";
import { chargeDownloadRequest, refundDownloadCharge } from "../economia/download-access.js";
import { sanitizeProviderMessage } from "./_errorMessages.js";

const RESULT_LIMIT = 5;
const DEFAULT_COVER = "https://i.ibb.co/5xrnyZhN/fsociety-bot-profile.png";
const SEARCH_RETRY_ATTEMPTS = 3;
const SEARCH_RETRY_DELAY_MS = 900;

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
      source.includes('"cards" in message')
    );
  } catch {
    return false;
  }
}

const SUPPORTS_BAILEYS_CARDS = supportsBaileysCards();

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipText(value = "", max = 72) {
  const text = clean(value);
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => clean(value)) || ".";
  }

  return clean(settings?.prefix || ".") || ".";
}

function compactNumber(value = 0) {
  const n = Number(value || 0);

  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;

  return String(Math.floor(n));
}

function formatDurationSeconds(value = 0) {
  const seconds = Number(value || 0);

  if (!Number.isFinite(seconds) || seconds <= 0) return "N/D";
  if (seconds < 60) return `${Math.floor(seconds)}s`;

  const minutes = Math.floor(seconds / 60);
  const rem = Math.floor(seconds % 60);

  return rem > 0 ? `${minutes}m ${rem}s` : `${minutes}m`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function searchTikTokVideosWithRetries(query, limit) {
  let lastError = null;

  for (let attempt = 1; attempt <= SEARCH_RETRY_ATTEMPTS; attempt++) {
    try {
      const results = await searchTikTokVideos(query, limit);

      if (Array.isArray(results) && results.length > 0) {
        return results;
      }

      lastError = new Error("No se encontraron resultados.");
    } catch (error) {
      lastError = error;
    }

    if (attempt < SEARCH_RETRY_ATTEMPTS) {
      await sleep(SEARCH_RETRY_DELAY_MS * attempt);
    }
  }

  if (String(lastError?.message || "").toLowerCase() === "no se encontraron resultados.") {
    return [];
  }

  throw lastError || new Error("Error de búsqueda TikTok.");
}

function buildTikTokPublicUrl(item = {}) {
  const explicitUrl = clean(item?.publicUrl || item?.url);

  if (/^https?:\/\/(?:www\.)?(?:m\.)?tiktok\.com\//i.test(explicitUrl)) {
    return explicitUrl;
  }

  const author = clean(item?.author).replace(/^@/, "");
  const id = clean(item?.id);

  if (!author || !id) return "";

  return `https://www.tiktok.com/@${author}/video/${id}`;
}

function buildTikTokCommand(prefix, item = {}) {
  const publicUrl = buildTikTokPublicUrl(item);
  const playUrl = clean(item?.play);
  const target = publicUrl || playUrl;

  return target ? `${prefix}tiktok ${target}` : `${prefix}tiktok`;
}

function buildUsageMessage(prefix = ".") {
  return [
    "╭━━━〔 🔎 *FSOCIETY TIKTOK* 〕━━━⬣",
    "┃",
    "┃ ✘ Falta el texto para buscar.",
    "┃",
    "┣━━━〔 ✦ USO 〕━━━⬣",
    `┃ ➤ ${prefix}ttsearch edit goku`,
    `┃ ➤ ${prefix}tts anime sad`,
    `┃ ➤ ${prefix}tiktoksearch autos`,
    "┃",
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function buildNotFoundMessage(query = "") {
  return [
    "╭━━━〔 ⚠️ *TIKTOK SEARCH* 〕━━━⬣",
    "┃",
    `┃ No encontré videos para: *${clipText(query, 45)}*`,
    "┃ Intenta con otra palabra.",
    "┃",
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function buildSearchingMessage(query = "") {
  return [
    "╭━━━〔 🔎 *FSOCIETY TIKTOK* 〕━━━⬣",
    "┃",
    `┃ Buscando videos para: *${clipText(query, 45)}*`,
    "┃",
    "┃ ✦ Preparando carrusel...",
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function buildErrorMessage(error) {
  return [
    "╭━━━〔 ❌ *TIKTOK ERROR* 〕━━━⬣",
    "┃",
    `┃ ${sanitizeProviderMessage(error, {
      kind: "search",
      fallback: "Intenta otra búsqueda en unos segundos.",
    })}`,
    "┃",
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function buildCardBody(item = {}, index = 0, query = "") {
  const title = clipText(item?.title || "Video TikTok", 95);
  const author = clean(item?.author || "usuario").replace(/^@/, "");
  const views = compactNumber(item?.stats?.views || 0);
  const likes = compactNumber(item?.stats?.likes || 0);
  const duration = formatDurationSeconds(item?.durationSeconds || 0);

  return (
    `🔎 ${clipText(query, 40)}\n` +
    `🎬 ${index + 1}. ${title}\n` +
    `👤 @${author}\n` +
    `⏱️ ${duration} | 👁️ ${views} | ❤️ ${likes}`
  );
}

function buildCarouselCards(results = [], prefix = ".", query = "") {
  return results
    .slice(0, RESULT_LIMIT)
    .map((item, index) => {
      const play = clean(item?.play);
      const cover = clean(item?.cover) || DEFAULT_COVER;
      const commandId = buildTikTokCommand(prefix, item);

      return {
        image: { url: cover },
        title: `TikTok #${index + 1}`,
        body: buildCardBody(item, index, query),
        footer: "FSOCIETY BOT",
        buttons: [
          {
            name: "quick_reply",
            buttonParamsJson: JSON.stringify({
              display_text: "Descargar",
              id: commandId,
            }),
          },
          play
            ? {
                name: "cta_url",
                buttonParamsJson: JSON.stringify({
                  display_text: "Ver video",
                  url: buildTikTokPublicUrl(item) || play,
                }),
              }
            : null,
        ].filter(Boolean),
      };
    })
    .filter((card) => card?.image?.url);
}

async function sendTikTokCarousel(sock, from, quoted, query, results, prefix) {
  if (!SUPPORTS_BAILEYS_CARDS) {
    throw new Error("baileys_cards_not_supported");
  }

  const cards = buildCarouselCards(results, prefix, query);

  if (!cards.length) {
    throw new Error("No hay tarjetas válidas.");
  }

  await sock.sendMessage(
    from,
    {
      text: "🎵 *TikTok Carrusel*",
      title: "FSOCIETY TIKTOK",
      footer: `Resultados para: ${clipText(query, 60)}`,
      cards,
      ...global.channelInfo,
    },
    quoted
  );
}

async function sendFallbackList(sock, from, quoted, query, results, prefix) {
  const rows = results.slice(0, RESULT_LIMIT).map((item, index) => {
    const title = clipText(item?.title || "Video TikTok", 60);
    const author = clean(item?.author || "usuario").replace(/^@/, "");
    const views = compactNumber(item?.stats?.views || 0);

    return {
      header: `${index + 1}`,
      title,
      description: `@${author} | 👁️ ${views}`,
      id: buildTikTokCommand(prefix, item),
    };
  });

  await sock.sendMessage(
    from,
    {
      text: `Resultados para: *${clipText(query, 60)}*`,
      title: "FSOCIETY TIKTOK",
      subtitle: "Selecciona un video para descargar",
      footer: "FSOCIETY BOT",
      interactiveButtons: [
        {
          name: "single_select",
          buttonParamsJson: JSON.stringify({
            title: "Ver resultados",
            sections: [
              {
                title: "Resultados TikTok",
                rows,
              },
            ],
          }),
        },
      ],
      ...global.channelInfo,
    },
    quoted
  );
}

export default {
  name: "ttsearch",
  command: ["ttsearch", "ttksearch", "tts", "tiktoksearch"],
  category: "busqueda",
  description: "Busca videos de TikTok y envía carrusel de resultados",

  run: async (ctx) => {
    const { sock, msg, from, args, settings } = ctx;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const q = clean(args.join(" "));
    const prefix = getPrefix(settings);

    if (!q) {
      return sock.sendMessage(
        from,
        {
          text: buildUsageMessage(prefix),
          ...global.channelInfo,
        },
        quoted
      );
    }

    let downloadCharge = null;

    try {
      await sock.sendMessage(
        from,
        {
          text: buildSearchingMessage(q),
          ...global.channelInfo,
        },
        quoted
      );

      const results = await searchTikTokVideosWithRetries(q, RESULT_LIMIT);

      if (!results.length) {
        return sock.sendMessage(
          from,
          {
            text: buildNotFoundMessage(q),
            ...global.channelInfo,
          },
          quoted
        );
      }

      downloadCharge = await chargeDownloadRequest(ctx, {
        commandName: "tiktoksearch",
        query: q,
        totalResults: results.length,
      });

      if (!downloadCharge?.ok) return null;

      try {
        await sendTikTokCarousel(sock, from, quoted, q, results, prefix);
      } catch (carouselError) {
        console.error("ttsearch carousel fallback:", carouselError?.message || carouselError);
        await sendFallbackList(sock, from, quoted, q, results, prefix);
      }
    } catch (error) {
      console.error("Error ejecutando ttsearch:", error?.message || error);

      refundDownloadCharge(ctx, downloadCharge, {
        commandName: "tiktoksearch",
        reason: error?.message || "search_error",
      });

      await sock.sendMessage(
        from,
        {
          text: buildErrorMessage(error),
          ...global.channelInfo,
        },
        quoted
      );
    }
  },
};