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
  assertDownloadWithinPolicy,
  getDownloadExecutionPolicy,
} from "../../lib/subbot-download-policy.js";
import {
  buildRateIdentity,
  checkRateLimit,
  formatRetrySeconds,
  runWithProviderCircuit,
} from "../../lib/provider-guard.js";

const API_YTMP3_URLS = [
  "https://dv-yer-api.online/ytmp3",
];

const TMP_DIR = path.join(os.tmpdir(), "dvyer-ytmp3");

const REQUEST_TIMEOUT = 20 * 60 * 1000;
const API_LINK_TIMEOUT = 90_000;
const MAX_AUDIO_BYTES = 800 * 1024 * 1024;
const AUDIO_AS_DOCUMENT_THRESHOLD = 80 * 1024 * 1024;
const MIN_AUDIO_BYTES = 20 * 1024;

const RATE_LIMIT_MAX = 6;
const RATE_LIMIT_WINDOW_MS = 60_000;
const PROVIDER_NAME = "dvyer_ytmp3";

const TMP_FILE_MAX_AGE_MS = 20 * 60 * 1000;
const DELETE_RETRIES = 4;
const DELETE_RETRY_DELAY_MS = 120;

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

function getChannelInfo() {
  return global.channelInfo && typeof global.channelInfo === "object"
    ? global.channelInfo
    : {};
}

function resolvePrefix(ctx = {}) {
  const candidates = [
    ctx.prefix,
    ctx.usedPrefix,
    ctx?.settings?.prefix,
    global.prefix,
    global?.settings?.prefix,
  ];

  for (const value of candidates) {
    if (Array.isArray(value)) {
      const first = value.find((item) => cleanText(item));
      if (first) return cleanText(first);
      continue;
    }

    const text = cleanText(value);
    if (text) return text;
  }

  return ".";
}

function resolveMaxAudioBytes(ctx) {
  const policy = getDownloadExecutionPolicy(ctx, "ytmp3");
  return Math.max(
    MIN_AUDIO_BYTES,
    Math.min(MAX_AUDIO_BYTES, Number(policy?.maxBytes || MAX_AUDIO_BYTES))
  );
}

async function ensureTmpDir() {
  await fsp.mkdir(TMP_DIR, { recursive: true });
}

function waitMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(1, Number(ms || 0)));
  });
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

      const retryable = code === "EBUSY" || code === "EPERM" || code === "EACCES";
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

  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
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
  const envEndpoint = envBase ? `${envBase.replace(/\/+$/, "")}/ytmp3` : "";
  const seen = new Set();

  return [envEndpoint, ...API_YTMP3_URLS]
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
    text.includes("not found") ||
    text.includes("http 404") ||
    text.includes("econnrefused") ||
    text.includes("econnreset") ||
    text.includes("enotfound") ||
    text.includes("etimedout") ||
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

async function callYtmp3Api({
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

        const parsed =
          responseType === "stream"
            ? (() => {
                try {
                  return JSON.parse(bodyText);
                } catch {
                  return null;
                }
              })()
            : response.data;

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
      if (!shouldRetryWithNextApi(error)) throw error;
      errors.push(cleanErrorText(error));
    }
  }

  throw new Error(
    errors.filter(Boolean).join(" | ") ||
      "El servicio de audio no respondió correctamente."
  );
}

function cleanErrorText(error) {
  let text = String(error?.message || error || "No se pudo preparar el MP3.");

  try {
    const parsed = JSON.parse(text);
    text = parsed?.detail || parsed?.message || text;
  } catch {}

  const normalized = text.toLowerCase();

  if (
    normalized.includes("econnrefused") ||
    normalized.includes("econnreset") ||
    normalized.includes("enotfound") ||
    normalized.includes("etimedout") ||
    normalized.includes("socket hang up") ||
    normalized.includes("network error") ||
    normalized.includes("connect ")
  ) {
    return "El servicio de audio está temporalmente inestable.\nIntenta otra vez.";
  }

  if (
    normalized.includes("savetube") ||
    normalized.includes("yt1s") ||
    normalized.includes("internal ytmp3 error") ||
    normalized.includes("no devolvio formatos mp3") ||
    normalized.includes("no devolvió formatos mp3") ||
    normalized.includes("youtube esta protegiendo este audio") ||
    normalized.includes("youtube está protegiendo este audio") ||
    normalized.includes("protected") ||
    normalized.includes("copyright")
  ) {
    return "Audio no disponible en este momento.\nPuede estar protegido por YouTube.";
  }

  if (
    normalized.includes("rate-overlimit") ||
    normalized.includes("rate overlimit") ||
    normalized.includes("too many requests") ||
    normalized.includes("http 429") ||
    normalized.includes("429")
  ) {
    return "Hay muchas solicitudes. Reintenta en un momento.";
  }

  if (normalized.includes("403")) {
    return "El enlace de audio expiró o fue bloqueado.\nIntenta otra vez.";
  }

  if (normalized.includes("404")) {
    return "No se encontró el audio o el enlace ya no está disponible.";
  }

  if (normalized.includes("timeout")) {
    return "La descarga tardó demasiado. Intenta otra vez.";
  }

  if (
    normalized.includes("service unavailable") ||
    normalized.includes("temporarily unavailable")
  ) {
    return "Servicio de audio temporalmente inestable.\nReintenta en un momento.";
  }

  if (normalized.includes("supera el limite") || normalized.includes("demasiado grande")) {
    return text;
  }

  return "No se pudo preparar el MP3.\nIntenta nuevamente más tarde.";
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

async function resolveInputToUrl(input) {
  const directUrl = extractYouTubeUrl(input);

  if (directUrl) {
    return {
      url: directUrl,
      title: "YouTube MP3",
      thumbnail: "",
      duration: 0,
      author: "",
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
    thumbnail: cleanText(video.thumbnail || ""),
    duration: Number(video.seconds || 0),
    author: cleanText(video.author?.name || ""),
    searched: true,
  };
}

async function getYtmp3Data(videoUrl) {
  const { response, endpoint } = await callYtmp3Api({
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
  const remoteUrl = pickDownloadUrl(data, endpoint);

  if (!remoteUrl) {
    throw new Error("La API /ytmp3 no devolvió link válido.");
  }

  return {
    remoteUrl,
    title: cleanText(data.title || "YouTube MP3"),
    fileName: normalizeMp3Name(data.filename || data.title || "youtube-audio.mp3"),
    provider: data.provider || "ytmp3",
    duration: Number(data.duration || 0),
    thumbnail: cleanText(data.thumbnail || data.thumb || ""),
    author: cleanText(data.author || data.channel || data.uploader || ""),
    cached: Boolean(data.cached),
    sourceUrl: endpoint,
  };
}

async function requestYtmp3Stream(videoUrl) {
  const { response } = await callYtmp3Api({
    videoUrl,
    mode: "stream",
    responseType: "stream",
    timeout: REQUEST_TIMEOUT,
    accept: "*/*",
    maxRedirects: 5,
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

async function saveResponseToFile(response, outputPath, fallbackName, options = {}) {
  const maxAudioBytes = Math.max(
    MIN_AUDIO_BYTES,
    Number(options?.maxBytes || MAX_AUDIO_BYTES)
  );

  const contentLength = Number(response.headers?.["content-length"] || 0);

  if (contentLength > maxAudioBytes) {
    throw new Error(
      `El MP3 pesa ${humanBytes(contentLength)} y supera el límite permitido (${humanBytes(maxAudioBytes)}).`
    );
  }

  let downloaded = 0;

  response.data.on("data", (chunk) => {
    downloaded += chunk.length;

    if (downloaded > maxAudioBytes) {
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

  assertDownloadWithinPolicy(options?.ctx || {}, stat.size, "audios");

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

async function downloadYtmp3File(videoUrl, preferredName, knownLinkData = null, options = {}) {
  await ensureTmpDir();

  const errors = [];

  const attempts = [
    async () => {
      if (!knownLinkData?.remoteUrl) {
        throw new Error("No hay enlace remoto conocido.");
      }

      const response = await requestRemoteYtmp3Stream(knownLinkData.remoteUrl);
      return await saveResponseToFile(
        response,
        path.join(TMP_DIR, `${Date.now()}-${randomUUID()}-ytmp3.mp3`),
        knownLinkData.fileName || preferredName,
        options
      );
    },
    async () => {
      const response = await requestYtmp3Stream(videoUrl);
      return await saveResponseToFile(
        response,
        path.join(TMP_DIR, `${Date.now()}-${randomUUID()}-ytmp3.mp3`),
        preferredName,
        options
      );
    },
    async () => {
      const linkData = await getYtmp3Data(videoUrl);
      const response = await requestRemoteYtmp3Stream(linkData.remoteUrl);
      return await saveResponseToFile(
        response,
        path.join(TMP_DIR, `${Date.now()}-${randomUUID()}-ytmp3.mp3`),
        linkData.fileName || preferredName,
        options
      );
    },
  ];

  for (const attempt of attempts) {
    let downloaded = null;

    try {
      downloaded = await attempt();
      return downloaded;
    } catch (error) {
      if (downloaded?.tempPath) await deleteFileSafe(downloaded.tempPath);
      errors.push(cleanErrorText(error));
    }
  }

  throw new Error(errors.filter(Boolean).join(" | ") || "No se pudo descargar el MP3.");
}

async function react(sock, msg, emoji) {
  try {
    if (!msg?.key || !emoji) return;

    await sock.sendMessage(msg.key.remoteJid, {
      react: {
        text: emoji,
        key: msg.key,
      },
    });
  } catch {}
}

function buildUsageMessage(prefix = ".") {
  return [
    "╭━━━〔 ✦ *ＦＳＯＣＩＥＴＹ ＭＰ３* ✦ 〕━━━⬣",
    "┃",
    "┃ ⚠️ No enviaste un link o nombre válido.",
    "┃",
    "┣━━━〔 USO CORRECTO 〕━━━⬣",
    `┃ ➤ ${prefix}ytmp3 ozuna odisea`,
    `┃ ➤ ${prefix}ytmp3 bad bunny monaco`,
    `┃ ➤ ${prefix}ytmp3 https://youtu.be/xxxx`,
    "┃",
    "┣━━━〔 SOPORTADO 〕━━━⬣",
    "┃ ✦ Links de YouTube",
    "┃ ✦ Nombre de canciones",
    "┃ ✦ Búsqueda automática",
    "┃",
    "╰━━━〔 ⚡ DVYER - MUSIC SYSTEM ⚡ 〕━━━⬣",
  ].join("\n");
}

function buildLimitMessage(retryMs) {
  return [
    "╭━━━〔 ⚠️ ✦ *ＬÍＭＩＴＥ ＤＥ ＵＳＯ* ✦ ⚠️ 〕━━━⬣",
    "┃",
    "┃ Estás usando mucho este comando.",
    `┃ ⏳ Espera *${formatRetrySeconds(retryMs)}s*`,
    "┃ para volver a descargar música.",
    "┃",
    "┣━━━〔 AVISO 〕━━━⬣",
    "┃ ✦ Evita spam masivo",
    "┃ ✦ Mantén estable el sistema",
    "┃ ✦ Usa el comando con calma",
    "┃",
    "╰━━━〔 FSOCIETY PROTECTION 〕━━━⬣",
  ].join("\n");
}

function buildErrorMessage(errorText) {
  return [
    "╭━━━〔 ❌ ✦ *ＹＴＭＰ３ ＥＲＲＯＲ* ✦ ❌ 〕━━━⬣",
    "┃",
    ...String(errorText || "No se pudo preparar el MP3.")
      .split("\n")
      .map((line) => `┃ ${line}`),
    "┃",
    "┣━━━〔 POSIBLES CAUSAS 〕━━━⬣",
    "┃ ✦ API fuera de línea",
    "┃ ✦ Video restringido",
    "┃ ✦ Error de conexión",
    "┃ ✦ Archivo demasiado pesado",
    "┃",
    "╰━━━〔 ⚡ DVYER API SYSTEM ⚡ 〕━━━⬣",
  ].join("\n");
}

async function getBuffer(url = "", timeout = 12_000) {
  const target = cleanText(url);
  if (!target || !/^https?:\/\//i.test(target)) return null;

  try {
    const response = await axios.get(target, {
      responseType: "arraybuffer",
      timeout,
      httpAgent: HTTP_AGENT,
      httpsAgent: HTTPS_AGENT,
      maxRedirects: 4,
      validateStatus: () => true,
    });

    if (Number(response.status || 0) >= 400) return null;
    return Buffer.from(response.data);
  } catch {
    return null;
  }
}

function buildPreviewCaption(data = {}) {
  const title = clipText(data.title || data.fileName || "YouTube MP3", 78);
  const duration = formatDuration(data.duration);
  const author = clipText(data.author || "", 46);

  return [
    "╭━━━〔 *ＦＳＯＣＩＥＴＹ ＡＵＤＩＯ* 〕━━━⬣",
    "┃",
    `┃ *Título:* ${title}`,
    duration ? `┃ ⌛ *Tiempo:* ${duration}` : null,
    author ? `┃ *Artista/Canal:* ${author}` : null,
    "┃",
    "┣━━━〔 ⚡ DESCARGA EN PROCESO ⚡ 〕━━━⬣",
    "┃ ✦ Buscando mejor calidad...",
    "┃ ✦ Generando archivo MP3...",
    "┃ ✦ Enviando música...",
    "┃",
    "┣━━━━━━━━━━━━━━━━━━━━━━⬣",
    "┃ *DVYER • FSOCIETY SYSTEM*",
    "╰━━━〔 ✧ ✧ ✧ 〕━━━⬣",
  ]
    .filter(Boolean)
    .join("\n");
}

async function sendAudioPreview(sock, from, quoted, data = {}) {
  const caption = buildPreviewCaption(data);
  const thumbBuffer = await getBuffer(data.thumbnail);

  if (thumbBuffer) {
    try {
      await sock.sendMessage(
        from,
        {
          image: thumbBuffer,
          caption,
          ...getChannelInfo(),
        },
        quoted
      );
      return;
    } catch {}
  }

  try {
    await sock.sendMessage(
      from,
      {
        text: caption,
        ...getChannelInfo(),
      },
      quoted
    );
  } catch {}
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
    },
    quoted
  );

  return "document";
}

export default {
  command: ["ytmp3", "yta", "ytaudio"],
  categoria: "descarga",
  category: "descarga",
  description: "Descarga audio MP3 de YouTube con portada previa",

  run: async (ctx) => {
    const { sock, from } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const prefix = resolvePrefix(ctx);

    let tempPath = null;
    let downloadCharge = null;
    let sentSuccessfully = false;

    const maxAudioBytes = resolveMaxAudioBytes(ctx);

    try {
      cleanupOldFiles().catch(() => {});

      const input = resolveUserInput(ctx);

      if (!input) {
        await react(sock, msg, "❌");
        return await sock.sendMessage(
          from,
          {
            text: buildUsageMessage(prefix),
            ...getChannelInfo(),
          },
          quoted
        );
      }

      await react(sock, msg, "⏳");

      const identity = buildRateIdentity(
        {
          senderPhone: msg?.senderPhone || ctx?.senderPhone,
          sender: msg?.sender || ctx?.sender,
          from,
        },
        from
      );

      const limitState = checkRateLimit({
        scope: `ytmp3:${identity}`,
        limit: RATE_LIMIT_MAX,
        windowMs: RATE_LIMIT_WINDOW_MS,
      });

      if (!limitState.ok) {
        await react(sock, msg, "⚠️");
        return await sock.sendMessage(
          from,
          {
            text: buildLimitMessage(limitState.retryAfterMs),
            ...getChannelInfo(),
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
            text: buildUsageMessage(prefix),
            ...getChannelInfo(),
          },
          quoted
        );
      }

      downloadCharge = await chargeDownloadRequest(ctx, {
        feature: "ytmp3",
        videoUrl: resolved.url,
      });

      if (!downloadCharge?.ok) {
        await react(sock, msg, "❌");
        return;
      }

      const apiData = await runWithProviderCircuit(
        PROVIDER_NAME,
        () => getYtmp3Data(resolved.url),
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
        thumbnail: apiData.thumbnail || resolved.thumbnail || "",
        author: apiData.author || resolved.author || "",
        duration: Number(apiData.duration || resolved.duration || 0),
        sourceUrl:
          apiData.sourceUrl || getApiCandidates()[0] || "https://dv-yer-api.online/ytmp3",
      };

      await sendAudioPreview(sock, from, quoted, finalData);

      const downloaded = await downloadYtmp3File(
        resolved.url,
        finalData.fileName || finalData.title || resolved.title,
        finalData,
        {
          ctx,
          maxBytes: maxAudioBytes,
        }
      );

      tempPath = downloaded.tempPath;

      await sendLocalMp3(sock, from, quoted, {
        ...downloaded,
        title: finalData.title || resolved.title,
        duration: finalData.duration || 0,
        sourceUrl: finalData.sourceUrl,
      });

      sentSuccessfully = true;
      await react(sock, msg, "✅");
    } catch (error) {
      console.error("YTMP3 ERROR:", error?.message || error);

      if (!sentSuccessfully) {
        refundDownloadCharge(ctx, downloadCharge, {
          feature: "ytmp3",
          error: String(error?.message || error || "unknown_error"),
        });
      }

      await react(sock, msg, "❌");

      const errorText =
        error?.code === "PROVIDER_CIRCUIT_OPEN"
          ? "Servicio temporalmente no disponible para audio.\nIntenta otra vez."
          : cleanErrorText(error);

      await sock.sendMessage(
        from,
        {
          text: buildErrorMessage(errorText),
          ...getChannelInfo(),
        },
        quoted
      );
    } finally {
      if (tempPath) await deleteFileSafe(tempPath);
    }
  },
};