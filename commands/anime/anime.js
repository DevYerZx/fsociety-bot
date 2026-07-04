import axios from "axios";
import { buildDvyerUrl, getDvyerBaseUrl } from "../../lib/api-manager.js";
import { stylizeSignature, stylizeWord } from "../../lib/unicode-style.js";

const API_TIMEOUT = 45_000;
const DEFAULT_LIMIT = 8;

function decodeHtmlEntities(value = "") {
  const text = String(value || "");
  return text
    .replace(/&#(\d+);/g, (_, num) => {
      const code = Number(num);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, num) => {
      const code = Number.parseInt(num, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    })
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function cleanText(value = "") {
  return decodeHtmlEntities(String(value || "").replace(/\s+/g, " ").trim());
}

function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }
  return String(settings?.prefix || ".").trim() || ".";
}

function clipText(value = "", max = 88) {
  const text = cleanText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 3))}...`;
}

function toRows(items = [], mapper = (item) => item, limit = DEFAULT_LIMIT) {
  return items.slice(0, limit).map((item, index) => mapper(item, index));
}

function buildMenuSections(prefix) {
  return [
    {
      title: "Noticias y tendencias",
      rows: [
        {
          header: "NEWS",
          title: "Noticias Anime",
          description: "Noticias recientes de anime y manga.",
          id: `${prefix}anime news`,
        },
        {
          header: "TREND",
          title: "Tendencias Anime",
          description: "Lo que esta destacando ahora mismo.",
          id: `${prefix}anime trending`,
        },
      ],
    },
    {
      title: "Estrenos y hoy",
      rows: [
        {
          header: "SCHEDULE",
          title: "Proximos estrenos",
          description: "Calendario de episodios que salen pronto.",
          id: `${prefix}anime schedule`,
        },
        {
          header: "LATEST",
          title: "Episodios de hoy",
          description: "Episodios publicados hoy.",
          id: `${prefix}anime latest`,
        },
      ],
    },
    {
      title: "Busqueda",
      rows: [
        {
          header: "SEARCH",
          title: "Buscar anime",
          description: `Ejemplo: ${prefix}anime naruto`,
          id: `${prefix}anime naruto`,
        },
      ],
    },
  ];
}

async function fetchAnime(endpoint, params = {}) {
  const response = await axios.get(buildDvyerUrl(endpoint), {
    timeout: API_TIMEOUT,
    params,
    validateStatus: () => true,
  });

  const data = response.data || {};
  if (response.status >= 400 || !data.ok) {
    throw new Error(
      cleanText(
        data.detail || data.error?.message || data.message || `HTTP ${response.status}`
      )
    );
  }

  return data;
}

function formatNews(items = []) {
  const rows = toRows(items, (item, index) => {
    const title = cleanText(item?.title || "Noticia anime");
    const url = cleanText(item?.source_url || "");
    return `• ${String(index + 1).padStart(2, "0")}. ${title}${url ? `\n  ${url}` : ""}`;
  });

  return rows.length ? rows.join("\n") : "Sin noticias disponibles.";
}

function formatTrending(items = []) {
  const rows = toRows(items, (item, index) => {
    const title = cleanText(item?.title || "Anime");
    const score = item?.score !== undefined ? ` | score ${Number(item.score).toFixed(2)}` : "";
    const url = cleanText(item?.source_url || "");
    return `• ${String(index + 1).padStart(2, "0")}. ${title}${score}${url ? `\n  ${url}` : ""}`;
  });

  return rows.length ? rows.join("\n") : "Sin tendencias disponibles.";
}

function formatSchedule(items = []) {
  const rows = toRows(items, (item, index) => {
    const title = cleanText(item?.title || "Anime");
    const episode = cleanText(item?.episode || "EP");
    return `• ${String(index + 1).padStart(2, "0")}. ${title} - ${episode}`;
  }, 12);

  return rows.length ? rows.join("\n") : "Sin estrenos disponibles.";
}

function formatSearch(items = [], query = "") {
  const rows = toRows(items, (item, index) => {
    const title = cleanText(item?.title || "Anime");
    const url = cleanText(item?.source_url || "");
    return `• ${String(index + 1).padStart(2, "0")}. ${title}${url ? `\n  ${url}` : ""}`;
  });

  const head = query ? `Resultados para: *${cleanText(query)}*\n` : "";
  return `${head}${rows.length ? rows.join("\n") : "Sin resultados."}`.trim();
}

function buildCaption(kind, total, extra = "") {
  const lines = [
    `╭━━〔 ✦ ${stylizeWord("ANIME")} ✦ 〕━━⬣`,
    `┃ ${stylizeSignature(kind)}`,
    `┃ Total: *${total}*`,
  ];

  if (extra) {
    lines.push(`┃ ${extra}`);
  }

  lines.push("╰━━━━━━━━━━━━━━━━━━⬣");
  return lines.join("\n");
}

function buildSearchHelp(prefix, query = "") {
  return [
    `🔎 *BUSQUEDA ANIME*`,
    "",
    query
      ? `Consulta actual: *${cleanText(query)}*`
      : `Uso: *${prefix}anime buscar naruto*`,
    "",
    `Tambien puedes escribir directamente: *${prefix}anime naruto*`,
  ].join("\n");
}

export default {
  name: "anime",
  command: ["anime", "animes", "otaku", "animeinfo"],
  category: "anime",
  description: "Noticias, tendencias, estrenos y busqueda de anime desde tu API",
  groupOnly: false,

  async run({ sock, from, msg, args = [], settings }) {
    const prefix = getPrefix(settings);
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const action = String(args[0] || "menu").trim().toLowerCase();
    const query = args.slice(1).join(" ").trim();

    if (
      !args.length ||
      ["menu", "help", "ayuda", "inicio", "panel"].includes(action)
    ) {
      return sock.sendMessage(
        from,
        {
          text:
            `╭━━〔 ✦ ${stylizeWord("ANIME HUB")} ✦ 〕━━⬣\n` +
            `┃ API: ${getDvyerBaseUrl()}\n` +
            `┃ Elige una seccion o busca un anime.\n` +
            `╰━━━━━━━━━━━━━━━━━━⬣`,
          footer: "Noticias, tendencias, estrenos y busqueda",
          interactiveButtons: [
            {
              name: "single_select",
              buttonParamsJson: JSON.stringify({
                title: "Panel Anime",
                sections: buildMenuSections(prefix),
              }),
            },
          ],
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (["news", "noticias"].includes(action)) {
      const data = await fetchAnime("/anime/myanimelist/news");
      const results = Array.isArray(data.results) ? data.results : [];
      const text = buildCaption("Noticias Anime", data.count || results.length, "MyAnimeList");
      return sock.sendMessage(
        from,
        {
          text: `${text}\n\n${formatNews(results)}`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (["trending", "tendencias"].includes(action)) {
      const data = await fetchAnime("/anime/trending");
      const results = Array.isArray(data.results) ? data.results : [];
      const text = buildCaption("Tendencias Anime", data.count || results.length, "Top anime del momento");
      return sock.sendMessage(
        from,
        {
          text: `${text}\n\n${formatTrending(results)}`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (["schedule", "estrenos", "proximos"].includes(action)) {
      const data = await fetchAnime("/anime/livechart/schedule");
      const results = Array.isArray(data.results) ? data.results : [];
      const text = buildCaption("Proximos estrenos", data.count || results.length, "LiveChart");
      return sock.sendMessage(
        from,
        {
          text: `${text}\n\n${formatSchedule(results)}`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (["latest", "hoy", "episodios"].includes(action)) {
      const data = await fetchAnime("/anime/subespanollatam/latest");
      const results = Array.isArray(data.results) ? data.results : [];
      const text = buildCaption("Episodios de hoy", data.count || results.length, "SubEspañol LATAM");
      return sock.sendMessage(
        from,
        {
          text: `${text}\n\n${formatSearch(results, "Episodios publicados hoy")}`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (["search", "buscar", "busca"].includes(action) || query) {
      const searchQuery = ["search", "buscar", "busca"].includes(action) ? query : [action, ...args.slice(1)].join(" ").trim();
      if (!searchQuery) {
        return sock.sendMessage(
          from,
          { text: buildSearchHelp(prefix), ...global.channelInfo },
          quoted
        );
      }

      const data = await fetchAnime("/anime/animedao/search", { q: searchQuery });
      const results = Array.isArray(data.results) ? data.results : [];
      const text = buildCaption("Anime Search", data.count || results.length, `Busqueda: ${clipText(searchQuery, 30)}`);
      return sock.sendMessage(
        from,
        {
          text: `${text}\n\n${formatSearch(results, searchQuery)}`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    return sock.sendMessage(
      from,
      { text: buildSearchHelp(prefix, query), ...global.channelInfo },
      quoted
    );
  },
};
