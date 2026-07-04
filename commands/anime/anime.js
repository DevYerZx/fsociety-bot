import axios from "axios";
import mediafireCmd from "../descargas/mediafire.js";
import { buildDvyerUrl } from "../../lib/api-manager.js";
import {
  buildSelectorPayload,
  downloadFirstValidImageBuffer,
} from "../descargas/_downloadUi.js";
import { stylizeSignature, stylizeWord } from "../../lib/unicode-style.js";

const API_TIMEOUT = 45_000;
const IMAGE_TIMEOUT = 25_000;
const DEFAULT_LIMIT = 8;

function cleanText(value = "") {
  return String(value || "")
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
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function slugify(value = "") {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim();
}

function extractSlugFromUrl(value = "") {
  const text = cleanText(value);
  if (!text) return "";
  const mal = text.match(/myanimelist\.net\/anime\/\d+\/([^/?#]+)/i);
  if (mal?.[1]) return cleanText(mal[1]);
  const animeSlug = text.match(/\/anime\/subespanol\/([^/?#]+)/i);
  if (animeSlug?.[1]) return cleanText(animeSlug[1]);
  return "";
}

function resolveAnimeTarget(value = "") {
  const raw = cleanText(value);
  if (!raw) return "";
  const fromUrl = extractSlugFromUrl(raw);
  if (fromUrl) return fromUrl;
  if (/^https?:\/\//i.test(raw)) return "";
  return slugify(raw);
}

function normalizeUrl(value = "") {
  const text = cleanText(value);
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  return "";
}

function getResultTitle(item = {}) {
  return cleanText(item?.title || item?.name || "Anime");
}

function getResultUrl(item = {}) {
  return normalizeUrl(item?.source_url || item?.url || item?.link || "");
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
  if (response.status >= 400 || data?.ok === false || data?.status === false) {
    throw new Error(
      cleanText(data.detail || data.error?.message || data.message || `HTTP ${response.status}`)
    );
  }

  return data;
}

async function fetchCoverFromPage(url = "") {
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
        /<meta property="og:image" content="([^"]+)"/i,
        /<meta property="og:image:secure_url" content="([^"]+)"/i,
        /<meta name="twitter:image" content="([^"]+)"/i,
      ]) || ""
    );
  } catch {
    return "";
  }
}

async function getImageBuffer(url = "") {
  const imageUrl = cleanText(url);
  if (!imageUrl) return null;
  return downloadFirstValidImageBuffer([imageUrl], {
    timeout: IMAGE_TIMEOUT,
    minBytes: 2_000,
  });
}

function collectMediafireLinks(value, results = []) {
  if (!value || typeof value !== "object") return results;

  if (Array.isArray(value)) {
    for (const item of value) collectMediafireLinks(item, results);
    return results;
  }

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      const strict = item.match(/https?:\/\/(?:www\.)?(?:[a-z0-9-]+\.)?mediafire\.com\/[^\s"'<>\]]+/i);
      if (strict?.[0]) results.push(strict[0].trim());

      if (/url|link|download|stream|source/i.test(key)) {
        const loose = item.match(/https?:\/\/[^\s"'<>\]]+/i);
        if (loose?.[0]) results.push(loose[0].trim());
      }
      continue;
    }

    collectMediafireLinks(item, results);
  }

  return [...new Set(results.filter(Boolean))];
}

function collectChapterMediafireLinks(chapter = {}) {
  const links = [];
  const entries = Array.isArray(chapter?.enlaces_reproduccion)
    ? chapter.enlaces_reproduccion
    : [];

  for (const entry of entries) {
    const raw = cleanText(entry?.url || entry?.link || "");
    if (!raw) continue;
    const match = raw.match(/https?:\/\/(?:www\.)?(?:[a-z0-9-]+\.)?mediafire\.com\/[^\s"'<>\]]+/i);
    if (match?.[0]) links.push(match[0].trim());
  }

  return [...new Set(links)];
}

function flattenChapters(seasons = [], slug = "") {
  const rows = [];

  for (const season of seasons) {
    const seasonNo = Number(season?.temporada_numero || 0) || 0;
    const chapters = Array.isArray(season?.capitulos) ? season.capitulos : [];
    for (const chapter of chapters) {
      const chapterNo = Number(chapter?.capitulo_numero || 0) || 0;
      rows.push({
        slug,
        seasonNo,
        chapterNo,
        title: cleanText(chapter?.titulo_capitulo || `Episodio ${chapterNo || "?"}`),
        mediafireLinks: collectChapterMediafireLinks(chapter),
        raw: chapter,
      });
    }
  }

  return rows.sort((a, b) => {
    if (a.seasonNo !== b.seasonNo) return b.seasonNo - a.seasonNo;
    return b.chapterNo - a.chapterNo;
  });
}

function findChapter(seasons = [], seasonNo = 0, chapterNo = 0) {
  for (const season of seasons) {
    const currentSeason = Number(season?.temporada_numero || 0) || 0;
    if (currentSeason !== Number(seasonNo || 0)) continue;
    const chapters = Array.isArray(season?.capitulos) ? season.capitulos : [];
    for (const chapter of chapters) {
      const currentChapter = Number(chapter?.capitulo_numero || 0) || 0;
      if (currentChapter === Number(chapterNo || 0)) {
        return { season, chapter, seasonNo: currentSeason, chapterNo: currentChapter };
      }
    }
  }
  return null;
}

function buildRootSections(prefix) {
  return [
    {
      title: "Nuevos capitulos",
      rows: [
        {
          header: "LATEST",
          title: "Capitulos nuevos",
          description: "Abre los episodios recien publicados.",
          id: `${prefix}anime latest`,
        },
        {
          header: "TRENDING",
          title: "Anime en tendencia",
          description: "Muestra lo mas destacado ahora mismo.",
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
          header: "SEARCH",
          title: "Buscar anime",
          description: `Ejemplo: ${prefix}anime naruto`,
          id: `${prefix}anime naruto`,
        },
      ],
    },
  ];
}

function buildResultsSections(prefix, results = []) {
  const rows = results.slice(0, DEFAULT_LIMIT).map((item, index) => {
    const title = getResultTitle(item);
    const url = getResultUrl(item);
    const slug = resolveAnimeTarget(url || title);

    return {
      header: String(index + 1),
      title: clipText(title, 60),
      description: clipText(getResultSubtitle(item) || url.replace(/^https?:\/\//i, ""), 72),
      id: slug ? `${prefix}anime detail ${slug}` : `${prefix}anime trending`,
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
          header: "TREND",
          title: "Ver tendencias",
          description: "Regresa al panel principal.",
          id: `${prefix}anime trending`,
        },
      ],
    },
  ];
}

function buildChapterSections(prefix, slug, chapters = []) {
  const rows = chapters.slice(0, 12).map((item, index) => ({
    header: `${index + 1}`,
    title: clipText(`T${item.seasonNo || "?"} · EP${item.chapterNo || "?"} · ${item.title}`, 64),
    description: clipText(
      item.mediafireLinks.length
        ? "Descarga disponible por MediaFire"
        : "Sin MediaFire para este capitulo",
      72
    ),
    id: `${prefix}anime chapter ${slug} ${item.seasonNo} ${item.chapterNo}`,
  }));

  return [
    {
      title: "Capitulos recientes",
      rows,
    },
    {
      title: "Acciones",
      rows: [
        {
          header: "DESCARGA",
          title: "Intentar descarga del anime",
          description: "Usa el capitulo que tenga MediaFire disponible.",
          id: `${prefix}anime download ${slug}`,
        },
        {
          header: "MENU",
          title: "Volver al menu anime",
          description: "Regresa a los capitulos nuevos.",
          id: `${prefix}anime`,
        },
      ],
    },
  ];
}

function buildCaption(title, subtitle, total, extra = []) {
  return [
    `╭━━〔 ✦ ${stylizeWord("ANIME")} ✦ 〕━━⬣`,
    `┃ ${stylizeSignature(title)}`,
    subtitle ? `┃ ${subtitle}` : null,
    `┃ Total: *${total}*`,
    ...extra.map((line) => `┃ ${line}`),
    "╰━━━━━━━━━━━━━━━━━━⬣",
  ]
    .filter(Boolean)
    .join("\n");
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

  return [`Resultados visibles: *${total}*`, "", ...lines].join("\n");
}

function getPrivateJid(ctx = {}) {
  const candidates = [
    ctx?.m?.senderPhone,
    ctx?.senderPhone,
    ctx?.m?.sender,
    ctx?.sender,
  ];

  for (const candidate of candidates) {
    const jid = cleanText(candidate);
    if (jid.endsWith("@s.whatsapp.net")) return jid;
  }

  return "";
}

async function sendRootFeed({ sock, from, msg, settings, endpoint, title, subtitle, query = "" }) {
  const quoted = msg?.key ? { quoted: msg } : undefined;
  const prefix = getPrefix(settings);
  const data = await fetchJson(endpoint, query ? { q: query } : {});
  const results = Array.isArray(data.results) ? data.results : [];
  const firstItem = results[0] || {};
  const sourceUrl = getResultUrl(firstItem);
  const coverUrl =
    (sourceUrl ? await fetchCoverFromPage(sourceUrl) : "") ||
    (results[0]?.anime_info?.imagen_portada || results[0]?.anime_info?.image_portada || "");
  const buffer = coverUrl ? await getImageBuffer(coverUrl) : null;

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
    sections: buildResultsSections(prefix, results),
  });

  if (!buffer) {
    payload.text = payload.caption || payload.text || caption;
    delete payload.image;
    delete payload.caption;
  }

  return sock.sendMessage(from, payload, quoted);
}

async function fetchDetailData(target = "") {
  const slug = resolveAnimeTarget(target);
  if (!slug) return null;
  return fetchJson(`/anime/subespanol/${encodeURIComponent(slug)}`);
}

function buildDetailSummary(data = {}) {
  const animeInfo = data?.anime_info || {};
  const seasons = Array.isArray(data?.temporadas) ? data.temporadas : [];
  const chapterCount = seasons.reduce(
    (sum, season) => sum + (Array.isArray(season?.capitulos) ? season.capitulos.length : 0),
    0
  );
  const slug = resolveAnimeTarget(animeInfo?.titulo || data?.title || "");
  const chapters = flattenChapters(seasons, slug);
  const mediafireLinks = [...new Set(chapters.flatMap((item) => item.mediafireLinks))];

  return {
    title: cleanText(animeInfo?.titulo || data?.title || "Anime"),
    cover: cleanText(animeInfo?.imagen_portada || animeInfo?.image_portada || ""),
    seasons,
    chapterCount,
    chapters,
    mediafireLinks,
    slug,
  };
}

async function sendDetailToJid({ sock, jid, msg, settings, target, mode = "open" }) {
  const quoted = msg?.key ? { quoted: msg } : undefined;
  const prefix = getPrefix(settings);
  const data = await fetchDetailData(target);
  if (!data) {
    return sock.sendMessage(
      jid,
      {
        text: `URL invalida. Usa: ${prefix}anime buscar naruto`,
        ...global.channelInfo,
      },
      quoted
    );
  }

  const detail = buildDetailSummary(data);
  const imageBuffer = detail.cover ? await getImageBuffer(detail.cover) : null;
  const subtitle = mode === "download" ? "Detalle y descarga" : "Detalle de anime";
  const summaryLines = [
    detail.mediafireLinks.length
      ? `MediaFire disponible en ${detail.mediafireLinks.length} capitulo(s)`
      : "MediaFire: no detectado en capitulos",
    detail.cover ? `Portada: ${cleanText(detail.cover)}` : "Portada: no disponible",
    `Temporadas: *${detail.seasons.length}*`,
    `Capitulos: *${detail.chapterCount}*`,
  ];

  const chapterPreview = [];
  for (const season of detail.seasons.slice(0, 3)) {
    const seasonNo = season?.temporada_numero || "?";
    const chapters = Array.isArray(season?.capitulos) ? season.capitulos : [];
    const firstChapter = chapters[0];
    chapterPreview.push(
      `Temporada ${seasonNo}: ${chapters.length} capitulos${firstChapter?.titulo_capitulo ? ` | ${cleanText(firstChapter.titulo_capitulo)}` : ""}`
    );
  }

  const caption = buildCaption(
    detail.title,
    subtitle,
    detail.chapterCount || (detail.cover ? 1 : 0),
    [...summaryLines, ...chapterPreview]
  );

  if (mode === "download" && detail.mediafireLinks.length) {
    await sock.sendMessage(
      jid,
      {
        text: `${caption}\n\n🚀 Descarga interna iniciada con MediaFire.`,
        ...global.channelInfo,
      },
      quoted
    );

    await mediafireCmd.run({
      sock,
      from: jid,
      msg,
      m: msg,
      args: [detail.mediafireLinks[0]],
      settings,
      sender: jid,
    });
    return;
  }

  if (mode === "download" && imageBuffer) {
    return sock.sendMessage(
      jid,
      {
        document: imageBuffer,
        mimetype: "image/jpeg",
        fileName: `${cleanText(detail.title).replace(/[\\/:*?"<>|]/g, "") || "anime"}.jpg`,
        caption,
        ...global.channelInfo,
      },
      quoted
    );
  }

  const payload = buildSelectorPayload({
    imageBuffer,
    caption,
    title: "FSOCIETY BOT",
    subtitle: "Anime detalle",
    footer: "Abrir, descargar o volver al selector",
    selectorTitle: "Anime detalle",
    sections: buildChapterSections(prefix, detail.slug || resolveAnimeTarget(target), detail.chapters),
  });

  if (!imageBuffer) {
    payload.text = payload.caption || payload.text || caption;
    delete payload.image;
    delete payload.caption;
  }

  return sock.sendMessage(jid, payload, quoted);
}

async function notifyPrivateDelivery({ sock, from, msg, privateJid }) {
  const quoted = msg?.key ? { quoted: msg } : undefined;
  if (!privateJid || privateJid === from) return;

  await sock.sendMessage(
    from,
    {
      text: `📩 Te envie el anime al privado: *${privateJid.replace(/@s\.whatsapp\.net$/i, "")}*`,
      ...global.channelInfo,
    },
    quoted
  );
}

async function sendChapterToJid({
  sock,
  jid,
  msg,
  settings,
  target,
  seasonNo,
  chapterNo,
  mode = "open",
}) {
  const quoted = msg?.key ? { quoted: msg } : undefined;
  const data = await fetchDetailData(target);
  if (!data) {
    return sock.sendMessage(
      jid,
      {
        text: "No pude cargar el anime solicitado.",
        ...global.channelInfo,
      },
      quoted
    );
  }

  const detail = buildDetailSummary(data);
  const found = findChapter(detail.seasons, seasonNo, chapterNo);
  if (!found) {
    return sock.sendMessage(
      jid,
      {
        text: `No encontre el capitulo T${seasonNo} EP${chapterNo}.`,
        ...global.channelInfo,
      },
      quoted
    );
  }

  const chapterTitle = cleanText(found.chapter?.titulo_capitulo || `Episodio ${chapterNo}`);
  const mediafireLinks = collectChapterMediafireLinks(found.chapter);
  const imageBuffer = detail.cover ? await getImageBuffer(detail.cover) : null;
  const caption = buildCaption(
    detail.title,
    `T${found.seasonNo} · EP${found.chapterNo}`,
    1,
    [
      `Capitulo: ${chapterTitle}`,
      mediafireLinks.length
        ? `MediaFire: ${cleanText(mediafireLinks[0])}`
        : "MediaFire: no disponible en este capitulo",
      detail.cover ? `Portada: ${cleanText(detail.cover)}` : "Portada: no disponible",
    ]
  );

  if (mode === "download" && mediafireLinks.length) {
    await sock.sendMessage(
      jid,
      {
        text: `${caption}\n\n🚀 Descarga interna iniciada para este capitulo.`,
        ...global.channelInfo,
      },
      quoted
    );

    await mediafireCmd.run({
      sock,
      from: jid,
      msg,
      m: msg,
      args: [mediafireLinks[0]],
      settings,
      sender: jid,
    });
    return;
  }

  if (mode === "download") {
    return sock.sendMessage(
      jid,
      {
        text: `${caption}\n\n❌ Este capitulo no tiene enlace MediaFire disponible.`,
        ...global.channelInfo,
      },
      quoted
    );
  }

  const prefix = getPrefix(settings);
  const payload = buildSelectorPayload({
    imageBuffer,
    caption,
    title: "FSOCIETY BOT",
    subtitle: "Anime capitulo",
    footer: "Detalle del capitulo",
    selectorTitle: "Capitulo anime",
    sections: [
      {
        title: "Acciones",
        rows: [
          {
            header: "DESCARGA",
            title: "Descargar este capitulo",
            description: mediafireLinks.length
              ? "Usa el MediaFire detectado para este capitulo."
              : "No hay MediaFire para este capitulo.",
            id: `${prefix}anime chapterdl ${resolveAnimeTarget(target)} ${found.seasonNo} ${found.chapterNo}`,
          },
          {
            header: "ATRAS",
            title: "Volver al anime",
            description: "Regresa al selector de capitulos.",
            id: `${prefix}anime detail ${resolveAnimeTarget(target)}`,
          },
        ],
      },
    ],
  });

  if (!imageBuffer) {
    payload.text = payload.caption || payload.text || caption;
    delete payload.image;
    delete payload.caption;
  }

  return sock.sendMessage(jid, payload, quoted);
}

export default {
  name: "anime",
  command: ["anime", "animes", "otaku", "animeinfo"],
  category: "anime",
  description: "Anime en tendencia, noticias, estrenos y busqueda con selector e imagen",

  async run({ sock, from, msg, args = [], settings, m, sender, senderPhone, isGroup, esGrupo }) {
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const prefix = getPrefix(settings);
    const action = cleanText(args[0] || "menu").toLowerCase();
    const query = args.slice(1).join(" ").trim();
    const groupChat = Boolean(isGroup || esGrupo || String(from).endsWith("@g.us"));
    const privateJid = getPrivateJid({ m, sender, senderPhone }) || from;

    if (!args.length || ["menu", "help", "ayuda", "inicio", "panel", "latest", "hoy", "episodios"].includes(action)) {
      return sendRootFeed({
        sock,
        from,
        msg,
        settings,
        endpoint: "/anime/subespanollatam/latest",
        title: "Capitulos nuevos",
        subtitle: "Recien publicados en SubEspañol LATAM",
      });
    }

    if (["trending", "tendencias"].includes(action)) {
      return sendRootFeed({
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
      return sendRootFeed({
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
      return sendRootFeed({
        sock,
        from,
        msg,
        settings,
        endpoint: "/anime/livechart/schedule",
        title: "Proximos estrenos",
        subtitle: "Calendario de episodios",
      });
    }

    if (["chapter", "capitulo", "episodio", "ep"].includes(action)) {
      const target = cleanText(args[1] || "");
      const seasonNo = Number(args[2] || 0);
      const chapterNo = Number(args[3] || 0);
      const deliveryJid = groupChat ? privateJid : from;

      if (!target || !seasonNo || !chapterNo) {
        return sock.sendMessage(
          from,
          {
            text: `Uso: ${prefix}anime chapter <slug> <temporada> <capitulo>`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      if (groupChat && privateJid && privateJid !== from) {
        await notifyPrivateDelivery({ sock, from, msg, privateJid });
      }

      return sendChapterToJid({
        sock,
        jid: deliveryJid,
        msg,
        settings,
        target,
        seasonNo,
        chapterNo,
        mode: "open",
      });
    }

    if (["chapterdl", "capitulodl", "episodiodl", "epdl"].includes(action)) {
      const target = cleanText(args[1] || "");
      const seasonNo = Number(args[2] || 0);
      const chapterNo = Number(args[3] || 0);
      const deliveryJid = groupChat ? privateJid : from;

      if (!target || !seasonNo || !chapterNo) {
        return sock.sendMessage(
          from,
          {
            text: `Uso: ${prefix}anime chapterdl <slug> <temporada> <capitulo>`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      if (groupChat && privateJid && privateJid !== from) {
        await notifyPrivateDelivery({ sock, from, msg, privateJid });
      }

      return sendChapterToJid({
        sock,
        jid: deliveryJid,
        msg,
        settings,
        target,
        seasonNo,
        chapterNo,
        mode: "download",
      });
    }

    if (["latest", "hoy", "episodios"].includes(action)) {
      return sendRootFeed({
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

      return sendRootFeed({
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

    if (["detail", "detalle", "open", "ver", "download"].includes(action)) {
      const target = query || args[1] || "";
      const deliveryJid = groupChat ? privateJid : from;

      if (groupChat && privateJid && privateJid !== from) {
        await notifyPrivateDelivery({ sock, from, msg, privateJid });
      }

      return sendDetailToJid({
        sock,
        jid: deliveryJid,
        msg,
        settings,
        target,
        mode: action === "download" ? "download" : "open",
      });
    }

    if (groupChat && privateJid && privateJid !== from) {
      await notifyPrivateDelivery({ sock, from, msg, privateJid });
      return sendDetailToJid({
        sock,
        jid: privateJid,
        msg,
        settings,
        target: action || query || "trending",
        mode: "open",
      });
    }

    return sendRootFeed({
      sock,
      from,
      msg,
      settings,
      endpoint: "/anime/subespanollatam/latest",
      title: "Capitulos nuevos",
      subtitle: "Recien publicados en SubEspañol LATAM",
    });
  },
};
