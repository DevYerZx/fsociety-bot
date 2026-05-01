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

const REQUEST_TIMEOUT = 15 * 60 * 1000;
const SEARCH_TIMEOUT = 45_000;
const MAX_FILE_BYTES = 800 * 1024 * 1024;
const MIN_FILE_BYTES = 20_000;
const TMP_ROOT = path.join(os.tmpdir(), "dvyer-app-downloads");
const COOLDOWN_TIME = 0;

const cooldowns = new Map();

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
  if (!String(url || "").trim()) return null;

  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 15_000,
    validateStatus: () => true,
  });

  if (response.status >= 400 || !response.data) {
    return null;
  }

  return Buffer.from(response.data);
}

async function requestSearchResults(input, config) {
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
  const downloadUrl = normalizeApiUrl(pickApiDownloadUrl(data));

  if (!downloadUrl) {
    throw new Error("La API no devolvió enlace interno de descarga.");
  }

  const inferredExt =
    String(data?.format || data?.download_type || config.defaultExtension)
      .trim()
      .toLowerCase() || config.defaultExtension;

  return {
    title: safeFileName(data?.title || data?.package_name || `${config.name} File`),
    fileName: normalizeDownloadFileName(
      data?.filename || `${config.key}-download.${inferredExt}`,
      data?.title || `${config.name} File`,
      inferredExt
    ),
    version: String(data?.version || "").trim() || null,
    format: inferredExt,
    icon: data?.icon || null,
    description: cleanText(data?.description || "") || null,
    sizeBytes:
      Number(data?.size_bytes || data?.content_length || data?.filesize_bytes || 0) ||
      null,
    downloadUrl,
    packageName: String(data?.package_name || "").trim() || null,
  };
}

async function downloadAbsoluteFile(downloadUrl, outputPath) {
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

  if (contentLength && contentLength > MAX_FILE_BYTES) {
    throw new Error("El archivo es demasiado grande para enviarlo por WhatsApp.");
  }

  let downloaded = 0;

  response.data.on("data", (chunk) => {
    downloaded += chunk.length;

    if (downloaded > MAX_FILE_BYTES) {
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

  if (size > MAX_FILE_BYTES) {
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

function buildPreviewCaption(info, config) {
  const lines = [
    "╭━━〔 📦 *FSOCIETY DOWNLOAD* 〕━━⬣",
    `┃ ${config.rowLabel} *${info.title || `${config.name} File`}*`,
  ];

  if (info.version) lines.push(`┃ 🧩 Versión: *${info.version}*`);
  if (info.packageName) lines.push(`┃ 📛 Paquete: *${info.packageName}*`);
  if (info.format) lines.push(`┃ 📁 Formato: *${String(info.format).toUpperCase()}*`);

  const sizeText = humanBytes(info.sizeBytes);
  if (sizeText) lines.push(`┃ 📦 Tamaño: *${sizeText}*`);

  lines.push("╰━━━━━━━━━━━━━━━━━━⬣");

  if (info.description) {
    lines.push("");
    lines.push(clipText(info.description, 260));
  }

  return lines.join("\n");
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
    description: clipText(
      `${config.rowLabel} | ${String(
        result.format || config.defaultExtension
      ).toUpperCase()} | ${result.version || "Sin versión"}${
        humanBytes(result.filesize_bytes || result.size_bytes)
          ? ` | ${humanBytes(result.filesize_bytes || result.size_bytes)}`
          : ""
      }`,
      72
    ),
    id: `${prefix}${config.primaryCommand} --pick=${index + 1} ${query}`,
  }));

  let thumbBuffer = null;

  try {
    thumbBuffer = await downloadThumbnailBuffer(results[0]?.icon);
  } catch (error) {
    console.error(`${config.key.toUpperCase()} thumb search error:`, error?.message || error);
  }

  const introPayload = thumbBuffer
    ? {
        image: thumbBuffer,
        caption:
          `╭━━〔 🔎 *FSOCIETY BOT* 〕━━⬣\n` +
          `┃ Resultado para: *${clipText(query, 80)}*\n` +
          `┃ Primer resultado: *${clipText(results[0]?.title || "Sin título", 80)}*\n` +
          `╰━━━━━━━━━━━━━━━━━━⬣\n\n` +
          `${config.selectionText}`,
      }
    : {
        text:
          `╭━━〔 🔎 *FSOCIETY BOT* 〕━━⬣\n` +
          `┃ Resultado para: *${clipText(query, 80)}*\n` +
          `╰━━━━━━━━━━━━━━━━━━⬣\n\n` +
          `${config.selectionText}`,
      };

  await safeSendMessage(
    sock,
    from,
    {
      ...introPayload,
      ...global.channelInfo,
    },
    quoted,
    { label: `${config.key}:intro`, throwOnUnavailable: true }
  );

  const interactivePayload = {
    text: `Resultados para: ${clipText(query, 80)}`,
    title: "FSOCIETY BOT",
    subtitle: config.subtitle,
    footer: config.footer,
    interactiveButtons: [
      {
        name: "single_select",
        buttonParamsJson: JSON.stringify({
          title: config.pickerTitle,
          sections: [
            {
              title: config.sectionTitle,
              rows,
            },
          ],
        }),
      },
    ],
  };

  try {
    await safeSendMessage(sock, from, interactivePayload, quoted, {
      label: `${config.key}:picker`,
      throwOnUnavailable: true,
    });
  } catch (error) {
    console.error(`${config.key.toUpperCase()} interactive search failed:`, error?.message || error);

    const fallbackText = rows
      .slice(0, 5)
      .map((row) => `${row.header}. ${row.title}\n${row.id}`)
      .join("\n\n");

    await safeSendMessage(
      sock,
      from,
      {
        text:
          `Resultados para: ${clipText(query, 80)}\n\n${fallbackText}\n\n` +
          `Toca o copia uno de los comandos para descargar.`,
        ...global.channelInfo,
      },
      quoted,
      { label: `${config.key}:picker-fallback` }
    );
  }
}

async function sendFileDocument(sock, from, quoted, info, filePath, fileName, size) {
  const extra = [];

  if (info.version) extra.push(`┃ 🧩 Versión: ${info.version}`);
  if (info.packageName) extra.push(`┃ 📛 Paquete: ${info.packageName}`);
  if (info.format) extra.push(`┃ 📁 Formato: ${String(info.format).toUpperCase()}`);

  const sizeText = humanBytes(size);
  if (sizeText) extra.push(`┃ 📦 Tamaño: ${sizeText}`);

  const caption =
    `╭━━〔 ✅ *DESCARGA LISTA* 〕━━⬣\n` +
    `┃ 📌 ${info.title}\n` +
    `${extra.length ? `${extra.join("\n")}\n` : ""}` +
    `╰━━━━━━━━━━━━━━━━━━⬣`;

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
      text:
        `╭━━〔 ⚠️ *ARCHIVO GRANDE* 〕━━⬣\n` +
        `┃ El ${config.tooLargeLabel} supera el límite de envío directo.\n` +
        `${sizeText ? `┃ Tamaño: *${sizeText}*\n` : ""}` +
        `╰━━━━━━━━━━━━━━━━━━⬣\n\n` +
        `No envío el enlace con API key por seguridad.`,
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
              text: config.usage,
              ...global.channelInfo,
            },
            quoted,
            { label: `${config.key}:usage`, throwOnUnavailable: true }
          );
        }

        if (!parsedInput.explicitPick && !isHttpUrl(userInput)) {
          const results = await requestSearchResults(userInput, config);

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

        await safeSendMessage(
          sock,
          from,
          {
            text:
              `╭━━〔 ⬇️ *PREPARANDO* 〕━━⬣\n` +
              `┃ ${config.preparing}\n` +
              `┃ Entrada: ${clipText(userInput, 120)}\n` +
              `┃ 🔑 API Key: Activa\n` +
              `╰━━━━━━━━━━━━━━━━━━⬣`,
            ...global.channelInfo,
          },
          quoted,
          { label: `${config.key}:preparing`, throwOnUnavailable: true }
        );

        downloadInfo = await requestDownloadMeta(userInput, config, {
          pick: parsedInput.pick,
        });

        await sendPreviewCard(sock, from, quoted, downloadInfo, config);

        if (downloadInfo.sizeBytes && downloadInfo.sizeBytes > MAX_FILE_BYTES) {
          await sendLargeFileLink(sock, from, quoted, downloadInfo, config);
          cooldowns.delete(userId);
          return null;
        }

        const tmpDir = path.join(TMP_ROOT, config.key);

        if (!fs.existsSync(tmpDir)) {
          fs.mkdirSync(tmpDir, { recursive: true });
        }

        tempPath = path.join(tmpDir, `${Date.now()}-${downloadInfo.fileName}`);

        const downloaded = await downloadAbsoluteFile(
          downloadInfo.downloadUrl,
          tempPath
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
          downloaded.size
        );
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

        await safeSendMessage(
          sock,
          from,
          {
            text:
              `╭━━〔 ❌ *ERROR* 〕━━⬣\n` +
              `┃ ${detail}\n` +
              `╰━━━━━━━━━━━━━━━━━━⬣`,
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
