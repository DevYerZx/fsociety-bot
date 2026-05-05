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
import { withDvyerApiKey } from "../../lib/api-manager.js";
import {
  chargeDownloadRequest,
  refundDownloadCharge,
} from "../economia/download-access.js";
import {
  buildRateIdentity,
  checkRateLimit,
  formatRetrySeconds,
  runWithProviderCircuit,
} from "../../lib/provider-guard.js";

const API_YTMP3DL_URLS = [
  "https://dv-yer-api.online/ytmp3dl",
  "https://dvyer-api.onrender.com/ytmp3dl",
];

const TMP_DIR = path.join(os.tmpdir(), "dvyer-ytmp3dl");

const REQUEST_TIMEOUT = 20 * 60 * 1000;
const API_LINK_TIMEOUT = 90_000;

const MAX_AUDIO_BYTES = 800 * 1024 * 1024;
const AUDIO_AS_DOCUMENT_THRESHOLD = 80 * 1024 * 1024;
const MIN_AUDIO_BYTES = 20 * 1024;

const RATE_LIMIT_MAX = 6;
const RATE_LIMIT_WINDOW_MS = 60_000;

const PROVIDER_NAME = "dvyer_ytmp3dl";

const HTTP_AGENT = new http.Agent({
  keepAlive: true,
  maxSockets: 40,
  maxFreeSockets: 20,
});

const HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  maxSockets: 40,
  maxFreeSockets: 20,
});

const TMP_FILE_MAX_AGE_MS = 20 * 60 * 1000;
const DELETE_RETRIES = 4;
const DELETE_RETRY_DELAY_MS = 120;
const REMOTE_SEND_TIMEOUT_MS = 25_000;

async function ensureTmpDir() {
  await fsp.mkdir(TMP_DIR, { recursive: true });
}

function waitMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(1, Number(ms || 0)));
  });
}

async function withTimeout(promise, timeoutMs, label = "timeout") {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), Math.max(1000, Number(timeoutMs || 0)));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function deleteFileSafe(filePath) {
  const target = String(filePath || "").trim();
  if (!target) return true;

  for (let attempt = 0; attempt <= DELETE_RETRIES; attempt += 1) {
    try {
      await fsp.unlink(target);
      return true;
    } catch (error) {
      const code = String(error?.code || "").toUpperCase();

      if (code === "ENOENT") return true;

      const retryable =
        code === "EBUSY" || code === "EPERM" || code === "EACCES";

      if (retryable && attempt < DELETE_RETRIES) {
        await waitMs(DELETE_RETRY_DELAY_MS * (attempt + 1));
        continue;
      }

      return false;
    }
  }

  return false;
}

async function cleanupOldFiles(maxAgeMs = TMP_FILE_MAX_AGE_MS) {
  await ensureTmpDir();

  const now = Date.now();
  const entries = await fsp
    .readdir(TMP_DIR, { withFileTypes: true })
    .catch(() => []);

  for (const entry of entries) {
    if (!entry?.isFile?.()) continue;

    const filePath = path.join(TMP_DIR, entry.name);
    const stat = await fsp.stat(filePath).catch(() => null);

    if (!stat?.mtimeMs) continue;
    if (now - stat.mtimeMs < maxAgeMs) continue;

    await deleteFileSafe(filePath);
  }
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipText(value = "", max = 70) {
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

  return `${
    value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)
  } ${units[index]}`;
}

function formatDuration(seconds = 0) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));

  if (!total) return "";

  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  return `${m}:${String(s).padStart(2, "0")}`;
}

function safeFileName(name) {
  return (
    String(name || "youtube-audio")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/[^\w .()[\]-]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "youtube-audio"
  );
}

function normalizeMp3Name(name) {
  const parsed = path.parse(String(name || "").trim());
  const base = safeFileName(parsed.name || name || "youtube-audio");

  return `${base || "youtube-audio"}.mp3`;
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

function resolveUserInput(ctx) {
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

function parseContentDispositionFileName(headerValue) {
  const text = String(headerValue || "");

  const utfMatch = text.match(/filename\*=UTF-8''([^;]+)/i);

  if (utfMatch?.[1]) {
    try {
      return decodeURIComponent(utfMatch[1]).replace(/["']/g, "").trim();
    } catch {}
  }

  const normalMatch = text.match(/filename="?([^"]+)"?/i);

  return normalMatch?.[1]?.trim() || "";
}

function chunkToText(chunk) {
  if (chunk == null) return "";
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
  return String(chunk);
}

async function readStreamToText(stream) {
  if (!stream) return "";

  if (typeof stream[Symbol.asyncIterator] === "function") {
    let data = "";

    for await (const chunk of stream) {
      data += chunkToText(chunk);
      if (data.length > 20000) data = data.slice(-20000);
    }

    return data;
  }

  if (typeof stream.on !== "function") return "";

  return await new Promise((resolve, reject) => {
    let data = "";

    stream.on("data", (chunk) => {
      data += chunkToText(chunk);
      if (data.length > 20000) data = data.slice(-20000);
    });

    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

function extractApiError(data, status) {
  return (
    data?.detail ||
    data?.error?.message ||
    data?.message ||
    (status ? `HTTP ${status}` : "Error de API")
  );
}

function getApiCandidates() {
  const envBase = String(process.env.DVYER_API_BASE_URL || "").trim();
  const envEndpoint = envBase
    ? `${envBase.replace(/\/+$/, "")}/ytmp3dl`
    : "";
  const seen = new Set();
  return [envEndpoint, ...API_YTMP3DL_URLS]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function shouldRetryWithNextApi(errorOrText) {
  const text = String(errorOrText?.message || errorOrText || "").toLowerCase();
  if (!text) return true;
  return (
    text.includes("econnrefused") ||
    text.includes("enotfound") ||
    text.includes("timeout") ||
    text.includes("socket hang up") ||
    text.includes("temporarily unavailable") ||
    text.includes("service unavailable") ||
    text.includes("http 500") ||
    text.includes("http 502") ||
    text.includes("http 503") ||
    text.includes("http 504")
  );
}

async function callYtmp3DlApi({
  videoUrl,
  mode = "link",
  responseType = "json",
  timeout = API_LINK_TIMEOUT,
  accept = "application/json",
  maxRedirects = 5,
}) {
  const endpoints = getApiCandidates();
  const errors = [];

  for (const endpoint of endpoints) {
    try {
      const response = await axios.get(endpoint, {
        responseType,
        timeout,
        params: {
          mode,
          url: videoUrl,
          ...withDvyerApiKey(),
        },
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145 Safari/537.36",
          Accept: accept,
        },
        httpAgent: HTTP_AGENT,
        httpsAgent: HTTPS_AGENT,
        maxRedirects,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: () => true,
      });

      if (response.status >= 400) {
        let bodyText = "";
        if (responseType === "stream") {
          bodyText = await readStreamToText(response.data).catch(() => "");
        }
        const parsed = responseType === "stream" ? (() => {
          try {
            return JSON.parse(bodyText);
          } catch {
            return null;
          }
        })() : response.data;
        const apiError = extractApiError(
          parsed || { message: bodyText || `HTTP ${response.status}` },
          response.status
        );
        const err = new Error(apiError);
        if (!shouldRetryWithNextApi(err)) throw err;
        errors.push(cleanErrorText(err));
        continue;
      }

      return { response, endpoint };
    } catch (error) {
      if (!shouldRetryWithNextApi(error)) {
        throw error;
      }
      errors.push(cleanErrorText(error));
    }
  }

  throw new Error(errors.filter(Boolean).join(" | ") || "No se pudo conectar con la API ytmp3dl.");
}

function cleanErrorText(error) {
  let text = String(error?.message || error || "No se pudo preparar el MP3.");

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
    return "No pude procesar el audio en este intento. Reintenta en un momento.";
  }

  if (text.includes("403")) {
    return "El enlace de audio expiró o fue bloqueado. Intenta otra vez.";
  }

  if (text.includes("404")) {
    return "No se encontró el audio o el enlace ya no está disponible.";
  }

  if (text.toLowerCase().includes("timeout")) {
    return "La descarga tardó demasiado. Intenta otra vez.";
  }

  if (
    normalized.includes("socket hang up") ||
    normalized.includes("econnreset") ||
    normalized.includes("service unavailable") ||
    normalized.includes("temporarily unavailable")
  ) {
    return "El proveedor de audio esta temporalmente inestable. Reintenta en un momento.";
  }

  return text;
}

function resolveAbsoluteUrl(value, baseUrl) {
  const raw = String(value || "").trim();

  if (!raw) return "";

  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  if (raw.startsWith("/")) {
    const base = new URL(baseUrl);
    return `${base.origin}${raw}`;
  }

  return raw;
}

function scoreUrl(url = "") {
  const text = String(url || "").toLowerCase();

  if (!text) return 0;

  if (text.includes("dv-yer-api.online")) return 100;
  if (text.includes("/download/stream/")) return 90;
  if (text.includes("googlevideo.com")) return 40;

  return 60;
}

function pickDownloadUrl(data, baseUrl) {
  const candidates = [
    data?.download_url_full,
    data?.stream_url_full,
    data?.direct_url,
    data?.download_url,
    data?.stream_url,
    data?.url,
    data?.provider_direct_url,
  ]
    .map((item) => resolveAbsoluteUrl(item, baseUrl))
    .filter(Boolean)
    .sort((a, b) => scoreUrl(b) - scoreUrl(a));

  return candidates[0] || "";
}

function collectDownloadUrls(data, baseUrl) {
  const seen = new Set();
  return [
    data?.download_url_full,
    data?.stream_url_full,
    data?.download_url,
    data?.stream_url,
    data?.url,
    data?.direct_url,
    data?.provider_direct_url,
  ]
    .map((item) => resolveAbsoluteUrl(item, baseUrl))
    .filter(Boolean)
    .sort((a, b) => scoreUrl(b) - scoreUrl(a))
    .filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });
}

async function resolveInputToUrl(input) {
  const directUrl = extractYouTubeUrl(input);

  if (directUrl) {
    return {
      url: directUrl,
      title: "YouTube MP3",
      searched: false,
    };
  }

  const query = cleanText(input);

  if (!query) return null;

  const results = await yts(query);
  const video = Array.isArray(results?.videos)
    ? results.videos.find((item) => item?.url)
    : null;

  if (!video?.url) {
    throw new Error("No encontré resultados en YouTube.");
  }

  return {
    url: video.url,
    title: cleanText(video.title || "YouTube MP3"),
    searched: true,
  };
}

async function getYtmp3DlData(videoUrl) {
  const { response, endpoint } = await callYtmp3DlApi({
    videoUrl,
    mode: "link",
    responseType: "json",
    timeout: API_LINK_TIMEOUT,
    accept: "application/json",
    maxRedirects: 5,
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
  const remoteUrls = collectDownloadUrls(data, endpoint);
  const remoteUrl = remoteUrls[0] || "";

  if (!remoteUrl) {
    throw new Error("La API /ytmp3dl no devolvio link valido.");
  }

  return {
    remoteUrl,
    remoteUrls,
    title: cleanText(data.title || "YouTube MP3"),
    fileName: normalizeMp3Name(data.filename || data.title || "youtube-audio.mp3"),
    thumbnail: data.thumbnail || null,
    provider: data.provider || "savetube",
    duration: data.duration || 0,
    cached: Boolean(data.cached),
  };
}

async function requestYtmp3DlStream(videoUrl) {
  const { response } = await callYtmp3DlApi({
    videoUrl,
    mode: "stream",
    responseType: "stream",
    timeout: REQUEST_TIMEOUT,
    accept: "*/*",
    maxRedirects: 5,
  });
  return response;
}

async function requestYtmp3DlFileDownload(videoUrl) {
  const { response } = await callYtmp3DlApi({
    videoUrl,
    mode: "file",
    responseType: "stream",
    timeout: REQUEST_TIMEOUT,
    accept: "*/*",
    maxRedirects: 10,
  });
  return response;
}

async function requestRemoteYtmp3Stream(remoteUrl) {
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
    const errorText = await readStreamToText(response.data).catch(() => "");
    let parsed = null;

    try {
      parsed = JSON.parse(errorText);
    } catch {}

    throw new Error(extractApiError(parsed || { message: errorText }, response.status));
  }

  return response;
}

async function saveResponseToFile(response, outputPath, fallbackName) {
  const contentLength = Number(response.headers?.["content-length"] || 0);

  if (contentLength > MAX_AUDIO_BYTES) {
    throw new Error(`El MP3 pesa ${humanBytes(contentLength)} y supera el límite del bot.`);
  }

  let downloaded = 0;

  response.data.on("data", (chunk) => {
    downloaded += chunk.length;

    if (downloaded > MAX_AUDIO_BYTES) {
      response.data.destroy(
        new Error("El MP3 es demasiado grande para enviarlo por WhatsApp.")
      );
    }
  });

  try {
    await pipeline(response.data, fs.createWriteStream(outputPath));
  } catch (error) {
    await deleteFileSafe(outputPath);
    throw error;
  }

  const stat = await fsp.stat(outputPath).catch(() => null);

  if (!stat?.size || stat.size < MIN_AUDIO_BYTES) {
    await deleteFileSafe(outputPath);
    throw new Error("El archivo MP3 descargado es inválido.");
  }

  const headerName = parseContentDispositionFileName(
    response.headers?.["content-disposition"]
  );

  const fileName = normalizeMp3Name(headerName || fallbackName || "youtube-audio.mp3");

  return {
    tempPath: outputPath,
    fileName,
    size: stat.size,
    contentType: response.headers?.["content-type"] || "audio/mpeg",
  };
}

async function downloadYtmp3DlFallback(videoUrl, preferredName, knownLinkData = null) {
  await ensureTmpDir();

  const outputPath = path.join(TMP_DIR, `${Date.now()}-${randomUUID()}-ytmp3dl.mp3`);

  const attempts = [
    async () => {
      const response = await requestYtmp3DlFileDownload(videoUrl);
      return await saveResponseToFile(response, outputPath, preferredName);
    },

    async () => {
      const remoteCandidates = Array.isArray(knownLinkData?.remoteUrls)
        ? knownLinkData.remoteUrls
        : knownLinkData?.remoteUrl
        ? [knownLinkData.remoteUrl]
        : [];

      if (!remoteCandidates.length) {
        throw new Error("No hay enlace remoto conocido.");
      }

      let lastError = null;
      for (const remoteCandidate of remoteCandidates) {
        try {
          const response = await requestRemoteYtmp3Stream(remoteCandidate);
          return await saveResponseToFile(
            response,
            outputPath,
            knownLinkData.fileName || preferredName
          );
        } catch (error) {
          lastError = error;
          await deleteFileSafe(outputPath);
        }
      }

      throw lastError || new Error("No se pudo abrir ningun enlace remoto conocido.");
    },

    async () => {
      const linkData = await getYtmp3DlData(videoUrl);
      const response = await requestRemoteYtmp3Stream(linkData.remoteUrl);

      return await saveResponseToFile(
        response,
        outputPath,
        linkData.fileName || preferredName
      );
    },

    async () => {
      const response = await requestYtmp3DlStream(videoUrl);

      return await saveResponseToFile(response, outputPath, preferredName);
    },
  ];

  const errors = [];
  const seenErrors = new Set();

  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      const normalized = cleanErrorText(error);
      if (!seenErrors.has(normalized)) {
        seenErrors.add(normalized);
        errors.push(normalized);
      }
      await deleteFileSafe(outputPath);
    }
  }

  throw new Error(errors.filter(Boolean).join(" | ") || "No se pudo descargar el MP3.");
}

async function react(sock, msg, emoji) {
  try {
    if (!msg?.key) return;

    await sock.sendMessage(msg.key.remoteJid, {
      react: {
        text: emoji,
        key: msg.key,
      },
    });
  } catch {}
}

function buildUsageMessage() {
  return [
    "╭━━〔 *🎧 YTMP3DL* 〕━━⬣",
    "┃ ❌ *Falta el link o nombre.*",
    "┃",
    "┃ Usa:",
    "┃ *.ytmp3dl <link o nombre>*",
    "┃",
    "┃ Ejemplo:",
    "┃ *.ytmp3dl ozuna odisea*",
    "╰━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function buildDownloadingCaption(data = {}) {
  const duration = formatDuration(data.duration);

  return [
    "╭━━〔 *🎧 FSOCIETY MP3* 〕━━⬣",
    `┃ 🎵 *Título:* ${clipText(data.title || data.fileName || "YouTube MP3", 55)}`,
    duration ? `┃ ⏱️ *Duración:* ${duration}` : "",
    "┃",
    "┃ 📥 *Descargando audio...*",
    "╰━━━━━━━━━━━━━━━━━━⬣",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildErrorMessage(errorText) {
  return [
    "╭━━〔 *❌ YTMP3 ERROR* 〕━━⬣",
    `┃ ${String(errorText || "No se pudo preparar el MP3.")}`,
    "╰━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}


async function sendDownloadingImage(sock, from, quoted, data = {}) {
  const caption = buildDownloadingCaption(data);

  if (data.thumbnail) {
    try {
      await sock.sendMessage(
        from,
        {
          image: { url: data.thumbnail },
          caption,
          ...global.channelInfo,
        },
        quoted
      );
      return;
    } catch (error) {
      console.error("SEND THUMBNAIL ERROR:", error?.message || error);
    }
  }

  await sock.sendMessage(
    from,
    {
      text: caption,
      ...global.channelInfo,
    },
    quoted
  );
}

async function sendRemoteMp3(sock, from, quoted, data) {
  const remoteCandidates = Array.isArray(data?.remoteUrls)
    ? data.remoteUrls
    : data?.remoteUrl
    ? [data.remoteUrl]
    : [];

  let lastError = null;

  for (const remoteCandidate of remoteCandidates) {
    try {
      await sock.sendMessage(
        from,
        {
          audio: { url: remoteCandidate },
          mimetype: "audio/mpeg",
          fileName: data.fileName,
          ptt: false,
          ...global.channelInfo,
        },
        quoted
      );

      return "audio";
    } catch (error) {
      lastError = error;
      console.error("SEND REMOTE MP3 URL ERROR:", remoteCandidate, error?.message || error);
    }
  }

  throw lastError || new Error("No se pudo enviar el MP3 remoto.");
}

async function sendLocalMp3(sock, from, quoted, data) {
  if (data.size <= AUDIO_AS_DOCUMENT_THRESHOLD) {
    try {
      await sock.sendMessage(
        from,
        {
          audio: { url: data.tempPath },
          mimetype: "audio/mpeg",
          fileName: data.fileName,
          ptt: false,
          ...global.channelInfo,
        },
        quoted
      );

      return "audio";
    } catch (error) {
      console.error("SEND LOCAL AUDIO ERROR:", error?.message || error);
    }
  }

  await sock.sendMessage(
    from,
    {
      document: { url: data.tempPath },
      mimetype: "audio/mpeg",
      fileName: data.fileName,
      ...global.channelInfo,
    },
    quoted
  );

  return "document";
}

export default {
  command: ["ytmp3dl", "ytadl", "ytmp3128"],
  categoria: "descarga",
  category: "descarga",
  description: "Descarga audio MP3 de YouTube con fallback de API",

  run: async (ctx) => {
    const { sock, from } = ctx;

    const msg = ctx.m || ctx.msg || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;

    let tempPath = null;
    let downloadCharge = null;
    let sentSuccessfully = false;

    try {
      cleanupOldFiles().catch(() => {});
      await react(sock, msg, "🕓");

      const input = resolveUserInput(ctx);

      const identity = buildRateIdentity(
        {
          senderPhone: msg?.senderPhone || ctx?.senderPhone,
          sender: msg?.sender || ctx?.sender,
          from,
        },
        from
      );

      const limitState = checkRateLimit({
        scope: `ytmp3dl:${identity}`,
        limit: RATE_LIMIT_MAX,
        windowMs: RATE_LIMIT_WINDOW_MS,
      });

      if (!limitState.ok) {
        await react(sock, msg, "⚠️");

        return await sock.sendMessage(
          from,
          {
            text: [
              "╭━━〔 *⚠️ YTMP3 LIMIT* 〕━━⬣",
              "┃ Usaste mucho este comando.",
              `┃ Reintenta en *${formatRetrySeconds(limitState.retryAfterMs)}s*.`,
              "╰━━━━━━━━━━━━━━━━━━⬣",
            ].join("\n"),
            ...global.channelInfo,
          },
          quoted
        );
      }

      if (!input) {
        await react(sock, msg, "❌");

        return await sock.sendMessage(
          from,
          {
            text: buildUsageMessage(),
            ...global.channelInfo,
          },
          quoted
        );
      }

      const resolved = await resolveInputToUrl(input);

      if (!resolved?.url) {
        await react(sock, msg, "❌");

        return await sock.sendMessage(
          from,
          {
            text: buildUsageMessage(),
            ...global.channelInfo,
          },
          quoted
        );
      }

      downloadCharge = await chargeDownloadRequest(ctx, {
        feature: "ytmp3dl",
        videoUrl: resolved.url,
      });

      if (!downloadCharge?.ok) {
        await react(sock, msg, "❌");
        return;
      }

      const apiData = await runWithProviderCircuit(
        PROVIDER_NAME,
        () => getYtmp3DlData(resolved.url),
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
            if (text.includes("403")) return false;

            return true;
          },
        }
      );

      const finalData = {
        ...apiData,
        title: apiData.title || resolved.title,
      };

      await sendDownloadingImage(sock, from, quoted, finalData);
      let sentMode = null;
      try {
        sentMode = await withTimeout(
          sendRemoteMp3(sock, from, quoted, finalData),
          REMOTE_SEND_TIMEOUT_MS,
          "remote_send_timeout"
        );
      } catch (remoteError) {
        console.error("YTMP3DL REMOTE SEND FALLBACK:", remoteError?.message || remoteError);
      }

      if (!sentMode) {
        const downloaded = await downloadYtmp3DlFallback(
          resolved.url,
          finalData.fileName,
          finalData
        );
        tempPath = downloaded.tempPath;
        sentMode = await sendLocalMp3(sock, from, quoted, downloaded);
      }

      if (!sentMode) {
        throw new Error("No se pudo enviar el audio al chat.");
      }

      sentSuccessfully = true;
      await react(sock, msg, "✅");
    } catch (error) {
      console.error("YTMP3DL ERROR:", error?.message || error);

      if (!sentSuccessfully) {
        refundDownloadCharge(ctx, downloadCharge, {
          feature: "ytmp3dl",
          error: String(error?.message || error || "unknown_error"),
        });
      }

      await react(sock, msg, "❌");

      const errorText =
        error?.code === "PROVIDER_CIRCUIT_OPEN"
          ? "Servicio temporalmente no disponible para audio. Intenta otra vez."
          : cleanErrorText(error);

      await sock.sendMessage(
        from,
        {
          text: buildErrorMessage(errorText),
          ...global.channelInfo,
        },
        quoted
      );
    } finally {
      if (tempPath) await deleteFileSafe(tempPath);
    }
  },
};
