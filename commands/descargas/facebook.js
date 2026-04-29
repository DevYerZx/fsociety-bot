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

const API_BASE = getDvyerBaseUrl();
const API_FACEBOOK_URL = `${API_BASE}/facebook`;

const VIDEO_QUALITY = "auto";
const COOLDOWN_TIME = 0;
const REQUEST_TIMEOUT = 120000;
const MAX_VIDEO_BYTES = 800 * 1024 * 1024;
const VIDEO_AS_DOCUMENT_THRESHOLD = 45 * 1024 * 1024;

// Más seguro que /home/container/tmp en algunos hostings
const TMP_DIR = path.join(process.cwd(), "tmp", "dvyer-facebook");

const cooldowns = new Map();

ensureTmpDir();

function ensureTmpDir() {
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  } catch {}
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

function buildTempPath(fileName) {
  ensureTmpDir();

  return path.join(
    TMP_DIR,
    `${Date.now()}-${randomUUID()}-${normalizeMp4Name(fileName)}`
  );
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
    /https?:\/\/(?:www\.)?(?:facebook\.com|m\.facebook\.com|fb\.watch)\/[^\s]+/i
  );
  return match ? match[0].trim() : "";
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

function parseContentDispositionFileName(headerValue) {
  const text = String(headerValue || "");
  const utfMatch = text.match(/filename\*=UTF-8''([^;]+)/i);

  if (utfMatch?.[1]) {
    try {
      return decodeURIComponent(utfMatch[1]).replace(/["']/g, "").trim();
    } catch {}
  }

  const normalMatch = text.match(/filename="?([^"]+)"?/i);
  if (normalMatch?.[1]) return normalMatch[1].trim();

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
    params: withDvyerApiKey(params),
    headers: withDvyerApiKeyHeader({
      Accept: "application/json,text/plain,*/*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
      Referer: `${API_BASE}/`,
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

async function requestFacebookMeta(videoUrl) {
  const data = await apiGet(API_FACEBOOK_URL, {
    mode: "link",
    quality: VIDEO_QUALITY,
    url: videoUrl,
  });

  return {
    title: safeFileName(data?.title || data?.result?.title || "Facebook Video"),
    description: String(data?.description || data?.result?.description || "").trim() || null,
    duration: String(data?.duration || data?.result?.duration || "").trim() || null,
    thumbnail: data?.thumbnail || data?.result?.thumbnail || null,
    fileName: normalizeMp4Name(
      data?.filename || data?.file_name || data?.result?.filename || "facebook-video.mp4"
    ),
    downloadUrl: pickApiDownloadUrl(data),
  };
}

async function downloadFacebookVideo(videoUrl, outputPath, directUrl = "") {
  ensureTmpDir();

  const hasDirectUrl = /^https?:\/\//i.test(String(directUrl || "").trim());
  const requestUrl = hasDirectUrl
    ? appendDvyerApiKeyToUrl(directUrl)
    : API_FACEBOOK_URL;

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

  if (!hasDirectUrl) {
    requestConfig.params = withDvyerApiKey({
      mode: "file",
      quality: VIDEO_QUALITY,
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
        parsed || { message: errorText || "No se pudo descargar el video." },
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
      response.data.destroy(
        new Error("El video es demasiado grande para enviarlo por WhatsApp.")
      );
    }
  });

  try {
    ensureTmpDir();
    await pipeline(response.data, fs.createWriteStream(outputPath));
  } catch (error) {
    deleteFileSafe(outputPath);

    const isEnoent = String(error?.message || "")
      .toUpperCase()
      .includes("ENOENT");

    if (!isEnoent) throw error;

    ensureTmpDir();

    const retryResponse = await axios.get(requestUrl, requestConfig);

    if (retryResponse.status >= 400) {
      const retryErrorText = await readStreamToText(retryResponse.data).catch(() => "");
      throw new Error(retryErrorText || "Error al descargar el video.");
    }

    await pipeline(retryResponse.data, fs.createWriteStream(outputPath));
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error("No se pudo guardar el video.");
  }

  const size = fs.statSync(outputPath).size;

  if (!size || size < 100000) {
    deleteFileSafe(outputPath);
    throw new Error("El archivo descargado es inválido.");
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

  const finalCaption =
    caption ||
    `╭━━〔 🎬 *FACEBOOK MP4* 〕━━⬣\n` +
      `┃ 📌 ${title || fileName}\n` +
      `╰━━━━━━━━━━━━━━━━━━⬣`;

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
  description: "Descarga videos públicos de Facebook usando DVYER API.",

  run: async (ctx) => {
    const { sock, from } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const userId = `${from}:facebook`;

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
      ensureTmpDir();

      const rawInput = resolveUserInput(ctx);
      const videoUrl = extractFacebookUrl(rawInput);

      if (!videoUrl) {
        cooldowns.delete(userId);

        return sock.sendMessage(
          from,
          {
            text:
              "╭━━〔 ❌ *USO INCORRECTO* 〕━━⬣\n" +
              "┃ Uso: .facebook <link público de Facebook>\n" +
              "┃ También puedes responder a un mensaje con el link.\n" +
              "╰━━━━━━━━━━━━━━━━━━⬣",
            ...global.channelInfo,
          },
          quoted
        );
      }

      downloadCharge = await chargeDownloadRequest(ctx, {
        feature: "facebook",
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
            "╭━━〔 ⬇️ *PREPARANDO FACEBOOK* 〕━━⬣\n" +
            `┃ 🔗 API: ${API_BASE}\n` +
            "┃ 🔑 API Key: Activa\n" +
            "╰━━━━━━━━━━━━━━━━━━⬣",
          ...global.channelInfo,
        },
        quoted
      );

      const info = await requestFacebookMeta(videoUrl);

      if (info.thumbnail) {
        const previewLines = [
          "╭━━〔 🎬 *FACEBOOK VIDEO* 〕━━⬣",
          `┃ 📌 ${info.title}`,
        ];

        if (info.duration) previewLines.push(`┃ ⏱️ Duración: ${info.duration}`);

        previewLines.push("╰━━━━━━━━━━━━━━━━━━⬣");

        if (info.description) {
          previewLines.push("");
          previewLines.push(info.description.slice(0, 400));
        }

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

      tempPath = buildTempPath(info.fileName);

      const downloaded = await downloadFacebookVideo(
        videoUrl,
        tempPath,
        info.downloadUrl
      );

      const captionLines = [
        "╭━━〔 ✅ *FACEBOOK ENVIADO* 〕━━⬣",
        `┃ 📌 ${info.title}`,
      ];

      if (info.duration) captionLines.push(`┃ ⏱️ Duración: ${info.duration}`);

      captionLines.push(`┃ 📦 Peso: ${(downloaded.size / 1024 / 1024).toFixed(2)} MB`);
      captionLines.push("╰━━━━━━━━━━━━━━━━━━⬣");

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

      refundDownloadCharge(ctx, downloadCharge, {
        feature: "facebook",
        error: String(error?.message || error || "unknown_error"),
      });

      cooldowns.delete(userId);

      await sock.sendMessage(
        from,
        {
          text:
            "╭━━〔 ❌ *ERROR FACEBOOK* 〕━━⬣\n" +
            `┃ ${String(error?.message || "No se pudo procesar el video de Facebook.")}\n` +
            "╰━━━━━━━━━━━━━━━━━━⬣",
          ...global.channelInfo,
        },
        quoted
      );
    } finally {
      deleteFileSafe(tempPath);
    }
  },
};