import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import http from "http";
import https from "https";
import axios from "axios";
import yts from "yt-search";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";
import { buildDvyerUrl, getDvyerBaseUrl, withDvyerApiKey } from "../../lib/api-manager.js";
import { bindAbort, throwIfAborted } from "../../lib/command-abort.js";
import { chargeDownloadRequest, refundDownloadCharge } from "../economia/download-access.js";
import {
  buildRateIdentity,
  checkRateLimit,
  formatRetrySeconds,
  runWithProviderCircuit,
} from "../../lib/provider-guard.js";

const API_YTMP4_URL = buildDvyerUrl("/ytmp4");
const API_BASE = getDvyerBaseUrl();
const TMP_DIR = path.join(os.tmpdir(), "dvyer-ytmp4");

const API_TIMEOUT = 90_000;
const FILE_TIMEOUT = 150_000;
const THUMB_TIMEOUT = 15_000;
const COMMAND_TIMEOUT_MS = 240_000;

const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const AS_DOCUMENT_BYTES = 35 * 1024 * 1024;
const MIN_VIDEO_BYTES = 64 * 1024;

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;
const PROVIDER_NAME = "dvyer_ytmp4";
const DEFAULT_QUALITY = "360p";
const FALLBACK_QUALITIES = ["360p", "240p", "144p"];
const QUALITY_RE = /^(1080p|720p|480p|360p|240p|144p|best|hd|sd|\d{3,4}p?)$/i;

const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 10 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 10 });

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145 Safari/537.36";

const sleepCleanupMs = 15 * 60 * 1000;

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clip(value = "", max = 80) {
  const text = clean(value);
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function bytes(size = 0) {
  const n = Number(size || 0);
  if (!Number.isFinite(n) || n <= 0) return "N/D";

  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }

  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function safeName(name = "youtube-video") {
  const parsed = path.parse(String(name || "youtube-video"));

  const base = clean(parsed.name || name)
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[^\w .()[\]-]/g, "")
    .slice(0, 120)
    .trim();

  return `${base || "youtube-video"}.mp4`;
}

function quality(value = "") {
  const text = clean(value).toLowerCase();

  if (!text || text === "best" || text === "sd") return DEFAULT_QUALITY;
  if (text === "hd") return "720p";

  const match = text.match(/(\d{3,4})/);
  const q = match ? `${match[1]}p` : DEFAULT_QUALITY;

  return ["1080p", "720p", "480p", "360p", "240p", "144p"].includes(q)
    ? q
    : DEFAULT_QUALITY;
}

function uniqQualities(preferred) {
  return [...new Set([quality(preferred), ...FALLBACK_QUALITIES])];
}

function sanitizeError(error, fallback = "No se pudo preparar el MP4.") {
  let text = clean(error?.message || error || fallback);

  try {
    const parsed = JSON.parse(text);
    text = clean(parsed?.detail || parsed?.message || text);
  } catch {}

  text = text
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[IP OCULTA]")
    .replace(/https?:\/\/\S+/gi, "[URL OCULTA]");

  const low = text.toLowerCase();

  if (low.includes("429") || low.includes("too many requests") || low.includes("rate-overlimit")) {
    return "El servidor recibió muchas solicitudes. Reintenta en un momento.";
  }

  if (low.includes("timeout") || low.includes("econnaborted")) {
    return "La API tardó demasiado. Intenta otra vez o usa calidad 240p.";
  }

  if (low.includes("403")) return "El enlace expiró o fue bloqueado. Intenta nuevamente.";
  if (low.includes("404")) return "No encontré el video o el enlace ya no está disponible.";

  if (low.includes("socket hang up") || low.includes("econnreset")) {
    return "El proveedor de video está inestable. Reintenta en un momento.";
  }

  return text || fallback;
}

async function react(sock, msg, emoji) {
  try {
    if (!emoji || !sock || !msg?.key) return;

    const jid = msg.key.remoteJid || msg.chat || msg.from;

    if (jid) {
      await sock.sendMessage(jid, {
        react: {
          text: emoji,
          key: msg.key,
        },
      });
    }
  } catch {}
}

async function ensureTmp() {
  await fsp.mkdir(TMP_DIR, { recursive: true });
}

async function deleteSafe(file) {
  try {
    if (file) await fsp.unlink(file);
  } catch {}
}

async function cleanupOldFiles() {
  try {
    await ensureTmp();

    const now = Date.now();
    const files = await fsp.readdir(TMP_DIR, { withFileTypes: true });

    for (const file of files) {
      if (!file.isFile()) continue;

      const full = path.join(TMP_DIR, file.name);
      const stat = await fsp.stat(full).catch(() => null);

      if (stat?.mtimeMs && now - stat.mtimeMs > sleepCleanupMs) {
        await deleteSafe(full);
      }
    }
  } catch {}
}

function textFromMessage(message) {
  return (
    message?.text ||
    message?.caption ||
    message?.body ||
    message?.message?.conversation ||
    message?.message?.extendedTextMessage?.text ||
    message?.message?.imageMessage?.caption ||
    message?.message?.videoMessage?.caption ||
    message?.message?.documentMessage?.caption ||
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    ""
  );
}

function rawInput(ctx) {
  const msg = ctx.m || ctx.msg || {};
  const argsText = Array.isArray(ctx.args) ? ctx.args.join(" ").trim() : "";
  const quoted =
    ctx.quoted ||
    msg.quoted ||
    msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;

  return clean(argsText || textFromMessage(quoted));
}

function ytUrl(text = "") {
  return clean(
    String(text).match(/https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/[^\s]+/i)?.[0] || ""
  );
}

function ytId(url = "") {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      return clean(parsed.pathname.replace(/^\/+/, "").split("/")[0]);
    }

    const v = clean(parsed.searchParams.get("v"));
    if (v) return v;

    const parts = parsed.pathname.split("/").filter(Boolean);

    if (["shorts", "embed", "live", "v"].includes(parts[0])) {
      return clean(parts[1]);
    }
  } catch {}

  return clean(
    String(url).match(
      /(?:youtu\.be\/|[?&]v=|youtube\.com\/(?:shorts|embed|live)\/)([A-Za-z0-9_-]{6,})/i
    )?.[1] || ""
  );
}

function parseInput(input) {
  const tokens = clean(input).split(/\s+/).filter(Boolean);

  let q = DEFAULT_QUALITY;
  let fast = true;
  const rest = [];

  for (const token of tokens) {
    const lower = token.toLowerCase();

    if (QUALITY_RE.test(token) && q === DEFAULT_QUALITY) {
      q = quality(token);
      continue;
    }

    if (["fast", "-fast", "--fast"].includes(lower)) {
      fast = true;
      continue;
    }

    if (["nofast", "-nofast", "--nofast"].includes(lower)) {
      fast = false;
      continue;
    }

    rest.push(token);
  }

  return {
    query: rest.join(" ").trim(),
    quality: q,
    fast,
  };
}

async function resolveVideo(input) {
  const url = ytUrl(input);

  if (url) {
    return {
      url,
      title: "YouTube Video",
      duration: "",
      author: "",
      thumbnail: "",
      videoId: ytId(url),
    };
  }

  const query = clean(input);
  if (!query) return null;

  const results = await yts(query);
  const video = results?.videos?.find((v) => v?.url);

  if (!video?.url) {
    throw new Error("No encontré resultados en YouTube.");
  }

  return {
    url: video.url,
    title: clean(video.title || "YouTube Video"),
    duration: clean(video.timestamp || ""),
    author: clean(video.author?.name || video.author || ""),
    thumbnail: clean(video.thumbnail || ""),
    videoId: clean(video.videoId || ""),
  };
}

async function thumb(url) {
  if (!url) return null;

  try {
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: THUMB_TIMEOUT,
      headers: {
        "User-Agent": UA,
      },
      httpAgent: HTTP_AGENT,
      httpsAgent: HTTPS_AGENT,
      validateStatus: () => true,
    });

    if (res.status >= 400 || !res.data) return null;

    const buffer = Buffer.from(res.data);

    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

async function apiRequest(videoUrl, q, fast, signal) {
  const res = await axios.get(API_YTMP4_URL, {
    timeout: API_TIMEOUT,
    params: {
      mode: "link",
      url: videoUrl,
      quality: q,
      fast,
      ...withDvyerApiKey(),
    },
    signal,
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
    },
    httpAgent: HTTP_AGENT,
    httpsAgent: HTTPS_AGENT,
    maxRedirects: 5,
    validateStatus: () => true,
  });

  if (res.status >= 400 || !res.data?.ok) {
    throw new Error(
      res.data?.detail ||
        res.data?.error?.message ||
        res.data?.message ||
        `HTTP ${res.status}`
    );
  }

  const data = res.data;

  const remoteUrl =
    data.direct_url ||
    data.provider_direct_url ||
    data.stream_url_full ||
    data.download_url_full ||
    data.url;

  if (!remoteUrl) {
    throw new Error("La API no devolvió URL de descarga.");
  }

  return {
    remoteUrl,
    title: clean(data.title || "YouTube Video"),
    fileName: safeName(data.filename || data.title || "youtube-video.mp4"),
    quality: clean(data.quality || data.quality_requested || q || DEFAULT_QUALITY),
    thumbnail: clean(data.thumbnail || ""),
  };
}

async function apiWithFallback(videoUrl, preferred, fast, signal) {
  let lastError = null;

  for (const q of uniqQualities(preferred)) {
    throwIfAborted(signal);

    try {
      return await apiRequest(videoUrl, q, fast, signal);
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error("No se pudo obtener el MP4.");
}

async function downloadFile(url, name, signal) {
  await ensureTmp();
  throwIfAborted(signal);

  const tempPath = path.join(TMP_DIR, `${Date.now()}-${randomUUID()}.mp4`);

  const res = await axios.get(url, {
    responseType: "stream",
    timeout: FILE_TIMEOUT,
    signal,
    headers: {
      "User-Agent": UA,
      Accept: "*/*",
    },
    httpAgent: HTTP_AGENT,
    httpsAgent: HTTPS_AGENT,
    maxRedirects: 5,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    throw new Error(`No pude descargar el MP4 remoto. HTTP ${res.status}`);
  }

  const total = Number(res.headers?.["content-length"] || 0);

  if (total > MAX_VIDEO_BYTES) {
    throw new Error(`El video pesa ${bytes(total)} y supera el límite.`);
  }

  const writer = fs.createWriteStream(tempPath);

  const unbind = bindAbort(signal, () => {
    try {
      res.data?.destroy?.(new Error("Descarga cancelada."));
    } catch {}

    try {
      writer.destroy?.(new Error("Descarga cancelada."));
    } catch {}
  });

  let downloaded = 0;

  res.data.on("data", (chunk) => {
    downloaded += chunk.length;

    if (downloaded > MAX_VIDEO_BYTES) {
      res.data.destroy(new Error("Video demasiado grande."));
    }
  });

  try {
    await pipeline(res.data, writer);
  } catch (e) {
    unbind();
    await deleteSafe(tempPath);
    throw e;
  }

  unbind();

  const stat = await fsp.stat(tempPath).catch(() => null);

  if (!stat?.size || stat.size < MIN_VIDEO_BYTES) {
    await deleteSafe(tempPath);
    throw new Error("El archivo MP4 descargado es inválido.");
  }

  return {
    tempPath,
    fileName: safeName(name),
    size: stat.size,
  };
}

function usage(prefix = ".") {
  return [
    "╭━━━〔 🎬 *FSOCIETY MP4* 〕━━━⬣",
    "┃",
    "┃ ✘ Falta el link o nombre del video.",
    "┃",
    "┣━━━〔 ✦ USO 〕━━━⬣",
    `┃ ➤ ${prefix}ytmp4 ozuna odisea`,
    `┃ ➤ ${prefix}ytmp4 240p bad bunny`,
    `┃ ➤ ${prefix}ytmp4 https://youtu.be/xxxx`,
    "┃",
    "┃ Calidad: *360p → 240p → 144p*",
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function limitMessage(retryMs) {
  return [
    "╭━━━〔 ⚠️ *LÍMITE MP4* 〕━━━⬣",
    "┃",
    "┃ Estás usando mucho este comando.",
    `┃ Reintenta en *${formatRetrySeconds(retryMs)}s*.`,
    "┃",
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function caption(data = {}) {
  return [
    "╭━━━〔 🎬 *FSOCIETY MP4* 〕━━━⬣",
    "┃",
    `┃ 🎞️ *${clip(data.title || data.fileName || "YouTube Video", 75)}*`,
    data.duration ? `┃ ⏱️ Duración: *${data.duration}*` : null,
    data.author ? `┃ 👤 Canal: *${clip(data.author, 45)}*` : null,
    `┃ 📺 Calidad: *${data.quality || DEFAULT_QUALITY}*`,
    data.size ? `┃ 💾 Peso: *${bytes(data.size)}*` : null,
    "┃",
    `┃ ⚡ Powered By *${API_BASE}*`,
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
  ].filter(Boolean).join("\n");
}

function errorMessage(error) {
  return [
    "╭━━━〔 ❌ *YTMP4 ERROR* 〕━━━⬣",
    "┃",
    `┃ ${sanitizeError(error)}`,
    "┃",
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

async function sendMp4(sock, from, quoted, data) {
  const jpegThumbnail = await thumb(data.thumbnail);
  const cap = caption(data);

  if (!data.size || Number(data.size) <= AS_DOCUMENT_BYTES) {
    try {
      await sock.sendMessage(
        from,
        {
          video: {
            url: data.tempPath || data.remoteUrl,
          },
          mimetype: "video/mp4",
          fileName: data.fileName,
          caption: cap,
          gifPlayback: false,
          jpegThumbnail: jpegThumbnail || undefined,
        },
        quoted
      );

      return "video";
    } catch {}
  }

  await sock.sendMessage(
    from,
    {
      document: {
        url: data.tempPath || data.remoteUrl,
      },
      mimetype: "video/mp4",
      fileName: data.fileName,
      caption: cap,
    },
    quoted
  );

  return "document";
}

export default {
  command: ["ytmp4", "ytv", "ytvideo"],
  categoria: "descarga",
  timeoutMs: COMMAND_TIMEOUT_MS,

  run: async (ctx) => {
    const { sock, from } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const signal = ctx.abortSignal || null;
    const prefix = ctx.prefix || global.prefix || ".";

    let tempPath = null;
    let charge = null;
    let sent = false;

    try {
      await react(sock, msg, "⏳");
      cleanupOldFiles().catch(() => {});
      throwIfAborted(signal);

      const input = rawInput(ctx);
      const parsed = parseInput(input);

      if (!clean(parsed.query || input)) {
        return sock.sendMessage(
          from,
          {
            text: usage(prefix),
            ...global.channelInfo,
          },
          quoted
        );
      }

      const identity = buildRateIdentity(
        {
          senderPhone: msg?.senderPhone || ctx.senderPhone,
          sender: msg?.sender || ctx.sender,
          from,
        },
        from
      );

      const limit = checkRateLimit({
        scope: `ytmp4:${identity}`,
        limit: RATE_LIMIT_MAX,
        windowMs: RATE_LIMIT_WINDOW_MS,
      });

      if (!limit.ok) {
        return sock.sendMessage(
          from,
          {
            text: limitMessage(limit.retryAfterMs),
            ...global.channelInfo,
          },
          quoted
        );
      }

      const video = await resolveVideo(parsed.query || input);

      if (!video?.url) {
        return sock.sendMessage(
          from,
          {
            text: usage(prefix),
            ...global.channelInfo,
          },
          quoted
        );
      }

      charge = await chargeDownloadRequest(ctx, {
        feature: "ytmp4",
        videoUrl: video.url,
      });

      if (!charge?.ok) return;

      const apiData = await runWithProviderCircuit(
        PROVIDER_NAME,
        () => apiWithFallback(video.url, parsed.quality, parsed.fast, signal),
        {
          failureThreshold: 4,
          cooldownMs: 90_000,
          shouldCountFailure: (e) => {
            const t = String(e?.message || e || "").toLowerCase();

            return !t.includes("no encontré resultados") && !t.includes("supera el límite");
          },
        }
      );

      const meta = {
        ...apiData,
        title: apiData.title || video.title,
        duration: video.duration,
        author: video.author,
        thumbnail: apiData.thumbnail || video.thumbnail,
      };

      try {
        throwIfAborted(signal);
        await sendMp4(sock, from, quoted, meta);
        sent = true;
        await react(sock, msg, "✅");
        return;
      } catch {}

      const file = await downloadFile(apiData.remoteUrl, apiData.fileName, signal);
      tempPath = file.tempPath;

      await sendMp4(sock, from, quoted, {
        ...meta,
        ...file,
      });

      sent = true;
      await react(sock, msg, "✅");
    } catch (error) {
      console.error("YTMP4 ERROR:", error?.message || error);

      if (!sent) {
        refundDownloadCharge(ctx, charge, {
          feature: "ytmp4",
          error: String(error?.message || error || "unknown_error"),
        });

        const shown = signal?.aborted
          ? "La descarga demoró demasiado y fue cancelada. Intenta con un video más corto."
          : error?.code === "PROVIDER_CIRCUIT_OPEN"
            ? String(error?.message || "Servicio temporalmente inestable.")
            : error;

        await sock.sendMessage(
          from,
          {
            text: errorMessage(shown),
            ...global.channelInfo,
          },
          quoted
        );

        await react(sock, msg, "❌");
      }
    } finally {
      if (tempPath) await deleteSafe(tempPath);
    }
  },
};