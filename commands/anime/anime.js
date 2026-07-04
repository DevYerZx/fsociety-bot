import axios from "axios";
import { buildDvyerUrl, getDvyerBaseUrl } from "../../lib/api-manager.js";
import {
  buildSelectorPayload,
  downloadFirstValidImageBuffer,
} from "../descargas/_downloadUi.js";
import { stylizeSignature, stylizeWord } from "../../lib/unicode-style.js";

const API_TIMEOUT = 45_000;
const IMAGE_TIMEOUT = 25_000;
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

function clipText(value = "", max = 88) {
  const text = cleanText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 3))}...`;
}

function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }
  return String(settings?.prefix || ".").trim() || ".";
}

function normalizeUrl(value = "") {
  const text = cleanText(value);
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  return "";
}

function normalizeMode(value = "") {
  return String(value || "").trim().toLowerCase();
}

function getResultUrl(item = {}) {
  return normalizeUrl(item?.source_url || item?.url || item?.link || "");
}

function getResultTitle(item = {}) {
  return cleanText(item?.title || item?.name || "Anime");
}

function getResultSubtitle(item = {}) {
  const score = item?.score !== undefined ? `score ${Number(item.score).toFixed(2)}` : "";
  const episode = item?.episode ? `episodio ${cleanText(item.episode)}` : "";
  return [score, episode].filter(Boolean).join(" | ");
}

function extractMeta(html = "", patterns = []) {
  const source = String(html || "");
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return cleanText(match[1]);
  }
  return "";
}

async function fetchJson(endpoint, params = {}) {
  const response = await axios.get(buildDvyerUrl(endpoint), {
    timeout: API_TIMEOUT,
    params,
    validateStatus: () => true,
  });

  const data = response.data || {};
  if (response.status >= 400 || !data.ok) {
    throw new Error(
      cleanText(data.detail || data.error?.message || data.message || `HTTP ${response.status}`)
    );
  }

  return data;
}

async function fetchCoverFromUrl(url = "") {
  const source = normalizeUrl(url);
  if (!source) return "";

  try {
    const response = await axios.get(source, {
      timeout: IMAGE_TIMEOUT,
      headers: { "user-agent": "Mozilla/5.0" },
      validateStatus: () => true,
    });

    if (response.status >= 400) return "";

    const html = String(response.data || "");
    return (
      extractMeta(html, [
        /<meta property="og:image" content="([^"]+)"/i,
        /<meta property="og:image:secure_url" content="([^"]+)"/i,
        /<meta name="twitter:image" content="([^"]+)"/i,
      ]) || ""
    );
  } catch {
    return "";
  }
}

async function fetchPageTitle(url = "") {
  const source = normalizeUrl(url);
  if (!source) return "";

  try {
    const response = await axios.get(source, {
      timeout: IMAGE_TIMEOUT,
      headers: { "user-agent": "Mozilla/5.0" },
      validateStatus: () => true,
    });

    if (response.status >= 400) return "";

    return (
      extractMeta(String(response.data || ""), [
        /<meta property="og:title" content="([^"]+)"/i,
        /<meta name="twitter:title" content="([^"]+)"/i,
      ]) ||
      extractMeta(String(response.data || ""), [/<title>([^<]+)<\/title>/i]) ||
      ""
    );
  } catch {
    return "";
  }
}

async function getImageBufferFromAnimeUrl(url = "") {
  const coverUrl = await fetchCoverFromUrl(url);
  if (!coverUrl) return { coverUrl: "", buffer: null };
  const buffer = await downloadFirstValidImageBuffer([coverUrl], {
    timeout: IMAGE_TIMEOUT,
    minBytes: 2_000,
  });
  return { coverUrl, buffer };
}

function buildRootSections(prefix) {
  return [
    {
      title: "Acciones rapidas",
      rows: [
        {
          header: "TRENDING",
          title: "Anime en tendencia",
          description: "Abre el panel principal con portada.",
          id: `${prefix}anime trending`,
        },
        {
          header: "NEWS",
          title: "Noticias anime",
          description: "Noticias recientes de anime y manga.",
          id: `${prefix}anime news`,
        },
        {
          header: "SCHEDULE",
          title: "Proximos estrenos",
          description: "Calendario de episodios por salir.",
          id: `${prefix}anime schedule`,
        },
        {
          header: "LATEST",
          title: "Episodios de hoy",
          description: "Publicaciones recientes del dia.",
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

function buildResultsSections(prefix, results = [], mode = "trending") {
  const rows = results.slice(0, DEFAULT_LIMIT).map((item, index) => {
    const url = getResultUrl(item);
    return {
      header: String(index + 1),
      title: clipText(getResultTitle(item), 60),
      description: clipText(
        getResultSubtitle(item) || cleanText(url.replace(/^https?:\/\//i, "")),
        72
      ),
      id: url ? `${prefix}anime open ${url}` : `${prefix}anime ${mode}`,
    };
  });

  return [
    {
      title: "Resultados",
      rows,
    },
    {
      title: "Acciones",
      rows: [
        {
          header: "BUSCAR",
          title: "Nueva busqueda",
          description: "Vuelve a buscar otro anime.",
          id: `${prefix}anime buscar naruto`,
        },
        {
          header: "TRENDS",
          title: "Ver tendencias",
          description: "Regresa al panel principal.",
          id: `${prefix}anime trending`,
        },
      ],
    },
  ];
}

function buildCaption(title, subtitle, total, extra = []) {
  const lines = [
    `╭━━〔 ✦ ${stylizeWord("ANIME")} ✦ 〕━━⬣`,
    `┃ ${stylizeSignature(title)}`,
    subtitle ? `┃ ${subtitle}` : null,
    `┃ Total: *${total}*`,
    ...extra.map((line) => `┃ ${line}`),
    "╰━━━━━━━━━━━━━━━━━━⬣",
  ];

  return lines.filter(Boolean).join("\n");
}

function buildListText(items = [], total = 0) {
  const lines = items.map((item, index) => {
    const title = getResultTitle(item);
    const extra = getResultSubtitle(item);
    const url = getResultUrl(item);
    return [
      `• ${String(index + 1).padStart(2, "0")}. ${title}`,
      extra ? `  ${extra}` : null,
      url ? `  ${url}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  });

  return [
    `Resultados visibles: *${total}*`,
    "",
    ...lines,
  ].join("\n");
}

async function sendAnimeFeed({ sock, from, msg, settings, endpoint, title, subtitle, query = "" }) {
  const quoted = msg?.key ? { quoted: msg } : undefined;
  const prefix = getPrefix(settings);
  const data = await fetchJson(endpoint, query ? { q: query } : {});
  const results = Array.isArray(data.results) ? data.results : [];
  const firstItem = results[0] || {};
  const sourceUrl = getResultUrl(firstItem);
  const { coverUrl, buffer } = sourceUrl
    ? await getImageBufferFromAnimeUrl(sourceUrl)
    : { coverUrl: "", buffer: null };

  const caption = buildCaption(
    title,
    subtitle,
    data.count || results.length,
    [
      coverUrl ? `Portada: ${cleanText(coverUrl)}` : "Portada: no disponible",
      sourceUrl ? `Fuente: ${cleanText(sourceUrl)}` : "Fuente: no disponible",
    ]
  );

  const payload = buildSelectorPayload({
    imageBuffer: buffer,
    caption: `${caption}\n\n${buildListText(results, data.count || results.length)}`,
    title: "FSOCIETY BOT",
    subtitle: "Anime Hub",
    footer: "Selecciona una accion",
    selectorTitle: "Anime Hub",
    sections: buildResultsSections(prefix, results, normalizeMode(title)),
  });

  if (!buffer) {
    payload.text = payload.caption || payload.text || caption;
    delete payload.image;
    delete payload.caption;
  }

  return sock.sendMessage(from, payload, quoted);
}

async function sendAnimeDetail({ sock, from, msg, settings, url, title = "", mode = "open" }) {
  const quoted = msg?.key ? { quoted: msg } : undefined;
  const prefix = getPrefix(settings);
  const sourceUrl = normalizeUrl(url);
  if (!sourceUrl) {
    return sock.sendMessage(
      from,
      {
        text: `URL invalida. Usa: ${prefix}anime buscar naruto`,
        ...global.channelInfo,
      },
      quoted
    );
  }

  const pageTitle = cleanText(title || (await fetchPageTitle(sourceUrl)) || "Anime");
  const { coverUrl, buffer } = await getImageBufferFromAnimeUrl(sourceUrl);
  const subtitle = mode === "download"
    ? "Descarga directa de portada"
    : "Vista de anime";

  const caption = buildCaption(
    pageTitle || "Anime",
    subtitle,
    coverUrl ? 1 : 0,
    [
      sourceUrl ? `Fuente: ${cleanText(sourceUrl)}` : "Fuente: no disponible",
      coverUrl ? `Portada: ${cleanText(coverUrl)}` : "Portada: no disponible",
      "Si quieres la version descargable, usa el boton de descarga.",
    ]
  );

  if (mode === "download" && buffer) {
    return sock.sendMessage(
      from,
      {
        document: buffer,
        mimetype: "image/jpeg",
        fileName: `${cleanText(pageTitle || "anime").replace(/[\\/:*?"<>|]/g, "") || "anime"}.jpg`,
        caption,
        ...global.channelInfo,
      },
      quoted
    );
  }

  const payload = buildSelectorPayload({
    imageBuffer: buffer,
    caption,
    title: "FSOCIETY BOT",
    subtitle: "Anime detalle",
    footer: "Abrir, descargar o volver al selector",
    selectorTitle: "Anime detalle",
    sections: [
      {
        title: "Acciones",
        rows: [
          {
            header: "DESCARGA",
            title: "Descargar portada",
            description: "Envia la miniatura como archivo.",
            id: `${prefix}anime download ${sourceUrl}`,
          },
          {
            header: "ABRIR",
            title: "Abrir fuente",
            description: "Vuelve al detalle del anime.",
            id: `${prefix}anime open ${sourceUrl}`,
          },
          {
            header: "ATRAS",
            title: "Volver al menu",
            description: "Regresa al selector principal.",
            id: `${prefix}anime`,
          },
        ],
      },
    ],
  });

  if (!buffer) {
    payload.text = payload.caption || payload.text || caption;
    delete payload.image;
    delete payload.caption;
  }

  return sock.sendMessage(from, payload, quoted);
}

export default {
  name: "anime",
  command: ["anime", "animes", "otaku", "animeinfo"],
  category: "anime",
  description: "Anime en tendencia, noticias, estrenos y busqueda con selector e imagen",

  async run({ sock, from, msg, args = [], settings }) {
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const prefix = getPrefix(settings);
    const action = normalizeMode(args[0] || "menu");
    const query = args.slice(1).join(" ").trim();

    if (!args.length || ["menu", "help", "ayuda", "inicio", "panel", "trending", "tendencias"].includes(action)) {
      return sendAnimeFeed({
        sock,
        from,
        msg,
        settings,
        endpoint: "/anime/trending",
        title: "Anime en tendencia",
        subtitle: "Lo mas destacado ahora mismo",
      });
    }

    if (["news", "noticias"].includes(action)) {
      return sendAnimeFeed({
        sock,
        from,
        msg,
        settings,
        endpoint: "/anime/myanimelist/news",
        title: "Noticias anime",
        subtitle: "Noticias recientes de anime y manga",
      });
    }

    if (["schedule", "estrenos", "proximos"].includes(action)) {
      return sendAnimeFeed({
        sock,
        from,
        msg,
        settings,
        endpoint: "/anime/livechart/schedule",
        title: "Proximos estrenos",
        subtitle: "Calendario de episodios",
      });
    }

    if (["latest", "hoy", "episodios"].includes(action)) {
      return sendAnimeFeed({
        sock,
        from,
        msg,
        settings,
        endpoint: "/anime/subespanollatam/latest",
        title: "Episodios de hoy",
        subtitle: "Publicados hoy en SubEspañol LATAM",
      });
    }

    if (["search", "buscar", "busca"].includes(action)) {
      if (!query) {
        return sock.sendMessage(
          from,
          {
            text:
              `🔎 *BUSQUEDA ANIME*\n\n` +
              `Uso: *${prefix}anime buscar naruto*\n` +
              `Tambien puedes escribir: *${prefix}anime naruto*`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      return sendAnimeFeed({
        sock,
        from,
        msg,
        settings,
        endpoint: "/anime/animedao/search",
        title: "Anime Search",
        subtitle: `Busqueda: ${clipText(query, 36)}`,
        query,
      });
    }

    if (action === "open" || action === "download") {
      const url = query || args[1] || "";
      return sendAnimeDetail({
        sock,
        from,
        msg,
        settings,
        url,
        mode: action,
      });
    }

    return sendAnimeFeed({
      sock,
      from,
      msg,
      settings,
      endpoint: "/anime/trending",
      title: "Anime en tendencia",
      subtitle: "Lo mas destacado ahora mismo",
    });
  },
};
