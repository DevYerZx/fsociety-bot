import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import { pipeline } from "stream/promises";

import {
  appendDvyerApiKeyToUrl,
  getDvyerBaseUrl,
  withDvyerApiKey,
  withDvyerApiKeyHeader,
} from "../../lib/api-manager.js";

import {
  chargeDownloadRequest,
  refundDownloadCharge,
} from "../economia/download-access.js";
import { sanitizeProviderMessage } from "./_errorMessages.js";
import {
  buildDownloadCard,
  buildSectionFallbackText,
  buildSelectorCaption,
  buildSelectorPayload,
  buildUsageCard,
  downloadFirstValidImageBuffer,
} from "./_downloadUi.js";

const REQUEST_TIMEOUT = 15 * 60 * 1000;
const SEARCH_TIMEOUT = 45_000;
const MAX_FILE_BYTES = 800 * 1024 * 1024;
const APKMOD_MAX_FILE_BYTES = 1500 * 1024 * 1024;
const MIN_FILE_BYTES = 20_000;
const TMP_ROOT = path.join(os.tmpdir(), "dvyer-app-downloads");
const COOLDOWN_TIME = 0;
const PICKER_CACHE_TTL_MS = 10 * 60 * 1000;

const cooldowns = new Map();
const pickerCache = new Map();

const COMMAND_CONFIG = {
  apk: {
    key: "apk",
    name: "APK",
    primaryCommand: "apk",
    aliases: ["apk", "app"],
    searchPath: "/apksearch",
    downloadPath: "/apkdl",
    defaultQuery: "freefire",
    defaultExtension: "apk",
    footer: "Descargas Android",
    subtitle: "Selecciona tu app",
    sectionTitle: "Resultados Android",
    pickerTitle: "📦 Elegir app",
    rowLabel: "📦 Android",
    usage: "Uso: .apk <nombre o URL directa de app Android>",
    preparing: "Preparando app Android...",
    selectionText: "Selecciona la app Android que quieres descargar.",
    tooLargeLabel: "app Android",
  },

  apkmod: {
    key: "apkmod",
    name: "APK MOD",
    primaryCommand: "apkmod",
    aliases: ["apkmod", "modapk", "apkmoddl"],
    downloadPath: "/apkmod",
    defaultQuery: "spotify",
    defaultExtension: "apk",
    footer: "Descargas Android MOD",
    subtitle: "Descarga app MOD",
    sectionTitle: "Resultados APK MOD",
    pickerTitle: "📦 Elegir MOD",
    rowLabel: "📦 APK MOD",
    usage: "Uso: .apkmod <nombre o URL directa de app MOD>\nEjemplo: .apkmod spotify\nOpcional: .apkmod --pick=2 spotify",
    preparing: "Preparando app MOD...",
    selectionText: "Selecciona la app MOD que quieres descargar.",
    tooLargeLabel: "APK MOD",
    maxFileBytes: APKMOD_MAX_FILE_BYTES,
    resolvePickerFromDownloadPicks: true,
    syntheticSearchPicks: 10,
    hidePackageName: true,
    fetchPageImage: true,
    previewBeforeSend: true,
    featuredLead: "🔓 Versiones MOD verificadas con datos reales",
    selectionText: "Selecciona la versión MOD que quieres descargar.",
    sectionTitle: "Resultados APK MOD verificados",
    pickerTitle: "📦 Elegir APK MOD",
    usageSummary: [
      "Busca MODs Android con selector visual.",
      "Muestra versión, tamaño, requisitos y fuente antes de descargar.",
    ],
  },

  windows: {
    key: "windows",
    name: "Windows",
    primaryCommand: "windows",
    aliases: ["windows", "win", "window"],
    searchPath: "/winsearch",
    downloadPath: "/windl",
    defaultQuery: "vlc",
    defaultExtension: "exe",
    footer: "Descargas Windows",
    subtitle: "Selecciona tu programa",
    sectionTitle: "Resultados Windows",
    pickerTitle: "🪟 Elegir programa",
    rowLabel: "🪟 Windows",
    usage: "Uso: .windows <nombre o URL directa de programa Windows>",
    preparing: "Preparando programa Windows...",
    selectionText: "Selecciona el programa de Windows que quieres descargar.",
    tooLargeLabel: "programa Windows",
  },

  mac: {
    key: "mac",
    name: "Mac",
    primaryCommand: "mac",
    aliases: ["mac", "macos"],
    searchPath: "/macsearch",
    downloadPath: "/macdl",
    defaultQuery: "vlc",
    defaultExtension: "dmg",
    footer: "Descargas Mac",
    subtitle: "Selecciona tu programa",
    sectionTitle: "Resultados Mac",
    pickerTitle: "🍎 Elegir programa",
    rowLabel: "🍎 Mac",
    usage: "Uso: .mac <nombre o URL directa de programa Mac>",
    preparing: "Preparando programa Mac...",
    selectionText: "Selecciona el programa de Mac que quieres descargar.",
    tooLargeLabel: "programa Mac",
  },
};

ensureTmpRoot();

function ensureTmpRoot() {
  try {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
  } catch {}
}

function getCommandConfig(kind) {
  const key = String(kind || "").trim().toLowerCase();
  return COMMAND_CONFIG[key] || COMMAND_CONFIG.apk;
}

function apiBaseLabel() {
  const configured = String(getDvyerBaseUrl() || "https://dv-yer-api.online")
    .trim()
    .replace(/\/+$/, "");

  // ✅ Para tu endpoint real:
  // https://dv-yer-api.online/apkdl?mode=link&q=freefire&pick=1&prefer=auto&lang=es&apikey=...
  return configured || "https://dv-yer-api.online";
}

function buildApiUrl(endpoint = "") {
  const base = apiBaseLabel();
  const suffix = String(endpoint || "").trim();

  if (!suffix) return base;
  if (/^https?:\/\//i.test(suffix)) return suffix;
  if (suffix.startsWith("/")) return `${base}${suffix}`;

  return `${base}/${suffix}`;
}

function normalizeApiUrl(url) {
  const value = String(url || "").trim();

  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return `${apiBaseLabel()}${value}`;

  return `${apiBaseLabel()}/${value}`;
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

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipText(value = "", max = 72) {
  const normalized = cleanText(value);

  if (normalized.length <= max) return normalized;

  return `${normalized.slice(0, Math.max(1, max - 3))}...`;
}

function safeFileName(name) {
  return (
    String(name || "file")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "file"
  );
}

function normalizeDownloadFileName(name, fallbackBase = "file", fallbackExt = "bin") {
  const parsed = path.parse(String(name || "").trim());

  const ext =
    String(parsed.ext || `.${fallbackExt}`)
      .replace(/^\./, "")
      .toLowerCase() || fallbackExt;

  const base = safeFileName(parsed.name || fallbackBase);

  return `${base}.${ext}`;
}

function pickImageUrl(data) {
  return (
    data?.icon ||
    data?.image ||
    data?.image_url ||
    data?.image_url_full ||
    data?.thumbnail ||
    data?.thumb ||
    data?.selected?.icon ||
    data?.selected?.image ||
    data?.selected?.image_url ||
    data?.selected?.thumbnail ||
    ""
  );
}

function pickSourcePageUrl(data) {
  return (
    data?.app_url ||
    data?.download_page_url ||
    data?.selected?.app_url ||
    data?.selected?.download_page_url ||
    data?.page_url ||
    ""
  );
}

function improveImageUrlQuality(url = "") {
  const value = String(url || "").trim();
  if (!value) return "";

  return value
    .replace(/-\d+x\d+(?=\.(?:jpe?g|png|webp)(?:[?#]|$))/i, "")
    .replace(/\/\d+x\d+(bb|cc)?\.(jpg|jpeg|png|webp)(?=([?#]|$))/i, "/1200x1200$1.$2");
}

function extractMetaImage(html = "", baseUrl = "") {
  const text = String(html || "");
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["'][^>]*>/i,
    /<link[^>]+rel=["'][^"']*preload[^"']*["'][^>]+as=["']image["'][^>]+href=["']([^"']+)["'][^>]*>/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*preload[^"']*["'][^>]+as=["']image["'][^>]*>/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;

    try {
      return improveImageUrlQuality(new URL(match[1], baseUrl).toString());
    } catch {
      return improveImageUrlQuality(String(match[1] || "").trim());
    }
  }

  return "";
}

async function fetchPageImageUrl(pageUrl) {
  const url = String(pageUrl || "").trim();
  if (!/^https?:\/\//i.test(url)) return "";

  try {
    const response = await axios.get(url, {
      timeout: 12_000,
      headers: {
        Accept: "text/html,*/*",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
      },
      validateStatus: () => true,
    });

    if (response.status >= 400 || !response.data) return "";
    return extractMetaImage(response.data, url);
  } catch {
    return "";
  }
}

function mimeFromFileName(fileName) {
  const lower = String(fileName || "").toLowerCase();

  if (lower.endsWith(".xapk")) return "application/xapk-package-archive";
  if (lower.endsWith(".apk")) return "application/vnd.android.package-archive";
  if (lower.endsWith(".exe")) return "application/vnd.microsoft.portable-executable";
  if (lower.endsWith(".msi")) return "application/x-msi";
  if (lower.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (lower.endsWith(".pkg")) return "application/octet-stream";
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".7z")) return "application/x-7z-compressed";
  if (lower.endsWith(".rar")) return "application/vnd.rar";

  return "application/octet-stream";
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

function parseHumanSizeToBytes(value = "") {
  const text = cleanText(String(value || "").replace(",", "."));
  if (!text) return null;

  const match = text.match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if (!match?.[1] || !match?.[2]) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const units = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };

  const multiplier = units[String(match[2]).toUpperCase()] || 1;
  return Math.round(amount * multiplier);
}

function uniqueList(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values]).map((value) => cleanText(value)).filter(Boolean))];
}

function prunePickerCache() {
  const now = Date.now();

  for (const [key, entry] of pickerCache.entries()) {
    if (!entry || Number(entry.expiresAt || 0) <= now) {
      pickerCache.delete(key);
    }
  }
}

function buildPickerCacheKey(userId, config, query) {
  return `${config.key}:${cleanText(userId).toLowerCase()}:${cleanText(query).toLowerCase()}`;
}

function storePickerResults(userId, config, query, results = []) {
  if (!config.resolvePickerFromDownloadPicks) return;

  prunePickerCache();
  pickerCache.set(buildPickerCacheKey(userId, config, query), {
    expiresAt: Date.now() + PICKER_CACHE_TTL_MS,
    results,
  });
}

function getCachedPickerResult(userId, config, query, pick) {
  if (!config.resolvePickerFromDownloadPicks) return null;

  prunePickerCache();
  const entry = pickerCache.get(buildPickerCacheKey(userId, config, query));
  if (!entry?.results?.length) return null;

  return (
    entry.results.find((item) => Number(item?.pick || 0) === Number(pick || 0)) || null
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

function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }

  return String(settings?.prefix || ".").trim() || ".";
}

function getCooldownRemaining(untilMs) {
  return Math.max(0, Math.ceil((untilMs - Date.now()) / 1000));
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function resolveCommandSocket(ctx = {}) {
  const candidates = [ctx?.sock, ctx?.conn, ctx?.client];

  return (
    candidates.find(
      (entry) => entry && typeof entry.sendMessage === "function"
    ) || null
  );
}

function resolveTargetJid(ctx = {}) {
  return String(ctx?.from || ctx?.chat || ctx?.m?.from || ctx?.msg?.from || "").trim();
}

async function safeSendMessage(sock, from, payload, quoted, options = {}) {
  const label = cleanText(options?.label || "command");
  const throwOnUnavailable = options?.throwOnUnavailable === true;

  if (!sock || typeof sock.sendMessage !== "function" || !from) {
    const error = new Error("La conexión del bot no está disponible ahora.");
    console.warn(`[${label || "command"}]`, error.message);

    if (throwOnUnavailable) throw error;
    return false;
  }

  try {
    await sock.sendMessage(from, payload, quoted);
    return true;
  } catch (error) {
    console.error(`[${label || "command"}] sendMessage error:`, error?.message || error);

    if (throwOnUnavailable) throw error;
    return false;
  }
}

async function reactToMessage(sock, msg, emoji) {
  try {
    if (!sock || typeof sock.sendMessage !== "function" || !msg?.key) return false;
    await sock.sendMessage(msg.key.remoteJid, {
      react: {
        text: emoji,
        key: msg.key,
      },
    });
    return true;
  } catch {
    return false;
  }
}

function parseSelectionInput(value) {
  const raw = cleanText(value);

  const patterns = [
    /^--pick=(\d+)\s+(.+)$/i,
    /^pick[:=](\d+)\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match) continue;

    return {
      pick: Math.max(1, Math.min(10, Number(match[1] || 1))),
      target: cleanText(match[2] || ""),
      explicitPick: true,
    };
  }

  return {
    pick: 1,
    target: raw,
    explicitPick: false,
  };
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

async function apiGet(url, params, timeout = SEARCH_TIMEOUT) {
  const response = await axios.get(url, {
    timeout,
    params: withDvyerApiKey(params),
    headers: withDvyerApiKeyHeader({
      Accept: "application/json,text/plain,*/*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
      Referer: `${apiBaseLabel()}/`,
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

async function downloadThumbnailBuffer(url) {
  return downloadFirstValidImageBuffer([url], {
    timeout: 15_000,
    minBytes: 2_000,
  });
}

async function requestSearchResults(input, config) {
  if (!config.searchPath && !config.resolvePickerFromDownloadPicks) {
    throw new Error(`La búsqueda previa no está disponible para ${config.name}.`);
  }

  if (config.resolvePickerFromDownloadPicks) {
    return requestDownloadPickerResults(input, config);
  }

  const data = await apiGet(
    buildApiUrl(config.searchPath),
    {
      q: input,
      limit: 10,
      lang: "es",
    },
    SEARCH_TIMEOUT
  );

  const results = Array.isArray(data?.results) ? data.results.slice(0, 10) : [];

  if (!results.length) {
    throw new Error(`No encontré resultados de ${config.name}.`);
  }

  return results;
}

async function requestDownloadPickerResults(input, config) {
  const maxPicks = Math.max(1, Math.min(10, Number(config.syntheticSearchPicks || 10)));
  const requests = Array.from({ length: maxPicks }, (_, index) => {
    const pick = index + 1;
    return requestDownloadMeta(input, config, { pick, includeDownloadUrl: false })
      .then((item) => ({ ...item, pick }))
      .catch(() => null);
  });

  const settled = await Promise.all(requests);
  const seen = new Set();
  const results = [];

  for (const item of settled) {
    if (!item?.title) continue;

    const key = cleanText(`${item.title}:${item.version || ""}:${item.format || ""}`).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    results.push(item);
  }

  if (!results.length) {
    throw new Error(`No encontré resultados de ${config.name}.`);
  }

  return results;
}

async function requestDownloadMeta(input, config, options = {}) {
  const params = {
    mode: "link",
    lang: "es",
    prefer: "auto",
    pick: Math.max(1, Math.min(10, Number(options?.pick || 1))),
  };

  if (isHttpUrl(input)) {
    params.url = input;
  } else {
    params.q = input;
  }

  const data = await apiGet(buildApiUrl(config.downloadPath), params, SEARCH_TIMEOUT);
  const rawDownloadUrl = pickApiDownloadUrl(data);
  const downloadUrl = normalizeApiUrl(rawDownloadUrl);

  if (!downloadUrl && options?.includeDownloadUrl !== false) {
    throw new Error("La API no devolvió enlace interno de descarga.");
  }

  const inferredExt =
    String(data?.format || data?.download_type || config.defaultExtension)
      .trim()
      .toLowerCase() || config.defaultExtension;

  const sourcePageUrl = pickSourcePageUrl(data);
  const rawIcon = improveImageUrlQuality(normalizeApiUrl(pickImageUrl(data)));
  const icon = rawIcon || (config.fetchPageImage ? await fetchPageImageUrl(sourcePageUrl) : "");
  const sizeBytes =
    Number(data?.size_bytes || data?.content_length || data?.filesize_bytes || 0) ||
    parseHumanSizeToBytes(data?.filesize || data?.size || data?.filesize_label || "") ||
    null;
  const sizeLabel =
    cleanText(data?.filesize || data?.size || data?.filesize_label || "") ||
    humanBytes(sizeBytes) ||
    null;
  const developer = cleanText(data?.developer || data?.author || data?.publisher || "");
  const requirements = cleanText(data?.requirements || data?.minimum_requirements || "");
  const publishedAt = cleanText(data?.published_at || data?.updated_at || data?.update_date || "");
  const deliveryMode = cleanText(
    data?.request?.resilience?.delivery_mode ||
    (data?.mediafire_resolved === true ? "mediafire_api_stream" : "")
  );
  const fallbackUsed = data?.request?.resilience?.fallback_used === true;
  const downloadCandidates = uniqueList([
    downloadUrl,
    data?.download_url_full,
    data?.stream_url_full,
    data?.download_url,
    data?.stream_url,
    ...(Array.isArray(data?.download_options)
      ? data.download_options.flatMap((option) => [
          option?.download_url,
          option?.download_url_full,
          option?.url,
        ])
      : []),
  ]).map(normalizeApiUrl);

  return {
    title: safeFileName(data?.title || data?.package_name || `${config.name} File`),
    fileName: normalizeDownloadFileName(
      data?.filename || `${config.key}-download.${inferredExt}`,
      data?.title || `${config.name} File`,
      inferredExt
    ),
    version: String(data?.version || "").trim() || null,
    format: inferredExt,
    icon: icon || null,
    description: cleanText(data?.description || "") || null,
    sizeBytes,
    sizeLabel,
    downloadUrl,
    downloadCandidates,
    packageName: config.hidePackageName
      ? null
      : String(data?.package_name || data?.selected?.slug || "").trim() || null,
    sourcePageUrl,
    developer: developer || null,
    requirements: requirements || null,
    publishedAt: publishedAt || null,
    category: cleanText(data?.category || "") || null,
    deliveryMode: deliveryMode || null,
    fallbackUsed,
    mediafireResolved: data?.mediafire_resolved === true,
    pick: Math.max(1, Math.min(10, Number(options?.pick || 1))),
  };
}

async function downloadAbsoluteFile(downloadUrl, outputPath, maxFileBytes = MAX_FILE_BYTES) {
  const finalUrl = appendDvyerApiKeyToUrl(downloadUrl);

  const response = await axios.get(finalUrl, {
    responseType: "stream",
    timeout: REQUEST_TIMEOUT,
    maxRedirects: 5,
    headers: withDvyerApiKeyHeader({
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
      Accept: "*/*",
      Referer: `${apiBaseLabel()}/`,
    }),
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
        parsed || { message: errorText || "No se pudo descargar el archivo." },
        response.status
      )
    );
  }

  const contentLength = Number(response.headers?.["content-length"] || 0);

  if (contentLength && contentLength > maxFileBytes) {
    throw new Error("El archivo es demasiado grande para enviarlo por WhatsApp.");
  }

  let downloaded = 0;

  response.data.on("data", (chunk) => {
    downloaded += chunk.length;

    if (downloaded > maxFileBytes) {
      response.data.destroy(
        new Error("El archivo es demasiado grande para enviarlo por WhatsApp.")
      );
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

  if (!size || size < MIN_FILE_BYTES) {
    deleteFileSafe(outputPath);
    throw new Error("El archivo descargado es inválido.");
  }

  if (size > maxFileBytes) {
    deleteFileSafe(outputPath);
    throw new Error("El archivo es demasiado grande para enviarlo por WhatsApp.");
  }

  return {
    tempPath: outputPath,
    size,
    fileName:
      parseContentDispositionFileName(response.headers?.["content-disposition"]) ||
      path.basename(outputPath),
  };
}

async function downloadAbsoluteFileWithFallbacks(downloadCandidates, outputPath, maxFileBytes) {
  const candidates = uniqueList(downloadCandidates).map(normalizeApiUrl).filter(Boolean);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      return await downloadAbsoluteFile(candidate, outputPath, maxFileBytes);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("No se pudo descargar el archivo.");
}

function buildAppMetaLines(info = {}, config = {}, sizeOverride = null) {
  const lines = [];

  if (info.version) lines.push(`🧩 Versión: *${info.version}*`);
  if (!config.hidePackageName && info.packageName) lines.push(`📛 Paquete: *${info.packageName}*`);
  if (info.format) lines.push(`📁 Formato: *${String(info.format).toUpperCase()}*`);

  const sizeText = humanBytes(sizeOverride || info.sizeBytes) || info.sizeLabel || null;
  if (sizeText) lines.push(`📦 Tamaño: *${sizeText}*`);

  if (config.key === "apkmod") {
    if (info.requirements) lines.push(`🤖 Requisitos: *${clipText(info.requirements, 44)}*`);
    if (info.developer) lines.push(`🏷️ Dev: *${clipText(info.developer, 40)}*`);
    if (info.publishedAt) lines.push(`🗓️ Actualizado: *${clipText(info.publishedAt, 34)}*`);

    const sourceLabel = info.deliveryMode
      ? clipText(String(info.deliveryMode).replace(/_/g, " "), 34)
      : info.mediafireResolved
        ? "mediafire resuelto"
        : "";

    if (sourceLabel) lines.push(`🚚 Fuente: *${sourceLabel}*`);
    if (info.fallbackUsed) lines.push("🛟 Respaldo: *Sí*");
  }

  return lines;
}

function buildPickerRowDescription(result = {}, config = {}) {
  if (config.key === "apkmod") {
    return clipText(
      [
        result.version ? `v${result.version}` : null,
        result.requirements || null,
        humanBytes(result.sizeBytes) || result.sizeLabel || null,
      ]
        .filter(Boolean)
        .join(" | "),
      72
    );
  }

  return clipText(
    `${config.rowLabel} | ${String(
      result.format || config.defaultExtension
    ).toUpperCase()} | ${result.version || "Sin versión"}${
      humanBytes(result.filesize_bytes || result.size_bytes || result.sizeBytes)
        ? ` | ${humanBytes(result.filesize_bytes || result.size_bytes || result.sizeBytes)}`
        : ""
    }`,
    72
  );
}

function buildPreviewCaption(info, config) {
  const summaryLines = [`${config.rowLabel} *${info.title || `${config.name} File`}*`];
  summaryLines.push(...buildAppMetaLines(info, config));

  return buildDownloadCard("📦 *FSOCIETY DOWNLOAD*", [
    { lines: summaryLines },
    info.description
      ? {
          title: "DETALLE",
          lines: [clipText(info.description, 260)],
        }
      : null,
  ]);
}

async function sendPreviewCard(sock, from, quoted, info, config) {
  const caption = buildPreviewCaption(info, config);

  if (info.icon) {
    await safeSendMessage(
      sock,
      from,
      {
        image: { url: info.icon },
        caption,
        ...global.channelInfo,
      },
      quoted,
      { label: `${config.key}:preview`, throwOnUnavailable: true }
    );

    return;
  }

  await safeSendMessage(
    sock,
    from,
    {
      text: caption,
      ...global.channelInfo,
    },
    quoted,
    { label: `${config.key}:preview`, throwOnUnavailable: true }
  );
}

async function sendSearchPicker(ctx, query, results, config) {
  const { sock, from, quoted, settings } = ctx;
  const prefix = getPrefix(settings);

  const rows = results.map((result, index) => ({
    header: `${index + 1}`,
    title: clipText(result.title || "Sin título", 72),
    description: buildPickerRowDescription(result, config),
    id: `${prefix}${config.primaryCommand} --pick=${Number(result.pick || index + 1)} ${query}`,
  }));

  let thumbBuffer = null;

  try {
    thumbBuffer = await downloadThumbnailBuffer(results[0]?.icon);
  } catch (error) {
    console.error(`${config.key.toUpperCase()} thumb search error:`, error?.message || error);
  }

  const caption =
    buildSelectorCaption({
      title: `${config.rowLabel} *FSOCIETY DOWNLOAD*`,
      query,
      lead: config.featuredLead || `📱 ${config.name} con resultados listos para descargar`,
      featuredTitle: results[0]?.title || "Sin título",
      featuredLines: buildAppMetaLines(results[0], config).slice(0, 4),
      actionLines: [config.selectionText],
    });

  const sections = [
    {
      title: config.sectionTitle,
      rows,
    },
  ];

  const interactivePayload = buildSelectorPayload({
    imageBuffer: thumbBuffer,
    caption,
    title: "📦 FSOCIETY DOWNLOAD",
    subtitle: config.subtitle,
    footer: config.footer,
    selectorTitle: config.pickerTitle,
    sections,
  });

  try {
    await safeSendMessage(sock, from, interactivePayload, quoted, {
      label: `${config.key}:picker`,
      throwOnUnavailable: true,
    });
  } catch (error) {
    console.error(`${config.key.toUpperCase()} interactive search failed:`, error?.message || error);

    if (thumbBuffer) {
      try {
        await safeSendMessage(
          sock,
          from,
          {
            image: thumbBuffer,
            caption,
            ...global.channelInfo,
          },
          quoted,
          { label: `${config.key}:image-fallback` }
        );
      } catch {}
    }

    await safeSendMessage(
      sock,
      from,
      {
        text: buildSectionFallbackText(caption, sections),
        ...global.channelInfo,
      },
      quoted,
      { label: `${config.key}:picker-fallback` }
    );
  }
}

async function sendFileDocument(sock, from, quoted, info, filePath, fileName, size, config = {}) {
  const extra = buildAppMetaLines(info, config, size).map((line) =>
    String(line).replace(/\*/g, "")
  );

  const caption =
    buildDownloadCard("✅ *DESCARGA LISTA*", [
      {
        lines: [
          `📌 ${info.title}`,
          ...extra,
        ],
      },
    ]);

  await safeSendMessage(
    sock,
    from,
    {
      document: { url: filePath },
      mimetype: mimeFromFileName(fileName),
      fileName,
      caption,
      ...global.channelInfo,
    },
    quoted,
    { label: "file-document", throwOnUnavailable: true }
  );
}

async function sendLargeFileLink(sock, from, quoted, info, config) {
  const sizeText = humanBytes(info.sizeBytes);

  await safeSendMessage(
    sock,
    from,
    {
      text: buildDownloadCard("⚠️ *ARCHIVO GRANDE*", [
        {
          lines: [
            `El ${config.tooLargeLabel} supera el límite de envío directo.`,
            sizeText ? `Tamaño: *${sizeText}*` : null,
          ].filter(Boolean),
        },
        {
          title: "SEGURIDAD",
          lines: ["No envío el enlace con API key por seguridad."],
        },
      ]),
      ...global.channelInfo,
    },
    quoted,
    { label: `${config.key}:large-link`, throwOnUnavailable: true }
  );
}

export function buildDvyerAppCommand(kind) {
  const config = getCommandConfig(kind);

  const commandNames = Array.isArray(config.aliases)
    ? config.aliases
    : [config.primaryCommand];

  return {
    name: config.primaryCommand,
    command: commandNames,
    category: "descarga",
    description: `Busca y descarga ${config.name}.`,

    run: async (ctx) => {
      const sock = resolveCommandSocket(ctx);
      const from = resolveTargetJid(ctx);
      const settings = ctx?.settings;
      const msg = ctx.m || ctx.msg || null;
      const quoted = msg?.key ? { quoted: msg } : undefined;
      const userId = `${from || ctx?.botId || "unknown"}:${config.key}`;

      const runtimeCtx = {
        ...ctx,
        sock,
        from,
      };
      const maxFileBytes = Number(config.maxFileBytes || MAX_FILE_BYTES) || MAX_FILE_BYTES;

      let tempPath = null;
      let downloadCharge = null;
      let downloadInfo = null;

      try {
        if (!sock || !from) {
          console.warn(`${config.key.toUpperCase()} skipped: socket o chat no disponible.`);
          return null;
        }

        if (COOLDOWN_TIME > 0) {
          const until = cooldowns.get(userId);

          if (until && until > Date.now()) {
            return await safeSendMessage(
              sock,
              from,
              {
                text: `⏳ Espera ${getCooldownRemaining(until)}s`,
                ...global.channelInfo,
              },
              quoted,
              { label: `${config.key}:cooldown`, throwOnUnavailable: true }
            );
          }

          cooldowns.set(userId, Date.now() + COOLDOWN_TIME);
        }

        const parsedInput = parseSelectionInput(resolveUserInput(ctx));
        const userInput = parsedInput.target;

        if (!userInput) {
          cooldowns.delete(userId);

          return await safeSendMessage(
            sock,
            from,
            {
              text: buildUsageCard({
                title: `${config.rowLabel} *${config.name}*`,
                summary: Array.isArray(config.usageSummary) && config.usageSummary.length
                  ? config.usageSummary
                  : [
                      `Selector visual para ${config.name.toLowerCase()}.`,
                      "Puedes buscar por nombre o pegar un enlace directo.",
                    ],
                examples: config.usage.split("\n"),
                footer: "Si escribes solo el nombre, te mostraré opciones para escoger.",
              }),
              ...global.channelInfo,
            },
            quoted,
            { label: `${config.key}:usage`, throwOnUnavailable: true }
          );
        }

        if (
          (config.searchPath || config.resolvePickerFromDownloadPicks) &&
          !parsedInput.explicitPick &&
          !isHttpUrl(userInput)
        ) {
          const results = await requestSearchResults(userInput, config);
          storePickerResults(userId, config, userInput, results);

          await sendSearchPicker(
            { sock, from, quoted, settings },
            userInput,
            results,
            config
          );

          cooldowns.delete(userId);
          return;
        }

        downloadCharge = await chargeDownloadRequest(runtimeCtx, {
          commandName: config.primaryCommand,
          query: userInput,
          provider: "dvyer",
          platform: config.key,
        });

        if (!downloadCharge.ok) {
          cooldowns.delete(userId);
          return null;
        }

        await reactToMessage(sock, msg, "⏳");

        const cachedPickerResult = getCachedPickerResult(
          userId,
          config,
          userInput,
          parsedInput.pick
        );

        downloadInfo = cachedPickerResult || await requestDownloadMeta(userInput, config, {
          pick: parsedInput.pick,
        });

        if (downloadInfo.sizeBytes && downloadInfo.sizeBytes > maxFileBytes) {
          await reactToMessage(sock, msg, "⚠️");
          await sendLargeFileLink(sock, from, quoted, downloadInfo, config);
          cooldowns.delete(userId);
          return null;
        }

        if (config.previewBeforeSend) {
          await sendPreviewCard(sock, from, quoted, downloadInfo, config);
        }

        const tmpDir = path.join(TMP_ROOT, config.key);

        if (!fs.existsSync(tmpDir)) {
          fs.mkdirSync(tmpDir, { recursive: true });
        }

        tempPath = path.join(tmpDir, `${Date.now()}-${downloadInfo.fileName}`);

        const downloaded = await downloadAbsoluteFileWithFallbacks(
          downloadInfo.downloadCandidates || [downloadInfo.downloadUrl],
          tempPath,
          maxFileBytes
        );

        const finalFileName = normalizeDownloadFileName(
          downloaded.fileName || downloadInfo.fileName,
          downloadInfo.title,
          downloadInfo.format || config.defaultExtension
        );

        await sendFileDocument(
          sock,
          from,
          quoted,
          downloadInfo,
          downloaded.tempPath,
          finalFileName,
          downloaded.size,
          config
        );
        await reactToMessage(sock, msg, "✅");
      } catch (error) {
        console.error(`${config.key.toUpperCase()} ERROR:`, error?.message || error);

        refundDownloadCharge(runtimeCtx, downloadCharge, {
          commandName: config.primaryCommand,
          reason: error?.message || "download_error",
        });

        cooldowns.delete(userId);

        const detail = sanitizeProviderMessage(error, {
          kind: "file",
          fallback: "No se pudo procesar la descarga.",
        });

        await reactToMessage(sock, msg, "❌");

        await safeSendMessage(
          sock,
          from,
          {
            text: buildDownloadCard("❌ *ERROR*", [
              { lines: [detail] },
            ]),
            ...global.channelInfo,
          },
          quoted,
          { label: `${config.key}:error` }
        );
      } finally {
        deleteFileSafe(tempPath);
      }
    },
  };
}
