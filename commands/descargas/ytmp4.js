import axios from "axios";
import { buildDvyerUrl, getDvyerBaseUrl } from "../../lib/api-manager.js";
import { throwIfAborted } from "../../lib/command-abort.js";
import { chargeDownloadRequest, refundDownloadCharge } from "../economia/download-access.js";

const API_BASE = getDvyerBaseUrl();
const API_SEARCH_URL = buildDvyerUrl("/ytsearch");
const VIDEO_ENDPOINTS = [
  buildDvyerUrl("/ytdlmp4"),
  buildDvyerUrl("/ytmp4"),
  buildDvyerUrl("/ytaltmp4"),
];

const REQUEST_TIMEOUT = 210000;
const LINK_TIMEOUT = 90000;
const QUALITY_CANDIDATES = ["240p", "360p", "144p"];
const COOLDOWN_TIME = 0;
const LINK_CACHE_TTL_MS = 8 * 60 * 1000;
const LINK_RETRY_ATTEMPTS = 2;

const cooldowns = new Map();
const linkCache = new Map();

function now() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLinkCache(key) {
  const hit = linkCache.get(key);
  if (!hit || hit.expiresAt <= now()) {
    linkCache.delete(key);
    return null;
  }
  return hit.value;
}

function writeLinkCache(key, value) {
  linkCache.set(key, { value, expiresAt: now() + LINK_CACHE_TTL_MS });
}

function safeText(value, fallback = "") {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

function safeFileName(value, fallback = "video") {
  const clean = String(value || fallback)
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
  return clean || fallback;
}

function normalizeMp4Name(value) {
  const base = safeFileName(String(value || "video").replace(/\.mp4$/i, ""), "video");
  return `${base}.mp4`;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function normalizeApiUrl(value) {
  const text = safeText(value);
  if (!text) return "";
  if (isHttpUrl(text)) return text;
  if (text.startsWith("/")) return `${API_BASE}${text}`;
  return `${API_BASE}/${text}`;
}

function pickVideoStreamUrl(payload) {
  return (
    payload?.stream_url_full ||
    payload?.download_url_full ||
    payload?.stream_url ||
    payload?.download_url ||
    payload?.url ||
    payload?.result?.stream_url_full ||
    payload?.result?.download_url_full ||
    payload?.result?.stream_url ||
    payload?.result?.download_url ||
    payload?.result?.url ||
    ""
  );
}

function extractApiError(data, status) {
  return (
    data?.detail ||
    data?.error?.message ||
    data?.message ||
    (status ? `HTTP ${status}` : "Error de API")
  );
}

function extractYouTubeUrl(text) {
  const match = String(text || "").match(
    /https?:\/\/(?:www\.)?(?:youtube\.com|music\.youtube\.com|youtu\.be)\/[^\s]+/i
  );
  return match ? match[0].trim() : "";
}

function extractTextFromAnyMessage(message) {
  return (
    message?.text ||
    message?.caption ||
    message?.body ||
    message?.message?.conversation ||
    message?.message?.extendedTextMessage?.text ||
    message?.message?.imageMessage?.caption ||
    message?.message?.videoMessage?.caption ||
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    ""
  );
}

function resolveInput(ctx) {
  const msg = ctx.m || ctx.msg || null;
  const argsText = Array.isArray(ctx.args) ? ctx.args.join(" ").trim() : "";
  const quoted =
    ctx?.quoted ||
    msg?.quoted ||
    msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
    null;
  const quotedText = extractTextFromAnyMessage(quoted);
  return argsText || quotedText || "";
}

function getCooldownRemaining(untilMs) {
  return Math.max(0, Math.ceil((untilMs - now()) / 1000));
}

function shouldRetryError(error) {
  const text = String(error?.message || error || "").toLowerCase();
  return (
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("socket hang up") ||
    text.includes("econnreset") ||
    text.includes("etimedout") ||
    text.includes("429") ||
    text.includes("too many requests") ||
    text.includes("temporarily") ||
    text.includes("internal")
  );
}

function toFriendlyError(error) {
  const text = String(error?.message || error || "").trim();
  const lower = text.toLowerCase();
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "El servidor tardo demasiado. Intenta de nuevo.";
  }
  if (lower.includes("429") || lower.includes("too many requests")) {
    return "Hay muchas solicitudes ahora. Intenta en unos segundos.";
  }
  return text || "Error al procesar el video.";
}

async function apiGet(url, params, timeoutMs, signal) {
  const response = await axios.get(url, {
    timeout: timeoutMs,
    params,
    signal: signal || undefined,
    validateStatus: () => true,
  });
  if (response.status >= 400 || response?.data?.ok === false || response?.data?.status === false) {
    throw new Error(extractApiError(response.data, response.status));
  }
  return response.data;
}

async function resolveVideoInput(rawInput, signal) {
  const videoUrl = extractYouTubeUrl(rawInput);
  if (videoUrl) {
    return { videoUrl, title: "video youtube", thumbnail: null };
  }
  if (isHttpUrl(rawInput)) {
    throw new Error("Enviame un link valido de YouTube.");
  }
  const search = await apiGet(API_SEARCH_URL, { q: rawInput, limit: 1 }, 30000, signal);
  const first = search?.results?.[0];
  if (!first?.url) {
    throw new Error("No encontre resultados para ese titulo.");
  }
  return {
    videoUrl: safeText(first.url),
    title: safeText(first.title, "video youtube"),
    thumbnail: first.thumbnail || null,
  };
}

async function requestVideoLink(endpointUrl, videoUrl, quality, signal) {
  let lastError = null;
  for (let attempt = 1; attempt <= LINK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const payload = await apiGet(
        endpointUrl,
        {
          mode: "link",
          fast: "true",
          url: videoUrl,
          quality,
        },
        LINK_TIMEOUT,
        signal
      );
      const streamUrl = normalizeApiUrl(pickVideoStreamUrl(payload));
      if (!streamUrl) {
        throw new Error("No se obtuvo enlace de stream.");
      }
      const title = safeText(payload?.title, "video youtube");
      const fileName = normalizeMp4Name(payload?.filename || payload?.fileName || title);
      return { streamUrl, title, fileName };
    } catch (error) {
      lastError = error;
      if (attempt >= LINK_RETRY_ATTEMPTS || !shouldRetryError(error)) {
        break;
      }
      await sleep(900 * attempt);
    }
  }
  throw lastError || new Error("No se pudo preparar enlace de video.");
}

async function resolveVideoLink(videoUrl, signal) {
  const cacheKey = `ytmp4:${videoUrl}`;
  const cached = readLinkCache(cacheKey);
  if (cached?.streamUrl) {
    return cached;
  }

  let lastError = null;
  for (const endpointUrl of VIDEO_ENDPOINTS) {
    for (const quality of QUALITY_CANDIDATES) {
      try {
        const resolved = await requestVideoLink(endpointUrl, videoUrl, quality, signal);
        const result = { ...resolved, quality };
        writeLinkCache(cacheKey, result);
        return result;
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error("No se pudo obtener un enlace de video.");
}

async function sendVideo(sock, from, quoted, { streamUrl, title, fileName, quality }) {
  try {
    await sock.sendMessage(
      from,
      {
        video: { url: streamUrl },
        mimetype: "video/mp4",
        fileName,
        caption: `🎬 ${title}\n🎚️ ${quality}`,
        ...global.channelInfo,
      },
      quoted
    );
    return;
  } catch {}

  await sock.sendMessage(
    from,
    {
      document: { url: streamUrl },
      mimetype: "video/mp4",
      fileName,
      caption: `🎬 ${title}\n🎚️ ${quality}`,
      ...global.channelInfo,
    },
    quoted
  );
}

export default {
  command: ["ytmp4", "ytdlmp4", "ytaltmp4"],
  category: "descarga",

  run: async (ctx) => {
    const { sock, from } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const abortSignal = ctx.abortSignal || null;
    const userId = `${from}:ytmp4`;
    let charged = null;

    if (COOLDOWN_TIME > 0) {
      const until = cooldowns.get(userId);
      if (until && until > now()) {
        return sock.sendMessage(from, {
          text: `⏳ Espera ${getCooldownRemaining(until)}s`,
          ...global.channelInfo,
        });
      }
      cooldowns.set(userId, now() + COOLDOWN_TIME);
    }

    try {
      const input = resolveInput(ctx);
      if (!input) {
        cooldowns.delete(userId);
        return sock.sendMessage(from, {
          text: "❌ Uso: .ytmp4 <nombre o link de YouTube>",
          ...global.channelInfo,
        });
      }

      throwIfAborted(abortSignal);
      const video = await resolveVideoInput(input, abortSignal);
      throwIfAborted(abortSignal);

      charged = await chargeDownloadRequest(ctx, {
        feature: "ytmp4",
        title: video.title,
        videoUrl: video.videoUrl,
      });
      if (!charged.ok) {
        cooldowns.delete(userId);
        return;
      }

      await sock.sendMessage(
        from,
        {
          text: `🎬 Preparando video...\n\n📼 ${video.title}\n⚡ Modo rapido`,
          ...global.channelInfo,
        },
        quoted
      );

      throwIfAborted(abortSignal);
      const resolved = await resolveVideoLink(video.videoUrl, abortSignal);
      throwIfAborted(abortSignal);

      await sendVideo(sock, from, quoted, {
        streamUrl: resolved.streamUrl,
        title: safeText(resolved.title || video.title, "video youtube"),
        fileName: normalizeMp4Name(resolved.fileName || video.title),
        quality: resolved.quality || "auto",
      });
    } catch (error) {
      if (abortSignal?.aborted) {
        return;
      }
      refundDownloadCharge(ctx, charged, {
        feature: "ytmp4",
        error: String(error?.message || error || "unknown_error"),
      });
      cooldowns.delete(userId);
      await sock.sendMessage(from, {
        text: `❌ ${toFriendlyError(error)}`,
        ...global.channelInfo,
      });
    }
  },
};
