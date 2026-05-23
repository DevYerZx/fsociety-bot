import { searchTikTokVideos } from "./_searchFallbacks.js";
import { chargeDownloadRequest, refundDownloadCharge } from "../economia/download-access.js";
import { sanitizeProviderMessage } from "./_errorMessages.js";

const RESULT_LIMIT = 5;
const SEARCH_RETRY_ATTEMPTS = 3;
const SEARCH_RETRY_DELAY_MS = 900;

function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }

  return String(settings?.prefix || ".").trim() || ".";
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipText(value = "", max = 80) {
  const text = cleanText(value);
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function compactNumber(value = 0) {
  const n = Number(value || 0);

  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;

  return String(Math.floor(n));
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
  const explicitUrl = String(item?.publicUrl || item?.url || "").trim();

  if (/^https?:\/\/(?:www\.)?(?:m\.)?tiktok\.com\//i.test(explicitUrl)) {
    return explicitUrl;
  }

  const author = String(item?.author || "").replace(/^@/, "").trim();
  const id = String(item?.id || "").trim();

  if (!author || !id) return "";

  return `https://www.tiktok.com/@${author}/video/${id}`;
}

function buildUsageMessage(prefix) {
  return [
    "╭━━━〔 🔎 *FSOCIETY TIKTOK* 〕━━━⬣",
    "┃",
    "┃ ✘ Falta el texto para buscar.",
    "┃",
    "┃ ✦ Uso:",
    `┃ ➤ ${prefix}ttsearch edit goku`,
    `┃ ➤ ${prefix}tts anime sad`,
    "┃",
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function buildNotFoundMessage() {
  return [
    "╭━━━〔 ⚠️ *TIKTOK SEARCH* 〕━━━⬣",
    "┃",
    "┃ No encontré resultados de TikTok.",
    "┃ Intenta con otro nombre o palabra.",
    "┃",
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function buildVideoCaption(item = {}, query = "") {
  const title = clipText(item?.title || "Video TikTok", 90);
  const author = String(item?.author || "usuario").replace(/^@/, "");
  const views = compactNumber(item?.stats?.views || 0);
  const url = buildTikTokPublicUrl(item);

  return [
    "╭━━━〔 🎵 *FSOCIETY TIKTOK* 〕━━━⬣",
    "┃",
    `┃ 🔎 *Búsqueda:* ${clipText(query, 45)}`,
    `┃ 🎬 *Título:* ${title}`,
    `┃ 👤 *Autor:* @${author}`,
    `┃ 👁️ *Views:* ${views}`,
    url ? `┃ 🔗 *Link:* ${url}` : null,
    "┃",
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
  ].filter(Boolean).join("\n");
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

async function sendBestTikTokVideo(sock, from, quoted, query, results) {
  const video = results.find((item) => String(item?.play || "").trim()) || results[0];

  const playUrl = String(video?.play || "").trim();
  const coverUrl = String(video?.cover || "").trim();
  const caption = buildVideoCaption(video, query);

  if (playUrl) {
    await sock.sendMessage(
      from,
      {
        video: { url: playUrl },
        mimetype: "video/mp4",
        caption,
        ...global.channelInfo,
      },
      quoted
    );

    return;
  }

  if (coverUrl) {
    await sock.sendMessage(
      from,
      {
        image: { url: coverUrl },
        caption,
        ...global.channelInfo,
      },
      quoted
    );

    return;
  }

  await sock.sendMessage(
    from,
    {
      text: caption,
      ...global.channelInfo,
    },
    quoted
  );
}

export default {
  name: "ttsearch",
  command: ["ttsearch", "ttksearch", "tts", "tiktoksearch"],
  category: "busqueda",
  description: "Busca videos de TikTok y envía solo el primer video sin botones",

  run: async (ctx) => {
    const { sock, msg, from, args, settings } = ctx;
    const q = args.join(" ").trim();
    const prefix = getPrefix(settings);

    if (!q) {
      return sock.sendMessage(
        from,
        {
          text: buildUsageMessage(prefix),
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }

    let downloadCharge = null;

    try {
      const results = await searchTikTokVideosWithRetries(q, RESULT_LIMIT);

      if (!results.length) {
        return sock.sendMessage(
          from,
          {
            text: buildNotFoundMessage(),
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      }

      downloadCharge = await chargeDownloadRequest(ctx, {
        commandName: "tiktoksearch",
        query: q,
        totalResults: results.length,
      });

      if (!downloadCharge?.ok) return null;

      await sendBestTikTokVideo(sock, from, { quoted: msg }, q, results);
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
        { quoted: msg }
      );
    }
  },
};