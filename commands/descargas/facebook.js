import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import { pipeline } from "stream/promises";

const API_BASE = "https://dv-yer-api.online";
const API_FACEBOOK_URL = `${API_BASE}/facebook`;

const VIDEO_QUALITY = "auto";
const COOLDOWN_TIME = 15 * 1000;
const REQUEST_TIMEOUT = 120000;
const MAX_VIDEO_BYTES = 800 * 1024 * 1024;
const VIDEO_AS_DOCUMENT_THRESHOLD = 45 * 1024 * 1024;
const TMP_DIR = path.join(os.tmpdir(), "dvyer-facebook");

const cooldowns = new Map();

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function safeFileName(name) {
  return (
    String(name || "facebook-video")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "facebook-video"
  );
}

function normalizeMp4Name(name) {
  const clean = safeFileName(String(name || "facebook-video").replace(/\.mp4$/i, ""));
  return `${clean || "facebook-video"}.mp4`;
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

function extractFacebookUrl(text) {
  const match = String(text || "").match(
    /https?:\/\/(?:www\.)?(?:facebook\.com|fb\.watch)\/[^\s]+/i
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

async function requestFacebookMeta(videoUrl) {
  const data = await apiGet(API_FACEBOOK_URL, {
    mode: "link",
    quality: VIDEO_QUALITY,
    url: videoUrl,
  });

  return {
    title: safeFileName(data?.title || "Facebook Video"),
    description: String(data?.description || "").trim() || null,
    duration: String(data?.duration || "").trim() || null,
    thumbnail: data?.thumbnail || null,
    fileName: normalizeMp4Name(data?.filename || data?.file_name || "facebook-video.mp4"),
  };
}

async function downloadFacebookVideo(videoUrl, outputPath) {
  const response = await axios.get(API_FACEBOOK_URL, {
    responseType: "stream",
    timeout: REQUEST_TIMEOUT,
    params: {
      mode: "file",
      quality: VIDEO_QUALITY,
      url: videoUrl,
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
    throw new Error(
      extractApiError(
        { message: errorText || "No se pudo descargar el video." },
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
    await pipeline(response.data, fs.createWriteStream(outputPath));
  } catch (error) {
    deleteFileSafe(outputPath);
    throw error;
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error("No se pudo guardar el video.");
  }

  const size = fs.statSync(outputPath).size;
  if (!size || size < 100000) {
    deleteFileSafe(outputPath);
    throw new Error("El archivo descargado es invalido.");
  }

  if (size > MAX_VIDEO_BYTES) {
    deleteFileSafe(outputPath);
    throw new Error("El video es demasiado grande para enviarlo por WhatsApp.");
  }

  const detectedName = parseContentDispositionFileName(
    response.headers?.["content-disposition"]
  );

  return {
    tempPath: outputPath,
    size,
    fileName: normalizeMp4Name(detectedName || path.basename(outputPath)),
  };
}

async function sendVideoOrDocument(sock, from, quoted, options) {
  const {
    filePath,
    fileName,
    title,
    caption = null,
    documentThreshold = 70 * 1024 * 1024,
    size = 0,
  } = options;

  const finalCaption = caption || `DVYER API\n\n${title || fileName}`;

  if (size > documentThreshold) {
    await sock.sendMessage(
      from,
      {
        document: { url: filePath },
        mimetype: "video/mp4",
        fileName,
        caption: finalCaption,
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
        caption: finalCaption,
        ...global.channelInfo,
      },
      quoted
    );
    return "video";
  } catch (error) {
    console.error("send video failed:", error?.message || error);

    await sock.sendMessage(
      from,
      {
        document: { url: filePath },
        mimetype: "video/mp4",
        fileName,
        caption: finalCaption,
        ...global.channelInfo,
      },
      quoted
    );
    return "document";
  }
}

export default {
  command: ["facebook", "fb", "fbmp4"],
  category: "descarga",

  run: async (ctx) => {
    const { sock, from } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const userId = `${from}:facebook`;

    let tempPath = null;

    const until = cooldowns.get(userId);
    if (until && until > Date.now()) {
      return sock.sendMessage(from, {
        text: `Espera ${getCooldownRemaining(until)}s`,
        ...global.channelInfo,
      });
    }

    cooldowns.set(userId, Date.now() + COOLDOWN_TIME);

    try {
      const rawInput = resolveUserInput(ctx);
      const videoUrl = extractFacebookUrl(rawInput);

      if (!videoUrl) {
        cooldowns.delete(userId);
        return sock.sendMessage(from, {
          text: "Uso: .facebook <link publico de Facebook> o responde a un mensaje con el link",
          ...global.channelInfo,
        });
      }

      await sock.sendMessage(
        from,
        {
          text: `Preparando Facebook...\n\nAPI: ${API_BASE}`,
          ...global.channelInfo,
        },
        quoted
      );

      const info = await requestFacebookMeta(videoUrl);

      if (info.thumbnail) {
        const previewLines = ["DVYER API", "", info.title];
        if (info.duration) previewLines.push(`Duracion: ${info.duration}`);
        if (info.description) previewLines.push("", info.description);

        await sock.sendMessage(
          from,
          {
            image: { url: info.thumbnail },
            caption: previewLines.join("\n"),
            ...global.channelInfo,
          },
          quoted
        );
      }

      tempPath = path.join(TMP_DIR, `${Date.now()}-${info.fileName}`);
      const downloaded = await downloadFacebookVideo(videoUrl, tempPath);

      const captionLines = ["DVYER API", "", info.title];
      if (info.duration) captionLines.push(`Duracion: ${info.duration}`);

      await sendVideoOrDocument(sock, from, quoted, {
        filePath: downloaded.tempPath,
        fileName: normalizeMp4Name(downloaded.fileName || info.fileName),
        title: info.title,
        size: downloaded.size,
        documentThreshold: VIDEO_AS_DOCUMENT_THRESHOLD,
        caption: captionLines.join("\n"),
      });
    } catch (error) {
      console.error("FACEBOOK ERROR:", error?.message || error);

      await sock.sendMessage(from, {
        text: String(error?.message || "No se pudo procesar el video de Facebook."),
        ...global.channelInfo,
      });
    } finally {
      deleteFileSafe(tempPath);
    }
  },
};
