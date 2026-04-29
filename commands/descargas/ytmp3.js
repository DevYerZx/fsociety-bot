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
import { chargeDownloadRequest, refundDownloadCharge } from "../economia/download-access.js";
import {
  buildRateIdentity,
  checkRateLimit,
  formatRetrySeconds,
  runWithProviderCircuit,
} from "../../lib/provider-guard.js";

const API_YTMP3_URL = buildDvyerUrl("/ytmp3");
const DVYER_API_BASE_URL = getDvyerBaseUrl();
const TMP_DIR = path.join(os.tmpdir(), "dvyer-ytmp3");
const REQUEST_TIMEOUT = 20 * 60 * 1000;
const MAX_AUDIO_BYTES = 800 * 1024 * 1024;
const AUDIO_AS_DOCUMENT_THRESHOLD = 80 * 1024 * 1024;
const MIN_AUDIO_BYTES = 20 * 1024;
const RATE_LIMIT_MAX = 6;
const RATE_LIMIT_WINDOW_MS = 60_000;
const PROVIDER_NAME = "dvyer_ytmp3";
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 10 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 10 });
const TMP_FILE_MAX_AGE_MS = 20 * 60 * 1000;
const DELETE_RETRIES = 4;
const DELETE_RETRY_DELAY_MS = 120;

async function ensureTmpDir() {
  await fsp.mkdir(TMP_DIR, { recursive: true });
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, Number(ms || 0))));
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
      const isRetryable = code === "EBUSY" || code === "EPERM" || code === "EACCES";
      if (isRetryable && attempt < DELETE_RETRIES) {
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
  const entries = await fsp.readdir(TMP_DIR, { withFileTypes: true }).catch(() => []);

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

function clipText(value = "", max = 70) {
  const text = cleanText(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 3))}...`;
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
  const video = Array.isArray(results?.videos) ? results.videos.find((item) => item?.url) : null;

  if (!video?.url) {
    throw new Error("No encontré resultados en YouTube.");
  }

  return {
    url: video.url,
    title: cleanText(video.title || "YouTube MP3"),
    searched: true,
  };
}

async function getYtmp3Data(videoUrl) {
  const response = await axios.get(API_YTMP3_URL, {
    timeout: REQUEST_TIMEOUT,
    params: {
      mode: "link",
      url: videoUrl,
      ...withDvyerApiKey(),
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
    data.provider_direct_url ||
    data.stream_url_full ||
    data.download_url_full ||
    data.url;

  if (!remoteUrl) {
    throw new Error("La API no devolvió una URL de descarga válida.");
  }

  return {
    remoteUrl,
    title: cleanText(data.title || "YouTube MP3"),
    fileName: normalizeMp3Name(data.filename || data.title || "youtube-audio.mp3"),
    cached: Boolean(data.cached),
  };
}

async function requestYtmp3Stream(videoUrl) {
  const response = await axios.get(API_YTMP3_URL, {
    responseType: "stream",
    timeout: REQUEST_TIMEOUT,
    params: {
      mode: "stream",
      url: videoUrl,
      ...withDvyerApiKey(),
    },
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
    throw new Error(extractApiError({ message: errorText }, response.status));
  }

  return response;
}

async function downloadYtmp3Fallback(videoUrl, preferredName, knownLinkData = null) {
  await ensureTmpDir();
  const outputPath = path.join(TMP_DIR, `${Date.now()}-${randomUUID()}-ytmp3.mp3`);

  const saveResponseStream = async (response, fallbackName) => {
    const contentLength = Number(response.headers?.["content-length"] || 0);
    if (contentLength > MAX_AUDIO_BYTES) {
      throw new Error(`El MP3 pesa ${humanBytes(contentLength)} y supera el límite del bot.`);
    }

    let downloaded = 0;
    response.data.on("data", (chunk) => {
      downloaded += chunk.length;
      if (downloaded > MAX_AUDIO_BYTES) {
        response.data.destroy(new Error("El MP3 es demasiado grande para enviarlo por WhatsApp."));
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

    const headerName = parseContentDispositionFileName(response.headers?.["content-disposition"]);
    const fileName = normalizeMp3Name(headerName || fallbackName || "youtube-audio.mp3");

    return {
      tempPath: outputPath,
      fileName,
      size: stat.size,
      contentType: response.headers?.["content-type"] || "audio/mpeg",
    };
  };

  try {
    const response = await requestYtmp3Stream(videoUrl);
    return await saveResponseStream(response, preferredName);
  } catch (error) {
    await deleteFileSafe(outputPath);

    const linkData = knownLinkData?.remoteUrl ? knownLinkData : await getYtmp3Data(videoUrl);
    const response = await requestRemoteYtmp3Stream(linkData.remoteUrl);

    return await saveResponseStream(response, linkData.fileName || preferredName);
  }
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

function buildShortCaption(data = {}) {
  return [
    "🎧 *DVYER MP3*",
    `📌 ${clipText(data.title || data.fileName || "YouTube MP3", 70)}`,
    `🌐 ${DVYER_API_BASE_URL}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildAudioContextInfo(data = {}) {
  return {
    externalAdReply: {
      title: clipText(data.title || data.fileName || "YouTube MP3", 60),
      body: DVYER_API_BASE_URL,
      sourceUrl: DVYER_API_BASE_URL,
      mediaType: 1,
      renderLargerThumbnail: false,
      showAdAttribution: false,
    },
  };
}

async function sendRemoteMp3(sock, from, quoted, data) {
  try {
    await sock.sendMessage(
      from,
      {
        audio: { url: data.remoteUrl },
        mimetype: "audio/mpeg",
        fileName: data.fileName,
        ptt: false,
        contextInfo: buildAudioContextInfo(data),
        ...global.channelInfo,
      },
      quoted
    );
    return "audio";
  } catch {}

  await sock.sendMessage(
    from,
    {
      document: { url: data.remoteUrl },
      mimetype: "audio/mpeg",
      fileName: data.fileName,
      caption: buildShortCaption(data),
      ...global.channelInfo,
    },
    quoted
  );

  return "document";
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
          contextInfo: buildAudioContextInfo(data),
          ...global.channelInfo,
        },
        quoted
      );
      return "audio";
    } catch {}
  }

  await sock.sendMessage(
    from,
    {
      document: { url: data.tempPath },
      mimetype: "audio/mpeg",
      fileName: data.fileName,
      caption: buildShortCaption(data),
      ...global.channelInfo,
    },
    quoted
  );

  return "document";
}

export default {
  command: ["ytmp3", "yta", "ytaudio"],
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
        scope: `ytmp3:${identity}`,
        limit: RATE_LIMIT_MAX,
        windowMs: RATE_LIMIT_WINDOW_MS,
      });

      if (!limitState.ok) {
        await react(sock, msg, "⚠️");
        return await sock.sendMessage(
          from,
          {
            text: `⚠️ Mucho uso de ytmp3. Reintenta en ${formatRetrySeconds(limitState.retryAfterMs)}s.`,
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
            text: "Usa: .ytmp3 <link o nombre>",
            ...global.channelInfo,
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
            return true;
          },
        }
      );

      try {
        await sendRemoteMp3(sock, from, quoted, {
          ...apiData,
          title: apiData.title || resolved.title,
        });
        sentSuccessfully = true;
        await react(sock, msg, "✅");
        return;
      } catch {}

      const downloaded = await downloadYtmp3Fallback(
        resolved.url,
        apiData.fileName || resolved.title,
        apiData
      );
      tempPath = downloaded.tempPath;

      await sendLocalMp3(sock, from, quoted, downloaded);
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
          ? String(error?.message || "Servicio temporalmente no autorizado para audio.")
          : String(error?.message || "No se pudo preparar el MP3.");

      await sock.sendMessage(
        from,
        {
          text: `❌ ${errorText}`,
          ...global.channelInfo,
        },
        quoted
      );
    } finally {
      if (tempPath) await deleteFileSafe(tempPath);
    }
  },
};
