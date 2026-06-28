import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import { pipeline } from "stream/promises";

import {
  appendDvyerApiKeyToUrl,
  buildDvyerUrl,
  withDvyerApiKey,
  withDvyerApiKeyHeader,
} from "../../lib/api-manager.js";
import {
  assertDownloadWithinPolicy,
  getDownloadExecutionPolicy,
} from "../../lib/subbot-download-policy.js";
import { sanitizeProviderMessage } from "./_errorMessages.js";

const API_SEARCH_URL = buildDvyerUrl("/applemusicsearch");
const API_DOWNLOAD_URL = buildDvyerUrl("/applemusicdl");
const TMP_DIR = path.join(os.tmpdir(), "applemusic-downloads");
const REQUEST_TIMEOUT = 15 * 60 * 1000;
const SEARCH_TIMEOUT = 30_000;
const ARTWORK_TIMEOUT = 15_000;
const MAX_AUDIO_BYTES = 120 * 1024 * 1024;
const AUDIO_AS_DOCUMENT_THRESHOLD = 16 * 1024 * 1024;
const PICK_TOKEN_PATTERN = /^--pick=(\d{1,2})$/i;
const ARTWORK_SIZE_CANDIDATES = [2000, 1600, 1200, 800, 600];

const cooldowns = new Map();

function ensureTmpDir() {
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  } catch {}
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipText(value = "", max = 72) {
  const text = cleanText(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 3))}...`;
}

function normalizeComparableText(value = "") {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function tokenizeText(value = "") {
  return normalizeComparableText(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

function safeFileName(name) {
  return (
    String(name || "applemusic")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "applemusic"
  );
}

function normalizeAudioFileName(name, fallbackBase = "applemusic") {
  const parsed = path.parse(String(name || "").trim());
  const base = safeFileName(parsed.name || fallbackBase);
  return `${base}.mp3`;
}

function replaceAppleArtworkSize(url = "", size = 1200) {
  const value = String(url || "").trim();
  if (!value) return "";

  return value
    .replace(
      /\/\d+x\d+(bb|cc)?\.(jpg|jpeg|png|webp)(?=([?#]|$))/i,
      `/${size}x${size}$1.$2`
    )
    .replace(
      /\/\{w\}x\{h\}(bb|cc)?\.(jpg|jpeg|png|webp)(?=([?#]|$))/i,
      `/${size}x${size}$1.$2`
    )
    .replace(/\{w\}/gi, String(size))
    .replace(/\{h\}/gi, String(size));
}

function buildAppleArtworkCandidates(url = "") {
  const value = String(url || "").trim();
  if (!value) return [];

  return [...new Set([
    ...ARTWORK_SIZE_CANDIDATES.map((size) => replaceAppleArtworkSize(value, size)),
    value,
  ].filter(Boolean))];
}

function improveAppleArtworkUrl(url = "") {
  return buildAppleArtworkCandidates(url)[0] || "";
}

function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }

  return String(settings?.prefix || ".").trim() || ".";
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function isAppleMusicUrl(value) {
  return /^https?:\/\/music\.apple\.com\//i.test(String(value || "").trim());
}

function extractTextFromMessage(message) {
  return (
    message?.text ||
    message?.caption ||
    message?.body ||
    message?.message?.conversation ||
    message?.message?.extendedTextMessage?.text ||
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    ""
  );
}

function resolveUserInput(ctx) {
  const argsText = Array.isArray(ctx.args) ? ctx.args.join(" ").trim() : "";
  if (argsText) return argsText;

  const msg = ctx.m || ctx.msg || null;
  const quoted = msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage || ctx.quoted;
  return cleanText(extractTextFromMessage(quoted));
}

function parseInput(value) {
  const parts = cleanText(value).split(/\s+/).filter(Boolean);
  let pick = 1;
  const queryParts = [];

  for (const part of parts) {
    const match = part.match(PICK_TOKEN_PATTERN);
    if (match) {
      pick = Math.max(1, Math.min(40, Number(match[1] || 1)));
      continue;
    }

    queryParts.push(part);
  }

  return {
    pick,
    target: queryParts.join(" ").trim(),
    explicitPick: pick > 1,
  };
}

function durationLabel(durationMs) {
  const raw = String(durationMs ?? "").trim();
  if (!raw) return "??:??";
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(raw)) return raw;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return "??:??";

  const total = Math.max(1, Math.round(value > 10_000 ? value / 1000 : value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
  }

  return `${minutes}:${seconds}`;
}

function pickDownloadUrl(data) {
  return (
    data?.download_url_full ||
    data?.stream_url_full ||
    data?.full_url ||
    data?.download_url ||
    data?.stream_url ||
    data?.url ||
    data?.results?.[0]?.full_url ||
    data?.results?.[0]?.url ||
    data?.links?.[0]?.full_url ||
    data?.links?.[0]?.url ||
    data?.download_links?.[0]?.full_url ||
    data?.download_links?.[0]?.url ||
    ""
  );
}

function normalizeApiUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;

  const base = new URL(API_DOWNLOAD_URL);
  return new URL(value, base.origin).toString();
}

function deleteFileSafe(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

async function reactToMessage(sock, msg, emoji) {
  try {
    if (!sock || typeof sock.sendMessage !== "function" || !msg?.key) return false;
    await sock.sendMessage(msg.key.remoteJid, {
      react: {
        text: emoji,
        key: msg.key,
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function searchAppleMusic(query) {
  const response = await axios.get(API_SEARCH_URL, {
    params: withDvyerApiKey({ q: query, limit: 10 }),
    timeout: SEARCH_TIMEOUT,
    headers: withDvyerApiKeyHeader({
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0",
    }),
    validateStatus: () => true,
  });

  if (response.status >= 400 || response.data?.ok === false) {
    throw new Error(response.data?.message || response.data?.error || `HTTP ${response.status}`);
  }

  const results = Array.isArray(response.data?.results) ? response.data.results : [];
  const unique = new Set();

  return results
    .slice(0, 10)
    .map((item, index) => {
      const trackId = cleanText(item.track_id || item.id || "");
      const url = cleanText(item.song_url || item.apple_music_url || item.url || "");
      const uniqueKey = trackId || url;

      if (!uniqueKey || unique.has(uniqueKey)) return null;
      unique.add(uniqueKey);

      return {
        index: index + 1,
        title: cleanText(item.track_name || item.title || item.name || "Sin título"),
        artist: cleanText(item.artist_name || item.artist || "Apple Music"),
        album: cleanText(item.album_name || item.album || ""),
        genre: cleanText(item.genre || ""),
        duration: durationLabel(item.duration_ms || item.duration_seconds || item.duration),
        artwork: improveAppleArtworkUrl(item.artwork || item.thumbnail || item.image_url || ""),
        url,
      };
    })
    .filter((item) => item?.title && item?.url);
}

async function getAppleMusicInfo(input, pick = 1) {
  const params = {
    pick: Math.max(1, Math.min(40, Number(pick || 1))),
  };

  if (isAppleMusicUrl(input)) {
    params.url = input;
  } else {
    params.q = input;
  }

  const response = await axios.get(API_DOWNLOAD_URL, {
    params: withDvyerApiKey(params),
    timeout: SEARCH_TIMEOUT,
    headers: withDvyerApiKeyHeader({
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0",
    }),
    validateStatus: () => true,
  });

  if (response.status >= 400 || response.data?.ok === false) {
    throw new Error(response.data?.message || response.data?.error || `HTTP ${response.status}`);
  }

  const data = response.data || {};
  const downloadUrl = normalizeApiUrl(pickDownloadUrl(data));
  if (!downloadUrl) {
    throw new Error("La API no devolvió enlace de descarga.");
  }

  const title = cleanText(data.track_name || data.title || "Apple Music");
  const artist = cleanText(data.artist_name || data.artist || "Apple Music");

  return {
    title,
    artist,
    album: cleanText(data.album_name || data.album || ""),
    artwork: improveAppleArtworkUrl(
      normalizeApiUrl(data.image_url_full || data.image_url || data.thumbnail || "")
    ),
    fileName: normalizeAudioFileName(`${artist} - ${title}`, `${title} - ${artist}`),
    downloadUrl,
  };
}

async function downloadAudio(downloadUrl, outputPath, maxBytes) {
  const response = await axios.get(appendDvyerApiKeyToUrl(downloadUrl), {
    responseType: "stream",
    timeout: REQUEST_TIMEOUT,
    maxRedirects: 5,
    headers: withDvyerApiKeyHeader({
      Accept: "*/*",
      "User-Agent": "Mozilla/5.0",
    }),
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    throw new Error(`Error descarga: HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers?.["content-length"] || 0);
  if (contentLength && contentLength > maxBytes) {
    throw new Error("Audio demasiado grande para enviarlo por WhatsApp.");
  }

  let downloaded = 0;
  response.data.on("data", (chunk) => {
    downloaded += chunk.length;
    if (downloaded > maxBytes) {
      response.data.destroy(new Error("Audio demasiado grande para enviarlo por WhatsApp."));
    }
  });

  await pipeline(response.data, fs.createWriteStream(outputPath));

  const size = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
  if (!size || size < 50_000) {
    throw new Error("El audio descargado es inválido.");
  }

  if (size > maxBytes) {
    throw new Error("Audio demasiado grande para enviarlo por WhatsApp.");
  }

  return size;
}

function splitArtistNames(value = "") {
  const artist = cleanText(value);
  if (!artist) return [];

  return [...new Set(
    artist
      .split(/\s*(?:,|&|feat\.?|ft\.?|with|\bx\b|\by\b)\s*/i)
      .map((item) => cleanText(item))
      .filter(Boolean)
  )];
}

function scoreArtistMatch(query = "", artist = "") {
  const queryNormalized = normalizeComparableText(query);
  const artistNormalized = normalizeComparableText(artist);

  if (!queryNormalized || !artistNormalized) return 0;

  let score = 0;
  if (artistNormalized === queryNormalized) score += 120;
  if (artistNormalized.includes(queryNormalized)) score += 80;
  if (queryNormalized.includes(artistNormalized)) score += 55;

  const queryTokens = tokenizeText(query);
  const artistTokens = tokenizeText(artist);
  const shared = queryTokens.filter((token) => artistTokens.includes(token));
  score += shared.length * 20;

  if (shared.length && shared.length === queryTokens.length) {
    score += 30;
  }

  return score;
}

function pickFocusArtist(query, results = []) {
  const ranking = new Map();

  for (const result of results) {
    const variants = splitArtistNames(result.artist);
    const artists = variants.length ? variants : [cleanText(result.artist)];

    for (const artist of artists) {
      const key = normalizeComparableText(artist);
      if (!key) continue;

      const current = ranking.get(key) || { label: artist, score: 0, count: 0, rank: result.index || 99 };
      current.score += scoreArtistMatch(query, artist) + Math.max(0, 14 - ((result.index || 1) - 1) * 2);
      current.count += 1;
      current.rank = Math.min(current.rank, result.index || 99);

      if (artist.length < current.label.length) {
        current.label = artist;
      }

      ranking.set(key, current);
    }
  }

  if (!ranking.size) {
    const fallback = splitArtistNames(results[0]?.artist || "")[0] || cleanText(results[0]?.artist || "");
    return {
      key: normalizeComparableText(fallback),
      label: fallback || "Apple Music",
    };
  }

  const [key, entry] = [...ranking.entries()].sort((a, b) => {
    return (
      b[1].score - a[1].score ||
      b[1].count - a[1].count ||
      a[1].rank - b[1].rank
    );
  })[0];

  return { key, label: entry.label };
}

function matchesFocusArtist(artist = "", focus = {}) {
  const focusKey = cleanText(focus?.key);
  if (!focusKey) return false;

  const variants = splitArtistNames(artist);
  if (variants.some((value) => normalizeComparableText(value) === focusKey)) {
    return true;
  }

  return normalizeComparableText(artist).includes(focusKey);
}

function buildArtistSections(query, results, prefix) {
  const focusArtist = pickFocusArtist(query, results);
  const topTracks = [];
  const relatedTracks = [];

  for (const result of results) {
    if (matchesFocusArtist(result.artist, focusArtist)) {
      topTracks.push(result);
    } else {
      relatedTracks.push(result);
    }
  }

  const primary = topTracks.length ? topTracks : results;
  const sections = [];

  if (primary.length) {
    sections.push({
      title: focusArtist.label
        ? `Top canciones de ${clipText(focusArtist.label, 28)}`
        : "Resultados principales",
      highlight_label: "TOP",
      rows: primary.slice(0, 6).map((result) => ({
        header: `${result.index}`,
        title: clipText(result.title, 72),
        description: clipText(
          [result.duration || "??:??", result.artist, result.album].filter(Boolean).join(" • "),
          72
        ),
        id: `${prefix}applemusic ${result.url}`,
      })),
    });
  }

  if (relatedTracks.length) {
    sections.push({
      title: "Mas canciones relacionadas",
      highlight_label: "EXTRA",
      rows: relatedTracks.slice(0, 4).map((result) => ({
        header: `${result.index}`,
        title: clipText(result.title, 72),
        description: clipText(
          [result.duration || "??:??", result.artist, result.album].filter(Boolean).join(" • "),
          72
        ),
        id: `${prefix}applemusic ${result.url}`,
      })),
    });
  }

  return {
    focusArtist,
    featured: primary[0] || results[0] || null,
    topTracks: primary,
    relatedTracks,
    sections,
  };
}

function buildSearchCaption(query, searchView) {
  const featured = searchView?.featured || {};
  const artistLabel = cleanText(searchView?.focusArtist?.label || featured.artist || "Apple Music");

  return [
    "╭━━〔 🍎 *APPLE MUSIC* 〕━━⬣",
    `┃ 🔎 *Busqueda:* ${clipText(query, 54)}`,
    `┃ 🎤 *Top artista:* ${clipText(artistLabel, 42)}`,
    `┃ 🎼 *Resultados:* ${searchView?.topTracks?.length || 0} top • ${searchView?.relatedTracks?.length || 0} extra`,
    "┣━━〔 ⭐ DESTACADO 〕━━⬣",
    `┃ 🎵 *${clipText(featured.title || "Sin título", 58)}*`,
    `┃ 💿 ${clipText(featured.album || "Apple Music", 54)}`,
    `┃ ⏱️ ${featured.duration || "??:??"}  •  🖼️ Portada HD`,
    "┣━━〔 📥 SELECTOR 〕━━⬣",
    "┃ Elige una canción del top o de los relacionados",
    "╰━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function buildPickerFallbackText(caption, sections = []) {
  const blocks = sections
    .map((section) => {
      const rows = Array.isArray(section?.rows) ? section.rows : [];
      if (!rows.length) return "";

      return [
        `*${section.title || "Resultados"}*`,
        rows
          .map((row) => `*${row.header}. ${row.title}*\n${row.id}`)
          .join("\n\n"),
      ]
        .filter(Boolean)
        .join("\n");
    })
    .filter(Boolean)
    .join("\n\n");

  return blocks ? `${caption}\n\n${blocks}` : caption;
}

async function downloadArtworkBuffer(url = "") {
  for (const candidate of buildAppleArtworkCandidates(url)) {
    try {
      const response = await axios.get(candidate, {
        responseType: "arraybuffer",
        timeout: ARTWORK_TIMEOUT,
        maxRedirects: 4,
        validateStatus: () => true,
      });

      const contentType = cleanText(response?.headers?.["content-type"]).toLowerCase();
      const buffer = Buffer.from(response?.data || []);

      if (
        Number(response?.status || 0) < 400 &&
        contentType.startsWith("image/") &&
        buffer.length > 5_000
      ) {
        return buffer;
      }
    } catch {}
  }

  return null;
}

async function sendSearchPicker(ctx, query, results) {
  const { sock, from, quoted, settings } = ctx;
  const prefix = getPrefix(settings);
  const searchView = buildArtistSections(query, results, prefix);
  const imageBuffer = await downloadArtworkBuffer(searchView?.featured?.artwork || results[0]?.artwork || "");
  const caption = buildSearchCaption(query, searchView);

  const payload = {
    ...(imageBuffer ? { image: imageBuffer, caption } : { text: caption }),
    media: Boolean(imageBuffer),
    title: "🍎 APPLE MUSIC",
    subtitle: searchView?.focusArtist?.label
      ? `Top de ${clipText(searchView.focusArtist.label, 28)}`
      : "Elige una canción",
    footer: "Apple Music • DVYER",
    ...global.channelInfo,
    interactiveButtons: [
      {
        name: "single_select",
        buttonParamsJson: JSON.stringify({
          title: "🍎 Seleccionar canción",
          sections: searchView.sections,
        }),
      },
    ],
  };

  try {
    await sock.sendMessage(from, payload, quoted);
  } catch (error) {
    console.warn("APPLE MUSIC selector no disponible:", error?.message || error);
    if (imageBuffer) {
      try {
        await sock.sendMessage(
          from,
          {
            image: imageBuffer,
            caption,
            ...global.channelInfo,
          },
          quoted
        );
      } catch {}
    }

    const fallbackText = buildPickerFallbackText(caption, searchView.sections);

    await sock.sendMessage(
      from,
      {
        text: fallbackText,
        ...global.channelInfo,
      },
      quoted
    );
  }
}

async function sendAudio(sock, from, quoted, filePath, info, size) {
  if (size > AUDIO_AS_DOCUMENT_THRESHOLD) {
    await sock.sendMessage(
      from,
      {
        document: { url: filePath },
        mimetype: "audio/mpeg",
        fileName: info.fileName,
        caption: [
          `🍎 *${info.title}*`,
          `🎤 ${info.artist}`,
          info.album ? `💿 ${info.album}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        ...global.channelInfo,
      },
      quoted
    );
    return;
  }

  await sock.sendMessage(
    from,
    {
      audio: fs.readFileSync(filePath),
      mimetype: "audio/mpeg",
      ptt: false,
      fileName: info.fileName,
      ...global.channelInfo,
    },
    quoted
  );
}

function resolveMaxAudioBytes(ctx) {
  const policy = getDownloadExecutionPolicy(ctx, "applemusic");
  return Math.min(MAX_AUDIO_BYTES, Number(policy?.maxBytes || MAX_AUDIO_BYTES));
}

export default {
  name: "applemusic",
  command: ["applemusic", "apple", "applemusicdl", "amdl"],
  category: "descarga",
  description: "Busca y descarga canciones de Apple Music en MP3.",

  run: async (ctx) => {
    const { sock, from, settings } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const userId = `${from}:applemusic`;
    const maxAudioBytes = resolveMaxAudioBytes(ctx);
    let tempPath = null;

    try {
      ensureTmpDir();

      const until = cooldowns.get(userId);
      if (until && until > Date.now()) {
        return sock.sendMessage(from, { text: "⏳ Espera unos segundos.", ...global.channelInfo }, quoted);
      }
      cooldowns.set(userId, Date.now() + 3000);

      const parsed = parseInput(resolveUserInput(ctx));
      if (!parsed.target) {
        cooldowns.delete(userId);
        return sock.sendMessage(
          from,
          {
            text:
              "🍎 *Uso:*\n\n" +
              ".applemusic canción artista\n" +
              ".applemusic https://music.apple.com/...\n" +
              ".applemusic --pick=2 bad bunny",
            ...global.channelInfo,
          },
          quoted
        );
      }

      if (isHttpUrl(parsed.target) && !isAppleMusicUrl(parsed.target)) {
        cooldowns.delete(userId);
        return sock.sendMessage(
          from,
          { text: "❌ Solo URLs de Apple Music o búsqueda por texto.", ...global.channelInfo },
          quoted
        );
      }

      if (!isAppleMusicUrl(parsed.target) && !parsed.explicitPick) {
        const results = await searchAppleMusic(parsed.target);
        if (!results.length) {
          cooldowns.delete(userId);
          return sock.sendMessage(
            from,
            {
              text: "❌ No encontré canciones de Apple Music para esa búsqueda.",
              ...global.channelInfo,
            },
            quoted
          );
        }

        await sendSearchPicker({ sock, from, quoted, settings }, parsed.target, results);
        cooldowns.delete(userId);
        return;
      }

      await reactToMessage(sock, msg, "⏳");

      const info = await getAppleMusicInfo(parsed.target, parsed.pick);
      tempPath = path.join(TMP_DIR, `${Date.now()}-${info.fileName}`);
      const size = await downloadAudio(info.downloadUrl, tempPath, maxAudioBytes);
      assertDownloadWithinPolicy(ctx, size, "audios");

      await sendAudio(sock, from, quoted, tempPath, info, size);
      await reactToMessage(sock, msg, "✅");
    } catch (error) {
      console.error("APPLEMUSIC ERROR:", error?.message || error);
      cooldowns.delete(userId);
      await reactToMessage(sock, msg, "❌");

      await sock.sendMessage(
        from,
        {
          text: `❌ ${sanitizeProviderMessage(error, { kind: "audio", fallback: "No se pudo procesar Apple Music." })}`,
          ...global.channelInfo,
        },
        quoted
      );
    } finally {
      deleteFileSafe(tempPath);
    }
  },
};
