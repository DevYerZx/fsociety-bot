import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";

import {
  getDvyerBaseUrl,
  withDvyerApiKey,
  withDvyerApiKeyHeader,
  appendDvyerApiKeyToUrl,
} from "../../lib/api-manager.js";

import {
  chargeDownloadRequest,
  refundDownloadCharge,
} from "../economia/download-access.js";
import {
  assertDownloadWithinPolicy,
  getDownloadExecutionPolicy,
} from "../../lib/subbot-download-policy.js";

const API_BASE = getDvyerBaseUrl();
const API_TIKTOK_URL = `${API_BASE}/ttdlmp4`;

const COOLDOWN_TIME = 0;
const DEFAULT_VIDEO_QUALITY = "2";
const API_LANG = "es";
const REQUEST_TIMEOUT = 60000;
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
const VIDEO_AS_DOCUMENT_THRESHOLD = 40 * 1024 * 1024;

function resolveMaxVideoBytes(ctx) {
  const policy = getDownloadExecutionPolicy(ctx, "tiktok");
  return Math.min(MAX_VIDEO_BYTES, Number(policy?.maxBytes || MAX_VIDEO_BYTES));
}

const TMP_DIR = path.join(os.tmpdir(), "dvyer-tiktok");
const TMP_FILE_PREFIX = "dvyer-tt-";
const TMP_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const cooldowns = new Map();

ensureTmpDir();
cleanupOldTempFiles();

function ensureTmpDir() {
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  } catch {}
}

function cleanupOldTempFiles() {
  ensureTmpDir();

  try {
    const now = Date.now();
    const files = fs.readdirSync(TMP_DIR);

    for (const file of files) {
      if (!file.startsWith(TMP_FILE_PREFIX)) continue;

      const fullPath = path.join(TMP_DIR, file);
      const stat = fs.statSync(fullPath);

      if (!stat.isFile()) continue;

      if (now - stat.mtimeMs > TMP_MAX_AGE_MS) {
        fs.unlinkSync(fullPath);
      }
    }
  } catch {}
}

function deleteFileSafe(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

function safeFileName(name) {
  return (
    String(name || "tiktok")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "tiktok"
  );
}

function normalizeMp4Name(name) {
  const clean = safeFileName(String(name || "tiktok").replace(/\.mp4$/i, ""));
  return `${clean || "tiktok"}.mp4`;
}

function getCooldownRemaining(untilMs) {
  return Math.max(0, Math.ceil((untilMs - Date.now()) / 1000));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractApiError(data, status) {
  return (
    data?.detail ||
    data?.error?.message ||
    data?.message ||
    data?.error ||
    (status ? `HTTP ${status}` : "Error de API")
  );
}

function normalizeApiUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  if (value.startsWith("/")) {
    return `${API_BASE}${value}`;
  }

  return `${API_BASE}/${value}`;
}

function pickApiDownloadUrl(data) {
  return (
    data?.download_url_full ||
    data?.stream_url_full ||
    data?.download_url ||
    data?.stream_url ||
    data?.url ||
    data?.result?.download_url_full ||
    data?.result?.stream_url_full ||
    data?.result?.download_url ||
    data?.result?.stream_url ||
    data?.result?.url ||
    ""
  );
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

function extractTikTokUrl(text) {
  const match = String(text || "").match(
    /https?:\/\/(?:www\.)?(?:tiktok\.com|m\.tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com|douyin\.com)\/[^\s]+/i
  );

  return match ? match[0].trim() : "";
}

function getQuotedMessage(ctx, msg) {
  return (
    ctx?.quoted ||
    msg?.quoted ||
    msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
    null
  );
}

function resolveTikTokUrl(ctx) {
  const msg = ctx.m || ctx.msg || null;
  const directText = Array.isArray(ctx.args) ? ctx.args.join(" ").trim() : "";
  const quotedMessage = getQuotedMessage(ctx, msg);
  const quotedText = extractTextFromMessage(quotedMessage);

  return extractTikTokUrl(directText) || extractTikTokUrl(quotedText) || "";
}

function normalizeTikTokQuality(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";

  if (["hd", "best", "alta", "high"].includes(normalized)) return "hd";
  if (["sd", "low", "baja", "lite"].includes(normalized)) return "2";
  if (["1", "2", "3", "4", "5"].includes(normalized)) return normalized;

  const numericMatch = normalized.match(/(\d+)/);
  if (numericMatch?.[1]) return numericMatch[1];

  return "";
}

function resolveTikTokQuality(ctx) {
  const tokens = Array.isArray(ctx?.args) ? ctx.args : [];

  for (const token of tokens) {
    const quality = normalizeTikTokQuality(token);
    if (quality) return quality;
  }

  return DEFAULT_VIDEO_QUALITY;
}

function formatTikTokQualityLabel(quality = "") {
  const q = String(quality || "").trim().toLowerCase();

  if (q === "hd" || q === "best") return "HD";
  if (/^\d+$/.test(q)) return `Slot ${q}`;

  return q || DEFAULT_VIDEO_QUALITY;
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

  if (normalMatch?.[1]) {
    return normalMatch[1].trim();
  }

  return "";
}

async function readStreamToText(stream) {
  return await new Promise((resolve, reject) => {
    let data = "";

    stream.on("data", (chunk) => {
      data += chunk.toString();
    });

    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

async function apiGet(url, params, timeout = REQUEST_TIMEOUT) {
  const response = await axios.get(url, {
    timeout,
    params: withDvyerApiKey(params),
    headers: withDvyerApiKeyHeader({
      Accept: "application/json,text/plain,*/*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
    }),
    validateStatus: () => true,
  });

  const data = response.data;

  if (response.status >= 400) {
    throw new Error(extractApiError(data, response.status));
  }

  if (data?.ok === false || data?.status === false) {
    throw new Error(extractApiError(data, response.status));
  }

  return data;
}

async function requestTikTokMeta(videoUrl, qualityHint) {
  let lastError = "No se pudo obtener metadata del video de TikTok.";

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await apiGet(API_TIKTOK_URL, {
        mode: "link",
        quality: qualityHint,
        lang: API_LANG,
        url: videoUrl,
      });

      const title = safeFileName(data?.title || data?.result?.title || "tiktok");

      const fileName = normalizeMp4Name(
        data?.filename || data?.file_name || title || "tiktok"
      );

      const downloadUrl = normalizeApiUrl(pickApiDownloadUrl(data));

      return {
        title,
        fileName,
        downloadUrl,
      };
    } catch (error) {
      lastError = error?.message || "Error desconocido";
      await sleep(900 * attempt);
    }
  }

  throw new Error(lastError);
}

async function downloadTikTokViaApi(
  videoUrl,
  fileName,
  qualityHint,
  directUrl = "",
  options = {}
) {
  ensureTmpDir();
  const maxVideoBytes = Math.max(100_000, Number(options?.maxBytes || MAX_VIDEO_BYTES));

  const finalName = normalizeMp4Name(fileName || "tiktok.mp4");

  const tempPath = path.join(
    TMP_DIR,
    `${TMP_FILE_PREFIX}${Date.now()}-${randomUUID()}-${finalName}`
  );

  const normalizedDirectUrl = normalizeApiUrl(directUrl);

  // ✅ AQUÍ ESTÁ LA CORRECCIÓN:
  // Si la API devuelve un link directo, también le agregamos ?apikey=
  const secureDirectUrl = normalizedDirectUrl
    ? appendDvyerApiKeyToUrl(normalizedDirectUrl)
    : "";

  const requestUrl = secureDirectUrl || API_TIKTOK_URL;

  const requestConfig = {
    responseType: "stream",
    timeout: REQUEST_TIMEOUT,
    maxRedirects: 5,
    headers: withDvyerApiKeyHeader({
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
      Accept: "*/*",
      Referer: `${API_BASE}/`,
    }),
    validateStatus: () => true,
  };

  // Si NO hay link directo, usamos endpoint normal con params + apikey
  if (!secureDirectUrl) {
    requestConfig.params = withDvyerApiKey({
      mode: "file",
      quality: qualityHint,
      lang: API_LANG,
      url: videoUrl,
    });
  }

  const response = await axios.get(requestUrl, requestConfig);

  if (response.status >= 400) {
    const errorText = await readStreamToText(response.data).catch(() => "");
    let parsed = null;

    try {
      parsed = JSON.parse(errorText);
    } catch {}

    throw new Error(
      extractApiError(
        parsed || { message: errorText || "Error al descargar el video." },
        response.status
      )
    );
  }

  const contentLength = Number(response.headers?.["content-length"] || 0);

  if (contentLength && contentLength > maxVideoBytes) {
    throw new Error("El video es demasiado grande para enviarlo por WhatsApp.");
  }

  let downloaded = 0;

  response.data.on("data", (chunk) => {
    downloaded += chunk.length;

    if (downloaded > maxVideoBytes) {
      response.data.destroy(
        new Error("El video es demasiado grande para enviarlo por WhatsApp.")
      );
    }
  });

  try {
    await pipeline(response.data, fs.createWriteStream(tempPath));
  } catch (error) {
    deleteFileSafe(tempPath);

    const isEnoent = String(error?.message || "")
      .toUpperCase()
      .includes("ENOENT");

    if (!isEnoent) throw error;

    ensureTmpDir();

    const retryResponse = await axios.get(requestUrl, requestConfig);

    if (retryResponse.status >= 400) {
      const retryErrorText = await readStreamToText(retryResponse.data).catch(
        () => ""
      );

      throw new Error(retryErrorText || "Error al descargar el video.");
    }

    await pipeline(retryResponse.data, fs.createWriteStream(tempPath));
  }

  if (!fs.existsSync(tempPath)) {
    throw new Error("No se pudo guardar el video.");
  }

  const size = fs.statSync(tempPath).size;

  if (!size || size < 100000) {
    deleteFileSafe(tempPath);
    throw new Error("El archivo descargado es inválido.");
  }

  if (size > maxVideoBytes) {
    deleteFileSafe(tempPath);
    throw new Error("El video es demasiado grande para enviarlo por WhatsApp.");
  }
  assertDownloadWithinPolicy(options?.ctx || {}, size, "videos");

  const downloadedName = parseContentDispositionFileName(
    response.headers?.["content-disposition"]
  );

  return {
    tempPath,
    size,
    fileName: normalizeMp4Name(downloadedName || finalName),
  };
}

async function sendTikTokVideo(
  sock,
  from,
  quoted,
  { filePath, fileName, title, size }
) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error("No se encontró el archivo temporal de TikTok.");
  }

  const videoBuffer = fs.readFileSync(filePath);

  const caption =
    `╭━━〔 🎬 *TIKTOK MP4* 〕━━⬣\n` +
    `┃ 📌 *Título:* ${title}\n` +
    `┃ 📦 *Peso:* ${(size / 1024 / 1024).toFixed(2)} MB\n` +
    `┃ ⚡ *API:* DVYER\n` +
    `╰━━━━━━━━━━━━━━━━━━⬣`;

  if (size > VIDEO_AS_DOCUMENT_THRESHOLD) {
    await sock.sendMessage(
      from,
      {
        document: videoBuffer,
        mimetype: "video/mp4",
        fileName,
        caption: `${caption}\n\n📦 Enviado como documento porque pesa mucho.`,
        ...global.channelInfo,
      },
      quoted
    );

    return "document";
  }

  try {
    await sock.sendMessage(
      from,
      {
        video: videoBuffer,
        mimetype: "video/mp4",
        fileName,
        caption,
        ...global.channelInfo,
      },
      quoted
    );

    return "video";
  } catch (e1) {
    console.error("send local video failed:", e1?.message || e1);

    await sock.sendMessage(
      from,
      {
        document: videoBuffer,
        mimetype: "video/mp4",
        fileName,
        caption: `${caption}\n\n📦 Enviado como documento por compatibilidad.`,
        ...global.channelInfo,
      },
      quoted
    );

    return "document";
  }
}

export default {
  command: ["tiktok", "ttdlmp4", "tt"],
  category: "descarga",
  description: "Descarga videos de TikTok usando API DVYER.",

  run: async (ctx) => {
    const { sock, from } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const userId = `${from}:tiktok`;

    let tempPath = null;
    let downloadCharge = null;
    const maxVideoBytes = resolveMaxVideoBytes(ctx);

    if (COOLDOWN_TIME > 0) {
      const until = cooldowns.get(userId);

      if (until && until > Date.now()) {
        return sock.sendMessage(from, {
          text: `⏳ Espera ${getCooldownRemaining(until)}s`,
          ...global.channelInfo,
        });
      }

      cooldowns.set(userId, Date.now() + COOLDOWN_TIME);
    }

    try {
      const videoUrl = resolveTikTokUrl(ctx);
      const qualityHint = resolveTikTokQuality(ctx);
      const qualityLabel = formatTikTokQualityLabel(qualityHint);

      if (!videoUrl) {
        cooldowns.delete(userId);

        return sock.sendMessage(
          from,
          {
            text:
              `╭━━〔 ❌ *USO INCORRECTO* 〕━━⬣\n` +
              `┃ Usa:\n` +
              `┃ .tiktok <link de TikTok>\n` +
              `┃ .tiktok hd <link>\n` +
              `┃ .tiktok 2 <link>\n` +
              `╰━━━━━━━━━━━━━━━━━━⬣`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      downloadCharge = await chargeDownloadRequest(ctx, {
        feature: "tiktok",
        videoUrl,
      });

      if (!downloadCharge.ok) {
        cooldowns.delete(userId);
        return;
      }

      await sock.sendMessage(
        from,
        {
          text:
            `╭━━〔 ⬇️ *PREPARANDO TIKTOK* 〕━━⬣\n` +
            `┃ 🎬 *API:* DVYER\n` +
            `┃ 🎞️ *Calidad:* ${qualityLabel}\n` +
            `┃ 🔑 *Key:* Activa\n` +
            `╰━━━━━━━━━━━━━━━━━━⬣`,
          ...global.channelInfo,
        },
        quoted
      );

      const meta = await requestTikTokMeta(videoUrl, qualityHint);

      const downloaded = await downloadTikTokViaApi(
        videoUrl,
        meta.fileName,
        qualityHint,
        meta.downloadUrl,
        {
          ctx,
          maxBytes: maxVideoBytes,
        }
      );

      tempPath = downloaded.tempPath;

      await sendTikTokVideo(sock, from, quoted, {
        filePath: downloaded.tempPath,
        fileName: downloaded.fileName,
        title: meta.title,
        size: downloaded.size,
      });
    } catch (err) {
      console.error("TIKTOK ERROR:", err?.message || err);

      refundDownloadCharge(ctx, downloadCharge, {
        feature: "tiktok",
        error: String(err?.message || err || "unknown_error"),
      });

      cooldowns.delete(userId);

      await sock.sendMessage(
        from,
        {
          text:
            `╭━━〔 ❌ *ERROR TIKTOK* 〕━━⬣\n` +
            `┃ ${String(err?.message || "No se pudo procesar el video.")}\n` +
            `╰━━━━━━━━━━━━━━━━━━⬣`,
          ...global.channelInfo,
        },
        quoted
      );
    } finally {
      deleteFileSafe(tempPath);
    }
  },
};
