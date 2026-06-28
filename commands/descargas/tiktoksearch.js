import fs from "fs";
import path from "path";
import { searchTikTokVideos } from "./_searchFallbacks.js";
import { chargeDownloadRequest, refundDownloadCharge } from "../economia/download-access.js";
import { sanitizeProviderMessage } from "./_errorMessages.js";
import {
  buildDownloadCard,
  buildSelectorCaption,
  buildSelectorPayload,
  buildUsageCard,
  downloadFirstValidImageBuffer,
} from "./_downloadUi.js";

const RESULT_LIMIT = 5;
const DEFAULT_CAROUSEL_COVER = "https://i.ibb.co/5xrnyZhN/fsociety-bot-profile.png";
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

function clipText(value = "", max = 72) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(1, max - 3))}...`;
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
  if (seconds < 60) return `${Math.floor(seconds)} segundos`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.floor(seconds % 60);
  return rem > 0 ? `${minutes}m ${rem}s` : `${minutes}m`;
}

function normalizeRegion(value = "") {
  const region = String(value || "").trim().toUpperCase();
  return region || "N/D";
}

function compactUrl(value = "", max = 95) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 3))}...`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function searchTikTokVideosWithRetries(query, limit) {
  let lastError = null;

  for (let attempt = 1; attempt <= SEARCH_RETRY_ATTEMPTS; attempt += 1) {
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

  throw lastError || new Error("Error de busqueda TikTok.");
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

function buildTikTokCommandId(prefix, item) {
  const publicUrl = buildTikTokPublicUrl(item);
  const fallbackUrl = String(item?.play || "").trim();
  const targetUrl = publicUrl || fallbackUrl;
  if (!targetUrl) {
    return `${prefix}tiktok`;
  }
  return `${prefix}tiktok ${targetUrl}`.trim();
}

function buildResultRows(results, prefix) {
  return results.map((item, index) => {
    const title = clipText(item?.title || "Video TikTok", 70);
    const author = String(item?.author || "usuario").replace(/^@/, "");
    const views = compactNumber(item?.stats?.views || 0);

    return {
      header: `${index + 1}`,
      title,
      description: clipText(`@${author} | 👁️ ${views}`, 72),
      id: buildTikTokCommandId(prefix, item),
    };
  });
}

function buildSections(results, prefix) {
  return [
    {
      title: "Resultados TikTok",
      rows: buildResultRows(results, prefix),
    },
  ];
}

function buildCardButtons(item, prefix) {
  return buildCardButtonsWithMode(item, prefix, "copy");
}

function buildCardButtonsWithMode(item, prefix, mode = "copy") {
  const commandId = buildTikTokCommandId(prefix, item);

  if (mode === "quick_reply") {
    return [
      {
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({
          display_text: "Descargar",
          id: commandId,
        }),
      },
    ];
  }

  return [
    {
      name: "cta_copy",
      buttonParamsJson: JSON.stringify({
        display_text: "Copy",
        copy_code: commandId,
      }),
    },
  ];
}

function buildDetailedCardBody(item, index, query, mode = "detailed") {
  const title = clipText(item?.title || "Sin titulo", 220);
  const author = String(item?.author || "usuario").replace(/^@/, "");
  const likes = Number(item?.stats?.likes || 0);
  const comments = Number(item?.stats?.comments || 0);
  const shares = Number(item?.stats?.shares || 0);
  const views = Number(item?.stats?.views || 0);
  const duration = formatDurationSeconds(item?.durationSeconds || 0);
  const region = normalizeRegion(item?.region || "");
  const publicUrl = buildTikTokPublicUrl(item) || String(item?.play || "").trim() || "N/D";
  const safeUrl = compactUrl(publicUrl, 95);

  if (mode === "minimal") {
    return (
      `Resultados para: ${clipText(query, 40)}\n` +
      `➠ Video: ${index + 1}\n` +
      `➠ Autor: ${author}\n` +
      `➠ Reproducciones: ${views}\n` +
      `➠ URL: ${safeUrl}`
    );
  }

  if (mode === "compact") {
    return (
      `Resultados para: ${clipText(query, 48)}\n` +
      `TikTok - Resultado\n` +
      `➠ Video: ${index + 1}\n` +
      `➠ Titulo: ${clipText(title, 120)}\n` +
      `➠ Autor: ${author}\n` +
      `➠ Likes: ${likes} | Comentarios: ${comments}\n` +
      `➠ Reproducciones: ${views}\n` +
      `➠ URL: ${safeUrl}\n\n` +
      `Usa el boton para descargar/ver`
    );
  }

  return (
    `Resultados para: ${clipText(query, 60)}\n` +
    `TikTok - Resultado\n` +
    `➠ Video: ${index + 1}\n` +
    `➠ Titulo: ${clipText(title, 130)}\n` +
    `➠ Duracion: ${duration}\n` +
    `➠ Region: ${region}\n` +
    `➠ Autor: ${author}\n` +
    `➠ Likes: ${likes}\n` +
    `➠ Comentarios: ${comments}\n` +
    `➠ Shares: ${shares}\n` +
    `➠ Reproducciones: ${views}\n` +
    `➠ URL: ${safeUrl}\n\n` +
    `Usa el boton para descargar/ver`
  );
}

function buildCarouselCards(results, prefix, query, mode = "video", bodyMode = "detailed", buttonMode = "copy") {
  return results.map((item, index) => {
    const play = String(item?.play || "").trim();
    const cover = String(item?.cover || "").trim() || DEFAULT_CAROUSEL_COVER;
    const mediaPayload =
      mode === "video" && play
        ? { video: { url: play } }
        : { image: { url: cover } };

    return {
      ...mediaPayload,
      title: "TikTok - Resultado",
      body: buildDetailedCardBody(item, index, query, bodyMode),
      footer: "FSOCIETY BOT",
      buttons: buildCardButtonsWithMode(item, prefix, buttonMode),
    };
  });
}

async function sendCarouselResults(sock, from, quoted, query, results, prefix) {
  if (!SUPPORTS_BAILEYS_CARDS) {
    throw new Error("baileys_cards_not_supported");
  }

  const basePayload = {
    text: "🎥 FSOCIETY TIKTOK",
    footer: `TikTok • ${clipText(query, 60)}`,
    title: "FSOCIETY DOWNLOAD",
    ...global.channelInfo,
  };

  const attempts = [
    {
      label: "video-detailed-copy",
      cards: buildCarouselCards(results, prefix, query, "video", "detailed", "copy"),
    },
    {
      label: "image-detailed-copy",
      cards: buildCarouselCards(results, prefix, query, "image", "detailed", "copy"),
    },
    {
      label: "image-compact-copy",
      cards: buildCarouselCards(results, prefix, query, "image", "compact", "copy"),
    },
    {
      label: "image-minimal-quick",
      cards: buildCarouselCards(results, prefix, query, "image", "minimal", "quick_reply"),
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
      console.error(`ttsearch carousel fallback (${attempt.label}):`, error?.message || error);
    }
  }

  throw lastError || new Error("No se pudo enviar carrusel TikTok.");
}

async function sendFallbackResults(sock, from, quoted, query, results, prefix) {
  const sections = buildSections(results, prefix);
  const cover = await downloadFirstValidImageBuffer(
    [results[0]?.cover || "", DEFAULT_CAROUSEL_COVER],
    { timeout: 12_000, minBytes: 2_000 }
  );
  const author = String(results[0]?.author || "usuario").replace(/^@/, "");
  const caption = buildSelectorCaption({
    title: "🎥 *TIKTOK SEARCH*",
    query,
    lead: `👤 Creador top: @${clipText(author, 36)}`,
    featuredTitle: results[0]?.title || "Video TikTok",
    featuredLines: [
      `👁️ ${compactNumber(results[0]?.stats?.views || 0)}  •  ❤️ ${compactNumber(results[0]?.stats?.likes || 0)}`,
      `🌍 ${normalizeRegion(results[0]?.region || "")}  •  ⏱️ ${formatDurationSeconds(results[0]?.durationSeconds || 0)}`,
    ],
    actionLines: [
      "Abre el selector y elige el video que quieres descargar.",
    ],
  });

  await sock.sendMessage(
    from,
    buildSelectorPayload({
      imageBuffer: cover,
      caption,
      title: "🎥 TIKTOK SEARCH",
      subtitle: "Selector visual",
      footer: "TikTok • FSOCIETY",
      selectorTitle: "Ver resultados",
      sections,
    }),
    quoted
  );
}

export default {
  name: "ttsearch",
  command: ["ttsearch", "ttksearch", "tts", "tiktoksearch"],
  category: "busqueda",
  description: "Busca videos de TikTok y envia carrusel de videos",

  run: async (ctx) => {
    const { sock, msg, from, args, settings } = ctx;
    const q = args.join(" ").trim();
    const prefix = getPrefix(settings);

    if (!q) {
      return sock.sendMessage(
        from,
        {
          text: buildUsageCard({
            title: "🎥 *TIKTOK SEARCH*",
            summary: [
              "Busca videos de TikTok por texto y muestra resultados con selector.",
              "Si el carrusel no abre, el bot usa portada y lista interactiva.",
            ],
            examples: [
              `${prefix}ttsearch edit goku`,
              `${prefix}ttsearch style tips`,
              `${prefix}ttsearch cristiano ronaldo`,
            ],
            footer: "También puedes usar tiktokusuario para buscar por username.",
          }),
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
            text: buildDownloadCard("❌ *TIKTOK SEARCH*", [
              { lines: ["No encontré resultados de TikTok."] },
            ]),
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

      if (!downloadCharge.ok) {
        return null;
      }

      try {
        await sendCarouselResults(sock, from, { quoted: msg }, q, results, prefix);
      } catch (carouselError) {
        console.error("ttsearch carousel fallback:", carouselError?.message || carouselError);
        await sendFallbackResults(sock, from, { quoted: msg }, q, results, prefix);
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
          text: buildDownloadCard("❌ *TIKTOK SEARCH*", [
            {
              lines: [
                `Error obteniendo videos de TikTok: ${sanitizeProviderMessage(error, { kind: "search", fallback: "intenta otra busqueda en unos segundos" })}`,
              ],
            },
          ]),
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }
  },
};
