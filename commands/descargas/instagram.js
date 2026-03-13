import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import { pipeline } from "stream/promises";
import { spawn } from "child_process";

const API_BASE = "https://dv-yer-api.online";
const API_INSTAGRAM_URL = `${API_BASE}/instagram`;

const COOLDOWN_TIME = 15 * 1000;
const REQUEST_TIMEOUT = 120000;
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
const VIDEO_AS_DOCUMENT_THRESHOLD = 50 * 1024 * 1024;
const TMP_DIR = path.join(os.tmpdir(), "dvyer-instagram");

const cooldowns = new Map();

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function safeFileName(name) {
  return (
    String(name || "instagram-media")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "instagram-media"
  );
}

function normalizeMediaFileName(name, mediaType = "video") {
  const raw = String(name || "").trim();
  const defaultExt = mediaType === "image" ? "jpg" : "mp4";
  const extMatch = raw.match(/\.([a-z0-9]+)$/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : defaultExt;
  const base = safeFileName(raw.replace(/\.[^.]+$/i, "") || "instagram-media");
  return `${base}.${ext}`;
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

function extractInstagramUrl(text) {
  const match = String(text || "").match(
    /https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\/[^\s]+/i
  );
  return match ? match[0].trim() : "";
}

function resolveUserInput(ctx) {
  const msg = ctx.m || ctx.msg || null;
  const args = Array.isArray(ctx.args) ? ctx.args : [];
  const directText = args.join(" ").trim();
  const quotedMessage = getQuotedMessage(ctx, msg);
  const quotedText = extractTextFromMessage(quotedMessage);

  return {
    args,
    url: extractInstagramUrl(directText) || extractInstagramUrl(quotedText) || "",
  };
}

function resolvePick(args) {
  const first = String(args?.[0] || "").trim();
  if (!/^\d+$/.test(first)) return 1;
  const parsed = Number(first);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(parsed, 20));
}

function extractApiError(data, status) {
  return (
    data?.detail ||
    data?.error?.message ||
    data?.message ||
    (status ? `HTTP ${status}` : "Error de API")
  );
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

async function requestInstagramInfo(postUrl, pick) {
  const data = await apiGet(
    API_INSTAGRAM_URL,
    {
      mode: "link",
      url: postUrl,
      pick,
      lang: "es",
    },
    REQUEST_TIMEOUT
  );

  const selected = data?.selected || {};
  const mediaType = String(selected?.type || data?.type || "video").toLowerCase();

  return {
    title: safeFileName(data?.title || "Instagram Media"),
    username: String(data?.username || "").trim() || null,
    description: String(data?.description || "").trim() || null,
    thumbnail: data?.thumbnail || null,
    mediaType,
    count: Number(data?.count || 1),
    pick: Number(data?.pick || pick || 1),
    fileName: normalizeMediaFileName(
      selected?.filename || data?.filename || "instagram-media.mp4",
      mediaType
    ),
  };
}

async function downloadInstagramFile(postUrl, pick, outputPath) {
  const response = await axios.get(API_INSTAGRAM_URL, {
    responseType: "stream",
    timeout: REQUEST_TIMEOUT,
    params: {
      mode: "file",
      url: postUrl,
      pick,
      lang: "es",
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
        { message: errorText || "No se pudo descargar el archivo." },
        response.status
      )
    );
  }

  const contentLength = Number(response.headers?.["content-length"] || 0);
  if (contentLength && contentLength > MAX_MEDIA_BYTES) {
    throw new Error("El archivo es demasiado grande para enviarlo por WhatsApp.");
  }

  let downloaded = 0;

  response.data.on("data", (chunk) => {
    downloaded += chunk.length;
    if (downloaded > MAX_MEDIA_BYTES) {
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

  if (!size || size < 30000) {
    deleteFileSafe(outputPath);
    throw new Error("El archivo descargado es inválido.");
  }

  if (size > MAX_MEDIA_BYTES) {
    deleteFileSafe(outputPath);
    throw new Error("El archivo es demasiado grande para enviarlo por WhatsApp.");
  }

  return {
    tempPath: outputPath,
    size,
  };
}

async function convertVideoForWhatsApp(inputPath, outputPath) {
  return await new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-y",
        "-i",
        inputPath,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "28",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "main",
        "-level",
        "4.0",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ar",
        "44100",
        "-movflags",
        "+faststart",
        "-loglevel",
        "error",
        outputPath,
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
      }
    );

    let errorText = "";

    ffmpeg.stderr.on("data", (chunk) => {
      errorText += chunk.toString();
    });

    ffmpeg.on("error", (error) => {
      if (error?.code === "ENOENT") {
        reject(new Error("ffmpeg no está instalado en el hosting."));
        return;
      }
      reject(error);
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve(true);
        return;
      }
      reject(new Error(errorText.trim() || "No se pudo convertir el video para WhatsApp."));
    });
  });
}

async function sendInstagramMedia(sock, from, quoted, { filePath, fileName, mediaType, title, username, size }) {
  const lines = ["api dvyer", "", `📸 ${title}`];
  if (username) lines.push(`👤 ${username}`);
  const caption = lines.join("\n");

  if (mediaType === "image") {
    await sock.sendMessage(
      from,
      {
        image: { url: filePath },
        caption,
        ...global.channelInfo,
      },
      quoted
    );
    return "image";
  }

  if (size > VIDEO_AS_DOCUMENT_THRESHOLD) {
    await sock.sendMessage(
      from,
      {
        document: { url: filePath },
        mimetype: "video/mp4",
        fileName,
        caption: `${caption}\n📦 Enviado como documento`,
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
        caption,
        ...global.channelInfo,
      },
      quoted
    );
    return "video";
  } catch (error) {
    console.error("send instagram video failed:", error?.message || error);

    await sock.sendMessage(
      from,
      {
        document: { url: filePath },
        mimetype: "video/mp4",
        fileName,
        caption: `${caption}\n📦 Enviado como documento`,
        ...global.channelInfo,
      },
      quoted
    );
    return "document";
  }
}

export default {
  command: ["instagram", "ig", "igdl"],
  category: "descarga",

  run: async (ctx) => {
    const { sock, from } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const userId = `${from}:instagram`;

    let rawPath = null;
    let finalPath = null;

    const until = cooldowns.get(userId);
    if (until && until > Date.now()) {
      return sock.sendMessage(from, {
        text: `⏳ Espera ${getCooldownRemaining(until)}s`,
        ...global.channelInfo,
      });
    }

    cooldowns.set(userId, Date.now() + COOLDOWN_TIME);

    try {
      const input = resolveUserInput(ctx);
      const pick = resolvePick(input.args);
      const postUrl = input.url;

      if (!postUrl) {
        cooldowns.delete(userId);
        return sock.sendMessage(from, {
          text: "❌ Uso: .instagram <link>\n❌ O: .instagram 2 <link>",
          ...global.channelInfo,
        });
      }

      await sock.sendMessage(
        from,
        {
          text: `📸 Preparando Instagram...\n\n🌐 ${API_BASE}\n🎯 Pick: ${pick}`,
          ...global.channelInfo,
        },
        quoted
      );

      const info = await requestInstagramInfo(postUrl, pick);

      if (info.thumbnail) {
        const previewLines = ["api dvyer", "", `📸 ${info.title}`];
        if (info.username) previewLines.push(`👤 ${info.username}`);
        if (info.count > 1) previewLines.push(`🧩 Elementos: ${info.count}`);
        previewLines.push(`🎯 Pick: ${info.pick}`);

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

      rawPath = path.join(TMP_DIR, `${Date.now()}-raw-${info.fileName}`);
      const downloaded = await downloadInstagramFile(postUrl, pick, rawPath);

      let sendPath = downloaded.tempPath;
      let sendSize = downloaded.size;

      if (info.mediaType === "video") {
        finalPath = path.join(TMP_DIR, `${Date.now()}-final-${normalizeMediaFileName(info.fileName, "video")}`);
        await convertVideoForWhatsApp(downloaded.tempPath, finalPath);

        if (!fs.existsSync(finalPath)) {
          throw new Error("No se pudo preparar el video final.");
        }

        sendPath = finalPath;
        sendSize = fs.statSync(finalPath).size;

        if (!sendSize || sendSize < 100000) {
          throw new Error("El video convertido es inválido.");
        }
      }

      await sendInstagramMedia(sock, from, quoted, {
        filePath: sendPath,
        fileName: normalizeMediaFileName(info.fileName, info.mediaType),
        mediaType: info.mediaType,
        title: info.title,
        username: info.username,
        size: sendSize,
      });
    } catch (err) {
      console.error("INSTAGRAM ERROR:", err?.message || err);

      await sock.sendMessage(from, {
        text: `❌ ${String(err?.message || "No se pudo procesar la publicación de Instagram.")}`,
        ...global.channelInfo,
      });
    } finally {
      deleteFileSafe(rawPath);
      deleteFileSafe(finalPath);
    }
  },
};
