import { searchPinterestImages } from "./_searchFallbacks.js";
import { chargeDownloadRequest, refundDownloadCharge } from "../economia/download-access.js";
import { sanitizeProviderMessage } from "./_errorMessages.js";

const RESULT_LIMIT = 8;
const COOLDOWN_TIME = 0;
const cooldowns = new Map();

const DEFAULT_COVER = "https://i.ibb.co/5xrnyZhN/fsociety-bot-profile.png";

function clean(str = "") {
  return String(str || "").replace(/\s+/g, " ").trim();
}

function clip(str = "", max = 60) {
  const s = clean(str);
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => clean(value)) || ".";
  }

  return clean(settings?.prefix || ".") || ".";
}

function getImageUrl(item = {}) {
  return (
    clean(item.image_large_url) ||
    clean(item.image_medium_url) ||
    clean(item.image_small_url) ||
    clean(item.url) ||
    ""
  );
}

function buildUsageMessage(prefix = ".") {
  return [
    "╭━━━〔 📌 *FSOCIETY PINTEREST* 〕━━━⬣",
    "┃",
    "┃ ✘ Falta el texto para buscar.",
    "┃",
    "┣━━━〔 ✦ USO 〕━━━⬣",
    `┃ ➤ ${prefix}pin goku`,
    `┃ ➤ ${prefix}pinterest wallpaper anime`,
    `┃ ➤ ${prefix}psearch autos deportivos`,
    "┃",
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function buildNotFoundMessage(query = "") {
  return [
    "╭━━━〔 ⚠️ *PINTEREST SEARCH* 〕━━━⬣",
    "┃",
    `┃ No encontré imágenes para: *${clip(query, 45)}*`,
    "┃ Intenta con otra palabra.",
    "┃",
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function buildSearchingMessage(query = "") {
  return [
    "╭━━━〔 🔎 *FSOCIETY PINTEREST* 〕━━━⬣",
    "┃",
    `┃ Buscando imágenes para: *${clip(query, 45)}*`,
    "┃",
    "┃ ✦ Preparando carrusel...",
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function buildErrorMessage(error) {
  return [
    "╭━━━〔 ❌ *PINTEREST ERROR* 〕━━━⬣",
    "┃",
    `┃ ${clean(
      sanitizeProviderMessage(error, {
        kind: "search",
        fallback: "No pude buscar imágenes ahora.",
      })
    )}`,
    "┃",
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function buildCarouselCards(results = [], query = "") {
  return results
    .map((item, index) => {
      const imageUrl = getImageUrl(item) || DEFAULT_COVER;
      const title = clip(item.title || query || "Pinterest Result", 55);
      const source = clip(item.source || "Pinterest", 45);

      return {
        image: { url: imageUrl },
        title: `Pinterest #${index + 1}`,
        body:
          `🔎 Búsqueda: ${clip(query, 40)}\n` +
          `🖼️ Título: ${title}\n` +
          `🌐 Fuente: ${source}`,
        footer: "FSOCIETY BOT",
        buttons: [
          {
            name: "cta_copy",
            buttonParamsJson: JSON.stringify({
              display_text: "Copiar imagen",
              copy_code: imageUrl,
            }),
          },
        ],
      };
    })
    .filter((card) => card?.image?.url);
}

async function sendPinterestCarousel(sock, from, quoted, query, results) {
  const cards = buildCarouselCards(results, query);

  if (!cards.length) {
    throw new Error("No hay imágenes válidas para enviar.");
  }

  await sock.sendMessage(
    from,
    {
      text: "📌 *Pinterest Carrusel*",
      title: "FSOCIETY PINTEREST",
      footer: `Resultados para: ${clip(query, 60)}`,
      cards,
      ...global.channelInfo,
    },
    quoted
  );
}

async function sendFallbackImages(sock, from, quoted, query, results) {
  const validResults = results
    .map((item) => ({
      ...item,
      imageUrl: getImageUrl(item),
    }))
    .filter((item) => item.imageUrl)
    .slice(0, 4);

  if (!validResults.length) {
    throw new Error("No hay imágenes válidas para enviar.");
  }

  for (const [index, item] of validResults.entries()) {
    await sock.sendMessage(
      from,
      {
        image: { url: item.imageUrl },
        caption:
          `╭━━━〔 📌 *PINTEREST ${index + 1}/${validResults.length}* 〕━━━⬣\n` +
          `┃\n` +
          `┃ 🔎 *Búsqueda:* ${clip(query, 45)}\n` +
          `┃ 🖼️ *Título:* ${clip(item.title || query, 70)}\n` +
          `┃ 🌐 *Fuente:* ${clip(item.source || "Pinterest", 50)}\n` +
          `┃\n` +
          `╰━━━━━━━━━━━━━━━━━━━━⬣`,
        ...global.channelInfo,
      },
      quoted
    );
  }
}

export default {
  name: "pinterest",
  command: ["pinterest", "pin", "pint", "psearch"],
  category: "busqueda",
  description: "Busca imágenes estilo Pinterest en carrusel",

  run: async (ctx) => {
    const { sock, from, args, msg, settings } = ctx;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const userId = from;
    const prefix = getPrefix(settings);

    if (COOLDOWN_TIME > 0) {
      const now = Date.now();
      const wait = (cooldowns.get(userId) || 0) - now;

      if (wait > 0) {
        return sock.sendMessage(
          from,
          {
            text: `Espera ${Math.ceil(wait / 1000)}s para volver a buscar.`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      cooldowns.set(userId, now + COOLDOWN_TIME);
    }

    const query = clean(args.join(" "));

    if (!query) {
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
          text: buildSearchingMessage(query),
          ...global.channelInfo,
        },
        quoted
      );

      const results = await searchPinterestImages(query, RESULT_LIMIT);

      if (!Array.isArray(results) || !results.length) {
        cooldowns.delete(userId);

        return sock.sendMessage(
          from,
          {
            text: buildNotFoundMessage(query),
            ...global.channelInfo,
          },
          quoted
        );
      }

      downloadCharge = await chargeDownloadRequest(ctx, {
        commandName: "pinterest",
        query,
        totalResults: results.length,
      });

      if (!downloadCharge?.ok) return null;

      try {
        await sendPinterestCarousel(sock, from, quoted, query, results.slice(0, RESULT_LIMIT));
      } catch (carouselError) {
        console.error("PIN carousel fallback:", carouselError?.message || carouselError);

        await sendFallbackImages(sock, from, quoted, query, results);
      }
    } catch (error) {
      console.error("ERROR PIN:", error?.message || error);

      cooldowns.delete(userId);

      refundDownloadCharge(ctx, downloadCharge, {
        commandName: "pinterest",
        reason: error?.message || "pinterest_error",
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