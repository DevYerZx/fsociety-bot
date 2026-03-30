import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";
import { chargeDownloadRequest, refundDownloadCharge } from "../economia/download-access.js";

const API_BASE = "https://dv-yer-api.online";
const API_TIKTOK_URL = `${API_BASE}/ttdlmp4`;

const COOLDOWN_TIME = 0;
const VIDEO_QUALITY = "hd";
const API_LANG = "es";
const REQUEST_TIMEOUT = 60000;
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
const VIDEO_AS_DOCUMENT_THRESHOLD = 40 * 1024 * 1024;
const TMP_DIR = path.join(os.tmpdir(), "dvyer-tiktok");
const TMP_FILE_PREFIX = "dvyer-tt-";
const TMP_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const cooldowns = new Map();

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

cleanupOldTempFiles();

function cleanupOldTempFiles() {
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
    (status ? `HTTP ${status}` : "Error de API")
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
    params,
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

async function requestTikTokMeta(videoUrl) {
  let lastError = "No se pudo obtener metadata del video de TikTok.";

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await apiGet(API_TIKTOK_URL, {
        mode: "link",
        quality: VIDEO_QUALITY,
        lang: API_LANG,
        url: videoUrl,
      });

      const title = safeFileName(data?.title || data?.result?.title || "tiktok");
      const fileName = normalizeMp4Name(
        data?.filename || data?.file_name || title || "tiktok"
      );

      return {
        title,
        fileName,
      };
    } catch (error) {
      lastError = error?.message || "Error desconocido";
      await sleep(900 * attempt);
    }
  }

  throw new Error(lastError);
}

async function downloadTikTokViaApi(videoUrl, fileName) {
  const finalName = normalizeMp4Name(fileName || "tiktok.mp4");
  const tempPath = path.join(
    TMP_DIR,
    `${TMP_FILE_PREFIX}${Date.now()}-${randomUUID()}-${finalName}`
  );

  const response = await axios.get(API_TIKTOK_URL, {
    responseType: "stream",
    timeout: REQUEST_TIMEOUT,
    maxRedirects: 5,
    params: {
      mode: "file",
      quality: VIDEO_QUALITY,
      lang: API_LANG,
      url: videoUrl,
    },
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
      Accept: "*/*",
      Referer: `${API_BASE}/`,
    },
    validateStatus: () => true,
  });

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
  if (contentLength && contentLength > MAX_VIDEO_BYTES) {
    throw new Error("El video es demasiado grande para enviarlo por WhatsApp.");
  }

  let downloaded = 0;

  response.data.on("data", (chunk) => {
    downloaded += chunk.length;
    if (downloaded > MAX_VIDEO_BYTES) {
      response.data.destroy(new Error("El video es demasiado grande para enviarlo por WhatsApp."));
    }
  });

  try {
    await pipeline(response.data, fs.createWriteStream(tempPath));
  } catch (error) {
    deleteFileSafe(tempPath);
    throw error;
  }

  if (!fs.existsSync(tempPath)) {
    throw new Error("No se pudo guardar el video.");
  }

  const size = fs.statSync(tempPath).size;

  if (!size || size < 100000) {
    deleteFileSafe(tempPath);
    throw new Error("El archivo descargado es inválido.");
  }

  if (size > MAX_VIDEO_BYTES) {
    deleteFileSafe(tempPath);
    throw new Error("El video es demasiado grande para enviarlo por WhatsApp.");
  }

  const downloadedName = parseContentDispositionFileName(
    response.headers?.["content-disposition"]
  );

  return {
    tempPath,
    size,
    fileName: normalizeMp4Name(downloadedName || finalName),
  };
}

async function sendTikTokVideo(sock, from, quoted, { filePath, fileName, title, size }) {
  if (size > VIDEO_AS_DOCUMENT_THRESHOLD) {
    await sock.sendMessage(
      from,
      {
        document: { url: filePath },
        mimetype: "video/mp4",
        fileName,
        caption: `api dvyer\n\n🎬 ${title}\n📦 Enviado como documento`,
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
        video: { url: filePath },
        mimetype: "video/mp4",
        fileName,
        caption: `api dvyer\n\n🎬 ${title}`,
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
        document: { url: filePath },
        mimetype: "video/mp4",
        fileName,
        caption: `api dvyer\n\n🎬 ${title}\n📦 Enviado como documento`,
        ...global.channelInfo,
      },
      quoted
    );
    return "document";
  }
}

export default {
  command: ["tiktok", "ttdlmp4"],
  category: "descarga",

  run: async (ctx) => {
    const { sock, from } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const userId = `${from}:tiktok`;

    let tempPath = null;
    let downloadCharge = null;

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

      if (!videoUrl) {
        cooldowns.delete(userId);
        return sock.sendMessage(from, {
          text: "❌ Uso: .tiktok <link de TikTok> o responde a un mensaje con el link",
          ...global.channelInfo,
        });
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
          text: `⬇️ Preparando TikTok...\n\n🎬 api dvyer\n🌐 ${API_BASE}`,
          ...global.channelInfo,
        },
        quoted
      );

      const meta = await requestTikTokMeta(videoUrl);
      const downloaded = await downloadTikTokViaApi(videoUrl, meta.fileName);
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

      await sock.sendMessage(from, {
        text: `❌ ${String(err?.message || "No se pudo procesar el video.")}`,
        ...global.channelInfo,
      });
    } finally {
      deleteFileSafe(tempPath);
    }
  },
};
