import path from "path";
import os from "os";
import fs from "fs";
import fsp from "fs/promises";
import http from "http";
import https from "https";
import axios from "axios";
import yts from "yt-search";
import { spawn } from "child_process";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";
import { buildDvyerUrl } from "../../lib/api-manager.js";
import { chargeDownloadRequest, refundDownloadCharge } from "../economia/download-access.js";

const API_YTMP4_URL = buildDvyerUrl("/ytmp4");
const TMP_DIR = path.join(os.tmpdir(), "dvyer-ytmp4");
const REQUEST_TIMEOUT = 15 * 60 * 1000;
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const VIDEO_AS_DOCUMENT_THRESHOLD = 35 * 1024 * 1024;
const BUFFER_SEND_MAX_BYTES = 120 * 1024 * 1024;
const MIN_VIDEO_BYTES = 64 * 1024;
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 10 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 10 });
const QUALITY_PATTERN = /^(1080p|720p|480p|360p|240p|144p|best|hd|sd|\d{3,4}p?)$/i;
const FFMPEG_FULL_MAX_BYTES = 700 * 1024 * 1024;
const FFMPEG_REMUX_MAX_BYTES = 300 * 1024 * 1024;
const FFMPEG_MIN_TIMEOUT = 40_000;
const FFMPEG_MAX_TIMEOUT = 420_000;

async function ensureTmpDir() {
  await fsp.mkdir(TMP_DIR, { recursive: true });
}

async function deleteFileSafe(filePath) {
  try {
    if (filePath) await fsp.unlink(filePath);
  } catch {}
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipText(value = "", max = 90) {
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
    index++;
  }
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function safeFileName(name) {
  return (
    String(name || "youtube-video")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/[^\w .()[\]-]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "youtube-video"
  );
}

function normalizeMp4Name(name) {
  const parsed = path.parse(String(name || "").trim());
  const base = safeFileName(parsed.name || name || "youtube-video");
  return `${base || "youtube-video"}.mp4`;
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

function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    let stderr = "";
    const child = spawn("ffmpeg", args);

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill("SIGKILL");
      } catch {}
      reject(new Error("ffmpeg timeout"));
    }, timeoutMs);

    child.stderr?.on("data", (chunk) => {
      stderr += chunkToText(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(stderr.trim() || `ffmpeg exited ${code}`));
    });
  });
}

function ffmpegTimeoutForBytes(bytes) {
  const mb = Math.max(1, Math.round(Number(bytes || 0) / (1024 * 1024)));
  return Math.max(FFMPEG_MIN_TIMEOUT, Math.min(FFMPEG_MAX_TIMEOUT, mb * 1300));
}

async function transcodeMp4Full(data) {
  const sourcePath = String(data?.tempPath || "");
  if (!sourcePath || !fs.existsSync(sourcePath)) return data;
  const size = Number(data?.size || 0);
  if (!Number.isFinite(size) || size <= 0 || size > FFMPEG_FULL_MAX_BYTES) return data;

  const outputPath = path.join(TMP_DIR, `${Date.now()}-${randomUUID()}-ytmp4-full.mp4`);
  const timeoutMs = ffmpegTimeoutForBytes(size);

  try {
    await runFfmpeg(
      [
        "-y",
        "-i",
        sourcePath,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "24",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-max_muxing_queue_size",
        "1024",
        "-loglevel",
        "error",
        outputPath,
      ],
      timeoutMs
    );

    const stat = await fsp.stat(outputPath).catch(() => null);
    if (!stat?.size || stat.size < MIN_VIDEO_BYTES) {
      await deleteFileSafe(outputPath);
      return data;
    }

    await deleteFileSafe(sourcePath);
    return {
      ...data,
      tempPath: outputPath,
      size: stat.size,
      contentType: "video/mp4",
    };
  } catch {
    await deleteFileSafe(outputPath);
    return data;
  }
}

async function remuxMp4Fast(data) {
  const sourcePath = String(data?.tempPath || "");
  if (!sourcePath || !fs.existsSync(sourcePath)) return data;
  const size = Number(data?.size || 0);
  if (!Number.isFinite(size) || size <= 0 || size > FFMPEG_REMUX_MAX_BYTES) return data;

  const outputPath = path.join(TMP_DIR, `${Date.now()}-${randomUUID()}-ytmp4-fixed.mp4`);
  const timeoutMs = ffmpegTimeoutForBytes(size);

  try {
    await runFfmpeg(
      [
        "-y",
        "-i",
        sourcePath,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-loglevel",
        "error",
        outputPath,
      ],
      timeoutMs
    );
    const stat = await fsp.stat(outputPath).catch(() => null);
    if (!stat?.size || stat.size < MIN_VIDEO_BYTES) {
      await deleteFileSafe(outputPath);
      return data;
    }
    await deleteFileSafe(sourcePath);
    return {
      ...data,
      tempPath: outputPath,
      size: stat.size,
      contentType: "video/mp4",
    };
  } catch {
    await deleteFileSafe(outputPath);
    return data;
  }
}

async function findLatestTmpMp4(maxAgeMs = 30 * 60 * 1000) {
  await ensureTmpDir();
  const now = Date.now();
  const entries = await fsp.readdir(TMP_DIR, { withFileTypes: true }).catch(() => []);
  let selected = null;
  for (const entry of entries) {
    if (!entry?.isFile?.() || !entry.name.toLowerCase().endsWith(".mp4")) continue;
    const fullPath = path.join(TMP_DIR, entry.name);
    const stat = await fsp.stat(fullPath).catch(() => null);
    if (!stat?.size || stat.size < MIN_VIDEO_BYTES) continue;
    if (now - stat.mtimeMs > maxAgeMs) continue;
    if (!selected || stat.mtimeMs > selected.mtimeMs) {
      selected = { path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs };
    }
  }
  return selected;
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

function resolveRawInput(ctx) {
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

function normalizeQuality(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "360p";
  if (text === "hd") return "720p";
  if (text === "sd") return "360p";
  if (text === "best") return "best";
  const match = text.match(/(\d{3,4})/);
  return match ? `${match[1]}p` : "360p";
}

function extractQualityAndQuery(input) {
  const tokens = cleanText(input).split(/\s+/).filter(Boolean);
  let quality = "360p";
  let fast = true;
  const remaining = [];

  for (const token of tokens) {
    const lower = token.toLowerCase();

    if (QUALITY_PATTERN.test(token) && quality === "360p") {
      quality = token;
      continue;
    }

    if (lower === "fast" || lower === "-fast" || lower === "--fast") {
      fast = true;
      continue;
    }

    if (lower === "nofast" || lower === "-nofast" || lower === "--nofast") {
      fast = false;
      continue;
    }

    remaining.push(token);
  }

  return {
    quality: normalizeQuality(quality),
    query: remaining.join(" ").trim(),
    fast,
  };
}

async function resolveInputToUrl(input) {
  const directUrl = extractYouTubeUrl(input);
  if (directUrl) {
    return {
      url: directUrl,
      title: "YouTube MP4",
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
    title: cleanText(video.title || "YouTube MP4"),
    duration: cleanText(video.timestamp || ""),
    author: cleanText(video.author?.name || video.author || ""),
    searched: true,
  };
}

async function getYtmp4Link(videoUrl, quality, fast = true) {
  const response = await axios.get(API_YTMP4_URL, {
    timeout: REQUEST_TIMEOUT,
    params: {
      mode: "link",
      url: videoUrl,
      quality,
      fast,
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
    data.download_url_full ||
    data.stream_url_full ||
    data.direct_url ||
    data.url;

  if (!remoteUrl) {
    throw new Error("La API no devolvió una URL de descarga.");
  }

  return {
    remoteUrl,
    title: cleanText(data.title || "YouTube MP4"),
    fileName: normalizeMp4Name(data.filename || data.title || "youtube-video.mp4"),
    quality: cleanText(data.quality || data.quality_requested || quality || "360p"),
    thumbnail: data.thumbnail || "",
    cached: Boolean(data.cached),
    availableQualities: Array.isArray(data.available_qualities) ? data.available_qualities : [],
    expiresIn: Number(data.expires_in_hint_seconds || 0),
    request: data.request || {},
  };
}

async function downloadYtmp4Fallback(videoUrl, preferredName, quality, fast = true) {
  await ensureTmpDir();

  const outputPath = path.join(TMP_DIR, `${Date.now()}-${randomUUID()}-ytmp4.mp4`);

  const downloadFromResponse = async (response, fallbackName) => {
    const contentLength = Number(response.headers?.["content-length"] || 0);
    if (contentLength > MAX_VIDEO_BYTES) {
      throw new Error(`El video pesa ${humanBytes(contentLength)} y supera el limite del bot.`);
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
      throw new Error("No se pudo guardar el MP4.");
    }

    const size = fs.statSync(outputPath).size;
    if (size < MIN_VIDEO_BYTES) {
      deleteFileSafe(outputPath);
      throw new Error("El archivo MP4 descargado es invalido.");
    }
    if (size > MAX_VIDEO_BYTES) {
      deleteFileSafe(outputPath);
      throw new Error(`El video pesa ${humanBytes(size)} y supera el limite del bot.`);
    }

    const headerName = parseContentDispositionFileName(response.headers?.["content-disposition"]);
    const fileName = normalizeMp4Name(headerName || fallbackName || "youtube-video.mp4");

    return {
      tempPath: outputPath,
      fileName,
      size,
      contentType: response.headers?.["content-type"] || "video/mp4",
    };
  };

  const downloadFromStream = async (streamUrl, fallbackName) => {
    const response = await axios.get(streamUrl, {
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

    return await downloadFromResponse(response, fallbackName);
  };

  try {
    const response = await axios.get(API_YTMP4_URL, {
      responseType: "stream",
      timeout: REQUEST_TIMEOUT,
      params: {
        mode: "stream",
        url: videoUrl,
        quality,
        fast,
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

    return await downloadFromResponse(response, preferredName);
  } catch (error) {
    deleteFileSafe(outputPath);
    const linkData = await getYtmp4Link(videoUrl, quality, fast);
    if (!linkData?.remoteUrl) throw error;
    return await downloadFromStream(linkData.remoteUrl, linkData.fileName || preferredName);
  }
}

async function sendRemoteMp4(sock, from, quoted, data) {
  const caption = [
    "╭─〔 *DVYER • YTMP4* 〕",
    `┃ 🎬 Título: ${clipText(data.title || data.fileName, 80)}`,
    `┃ ⌁ Calidad: ${data.quality || "360p"}`,
    `┃ ⚡ Modo: remoto`,
    data.cached ? "┃ 🚀 Cache: sí" : "┃ 🚀 Cache: no",
    "╰─⟡ MP4 listo.",
  ].join("\n");

  try {
    await sock.sendMessage(
      from,
      {
        video: { url: data.remoteUrl },
        mimetype: "video/mp4",
        fileName: data.fileName,
        caption,
        gifPlayback: false,
        ...global.channelInfo,
      },
      quoted
    );
    return "video";
  } catch (e) {}

  await sock.sendMessage(
    from,
    {
      document: { url: data.remoteUrl },
      mimetype: "video/mp4",
      fileName: data.fileName,
      caption,
      ...global.channelInfo,
    },
    quoted
  );

  return "document";
}

async function sendLocalMp4(sock, from, quoted, data, options = {}) {
  const preferDocument = Boolean(options?.preferDocument);
  const caption = [
    "╭─〔 *DVYER • YTMP4* 〕",
    `┃ 🎬 Título: ${clipText(data.title || data.fileName, 80)}`,
    `┃ ⌁ Calidad: ${data.quality || "360p"}`,
    `┃ ◈ Peso: ${humanBytes(data.size)}`,
    `┃ ⚡ Modo: stream local estable`,
    "╰─⟡ MP4 listo.",
  ].join("\n");

  const fileSize = Number(data?.size || 0);
  const canUseBuffer = fileSize > 0 && fileSize <= BUFFER_SEND_MAX_BYTES;

  if (canUseBuffer) {
    const fileBuffer = await fsp.readFile(data.tempPath);
    if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length < MIN_VIDEO_BYTES) {
      throw new Error("El MP4 local es invalido o esta incompleto.");
    }

    if (!preferDocument && fileBuffer.length <= VIDEO_AS_DOCUMENT_THRESHOLD) {
      try {
        await sock.sendMessage(
          from,
          {
            video: fileBuffer,
            mimetype: "video/mp4",
            fileName: data.fileName,
            caption,
            gifPlayback: false,
            ...global.channelInfo,
          },
          quoted
        );
        return "video";
      } catch {}
    }

    try {
      await sock.sendMessage(
        from,
        {
          document: fileBuffer,
          mimetype: "video/mp4",
          fileName: data.fileName,
          caption,
          ...global.channelInfo,
        },
        quoted
      );
      return "document";
    } catch {}
  }

  if (!preferDocument && fileSize <= VIDEO_AS_DOCUMENT_THRESHOLD) {
    try {
      await sock.sendMessage(
        from,
        {
          video: { url: data.tempPath },
          mimetype: "video/mp4",
          fileName: data.fileName,
          caption,
          gifPlayback: false,
          ...global.channelInfo,
        },
        quoted
      );
      return "video";
    } catch {}
  }

  await sock.sendMessage(
    from,
    {
      document: { url: data.tempPath },
      mimetype: "video/mp4",
      fileName: data.fileName,
      caption,
      ...global.channelInfo,
    },
    quoted
  );

  return "document";
}

export default {
  command: ["ytmp4", "ytv", "ytvideo"],
  category: "descarga",

  run: async (ctx) => {
    const { sock, from } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;

    let tempPath = null;
    let downloadCharge = null;
    let sentSuccessfully = false;

    try {
      const rawInput = resolveRawInput(ctx);
      const { quality, query, fast } = extractQualityAndQuery(rawInput);
      const resolved = await resolveInputToUrl(query || rawInput);

      if (!resolved?.url) {
        return await sock.sendMessage(
          from,
          {
            text: [
              "╭─〔 *DVYER • YTMP4* 〕",
              "┃ Uso: .ytmp4 <link o nombre>",
              "┃ Uso: .ytmp4 720p <link o nombre>",
              "┃ Uso: .ytmp4 fast <link o nombre>",
              "┃ Uso: .ytmp4 nofast <link o nombre>",
              "╰─⟡ MP4 rápido desde DVYER API.",
            ].join("\n"),
            ...global.channelInfo,
          },
          quoted
        );
      }

      downloadCharge = await chargeDownloadRequest(ctx, {
        feature: "ytmp4",
        videoUrl: resolved.url,
      });
      if (!downloadCharge?.ok) return;

      await sock.sendMessage(
        from,
        {
          text: [
            "╭─〔 *DVYER • YTMP4* 〕",
            `┃ 🎬 Título: ${clipText(resolved.title, 80)}`,
            resolved.duration ? `┃ ⏱ Duración: ${resolved.duration}` : "┃ ⏱ Duración: detectando",
            `┃ ⌁ Calidad: ${quality}`,
            `┃ 🚀 Fast: ${fast ? "sí" : "no"}`,
            "╰─⟡ Preparando MP4...",
          ].join("\n"),
          ...global.channelInfo,
        },
        quoted
      );

      const downloaded = await downloadYtmp4Fallback(resolved.url, resolved.title, quality, fast);
      tempPath = downloaded.tempPath;

      // En fast evitamos ffmpeg pesado para enviar mas rapido.
      // En nofast mantenemos normalizacion para maxima compatibilidad.
      const prepared = fast
        ? downloaded
        : await remuxMp4Fast(await transcodeMp4Full(downloaded));
      tempPath = prepared.tempPath;
      const officialFileName = normalizeMp4Name(resolved.title || prepared.fileName || "youtube-video.mp4");

      await sendLocalMp4(sock, from, quoted, {
        ...prepared,
        fileName: officialFileName,
        title: resolved.title || path.parse(officialFileName).name,
        quality,
      }, { preferDocument: fast });
      sentSuccessfully = true;
    } catch (error) {
      console.error("YTMP4 ERROR:", error?.message || error);

      const errText = String(error?.message || error || "");
      if (!sentSuccessfully && /toString/i.test(errText)) {
        const fallback = await findLatestTmpMp4();
        if (fallback?.path) {
          tempPath = fallback.path;
          try {
            const fallbackName = normalizeMp4Name("youtube-video");
            await sendLocalMp4(sock, from, quoted, {
              tempPath: fallback.path,
              fileName: fallbackName,
              size: fallback.size,
              title: "YouTube Video",
              quality: "360p",
            });
            sentSuccessfully = true;
          } catch {}
        }
      }

      if (!sentSuccessfully) {
        refundDownloadCharge(ctx, downloadCharge, {
          feature: "ytmp4",
          error: String(error?.message || error || "unknown_error"),
        });
      }

      if (!sentSuccessfully) {
        await sock.sendMessage(
          from,
          {
            text: `❌ ${String(error?.message || "No se pudo preparar el MP4.")}`,
            ...global.channelInfo,
          },
          quoted
        );
      }
    } finally {
      await deleteFileSafe(tempPath);
    }
  },
};
