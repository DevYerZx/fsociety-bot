import path from "path";
import os from "os";
import fs from "fs";
import fsp from "fs/promises";
import http from "http";
import https from "https";
import axios from "axios";
import yts from "yt-search";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";
import { buildDvyerUrl } from "../../lib/api-manager.js";
import { chargeDownloadRequest, refundDownloadCharge } from "../economia/download-access.js";
import {
  buildRateIdentity,
  checkRateLimit,
  formatRetrySeconds,
  runWithProviderCircuit,
} from "../../lib/provider-guard.js";

const API_YTMP4DL_URL = buildDvyerUrl("/ytmp4dl");
const TMP_DIR = path.join(os.tmpdir(), "dvyer-ytmp4dl");
const REQUEST_TIMEOUT = 15 * 60 * 1000;
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const VIDEO_AS_DOCUMENT_THRESHOLD = 35 * 1024 * 1024;
const MIN_VIDEO_BYTES = 64 * 1024;
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 10 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 10 });
const QUALITY_PATTERN = /^(1080p|720p|360p|240p|best|hd|sd|\d{3,4}p?)$/i;
const QUALITY_OPTIONS = ["1080p", "720p", "360p", "240p"];

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;
const PROVIDER_NAME = "dvyer_ytmp4dl";
const TMP_FILE_MAX_AGE_MS = 15 * 60 * 1000;
const DEFAULT_QUALITY = "720p";

async function ensureTmpDir() {
  await fsp.mkdir(TMP_DIR, { recursive: true });
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipText(value = "", max = 90) {
  const text = cleanText(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 3))}...`;
}

function humanBytes(bytes = 0) {
  const size = Number(bytes || 0);
  if (!Number.isFinite(size) || size <= 0) return "N/D";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function safeFileName(name) {
  return (
    String(name || "youtube-video")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/[^\w .()[\]-]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "youtube-video"
  );
}

function normalizeMp4Name(name) {
  const parsed = path.parse(String(name || "").trim());
  const base = safeFileName(parsed.name || name || "youtube-video");
  return `${base || "youtube-video"}.mp4`;
}

function formatDuration(value = "") {
  const text = cleanText(value);
  return text || "Desconocida";
}

function normalizeQuality(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return DEFAULT_QUALITY;
  if (text === "hd") return "1080p";
  if (text === "sd") return "360p";
  if (text === "best") return "1080p";
  const match = text.match(/(\d{3,4})/);
  const numeric = Number(match?.[1] || 0);
  if (numeric >= 1080) return "1080p";
  if (numeric >= 720) return "720p";
  if (numeric >= 360) return "360p";
  return "240p";
}

function buildFallbackQualities(preferred) {
  const normalized = normalizeQuality(preferred);
  const startIndex = QUALITY_OPTIONS.indexOf(normalized);
  if (startIndex === -1) {
    return [DEFAULT_QUALITY, ...QUALITY_OPTIONS.filter((item) => item !== DEFAULT_QUALITY)];
  }
  return QUALITY_OPTIONS.slice(startIndex);
}

function cleanVideoErrorText(error, fallback = "No se pudo preparar el MP4.") {
  let text = String(error?.message || error || fallback);

  try {
    const parsed = JSON.parse(text);
    text = parsed?.detail || parsed?.message || text;
  } catch {}

  const normalized = text.toLowerCase();

  if (
    normalized.includes("rate-overlimit") ||
    normalized.includes("rate overlimit") ||
    normalized.includes("too many requests") ||
    normalized.includes("http 429") ||
    normalized.includes("429")
  ) {
    return "El servidor de video esta ocupado en este momento. Intenta otra vez en unos minutos.";
  }

  if (normalized.includes("timeout")) {
    return "La API de video tardó demasiado en responder. Intenta otra vez o usa una calidad menor.";
  }

  if (
    normalized.includes("socket hang up") ||
    normalized.includes("econnreset") ||
    normalized.includes("service unavailable") ||
    normalized.includes("temporarily unavailable")
  ) {
    return "El servidor de video esta temporalmente inestable. Intenta otra vez.";
  }

  if (normalized.includes("403")) {
    return "El enlace de video expiró o fue bloqueado. Intenta otra vez.";
  }

  if (normalized.includes("404")) {
    return "No se encontró el video o el enlace ya no está disponible.";
  }

  return text;
}

async function getBuffer(url) {
  const target = cleanText(url);
  if (!target) return null;

  try {
    const response = await axios.get(target, {
      responseType: "arraybuffer",
      timeout: 20_000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145 Safari/537.36",
      },
      httpAgent: HTTP_AGENT,
      httpsAgent: HTTPS_AGENT,
      maxRedirects: 5,
      validateStatus: () => true,
    });

    if (response.status >= 400 || !response.data) return null;
    const buffer = Buffer.from(response.data);
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

async function deleteFileSafe(filePath) {
  const target = String(filePath || "").trim();
  if (!target) return true;
  try {
    await fsp.unlink(target);
    return true;
  } catch (e) {
    if (String(e?.code || "").toUpperCase() === "ENOENT") return true;
    return false;
  }
}

async function cleanupOldFiles(maxAgeMs = TMP_FILE_MAX_AGE_MS) {
  await ensureTmpDir();
  const now = Date.now();
  const entries = await fsp.readdir(TMP_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry?.isFile?.()) continue;
    const fullPath = path.join(TMP_DIR, entry.name);
    const stat = await fsp.stat(fullPath).catch(() => null);
    if (!stat?.mtimeMs) continue;
    if (now - stat.mtimeMs < maxAgeMs) continue;
    await deleteFileSafe(fullPath);
  }
}

function extractTextFromMessage(message) {
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
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    message?.documentMessage?.caption ||
    ""
  );
}

function getQuotedMessage(ctx, msg) {
  return (
    ctx?.quoted ||
    msg?.quoted ||
    msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
    null
  );
}

function resolveRawInput(ctx) {
  const msg = ctx.m || ctx.msg || null;
  const argsText = Array.isArray(ctx.args) ? ctx.args.join(" ").trim() : "";
  const quotedText = extractTextFromMessage(getQuotedMessage(ctx, msg));
  return cleanText(argsText || quotedText || "");
}

function extractYouTubeUrl(text) {
  const match = String(text || "").match(
    /https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/[^\s]+/i
  );
  return match ? match[0].trim() : "";
}

function extractYouTubeVideoId(urlValue = "") {
  const urlText = String(urlValue || "").trim();
  if (!urlText) return "";

  try {
    const parsed = new URL(urlText);
    const host = String(parsed.hostname || "").replace(/^www\./i, "").toLowerCase();
    if (host === "youtu.be") {
      return String(parsed.pathname || "")
        .replace(/^\/+/, "")
        .split("/")[0]
        .trim();
    }

    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      const vParam = cleanText(parsed.searchParams.get("v"));
      if (vParam) return vParam;

      const parts = String(parsed.pathname || "")
        .split("/")
        .map((item) => item.trim())
        .filter(Boolean);

      if (parts.length >= 2 && ["shorts", "embed", "live", "v"].includes(parts[0].toLowerCase())) {
        return cleanText(parts[1]);
      }
    }
  } catch {}

  const fallbackMatch = urlText.match(
    /(?:youtu\.be\/|youtube\.com\/(?:shorts|embed|live)\/|[?&]v=)([A-Za-z0-9_-]{6,})/i
  );
  return cleanText(fallbackMatch?.[1] || "");
}

function extractQualityAndQuery(input) {
  const tokens = cleanText(input).split(/\s+/).filter(Boolean);
  let quality = null;
  const remaining = [];

  for (const token of tokens) {
    if (QUALITY_PATTERN.test(token) && !quality) {
      quality = normalizeQuality(token);
      continue;
    }
    remaining.push(token);
  }

  return {
    quality,
    query: remaining.join(" ").trim(),
  };
}

async function resolveInputToUrl(input) {
  const directUrl = extractYouTubeUrl(input);
  if (directUrl) {
    return {
      url: directUrl,
      title: "YouTube Video",
      duration: "",
      author: "",
      videoId: extractYouTubeVideoId(directUrl),
      thumbnail: "",
      searched: false,
    };
  }

  const query = cleanText(input);
  if (!query) return null;

  const results = await yts(query);
  const video = Array.isArray(results?.videos) ? results.videos.find((item) => item?.url) : null;

  if (!video?.url) throw new Error("No encontré resultados en YouTube.");

  return {
    url: video.url,
    title: cleanText(video.title || "YouTube Video"),
    duration: cleanText(video.timestamp || ""),
    author: cleanText(video.author?.name || video.author || ""),
    thumbnail: cleanText(video.thumbnail || ""),
    videoId: cleanText(video.videoId || ""),
    searched: true,
  };
}

async function getYtmp4dlData(videoUrl, quality) {
  const response = await axios.get(API_YTMP4DL_URL, {
    timeout: REQUEST_TIMEOUT,
    params: {
      mode: "link",
      url: videoUrl,
      quality,
    },
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145 Safari/537.36",
      Accept: "application/json",
    },
    httpAgent: HTTP_AGENT,
    httpsAgent: HTTPS_AGENT,
    maxRedirects: 5,
    validateStatus: () => true,
  });

  if (response.status >= 400 || !response.data?.ok) {
    throw new Error(
      response.data?.detail ||
      response.data?.error?.message ||
      response.data?.message ||
      `HTTP ${response.status}`
    );
  }

  const data = response.data;
  const remoteUrl =
    data.direct_url ||
    data.stream_url_full ||
    data.download_url_full ||
    data.provider_direct_url ||
    data.url;

  if (!remoteUrl) {
    throw new Error("La API no devolvió una URL de descarga válida.");
  }

  return {
    remoteUrl,
    title: cleanText(data.title || "YouTube Video"),
    fileName: normalizeMp4Name(data.filename || data.title || "youtube-video.mp4"),
    quality: cleanText(data.quality || data.quality_requested || quality || DEFAULT_QUALITY),
    thumbnail: cleanText(data.thumbnail || ""),
    cached: Boolean(data.cached),
    availableQualities: Array.isArray(data.available_qualities) ? data.available_qualities : [],
  };
}

async function downloadRemoteMp4(remoteUrl, preferredName) {
  await ensureTmpDir();

  const outputPath = path.join(TMP_DIR, `${Date.now()}-${randomUUID()}-ytmp4dl.mp4`);

  const response = await axios.get(remoteUrl, {
    responseType: "stream",
    timeout: REQUEST_TIMEOUT,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145 Safari/537.36",
      Accept: "*/*",
    },
    httpAgent: HTTP_AGENT,
    httpsAgent: HTTPS_AGENT,
    maxRedirects: 5,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    throw new Error(`No se pudo descargar el MP4 remoto. HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers?.["content-length"] || 0);
  if (contentLength > MAX_VIDEO_BYTES) {
    throw new Error(`El video pesa ${humanBytes(contentLength)} y supera el limite del bot.`);
  }

  let downloaded = 0;
  response.data.on("data", (chunk) => {
    downloaded += chunk.length;
    if (downloaded > MAX_VIDEO_BYTES) {
      response.data.destroy(new Error("El video es demasiado grande para enviarlo por WhatsApp."));
    }
  });

  try {
    await pipeline(response.data, fs.createWriteStream(outputPath));
  } catch (error) {
    await deleteFileSafe(outputPath);
    throw error;
  }

  const stat = await fsp.stat(outputPath).catch(() => null);
  if (!stat?.size || stat.size < MIN_VIDEO_BYTES) {
    await deleteFileSafe(outputPath);
    throw new Error("El archivo MP4 descargado es inválido.");
  }

  return {
    tempPath: outputPath,
    fileName: normalizeMp4Name(preferredName || "youtube-video.mp4"),
    size: stat.size,
    contentType: "video/mp4",
  };
}

function buildResultCaption(data, deliveryLabel) {
  const requested = normalizeQuality(data.requestedQuality || data.quality || DEFAULT_QUALITY);
  const delivered = cleanText(data.quality || DEFAULT_QUALITY);
  const requestedLabel = requested.toUpperCase();
  const deliveredLabel = delivered.toUpperCase();

  return [
    "🎬 *YTMP4DL*",
    `• *Video:* ${clipText(data.title || data.fileName || "YouTube Video", 80)}`,
    data.author ? `• *Canal:* ${clipText(data.author, 44)}` : null,
    data.duration ? `• *Duración:* ${formatDuration(data.duration)}` : null,
    `• *Pedido:* ${requestedLabel}`,
    `• *Entregado:* ${deliveredLabel}`,
    requestedLabel !== deliveredLabel ? "• *Nota:* se ajustó a una calidad menor compatible." : null,
    `• *Entrega:* ${deliveryLabel}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function sendRemoteMp4(sock, from, quoted, data) {
  const thumbBuffer = await getBuffer(data.thumbnail);
  const caption = buildResultCaption(data, data.cached ? "rápida" : "directa");

  try {
    await sock.sendMessage(
      from,
      {
        video: { url: data.remoteUrl },
        mimetype: "video/mp4",
        fileName: data.fileName,
        caption,
        gifPlayback: false,
        jpegThumbnail: thumbBuffer || undefined,
        ...global.channelInfo,
      },
      quoted
    );
    return "video";
  } catch {}

  await sock.sendMessage(
    from,
    {
      document: { url: data.remoteUrl },
      mimetype: "video/mp4",
      fileName: data.fileName,
      caption,
      ...global.channelInfo,
    },
    quoted
  );

  return "document";
}

async function sendLocalMp4(sock, from, quoted, data) {
  const thumbBuffer = await getBuffer(data.thumbnail);
  const caption = [
    buildResultCaption(data, "respaldo local"),
    data.size ? `• *Peso:* ${humanBytes(data.size)}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  if (Number(data?.size || 0) <= VIDEO_AS_DOCUMENT_THRESHOLD) {
    try {
      await sock.sendMessage(
        from,
        {
          video: { url: data.tempPath },
          mimetype: "video/mp4",
          fileName: data.fileName,
          caption,
          gifPlayback: false,
          jpegThumbnail: thumbBuffer || undefined,
          ...global.channelInfo,
        },
        quoted
      );
      return "video";
    } catch {}
  }

  await sock.sendMessage(
    from,
    {
      document: { url: data.tempPath },
      mimetype: "video/mp4",
      fileName: data.fileName,
      caption,
      ...global.channelInfo,
    },
    quoted
  );

  return "document";
}

function buildQualityRows(prefix, resolved, baseQuery = "") {
  const queryText = cleanText(baseQuery || resolved.url || resolved.title);
  return QUALITY_OPTIONS.map((quality, index) => ({
    header: `${index + 1}`,
    title: `${quality} - MP4`,
    description: clipText(
      `${resolved.title || "YouTube Video"} | ${resolved.duration || "N/D"} | baja sola si falla`,
      72
    ),
    id: `${prefix}ytmp4dl ${quality} ${queryText}`.trim(),
  }));
}

async function sendQualityPicker(sock, from, quoted, ctx, resolved, rawQuery) {
  const prefix = cleanText(ctx?.usedPrefix || ctx?.prefix || ".");
  const rows = buildQualityRows(prefix, resolved, rawQuery);
  const text = [
    "🎬 *YTMP4DL*",
    `• *Video:* ${clipText(resolved.title || "YouTube Video", 72)}`,
    resolved.author ? `• *Canal:* ${clipText(resolved.author, 42)}` : null,
    resolved.duration ? `• *Duración:* ${formatDuration(resolved.duration)}` : null,
    "• *Calidades:* 1080p, 720p, 360p, 240p",
    "• *Fallback:* baja sola si una calidad falla",
  ]
    .filter(Boolean)
    .join("\n");

  const interactivePayload = {
    text,
    title: "🎬 YTMP4DL",
    subtitle: "Elige una calidad",
    footer: "DVYER API",
    interactiveButtons: [
      {
        name: "single_select",
        buttonParamsJson: JSON.stringify({
          title: "Elegir calidad",
          sections: [
            {
              title: "Calidades disponibles",
              rows,
            },
          ],
        }),
      },
    ],
  };

  try {
    await sock.sendMessage(from, interactivePayload, quoted);
  } catch {
    await sock.sendMessage(
      from,
      {
        text: rows.map((row) => `*${row.title}*\n${row.id}`).join("\n\n"),
        ...global.channelInfo,
      },
      quoted
    );
  }
}

export default {
  command: ["ytmp4dl", "ytvdl"],
  categoria: "descarga",

  run: async (ctx) => {
    const { sock, from } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;

    let tempPath = null;
    let downloadCharge = null;
    let sentSuccessfully = false;

    try {
      cleanupOldFiles().catch(() => {});

      const rawInput = resolveRawInput(ctx);
      const { quality, query } = extractQualityAndQuery(rawInput);

      const identity = buildRateIdentity(
        {
          senderPhone: msg?.senderPhone || ctx?.senderPhone,
          sender: msg?.sender || ctx?.sender,
          from,
        },
        from
      );

      const limitState = checkRateLimit({
        scope: `ytmp4dl:${identity}`,
        limit: RATE_LIMIT_MAX,
        windowMs: RATE_LIMIT_WINDOW_MS,
      });

      if (!limitState.ok) {
        return await sock.sendMessage(
          from,
          {
            text: `⚠️ Mucho uso de ytmp4dl. Reintenta en ${formatRetrySeconds(limitState.retryAfterMs)}s.`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      const resolved = await resolveInputToUrl(query || rawInput);

      if (!resolved?.url) {
        return await sock.sendMessage(
          from,
          {
            text: [
              "🎬 *YTMP4DL*",
              "• *.ytmp4dl <link o nombre>*",
              "• *.ytmp4dl 1080p <link o nombre>*",
              "• *Calidades:* 1080p, 720p, 360p, 240p",
              "• *Busca por nombre:* sí",
              "• *Fallback:* baja sola si una calidad falla",
            ].join("\n"),
            ...global.channelInfo,
          },
          quoted
        );
      }

      if (!quality) {
        return await sendQualityPicker(sock, from, quoted, ctx, resolved, query || rawInput);
      }

      downloadCharge = await chargeDownloadRequest(ctx, {
        feature: "ytmp4dl",
        videoUrl: resolved.url,
      });
      if (!downloadCharge?.ok) return;

      const qualitiesToTry = buildFallbackQualities(quality);
      let apiData = null;
      let lastError = null;
      let requestedQualityUsed = normalizeQuality(quality);

      for (let index = 0; index < qualitiesToTry.length; index += 1) {
        const currentQuality = qualitiesToTry[index];

        try {
          apiData = await runWithProviderCircuit(
            PROVIDER_NAME,
            () => getYtmp4dlData(resolved.url, currentQuality),
            {
              failureThreshold: 4,
              cooldownMs: 90_000,
              shouldCountFailure: (error) => {
                const text = String(error?.message || error || "").toLowerCase();
                if (!text) return false;
                if (text.includes("no encontré resultados")) return false;
                if (text.includes("no encontre resultados")) return false;
                if (text.includes("uso:")) return false;
                if (text.includes("supera el limite")) return false;
                if (text.includes("demasiado grande")) return false;
                return true;
              },
            }
          );
          requestedQualityUsed = currentQuality;
          break;
        } catch (error) {
          lastError = error;
        }
      }

      if (!apiData) {
        throw lastError || new Error("No se pudo obtener el video.");
      }

      try {
        await sendRemoteMp4(sock, from, quoted, {
          ...apiData,
          title: apiData.title || resolved.title,
          duration: resolved.duration,
          quality: apiData.quality || quality,
          thumbnail: apiData.thumbnail || resolved.thumbnail,
          author: resolved.author,
          requestedQuality: requestedQualityUsed,
        });
        sentSuccessfully = true;
        return;
      } catch {}

      const downloaded = await downloadRemoteMp4(apiData.remoteUrl, apiData.fileName);
      tempPath = downloaded.tempPath;

      await sendLocalMp4(sock, from, quoted, {
        ...downloaded,
        title: apiData.title || resolved.title,
        duration: resolved.duration,
        quality: apiData.quality || quality,
        thumbnail: apiData.thumbnail || resolved.thumbnail,
        author: resolved.author,
        requestedQuality: requestedQualityUsed,
      });

      sentSuccessfully = true;
    } catch (error) {
      console.error("YTMP4DL ERROR:", error?.message || error);

      if (!sentSuccessfully) {
        refundDownloadCharge(ctx, downloadCharge, {
          feature: "ytmp4dl",
          error: String(error?.message || error || "unknown_error"),
        });
      }

      if (!sentSuccessfully) {
        const shownError =
          error?.code === "PROVIDER_CIRCUIT_OPEN"
            ? String(error?.message || "Servicio temporalmente no autorizado para video.")
            : cleanVideoErrorText(error, "No se pudo preparar el MP4.");

        await sock.sendMessage(
          from,
          {
            text: `❌ ${shownError}`,
            ...global.channelInfo,
          },
          quoted
        );
      }
    } finally {
      if (tempPath) await deleteFileSafe(tempPath);
    }
  },
};
