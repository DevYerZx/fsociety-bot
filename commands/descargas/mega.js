import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import { pipeline } from "stream/promises";
import { buildDvyerUrl, getDvyerBaseUrl, withDvyerApiKey } from "../../lib/api-manager.js";
import { chargeDownloadRequest, refundDownloadCharge } from "../economia/download-access.js";
import { sanitizeProviderMessage } from "./_errorMessages.js";

const API_MEGA_URL = buildDvyerUrl("/mega");
const COOLDOWN_TIME = 0;
const REQUEST_TIMEOUT = 180000;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const TMP_DIR = path.join(os.tmpdir(), "dvyer-mega");

const cooldowns = new Map();

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function safeFileName(name) {
  return (
    String(name || "mega-file")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140) || "mega-file"
  );
}

function normalizeFileName(name, fallback = "mega-file") {
  const raw = String(name || "").trim();
  const extMatch = raw.match(/(\.[a-z0-9]{1,10})$/i);
  const ext = extMatch ? extMatch[1] : "";
  const base = safeFileName(raw.replace(/\.[^.]+$/i, "") || fallback);
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
  if (lower.endsWith(".bin")) return "application/octet-stream";
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

function extractMegaUrl(text) {
  const match = String(text || "").match(
    /https?:\/\/(?:www\.)?(?:mega\.nz|mega\.co\.nz)\/[^\s]+/i
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

  const units = ["B", "KB", "MB", "GB", "TB"];
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
    params: withDvyerApiKey(params),
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

async function requestMegaMeta(fileUrl) {
  const data = await apiGet(
    API_MEGA_URL,
    {
      mode: "link",
      url: fileUrl,
    },
    45000
  );

  return {
    title: safeFileName(data?.title || data?.filename || "MEGA File"),
    fileName: normalizeFileName(data?.filename || "mega-file"),
    fileSize: String(data?.filesize || "").trim() || null,
    fileSizeBytes: Number(data?.filesize_bytes || 0) || null,
    format: String(data?.format || "").trim() || null,
  };
}

async function downloadMegaFile(fileUrl, outputPath) {
  const response = await axios.get(API_MEGA_URL, {
    responseType: "stream",
    timeout: REQUEST_TIMEOUT,
    params: {
      mode: "file",
      url: fileUrl,
      ...withDvyerApiKey(),
    },
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
      Accept: "*/*",
      Referer: `${getDvyerBaseUrl()}/`,
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
    fileName: normalizeFileName(detectedName || path.basename(outputPath), "mega-file"),
  };
}

async function sendMegaDocument(sock, from, quoted, payload) {
  const { filePath, fileName, title, fileSize, fileSizeBytes, size } = payload;
  const lines = ["DVYER API", "", `Archivo: ${title}`];
  if (fileSize) {
    lines.push(`Tamano: ${fileSize}`);
  } else {
    const prettySize = humanBytes(fileSizeBytes || size);
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
  command: ["mega", "megadl"],
  category: "descarga",

  run: async (ctx) => {
    const { sock, from } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const userId = `${from}:mega`;

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
      const fileUrl = extractMegaUrl(rawInput);

      if (!fileUrl) {
        cooldowns.delete(userId);
        return sock.sendMessage(
          from,
          {
            text:
              "Uso: .mega <link publico de MEGA> o responde a un mensaje con el link\n" +
              "Nota: por ahora solo sirve para enlaces de archivo, no carpetas.",
            ...global.channelInfo,
          },
          quoted
        );
      }

      downloadCharge = await chargeDownloadRequest(ctx, {
        feature: "mega",
        fileUrl,
      });
      if (!downloadCharge.ok) {
        cooldowns.delete(userId);
        return;
      }

      await sock.sendMessage(
        from,
        {
          text: `Preparando MEGA...\n\nAPI: ${getDvyerBaseUrl()}`,
          ...global.channelInfo,
        },
        quoted
      );

      const info = await requestMegaMeta(fileUrl);
      tempPath = path.join(TMP_DIR, `${Date.now()}-${info.fileName}`);

      const downloaded = await downloadMegaFile(fileUrl, tempPath);

      await sendMegaDocument(sock, from, quoted, {
        filePath: downloaded.tempPath,
        fileName: normalizeFileName(downloaded.fileName || info.fileName, "mega-file"),
        title: info.title,
        fileSize: info.fileSize,
        fileSizeBytes: info.fileSizeBytes,
        size: downloaded.size,
      });
    } catch (error) {
      console.error("MEGA ERROR:", error?.message || error);
      refundDownloadCharge(ctx, downloadCharge, {
        feature: "mega",
        error: String(error?.message || error || "unknown_error"),
      });
      cooldowns.delete(userId);

      await sock.sendMessage(
        from,
        {
          text: sanitizeProviderMessage(error, { kind: "file", fallback: "No se pudo procesar el archivo de MEGA." }),
          ...global.channelInfo,
        },
        quoted
      );
    } finally {
      deleteFileSafe(tempPath);
    }
  },
};
