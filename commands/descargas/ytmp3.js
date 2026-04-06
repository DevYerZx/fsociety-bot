import fs from "fs";
import path from "path";
import axios from "axios";
import { pipeline } from "stream/promises";
import { spawn } from "child_process";
import { buildDvyerUrl, getDvyerBaseUrl } from "../../lib/api-manager.js";
import { bindAbort, buildAbortError, throwIfAborted } from "../../lib/command-abort.js";
import { getDownloadCache, setDownloadCache, withInflightDedup } from "../../lib/download-cache.js";
import { chargeDownloadRequest, refundDownloadCharge } from "../economia/download-access.js";

const API_AUDIO_PATH = "/ytmp3";
const API_AUDIO_LEGACY_PATH = "/ytmp3";
const API_AUDIO_ALT_PATH = "/ytaltmp3";
const API_SEARCH_PATH = "/ytsearch";
const API_BASE = getDvyerBaseUrl();
const API_AUDIO_URL = buildDvyerUrl(API_AUDIO_PATH);
const API_AUDIO_LEGACY_URL = buildDvyerUrl(API_AUDIO_LEGACY_PATH);
const API_AUDIO_ALT_URL = buildDvyerUrl(API_AUDIO_ALT_PATH);
const API_SEARCH_URL = buildDvyerUrl(API_SEARCH_PATH);
const AUDIO_SOURCES = [
  { endpointUrl: API_AUDIO_URL, sourceLabel: "principal" },
  { endpointUrl: API_AUDIO_ALT_URL, sourceLabel: "alterna" },
];

const COOLDOWN_TIME = 0;
const AUDIO_QUALITY = "128k";
const AUDIO_LINK_QUALITIES = ["128k", "48k"];
const LINK_FAST_ENABLED = true;
const AUDIO_MP3_PREFERRED_WAIT_MS = 1200;
const REQUEST_TIMEOUT = 120000;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const REQUEST_RETRY_ATTEMPTS = 3;
const REQUEST_RETRY_DELAY_MS = 900;
const TMP_DIR = path.join(process.cwd(), "tmp");

const cooldowns = new Map();

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function ensureTmpDir() {
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
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
    String(name || "audio")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "audio"
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

function normalizeAudioFileName(name, fallbackBase = "audio", fallbackExt = "mp3") {
  const parsed = path.parse(String(name || "").trim());
  const ext = String(parsed.ext || `.${fallbackExt}`).replace(/^\./, "").toLowerCase() || fallbackExt;
  const base = safeFileName(parsed.name || fallbackBase);
  return `${base}.${ext}`;
}

function detectAudioFromFile(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, buffer, 0, 16, 0);
    fs.closeSync(fd);

    const slice = buffer.subarray(0, bytesRead);

    if (slice.length >= 8 && slice.subarray(4, 8).toString("ascii") === "ftyp") {
      return { ext: "m4a", mimetype: "audio/mp4", isMp3: false };
    }

    if (slice.length >= 3 && slice.subarray(0, 3).toString("ascii") === "ID3") {
      return { ext: "mp3", mimetype: "audio/mpeg", isMp3: true };
    }

    if (slice.length >= 4 && slice[0] === 0x1a && slice[1] === 0x45 && slice[2] === 0xdf && slice[3] === 0xa3) {
      return { ext: "webm", mimetype: "audio/webm", isMp3: false };
    }

    if (slice.length >= 2 && slice[0] === 0xff && (slice[1] & 0xe0) === 0xe0) {
      return { ext: "mp3", mimetype: "audio/mpeg", isMp3: true };
    }
  } catch {}

  return null;
}

function buildAudioMeta(fileName, contentType, fallbackBase = "audio", sniffed = null) {
  const normalizedType = String(contentType || "").split(";")[0].trim().toLowerCase();
  const rawName = String(fileName || "").trim();
  const ext = path.extname(rawName).replace(/^\./, "").toLowerCase();

  if (sniffed?.ext) {
    return {
      fileName: normalizeAudioFileName(rawName, fallbackBase, sniffed.ext),
      mimetype: sniffed.mimetype,
      isMp3: sniffed.isMp3,
    };
  }

  let finalExt = ext || "bin";
  let mimetype = normalizedType || "application/octet-stream";

  if (ext === "mp3" || normalizedType.includes("audio/mpeg")) {
    finalExt = "mp3";
    mimetype = "audio/mpeg";
  } else if (ext === "m4a" || ext === "mp4" || normalizedType.includes("audio/mp4")) {
    finalExt = "m4a";
    mimetype = "audio/mp4";
  } else if (ext === "aac" || normalizedType.includes("audio/aac")) {
    finalExt = "aac";
    mimetype = "audio/aac";
  } else if (ext === "webm" || normalizedType.includes("audio/webm")) {
    finalExt = "webm";
    mimetype = "audio/webm";
  }

  return {
    fileName: normalizeAudioFileName(rawName, fallbackBase, finalExt),
    mimetype,
    isMp3: finalExt === "mp3",
  };
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function apiBaseLabel() {
  return getDvyerBaseUrl();
}

function normalizeApiUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return `${apiBaseLabel()}${value}`;
  return `${apiBaseLabel()}/${value}`;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeErrorText(error) {
  return String(error?.message || error || "").trim();
}

function shouldRetryDownloadError(error) {
  const text = normalizeErrorText(error).toLowerCase();
  if (!text) return false;

  return (
    text.includes("http 401") ||
    text.includes("unauthorized") ||
    text.includes("internal yt1s link error") ||
    text.includes("internal link error") ||
    text.includes("no se encontro un formato") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("socket hang up") ||
    text.includes("econnreset") ||
    text.includes("etimedout") ||
    text.includes("eai_again") ||
    text.includes("429") ||
    text.includes("too many requests") ||
    text.includes("temporarily unavailable") ||
    text.includes("service unavailable")
  );
}

async function withRetries(task, options = {}) {
  const attempts = Math.max(1, Number(options?.attempts || 1));
  const delayMs = Math.max(0, Number(options?.delayMs || 0));
  const signal = options?.signal || null;
  const label = String(options?.label || "retry-task");
  const logRetry = options?.logRetry !== false;
  const shouldRetry =
    typeof options?.shouldRetry === "function"
      ? options.shouldRetry
      : () => false;

  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(signal);

    try {
      return await task(attempt);
    } catch (error) {
      if (signal?.aborted) {
        throw buildAbortError(signal);
      }

      lastError = error;
      const canRetry = attempt < attempts && shouldRetry(error, attempt);
      if (!canRetry) {
        throw error;
      }

      if (logRetry) {
        console.log(
          `${label} reintento ${attempt}/${attempts}:`,
          error?.message || error
        );
      }

      const waitMs = delayMs * attempt;
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    }
  }

  throw lastError || new Error("Retry failed.");
}

function toFriendlyAudioError(error) {
  const raw = normalizeErrorText(error);
  const lower = raw.toLowerCase();

  if (
    lower.includes("http 401") ||
    lower.includes("unauthorized") ||
    lower.includes("internal yt1s link error") ||
    lower.includes("internal link error") ||
    lower.includes("no se encontro un formato")
  ) {
    return "No pude generar el enlace interno de audio tras 3 intentos. Intenta de nuevo en unos segundos.";
  }

  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("socket hang up") ||
    lower.includes("econnreset") ||
    lower.includes("eai_again")
  ) {
    return "El servidor de descarga tardo demasiado. Reintenta en unos segundos.";
  }

  return raw || "Error al procesar el audio.";
}

function toSafeYtmp3LogError(error) {
  const raw = normalizeErrorText(error);
  const lower = raw.toLowerCase();

  if (
    lower.includes("http 401") ||
    lower.includes("unauthorized") ||
    lower.includes("internal yt1s link error") ||
    lower.includes("internal link error") ||
    lower.includes("no se encontro un formato")
  ) {
    return "proveedor no disponible temporalmente";
  }

  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("socket hang up") ||
    lower.includes("econnreset") ||
    lower.includes("eai_again")
  ) {
    return "timeout de red";
  }

  if (lower.includes("audio demasiado grande")) {
    return "archivo demasiado grande";
  }

  if (lower.includes("audio inválido") || lower.includes("audio invalido")) {
    return "audio invalido";
  }

  return "error controlado";
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

function isLikelyMp3FileName(fileName) {
  return path.extname(String(fileName || "").trim()).toLowerCase() === ".mp3";
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
    throw new Error("No se encontró el audio.");
  }

  return {
    videoUrl: first.url,
    title: safeFileName(first.title || "audio"),
    thumbnail: first.thumbnail || null,
  };
}

async function requestAudioLink(videoUrl, endpointUrl, sourceLabel, options = {}) {
  const signal = options?.signal || null;
  const qualityCandidates = Array.from(
    new Set(
      [AUDIO_QUALITY, ...AUDIO_LINK_QUALITIES]
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );

  const { data, downloadUrl } = await withRetries(
    async () => {
      let lastQualityError = null;

      for (const quality of qualityCandidates) {
        try {
          const apiData = await apiGet(
            endpointUrl,
            {
              mode: "link",
              fast: LINK_FAST_ENABLED ? "true" : "false",
              quality,
              url: videoUrl,
            },
            45000,
            options
          );

          const resolvedUrl = normalizeApiUrl(pickApiDownloadUrl(apiData));
          if (!resolvedUrl) {
            throw new Error(
              `internal link error: no se encontro un formato audio disponible (${sourceLabel}:${quality})`
            );
          }

          return {
            data: apiData,
            downloadUrl: resolvedUrl,
          };
        } catch (error) {
          lastQualityError = error;
        }
      }

      throw (
        lastQualityError ||
        new Error(`internal link error: no se encontro un formato audio disponible (${sourceLabel})`)
      );
    },
    {
      attempts: REQUEST_RETRY_ATTEMPTS,
      delayMs: REQUEST_RETRY_DELAY_MS,
      signal,
      label: `ytmp3-link-${sourceLabel}`,
      logRetry: false,
      shouldRetry: shouldRetryDownloadError,
    }
  );

  return {
    sourceLabel,
    downloadUrl,
    title: safeFileName(data?.title || data?.result?.title || "audio"),
    fileName:
      String(data?.filename || data?.fileName || data?.result?.filename || "audio.bin").trim() ||
      "audio.bin",
  };
}

async function resolveFastestAudioLink(videoUrl) {
  const controllers = AUDIO_SOURCES.map(() => createAbortControllerSafe());

  return await new Promise((resolve, reject) => {
    let settled = false;
    let pending = AUDIO_SOURCES.length;
    let firstSuccess = null;
    let preferredTimer = null;
    const errors = [];

    const cleanupTimer = () => {
      if (!preferredTimer) return;
      clearTimeout(preferredTimer);
      preferredTimer = null;
    };

    const abortLosers = (winnerIndex) => {
      controllers.forEach((controller, index) => {
        if (index === winnerIndex) return;
        abortControllerSafe(controller, new Error("download_link_race_lost"));
      });
    };

    const finishSuccess = (result, winnerIndex) => {
      if (settled) return;
      settled = true;
      cleanupTimer();
      abortLosers(winnerIndex);
      resolve(result);
    };

    const finishError = () => {
      if (settled) return;
      settled = true;
      cleanupTimer();

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

    const maybeFinishWithFallback = () => {
      if (settled) return;
      if (firstSuccess) {
        finishSuccess(firstSuccess.result, firstSuccess.index);
        return;
      }
      if (pending === 0) {
        finishError();
      }
    };

    AUDIO_SOURCES.forEach((source, index) => {
      requestAudioLink(videoUrl, source.endpointUrl, source.sourceLabel, {
        signal: controllers[index]?.signal || null,
      })
        .then((result) => {
          if (settled) return;

          pending -= 1;

          if (isLikelyMp3FileName(result.fileName)) {
            finishSuccess(result, index);
            return;
          }

          if (!firstSuccess) {
            firstSuccess = { result, index };

            if (pending === 0) {
              maybeFinishWithFallback();
              return;
            }

            preferredTimer = setTimeout(() => {
              preferredTimer = null;
              maybeFinishWithFallback();
            }, AUDIO_MP3_PREFERRED_WAIT_MS);
            preferredTimer.unref?.();
            return;
          }

          if (pending === 0) {
            maybeFinishWithFallback();
          }
        })
        .catch((error) => {
          if (settled) return;

          pending -= 1;

          if (!isAbortLikeError(error)) {
            errors.push(error);
          }

          if (pending === 0) {
            maybeFinishWithFallback();
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

async function resolveFastestAudioLinkCached(videoUrl) {
  const cacheKey = `ytdlmp3:${String(videoUrl || "").trim()}`;
  return withInflightDedup(cacheKey, async () => {
    return await resolveFastestAudioLink(videoUrl);
  });
}

async function downloadAudioFromInternalLink(
  downloadUrl,
  outputPath,
  suggestedFileName = "audio.bin",
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
        parsed || { message: errorText || "Error al descargar el audio." },
        response.status
      )
    );
  }

  const contentLength = Number(response.headers?.["content-length"] || 0);
  if (contentLength && contentLength > MAX_AUDIO_BYTES) {
    throw new Error("Audio demasiado grande");
  }

  let downloaded = 0;

  response.data.on("data", (chunk) => {
    downloaded += chunk.length;
    if (downloaded > MAX_AUDIO_BYTES) {
      response.data.destroy(new Error("Audio demasiado grande"));
    }
  });

  ensureTmpDir();
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
    throw new Error("No se pudo descargar el audio.");
  }

  const size = fs.statSync(outputPath).size;

  if (!size || size < 100000) {
    throw new Error("Audio inválido");
  }

  if (size > MAX_AUDIO_BYTES) {
    throw new Error("Audio demasiado grande");
  }

  const detectedName = parseContentDispositionFileName(
    response.headers?.["content-disposition"]
  );
  const sniffed = detectAudioFromFile(outputPath);
  const audioMeta = buildAudioMeta(
    detectedName || suggestedFileName || path.basename(outputPath),
    response.headers?.["content-type"],
    "audio",
    sniffed
  );

  return {
    path: outputPath,
    size,
    fileName: audioMeta.fileName,
    mimetype: audioMeta.mimetype,
    isMp3: audioMeta.isMp3,
  };
}

async function downloadAudioFromApi(videoUrl, outputPath, options = {}) {
  const signal = options?.signal || null;
  const endpointUrl = String(options?.endpointUrl || API_AUDIO_URL).trim() || API_AUDIO_URL;
  throwIfAborted(signal);

  let response;
  try {
    response = await axios.get(endpointUrl, {
      responseType: "stream",
      timeout: REQUEST_TIMEOUT,
      signal,
      params: {
        mode: "file",
        quality: AUDIO_QUALITY,
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
        parsed || { message: errorText || "Error al descargar el audio." },
        response.status
      )
    );
  }

  const contentLength = Number(response.headers?.["content-length"] || 0);
  if (contentLength && contentLength > MAX_AUDIO_BYTES) {
    throw new Error("Audio demasiado grande");
  }

  let downloaded = 0;

  response.data.on("data", (chunk) => {
    downloaded += chunk.length;
    if (downloaded > MAX_AUDIO_BYTES) {
      response.data.destroy(new Error("Audio demasiado grande"));
    }
  });

  ensureTmpDir();
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
    throw new Error("No se pudo descargar el audio.");
  }

  const size = fs.statSync(outputPath).size;

  if (!size || size < 100000) {
    throw new Error("Audio inválido");
  }

  if (size > MAX_AUDIO_BYTES) {
    throw new Error("Audio demasiado grande");
  }

  const detectedName = parseContentDispositionFileName(
    response.headers?.["content-disposition"]
  );
  const sniffed = detectAudioFromFile(outputPath);
  const audioMeta = buildAudioMeta(
    detectedName || path.basename(outputPath),
    response.headers?.["content-type"],
    "audio",
    sniffed
  );

  return {
    path: outputPath,
    size,
    fileName: audioMeta.fileName,
    mimetype: audioMeta.mimetype,
    isMp3: audioMeta.isMp3,
  };
}

async function downloadAudioFromApiWithFallbacks(videoUrl, outputPath, options = {}) {
  const signal = options?.signal || null;
  const errors = [];

  for (const source of AUDIO_SOURCES) {
    try {
      const downloaded = await withRetries(
        async () => {
          deleteFileSafe(outputPath);

          return await downloadAudioFromApi(videoUrl, outputPath, {
            ...options,
            signal,
            endpointUrl: source.endpointUrl,
          });
        },
        {
          attempts: REQUEST_RETRY_ATTEMPTS,
          delayMs: REQUEST_RETRY_DELAY_MS,
          signal,
          label: `ytmp3-file-${source.sourceLabel}`,
          logRetry: false,
          shouldRetry: shouldRetryDownloadError,
        }
      );

      return {
        ...downloaded,
        sourceLabel: `${source.sourceLabel}:file`,
      };
    } catch (error) {
      if (signal?.aborted) {
        throw buildAbortError(signal);
      }

      console.log(
        `YTMP3 direct fallback ${source.sourceLabel}: ${toSafeYtmp3LogError(error)}`
      );
      errors.push(`${source.sourceLabel}: ${String(error?.message || error)}`);
    }
  }

  throw new Error(
    errors[0] || "No se pudo descargar el audio desde ninguna ruta directa."
  );
}

async function convertToMp3(inputPath, outputPath, options = {}) {
  const signal = options?.signal || null;
  throwIfAborted(signal);

  return await new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-y",
        "-i",
        inputPath,
        "-vn",
        "-c:a",
        "libmp3lame",
        "-b:a",
        AUDIO_QUALITY,
        "-ar",
        "44100",
        "-map_metadata",
        "-1",
        "-loglevel",
        "error",
        outputPath,
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
      }
    );

    let errorText = "";
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

    const finishResolve = () => {
      if (settled) return;
      settled = true;
      releaseAbort();
      resolve();
    };

    ffmpeg.stderr.on("data", (chunk) => {
      errorText += chunk.toString();
    });

    ffmpeg.on("error", (error) => {
      if (error?.code === "ENOENT") {
        finishReject(new Error("ffmpeg no está instalado en el hosting."));
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
        finishResolve();
        return;
      }
      finishReject(new Error(errorText.trim() || `ffmpeg salió con código ${code}`));
    });
  });
}

async function sendAudioFile(
  sock,
  from,
  quoted,
  { filePath, fileName, mimetype, title, forceDocument = false }
) {
  if (forceDocument || mimetype !== "audio/mpeg") {
    await sock.sendMessage(
      from,
      {
        document: { url: filePath },
        mimetype,
        fileName,
        caption: `api dvyer\n\n🎵 ${title}`,
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
        audio: { url: filePath },
        mimetype,
        ptt: false,
        fileName,
        ...global.channelInfo,
      },
      quoted
    );
    return "audio";
  } catch (e1) {
    console.log(`YTMP3 send audio fallback -> document: ${toSafeYtmp3LogError(e1)}`);

    await sock.sendMessage(
      from,
      {
        document: { url: filePath },
        mimetype,
        fileName,
        caption: `api dvyer\n\n🎵 ${title}`,
        ...global.channelInfo,
      },
      quoted
    );
    return "document";
  }
}

export default {
  command: ["ytmp3"],
  category: "descarga",

  run: async (ctx) => {
    const { sock, from } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const abortSignal = ctx.abortSignal || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const userId = `${from}:audio`;

    let sourceFile = null;
    let finalMp3 = null;
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
      const rawInput = resolveUserInput(ctx);

      if (!rawInput) {
        cooldowns.delete(userId);
        return sock.sendMessage(from, {
          text: "❌ Uso: .ytmp3 <nombre o link> o responde a un mensaje con el link",
          ...global.channelInfo,
        });
      }

      let videoUrl = extractYouTubeUrl(rawInput);
      let title = "audio";
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
        feature: "ytmp3",
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
              caption: `🎵 Preparando audio...\n\n🎧 ${title}\n🎚️ Calidad: ${AUDIO_QUALITY}\n🌐 ${API_BASE}`,
              ...global.channelInfo,
            }
          : {
              text: `🎵 Preparando audio...\n\n🎧 ${title}\n🎚️ Calidad: ${AUDIO_QUALITY}\n🌐 ${API_BASE}`,
              ...global.channelInfo,
            },
        quoted
      );

      const stamp = Date.now();
      ensureTmpDir();
      sourceFile = path.join(TMP_DIR, `${stamp}-source.bin`);
      finalMp3 = path.join(TMP_DIR, `${stamp}-audio.mp3`);

      const finalTitle = safeFileName(title || "audio");
      let downloadedAudio = null;
      throwIfAborted(abortSignal);

      try {
        const fastestLink = await resolveFastestAudioLinkCached(videoUrl);
        title = safeFileName(fastestLink.title || finalTitle || "audio");

        console.log(
          `YTMP3 link ganador: ${fastestLink.sourceLabel} -> ${fastestLink.downloadUrl}`
        );

        downloadedAudio = await downloadAudioFromInternalLink(
          fastestLink.downloadUrl,
          sourceFile,
          fastestLink.fileName || `${title}.bin`,
          { signal: abortSignal }
        );
      } catch (linkError) {
        console.log(`YTMP3 link fallback activado: ${toSafeYtmp3LogError(linkError)}`);
        downloadedAudio = await downloadAudioFromApiWithFallbacks(videoUrl, sourceFile, {
          signal: abortSignal,
        });
      }

      let filePathToSend = downloadedAudio.path;
      let fileNameToSend = downloadedAudio.fileName;
      let mimeToSend = downloadedAudio.mimetype;
      let forceDocument = false;

      if (!downloadedAudio.isMp3) {
        try {
          await convertToMp3(sourceFile, finalMp3, { signal: abortSignal });
          filePathToSend = finalMp3;
          fileNameToSend = `${title}.mp3`;
          mimeToSend = "audio/mpeg";
        } catch (convertError) {
          console.log(`YTMP3 conversion fallback: ${toSafeYtmp3LogError(convertError)}`);
          forceDocument = true;
        }
      }

      throwIfAborted(abortSignal);
      await sendAudioFile(sock, from, quoted, {
        filePath: filePathToSend,
        fileName: fileNameToSend,
        mimetype: mimeToSend,
        title,
        forceDocument,
      });
    } catch (err) {
      const aborted = abortSignal?.aborted === true;
      console.log(`YTMP3 fallo controlado: ${toSafeYtmp3LogError(err)}`);
      refundDownloadCharge(ctx, downloadCharge, {
        feature: "ytmp3",
        error: String(err?.message || err || "unknown_error"),
      });
      cooldowns.delete(userId);

      if (aborted) {
        return;
      }

      await sock.sendMessage(from, {
        text: `❌ ${toFriendlyAudioError(err)}`,
        ...global.channelInfo,
      });
    } finally {
      deleteFileSafe(sourceFile);
      deleteFileSafe(finalMp3);
    }
  },
};
