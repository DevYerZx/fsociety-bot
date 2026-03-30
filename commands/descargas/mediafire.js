import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import { pipeline } from "stream/promises";
import { chargeDownloadRequest, refundDownloadCharge } from "../economia/download-access.js";

const API_BASE = "https://dvyer-api.onrender.com";
const API_MEDIAFIRE_URL = `${API_BASE}/mediafire`;
const COOLDOWN_TIME = 0;
const REQUEST_TIMEOUT = 120000;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const TMP_DIR = path.join(os.tmpdir(), "dvyer-mediafire");

const cooldowns = new Map();

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function safeFileName(name) {
  return (
    String(name || "mediafire-file")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "mediafire-file"
  );
}

function normalizeFileName(name) {
  const raw = String(name || "mediafire-file").trim();
  const extMatch = raw.match(/(\.[a-z0-9]{1,10})$/i);
  const ext = extMatch ? extMatch[1] : "";
  const base = safeFileName(raw.replace(/\.[^.]+$/i, "") || "mediafire-file");
  return `${base}${ext}`;
}

function mimeFromFileName(fileName) {
  const lower = String(fileName || "").toLowerCase();
  if (lower.endsWith(".apk")) return "application/vnd.android.package-archive";
  if (lower.endsWith(".xapk")) return "application/xapk-package-archive";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".rar")) return "application/vnd.rar";
  if (lower.endsWith(".7z")) return "application/x-7z-compressed";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function getCooldownRemaining(untilMs) {
  return Math.max(0, Math.ceil((untilMs - Date.now()) / 1000));
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
  const quotedMessage = getQuotedMessage(ctx, msg);
  const quotedText = extractTextFromMessage(quotedMessage);
  return argsText || quotedText || "";
}

function extractMediaFireUrl(text) {
  const match = String(text || "").match(
    /https?:\/\/(?:www\.)?(?:[a-z0-9-]+\.)?mediafire\.com\/[^\s]+/i
  );
  return match ? match[0].trim() : "";
}

function extractApiError(data, status) {
  return (
    data?.detail ||
    data?.error?.message ||
    data?.message ||
    (status ? `HTTP ${status}` : "Error de API")
  );
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

function deleteFileSafe(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

function humanBytes(bytes) {
  const size = Number(bytes || 0);
  if (!size || size < 1) return null;

  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
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

async function apiGet(url, params, timeout = 45000) {
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

async function requestMediafireMeta(fileUrl) {
  const data = await apiGet(
    API_MEDIAFIRE_URL,
    {
      mode: "link",
      url: fileUrl,
    },
    45000
  );

  return {
    title: safeFileName(data?.title || data?.filename || "MediaFire File"),
    fileName: normalizeFileName(data?.filename || "mediafire-file"),
    fileSize: String(data?.filesize || "").trim() || null,
    format: String(data?.format || "").trim() || null,
  };
}

async function downloadMediafireFile(fileUrl, outputPath) {
  const response = await axios.get(API_MEDIAFIRE_URL, {
    responseType: "stream",
    timeout: REQUEST_TIMEOUT,
    params: {
      mode: "file",
      url: fileUrl,
    },
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
      Accept: "*/*",
      Referer: `${API_BASE}/`,
    },
    validateStatus: () => true,
    maxRedirects: 5,
  });

  if (response.status >= 400) {
    const errorText = await readStreamToText(response.data).catch(() => "");
    let parsed = null;

    try {
      parsed = JSON.parse(errorText);
    } catch {}

    throw new Error(
      extractApiError(
        parsed || { message: errorText || "No se pudo descargar el archivo." },
        response.status
      )
    );
  }

  const contentLength = Number(response.headers?.["content-length"] || 0);
  if (contentLength && contentLength > MAX_FILE_BYTES) {
    throw new Error("El archivo es demasiado grande para enviarlo por WhatsApp.");
  }

  let downloaded = 0;

  response.data.on("data", (chunk) => {
    downloaded += chunk.length;
    if (downloaded > MAX_FILE_BYTES) {
      response.data.destroy(new Error("El archivo es demasiado grande para enviarlo por WhatsApp."));
    }
  });

  try {
    await pipeline(response.data, fs.createWriteStream(outputPath));
  } catch (error) {
    deleteFileSafe(outputPath);
    throw error;
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error("No se pudo guardar el archivo.");
  }

  const size = fs.statSync(outputPath).size;
  if (!size || size < 1) {
    deleteFileSafe(outputPath);
    throw new Error("El archivo descargado es invalido.");
  }

  if (size > MAX_FILE_BYTES) {
    deleteFileSafe(outputPath);
    throw new Error("El archivo es demasiado grande para enviarlo por WhatsApp.");
  }

  const detectedName = parseContentDispositionFileName(
    response.headers?.["content-disposition"]
  );

  return {
    tempPath: outputPath,
    size,
    fileName: normalizeFileName(detectedName || path.basename(outputPath)),
  };
}

async function sendMediafireDocument(sock, from, quoted, payload) {
  const { filePath, fileName, title, fileSize, size } = payload;
  const lines = ["DVYER API", "", `Archivo: ${title}`];
  if (fileSize) lines.push(`Tamano: ${fileSize}`);
  else {
    const prettySize = humanBytes(size);
    if (prettySize) lines.push(`Tamano: ${prettySize}`);
  }

  await sock.sendMessage(
    from,
    {
      document: { url: filePath },
      mimetype: mimeFromFileName(fileName),
      fileName,
      caption: lines.join("\n"),
      ...global.channelInfo,
    },
    quoted
  );
}

export default {
  command: ["mediafire", "mf"],
  category: "descarga",

  run: async (ctx) => {
    const { sock, from } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const userId = `${from}:mediafire`;

    let tempPath = null;
    let downloadCharge = null;

    if (COOLDOWN_TIME > 0) {
      const until = cooldowns.get(userId);
      if (until && until > Date.now()) {
        return sock.sendMessage(from, {
          text: `Espera ${getCooldownRemaining(until)}s`,
          ...global.channelInfo,
        });
      }

      cooldowns.set(userId, Date.now() + COOLDOWN_TIME);
    }

    try {
      const rawInput = resolveUserInput(ctx);
      const fileUrl = extractMediaFireUrl(rawInput);

      if (!fileUrl) {
        cooldowns.delete(userId);
        return sock.sendMessage(from, {
          text: "Uso: .mediafire <link publico de MediaFire> o responde a un mensaje con el link",
          ...global.channelInfo,
        });
      }

      downloadCharge = await chargeDownloadRequest(ctx, {
        feature: "mediafire",
        fileUrl,
      });
      if (!downloadCharge.ok) {
        cooldowns.delete(userId);
        return;
      }

      await sock.sendMessage(
        from,
        {
          text: `Preparando MediaFire...\n\nProcesando tu enlace...`,
          ...global.channelInfo,
        },
        quoted
      );

      const info = await requestMediafireMeta(fileUrl);
      tempPath = path.join(TMP_DIR, `${Date.now()}-${info.fileName}`);

      const downloaded = await downloadMediafireFile(fileUrl, tempPath);

      await sendMediafireDocument(sock, from, quoted, {
        filePath: downloaded.tempPath,
        fileName: normalizeFileName(downloaded.fileName || info.fileName),
        title: info.title,
        fileSize: info.fileSize,
        size: downloaded.size,
      });
    } catch (error) {
      console.error("MEDIAFIRE ERROR:", error?.message || error);
      refundDownloadCharge(ctx, downloadCharge, {
        feature: "mediafire",
        error: String(error?.message || error || "unknown_error"),
      });
      cooldowns.delete(userId);

      await sock.sendMessage(from, {
        text: String(error?.message || "No se pudo procesar el archivo de MediaFire."),
        ...global.channelInfo,
      });
    } finally {
      deleteFileSafe(tempPath);
    }
  },
};
