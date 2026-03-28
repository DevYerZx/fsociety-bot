import fs from "fs";
import path from "path";
import axios from "axios";
import { pipeline } from "stream/promises";
import { spawn } from "child_process";
import { buildDvyerUrl, getDvyerBaseUrl } from "../../lib/api-manager.js";
import { bindAbort, buildAbortError, throwIfAborted } from "../../lib/command-abort.js";
import { getDownloadCache, setDownloadCache, withInflightDedup } from "../../lib/download-cache.js";
import { chargeDownloadRequest, refundDownloadCharge } from "../economia/download-access.js";

const API_VIDEO_PATH = "/ytdlmp4";
const API_VIDEO_LEGACY_PATH = "/ytmp4";
const API_VIDEO_ALT_PATH = "/ytaltmp4";
const API_SEARCH_PATH = "/ytsearch";
const API_BASE = getDvyerBaseUrl();
const API_VIDEO_URL = buildDvyerUrl(API_VIDEO_PATH);
const API_VIDEO_LEGACY_URL = buildDvyerUrl(API_VIDEO_LEGACY_PATH);
const API_VIDEO_ALT_URL = buildDvyerUrl(API_VIDEO_ALT_PATH);
const API_SEARCH_URL = buildDvyerUrl(API_SEARCH_PATH);

const COOLDOWN_TIME = 15 * 1000;
const VIDEO_QUALITY = "360p";
const REQUEST_TIMEOUT = 120000;
const MAX_VIDEO_BYTES = 1500 * 1024 * 1024;
const VIDEO_AS_DOCUMENT_THRESHOLD = 70 * 1024 * 1024;
const TMP_DIR = path.join(process.cwd(), "tmp");

const cooldowns = new Map();

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
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
    String(name || "video")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "video"
  );
}

function normalizeMp4Name(name) {
  const clean = safeFileName(String(name || "video").replace(/\.mp4$/i, ""));
  return `${clean || "video"}.mp4`;
}

function stripExtension(name) {
  return String(name || "").replace(/\.[^.]+$/i, "");
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function normalizeApiUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return `${API_BASE}${value}`;
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

function extractYouTubeUrl(text) {
  const match = String(text || "").match(
    /https?:\/\/(?:www\.)?(?:youtube\.com|music\.youtube\.com|youtu\.be)\/[^\s]+/i
  );
  return match ? match[0].trim() : "";
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

function getCooldownRemaining(untilMs) {
  return Math.max(0, Math.ceil((untilMs - Date.now()) / 1000));
}

function extractApiError(data, status) {
  return (
    data?.detail ||
    data?.error?.message ||
    data?.message ||
    (status ? `HTTP ${status}` : "Error de API")
  );
}

function createAbortControllerSafe() {
  try {
    return typeof AbortController === "function" ? new AbortController() : null;
  } catch {
    return null;
  }
}

function abortControllerSafe(controller, reason) {
  if (!controller || typeof controller.abort !== "function") return;

  try {
    controller.abort(reason);
  } catch {
    try {
      controller.abort();
    } catch {}
  }
}

function isAbortLikeError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const name = String(error?.name || "").trim().toLowerCase();
  return (
    code === "TASK_ABORTED" ||
    code === "ERR_CANCELED" ||
    name === "aborterror" ||
    name === "cancelederror"
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

async function apiGet(url, params, timeout = 35000, options = {}) {
  const response = await axios.get(url, {
    timeout,
    params,
    signal: options?.signal || undefined,
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

async function resolveSearch(query) {
  const data = await apiGet(API_SEARCH_URL, { q: query, limit: 1 }, 25000);
  const first = data?.results?.[0];

  if (!first?.url) {
    throw new Error("No se encontró el video.");
  }

  return {
    videoUrl: first.url,
    title: safeFileName(first.title || "video"),
    thumbnail: first.thumbnail || null,
  };
}

async function requestVideoLink(videoUrl, endpointUrl, sourceLabel, options = {}) {
  const data = await apiGet(
    endpointUrl,
    {
      mode: "link",
      quality: VIDEO_QUALITY,
      url: videoUrl,
    },
    45000,
    options
  );

  const downloadUrl = normalizeApiUrl(pickApiDownloadUrl(data));
  if (!downloadUrl) {
    throw new Error(`La ruta ${sourceLabel} no devolvió enlace de descarga.`);
  }

  return {
    sourceLabel,
    downloadUrl,
    title: safeFileName(data?.title || data?.result?.title || "video"),
    fileName: normalizeMp4Name(
      data?.filename || data?.fileName || data?.result?.filename || "video.mp4"
    ),
  };
}

async function resolveFastestVideoLink(videoUrl) {
  const sources = [
    { endpointUrl: API_VIDEO_URL, sourceLabel: "principal" },
    { endpointUrl: API_VIDEO_LEGACY_URL, sourceLabel: "legacy" },
    { endpointUrl: API_VIDEO_ALT_URL, sourceLabel: "alterna" },
  ];
  const controllers = sources.map(() => createAbortControllerSafe());

  return await new Promise((resolve, reject) => {
    let settled = false;
    let pending = sources.length;
    const errors = [];

    const finishSuccess = (result, winnerIndex) => {
      if (settled) return;
      settled = true;

      controllers.forEach((controller, index) => {
        if (index === winnerIndex) return;
        abortControllerSafe(controller, new Error("download_link_race_lost"));
      });

      resolve(result);
    };

    const finishError = () => {
      if (settled) return;
      settled = true;

      const messages = errors
        .map((item) => String(item?.message || item || "").trim())
        .filter(Boolean);

      reject(
        new Error(
          messages[0] ||
            "No se pudo obtener un enlace de descarga desde las rutas internas."
        )
      );
    };

    sources.forEach((source, index) => {
      requestVideoLink(videoUrl, source.endpointUrl, source.sourceLabel, {
        signal: controllers[index]?.signal || null,
      })
        .then((result) => {
          if (settled) return;
          pending -= 1;
          finishSuccess(result, index);
        })
        .catch((error) => {
          if (settled) return;

          pending -= 1;

          if (!isAbortLikeError(error)) {
            errors.push(error);
          }

          if (pending === 0) {
            finishError();
          }
        });
    });
  });
}

async function resolveSearchCached(query) {
  const cacheKey = `ytsearch:${String(query || "").trim().toLowerCase()}`;
  const cached = getDownloadCache(cacheKey);
  if (cached?.videoUrl) return cached;

  return withInflightDedup(cacheKey, async () => {
    const result = await resolveSearch(query);
    setDownloadCache(cacheKey, result);
    return result;
  });
}

async function resolveFastestVideoLinkCached(videoUrl) {
  const cacheKey = `ytdlmp4:${String(videoUrl || "").trim()}`;
  const cached = getDownloadCache(cacheKey);
  if (cached?.downloadUrl) return cached;

  return withInflightDedup(cacheKey, async () => {
    const result = await resolveFastestVideoLink(videoUrl);
    setDownloadCache(cacheKey, result);
    return result;
  });
}

async function downloadVideoFromInternalLink(
  downloadUrl,
  outputPath,
  suggestedFileName = "video.mp4",
  options = {}
) {
  const signal = options?.signal || null;
  throwIfAborted(signal);

  let response;
  try {
    response = await axios.get(downloadUrl, {
      responseType: "stream",
      timeout: REQUEST_TIMEOUT,
      signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
        Accept: "*/*",
        Referer: `${API_BASE}/`,
      },
      validateStatus: () => true,
      maxRedirects: 5,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw buildAbortError(signal);
    }
    throw error;
  }

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
    throw new Error("Video demasiado grande");
  }

  let downloaded = 0;

  response.data.on("data", (chunk) => {
    downloaded += chunk.length;
    if (downloaded > MAX_VIDEO_BYTES) {
      response.data.destroy(new Error("Video demasiado grande"));
    }
  });

  const outputStream = fs.createWriteStream(outputPath);
  const releaseAbort = bindAbort(signal, () => {
    const abortError = buildAbortError(signal);
    response.data?.destroy?.(abortError);
    outputStream.destroy(abortError);
    deleteFileSafe(outputPath);
  });

  try {
    await pipeline(response.data, outputStream);
  } catch (error) {
    deleteFileSafe(outputPath);
    if (signal?.aborted) {
      throw buildAbortError(signal);
    }
    throw error;
  } finally {
    releaseAbort();
  }

  throwIfAborted(signal);

  if (!fs.existsSync(outputPath)) {
    throw new Error("No se pudo descargar el video.");
  }

  const size = fs.statSync(outputPath).size;

  if (!size || size < 150000) {
    throw new Error("Video inválido");
  }

  if (size > MAX_VIDEO_BYTES) {
    throw new Error("Video demasiado grande");
  }

  const fromHeader = parseContentDispositionFileName(response.headers?.["content-disposition"]);

  return {
    path: outputPath,
    size,
    fileName: fromHeader || suggestedFileName || path.basename(outputPath),
  };
}

async function downloadVideoFromApi(videoUrl, outputPath, options = {}) {
  const signal = options?.signal || null;
  throwIfAborted(signal);

  let response;
  try {
    response = await axios.get(API_VIDEO_URL, {
      responseType: "stream",
      timeout: REQUEST_TIMEOUT,
      signal,
      params: {
        mode: "file",
        quality: VIDEO_QUALITY,
        url: videoUrl,
      },
      validateStatus: () => true,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw buildAbortError(signal);
    }
    throw error;
  }

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
    throw new Error("Video demasiado grande");
  }

  let downloaded = 0;

  response.data.on("data", (chunk) => {
    downloaded += chunk.length;
    if (downloaded > MAX_VIDEO_BYTES) {
      response.data.destroy(new Error("Video demasiado grande"));
    }
  });

  const outputStream = fs.createWriteStream(outputPath);
  const releaseAbort = bindAbort(signal, () => {
    const abortError = buildAbortError(signal);
    response.data?.destroy?.(abortError);
    outputStream.destroy(abortError);
    deleteFileSafe(outputPath);
  });

  try {
    await pipeline(response.data, outputStream);
  } catch (error) {
    deleteFileSafe(outputPath);
    if (signal?.aborted) {
      throw buildAbortError(signal);
    }
    throw error;
  } finally {
    releaseAbort();
  }

  throwIfAborted(signal);

  if (!fs.existsSync(outputPath)) {
    throw new Error("No se pudo descargar el video.");
  }

  const size = fs.statSync(outputPath).size;

  if (!size || size < 150000) {
    throw new Error("Video invalido");
  }

  if (size > MAX_VIDEO_BYTES) {
    throw new Error("Video demasiado grande");
  }

  const fromHeader = parseContentDispositionFileName(response.headers?.["content-disposition"]);

  return {
    path: outputPath,
    size,
    fileName: fromHeader || path.basename(outputPath),
  };
}

async function normalizeVideoForWhatsApp(inputPath, outputPath, options = {}) {
  const signal = options?.signal || null;
  throwIfAborted(signal);

  return await new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-y",
        "-i",
        inputPath,
        "-c",
        "copy",
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

    let settled = false;
    const releaseAbort = bindAbort(signal, () => {
      deleteFileSafe(outputPath);
      try {
        ffmpeg.kill("SIGKILL");
      } catch {}
    });

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      releaseAbort();
      reject(signal?.aborted ? buildAbortError(signal) : error);
    };

    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      releaseAbort();
      resolve(value);
    };

    ffmpeg.on("error", (error) => {
      if (error?.code === "ENOENT") {
        finishResolve(false);
        return;
      }
      finishReject(error);
    });

    ffmpeg.on("close", (code) => {
      if (signal?.aborted) {
        finishReject(buildAbortError(signal));
        return;
      }

      if (code === 0) {
        finishResolve(true);
        return;
      }
      finishResolve(false);
    });
  });
}

async function sendVideoDirect(sock, from, quoted, { filePath, fileName, title }) {
  await sock.sendMessage(
    from,
    {
      video: { url: filePath },
      mimetype: "video/mp4",
      fileName,
      caption: `api dvyer\n\n🎬 ${title}\n🎚️ ${VIDEO_QUALITY}`,
      ...global.channelInfo,
    },
    quoted
  );
  return "video";
}

async function sendVideoDocument(sock, from, quoted, { filePath, fileName, title }) {
  await sock.sendMessage(
    from,
    {
      document: { url: filePath },
      mimetype: "video/mp4",
      fileName,
      caption: `api dvyer\n\n🎬 ${title}\n🎚️ ${VIDEO_QUALITY}\n📦 Enviado como documento`,
      ...global.channelInfo,
    },
    quoted
  );
  return "document";
}

async function sendVideoOrDocument(
  sock,
  from,
  quoted,
  { filePath, fileName, title, size, allowDocumentFallback = true }
) {
  if (size > VIDEO_AS_DOCUMENT_THRESHOLD) {
    return await sendVideoDocument(sock, from, quoted, {
      filePath,
      fileName,
      title,
    });
  }

  try {
    return await sendVideoDirect(sock, from, quoted, {
      filePath,
      fileName,
      title,
    });
  } catch (e1) {
    if (!allowDocumentFallback) {
      throw e1;
    }

    console.error("send local video failed:", e1?.message || e1);
    return await sendVideoDocument(sock, from, quoted, {
      filePath,
      fileName,
      title,
    });
  }
}

export default {
  command: ["ytmp4", "ytdlmp4"],
  category: "descarga",

  run: async (ctx) => {
    const { sock, from } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const abortSignal = ctx.abortSignal || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const userId = `${from}:video`;

    let rawVideoFile = null;
    let finalVideoFile = null;
    let downloadCharge = null;

    const until = cooldowns.get(userId);
    if (until && until > Date.now()) {
      return sock.sendMessage(from, {
        text: `⏳ Espera ${getCooldownRemaining(until)}s`,
        ...global.channelInfo,
      });
    }

    cooldowns.set(userId, Date.now() + COOLDOWN_TIME);

    try {
      const rawInput = resolveUserInput(ctx);

      if (!rawInput) {
        cooldowns.delete(userId);
        return sock.sendMessage(from, {
          text: "❌ Uso: .ytmp4 <nombre o link> o responde a un mensaje con el link",
          ...global.channelInfo,
        });
      }

      let videoUrl = extractYouTubeUrl(rawInput);
      let title = "video";
      let thumbnail = null;

      if (!videoUrl) {
        if (isHttpUrl(rawInput)) {
          cooldowns.delete(userId);
          return sock.sendMessage(from, {
            text: "❌ Envíame un link válido de YouTube.",
            ...global.channelInfo,
          });
        }

        const search = await resolveSearchCached(rawInput);
        videoUrl = search.videoUrl;
        title = search.title;
        thumbnail = search.thumbnail;
      }

      downloadCharge = await chargeDownloadRequest(ctx, {
        feature: "ytmp4",
        title,
        videoUrl,
      });
      if (!downloadCharge.ok) {
        cooldowns.delete(userId);
        return;
      }

      await sock.sendMessage(
        from,
        thumbnail
          ? {
              image: { url: thumbnail },
              caption: `⬇️ Preparando video...\n\n🎬 ${title}\n🎚️ Calidad: ${VIDEO_QUALITY}\n🌐 ${API_BASE}`,
              ...global.channelInfo,
            }
          : {
              text: `⬇️ Preparando video...\n\n🎬 ${title}\n🎚️ Calidad: ${VIDEO_QUALITY}\n🌐 ${API_BASE}`,
              ...global.channelInfo,
            },
        quoted
      );

      const stamp = Date.now();
      rawVideoFile = path.join(TMP_DIR, `${stamp}-raw.mp4`);
      finalVideoFile = path.join(TMP_DIR, `${stamp}-final.mp4`);

      let downloaded = null;
      throwIfAborted(abortSignal);

      try {
        const fastestLink = await resolveFastestVideoLinkCached(videoUrl);
        title = safeFileName(fastestLink.title || title || "video");

        console.log(
          `YTMP4 link ganador: ${fastestLink.sourceLabel} -> ${fastestLink.downloadUrl}`
        );

        downloaded = await downloadVideoFromInternalLink(
          fastestLink.downloadUrl,
          rawVideoFile,
          fastestLink.fileName || `${title}.mp4`,
          { signal: abortSignal }
        );
      } catch (linkError) {
        console.log(
          `YTMP4 link fallback: ${linkError?.message || linkError}`
        );
        downloaded = await downloadVideoFromApi(videoUrl, rawVideoFile, {
          signal: abortSignal,
        });
      }

      const finalTitle = safeFileName(
        stripExtension(downloaded.fileName || `${title}.mp4`) || title
      );
      const rawSendPath = downloaded.path || rawVideoFile;
      const rawSendSize = fs.existsSync(rawSendPath)
        ? fs.statSync(rawSendPath).size
        : downloaded.size;
      const normalizedFileName = normalizeMp4Name(downloaded.fileName || `${finalTitle}.mp4`);

      throwIfAborted(abortSignal);

      if (rawSendSize > VIDEO_AS_DOCUMENT_THRESHOLD) {
        await sendVideoDocument(sock, from, quoted, {
          filePath: rawSendPath,
          fileName: normalizedFileName,
          title: finalTitle,
        });
        return;
      }

      try {
        await sendVideoOrDocument(sock, from, quoted, {
          filePath: rawSendPath,
          fileName: normalizedFileName,
          title: finalTitle,
          size: rawSendSize,
          allowDocumentFallback: false,
        });
      } catch (sendRawError) {
        console.warn(
          "YTMP4 raw send fallback:",
          sendRawError?.message || sendRawError
        );

        const normalized = await normalizeVideoForWhatsApp(
          rawSendPath,
          finalVideoFile,
          { signal: abortSignal }
        );

        if (!normalized || !fs.existsSync(finalVideoFile)) {
          await sendVideoDocument(sock, from, quoted, {
            filePath: rawSendPath,
            fileName: normalizedFileName,
            title: finalTitle,
          });
          return;
        }

        const normalizedSize = fs.statSync(finalVideoFile).size;

        await sendVideoOrDocument(sock, from, quoted, {
          filePath: finalVideoFile,
          fileName: normalizedFileName,
          title: finalTitle,
          size: normalizedSize,
        });
      }
    } catch (err) {
      const aborted = abortSignal?.aborted === true;
      console.error("YTMP4 ERROR:", err?.message || err);
      refundDownloadCharge(ctx, downloadCharge, {
        feature: "ytmp4",
        error: String(err?.message || err || "unknown_error"),
      });
      cooldowns.delete(userId);

      if (aborted) {
        return;
      }

      await sock.sendMessage(from, {
        text: `❌ ${String(err?.message || "Error al procesar el video.")}`,
        ...global.channelInfo,
      });
    } finally {
      deleteFileSafe(rawVideoFile);
      deleteFileSafe(finalVideoFile);
    }
  },
};
