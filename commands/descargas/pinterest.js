import fs from "fs";
import path from "path";

import { searchPinterestImages } from "./_searchFallbacks.js";
import { chargeDownloadRequest, refundDownloadCharge } from "../economia/download-access.js";
import { sanitizeProviderMessage } from "./_errorMessages.js";
import {
  buildDownloadCard,
  buildSelectorCaption,
  buildSelectorPayload,
  buildUsageCard,
  downloadFirstValidImageBuffer,
} from "./_downloadUi.js";

const RESULT_LIMIT = 8;
const COOLDOWN_TIME = 0;
const DEFAULT_COVER = "https://i.ibb.co/5xrnyZhN/fsociety-bot-profile.png";
const BAILEYS_MESSAGES_FILE = path.join(
  process.cwd(),
  "node_modules",
  "@dvyer",
  "baileys",
  "lib",
  "Utils",
  "messages.js"
);
const PICK_TOKEN_PATTERN = /^--pick=(\d{1,2})$/i;

const cooldowns = new Map();

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

function clean(str = "") {
  return String(str || "").replace(/\s+/g, " ").trim();
}

function clip(str = "", max = 60) {
  const s = clean(str);
  return s.length > max ? `${s.slice(0, Math.max(1, max - 3))}...` : s;
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

function parseInput(args = []) {
  const rawParts = Array.isArray(args) ? args : [];
  let pick = 0;
  const queryParts = [];

  for (const part of rawParts) {
    const token = clean(part);
    const match = token.match(PICK_TOKEN_PATTERN);

    if (match) {
      pick = Math.max(1, Math.min(RESULT_LIMIT, Number(match[1] || 1)));
      continue;
    }

    if (token) {
      queryParts.push(token);
    }
  }

  return {
    query: clean(queryParts.join(" ")),
    pick,
    explicitPick: pick > 0,
  };
}

function buildPickCommand(prefix, query, pick) {
  return `${prefix}pin --pick=${pick} ${query}`.trim();
}

function buildUsageMessage(prefix = ".") {
  return buildUsageCard({
    title: "📌 *FSOCIETY PINTEREST*",
    summary: [
      "Busca imágenes estilo Pinterest y las muestra en carrusel.",
      "Puedes tocar una tarjeta para enviar la imagen exacta.",
    ],
    examples: [
      `${prefix}pin goku`,
      `${prefix}pinterest wallpaper anime`,
      `${prefix}psearch autos deportivos`,
    ],
    footer: "Si eliges una tarjeta, el bot enviará la imagen seleccionada.",
  });
}

function buildNotFoundMessage(query = "") {
  return buildDownloadCard("⚠️ *PINTEREST SEARCH*", [
    {
      lines: [
        `No encontré imágenes para: *${clip(query, 45)}*`,
        "Intenta con otra palabra o una búsqueda más corta.",
      ],
    },
  ]);
}

function buildSearchingMessage(query = "") {
  return buildDownloadCard("🔎 *FSOCIETY PINTEREST*", [
    {
      lines: [
        `Buscando imágenes para: *${clip(query, 45)}*`,
      ],
    },
    {
      title: "ESTADO",
      lines: ["Preparando carrusel visual..."],
    },
  ]);
}

function buildErrorMessage(error) {
  return buildDownloadCard("❌ *PINTEREST ERROR*", [
    {
      lines: [
        clean(
          sanitizeProviderMessage(error, {
            kind: "search",
            fallback: "No pude buscar imágenes ahora.",
          })
        ),
      ],
    },
  ]);
}

function buildSelectedImageCaption(query = "", item = {}, pick = 1, total = 1) {
  const title = clip(item.title || query || "Pinterest", 70);
  const source = clip(item.source || "Pinterest", 46);

  return buildDownloadCard("📌 *PINTEREST IMAGE*", [
    {
      lines: [
        `Resultado: *${pick}/${total}*`,
        `🔎 Búsqueda: *${clip(query, 46)}*`,
      ],
    },
    {
      title: "DETALLE",
      lines: [
        `🖼️ ${title}`,
        `🌐 ${source}`,
      ],
    },
  ]);
}

function buildResultRows(results, query, prefix) {
  return results.map((item, index) => ({
    header: `${index + 1}`,
    title: clip(item.title || query || "Pinterest", 72),
    description: clip(`Pinterest • ${item.source || "Imagen HD"}`, 72),
    id: buildPickCommand(prefix, query, index + 1),
  }));
}

function buildCarouselCards(results = [], query = "", prefix = ".") {
  return results
    .map((item, index) => {
      const imageUrl = getImageUrl(item) || DEFAULT_COVER;
      const title = clip(item.title || query || "Pinterest Result", 55);
      const source = clip(item.source || "Pinterest", 45);
      const commandId = buildPickCommand(prefix, query, index + 1);

      return {
        image: { url: imageUrl },
        title: `Pinterest #${index + 1}`,
        body:
          `🔎 Búsqueda: ${clip(query, 40)}\n` +
          `🖼️ Título: ${title}\n` +
          `🌐 Fuente: ${source}\n\n` +
          `Toca enviar para recibir esta imagen.`,
        footer: "FSOCIETY BOT",
        buttons: [
          {
            name: "quick_reply",
            buttonParamsJson: JSON.stringify({
              display_text: "Enviar",
              id: commandId,
            }),
          },
        ],
      };
    })
    .filter((card) => card?.image?.url);
}

async function sendPinterestCarousel(sock, from, quoted, query, results, prefix) {
  const cards = buildCarouselCards(results, query, prefix);

  if (!cards.length) {
    throw new Error("No hay imágenes válidas para enviar.");
  }

  await sock.sendMessage(
    from,
    {
      text: "📌 FSOCIETY PIN",
      title: "FSOCIETY DOWNLOAD",
      footer: `Pinterest • ${clip(query, 60)}`,
      cards,
      ...global.channelInfo,
    },
    quoted
  );
}

async function sendFallbackSelector(sock, from, quoted, query, results, prefix) {
  const validResults = results
    .map((item) => ({
      ...item,
      imageUrl: getImageUrl(item),
    }))
    .filter((item) => item.imageUrl)
    .slice(0, RESULT_LIMIT);

  if (!validResults.length) {
    throw new Error("No hay imágenes válidas para enviar.");
  }

  const rows = buildResultRows(validResults, query, prefix);
  const cover = await downloadFirstValidImageBuffer(
    [validResults[0]?.imageUrl, DEFAULT_COVER],
    { timeout: 12_000, minBytes: 2_000 }
  );
  const caption = buildSelectorCaption({
    title: "📌 *PINTEREST SEARCH*",
    query,
    lead: "🖼️ Resultados en imagen HD listos para enviar",
    featuredTitle: validResults[0]?.title || query || "Pinterest",
    featuredLines: [
      `🌐 ${clip(validResults[0]?.source || "Pinterest", 40)}`,
      "📦 Selección rápida desde el bot",
    ],
    actionLines: [
      "Abre el selector y elige la imagen que quieres enviar.",
    ],
  });

  await sock.sendMessage(
    from,
    buildSelectorPayload({
      imageBuffer: cover,
      caption,
      title: "📌 PINTEREST SEARCH",
      subtitle: "Selector de imágenes",
      footer: "Pinterest • FSOCIETY",
      selectorTitle: "Elegir imagen",
      sections: [
        {
          title: "Resultados Pinterest",
          rows,
        },
      ],
    }),
    quoted
  );
}

async function sendSelectedImage(sock, from, quoted, query, results, pick) {
  const validResults = results
    .map((item) => ({
      ...item,
      imageUrl: getImageUrl(item),
    }))
    .filter((item) => item.imageUrl);

  if (!validResults.length) {
    throw new Error("No encontré imágenes válidas en esta búsqueda.");
  }

  const index = Math.max(0, Math.min(validResults.length - 1, Number(pick || 1) - 1));
  const item = validResults[index];

  await sock.sendMessage(
    from,
    {
      image: { url: item.imageUrl },
      caption: buildSelectedImageCaption(query, item, index + 1, validResults.length),
      ...global.channelInfo,
    },
    quoted
  );
}

export default {
  name: "pinterest",
  command: ["pinterest", "pin", "pint", "psearch"],
  category: "busqueda",
  description: "Busca imágenes estilo Pinterest en carrusel",

  run: async (ctx) => {
    const { sock, from, args, settings } = ctx;
    const msg = ctx.msg || ctx.m || null;
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
            text: buildDownloadCard("⏳ *PINTEREST*", [
              { lines: [`Espera ${Math.ceil(wait / 1000)}s para volver a buscar.`] },
            ]),
            ...global.channelInfo,
          },
          quoted
        );
      }

      cooldowns.set(userId, now + COOLDOWN_TIME);
    }

    const parsed = parseInput(args);
    const query = parsed.query;

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
      if (!parsed.explicitPick) {
        await sock.sendMessage(
          from,
          {
            text: buildSearchingMessage(query),
            ...global.channelInfo,
          },
          quoted
        );
      }

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

      if (parsed.explicitPick) {
        await sendSelectedImage(sock, from, quoted, query, results, parsed.pick);
        return null;
      }

      try {
        await sendPinterestCarousel(sock, from, quoted, query, results.slice(0, RESULT_LIMIT), prefix);
      } catch (carouselError) {
        console.error("PIN carousel fallback:", carouselError?.message || carouselError);
        await sendFallbackSelector(sock, from, quoted, query, results, prefix);
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
