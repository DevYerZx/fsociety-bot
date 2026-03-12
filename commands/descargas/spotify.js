import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import { pipeline } from "stream/promises";

const API_BASE = "https://dv-yer-api.online";
const API_SPOTIFY_URL = `${API_BASE}/spotify`;
const API_YTSEARCH_URL = `${API_BASE}/ytsearch`;
const API_AUDIO_URL = `${API_BASE}/ytdlmp3`;

const COOLDOWN_TIME = 15 * 1000;
const REQUEST_TIMEOUT = 120000;
const MAX_AUDIO_BYTES = 120 * 1024 * 1024;
const AUDIO_AS_DOCUMENT_THRESHOLD = 60 * 1024 * 1024;
const FALLBACK_AUDIO_QUALITY = "128k";
const TMP_DIR = path.join(os.tmpdir(), "dvyer-spotify");

const cooldowns = new Map();

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function safeFileName(name) {
  return (
    String(name || "spotify")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "spotify"
  );
}

function normalizeMp3Name(name) {
  const clean = safeFileName(String(name || "spotify").replace(/\.mp3$/i, ""));
  return `${clean || "spotify"}.mp3`;
}

function normalizeAudioFileName(name, fallbackBase = "spotify", fallbackExt = "mp3") {
  const parsed = path.parse(String(name || "").trim());
  const ext = String(parsed.ext || `.${fallbackExt}`).replace(/^\./, "").toLowerCase() || fallbackExt;
  const base = safeFileName(parsed.name || fallbackBase);
  return `${base}.${ext}`;
}

function buildAudioMeta(fileName, contentType, fallbackBase = "spotify") {
  const normalizedType = String(contentType || "").split(";")[0].trim().toLowerCase();
  const rawName = String(fileName || "").trim();
  const ext = path.extname(rawName).replace(/^\./, "").toLowerCase();

  let finalExt = ext || "bin";
  let mimetype = normalizedType || "application/octet-stream";

  if (normalizedType.includes("audio/mpeg") || ext === "mp3") {
    finalExt = "mp3";
    mimetype = "audio/mpeg";
  } else if (normalizedType.includes("audio/mp4") || ext === "m4a" || ext === "mp4") {
    finalExt = "m4a";
    mimetype = "audio/mp4";
  } else if (normalizedType.includes("audio/aac") || ext === "aac") {
    finalExt = "aac";
    mimetype = "audio/aac";
  }

  return {
    fileName: normalizeAudioFileName(rawName, fallbackBase, finalExt),
    mimetype,
  };
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

function isSpotifyUrl(value) {
  return /^(https?:\/\/)?(open\.spotify\.com|spotify\.link)\//i.test(
    String(value || "").trim()
  );
}

function buildSpotifyParams(input, mode = "link") {
  const params = {
    mode,
    pick: 1,
    limit: 5,
    lang: "es3",
  };

  if (isSpotifyUrl(input)) params.url = input;
  else params.q = input;

  return params;
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

function normalizeApiUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return `${API_BASE}${value}`;
  return `${API_BASE}/${value}`;
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

async function requestSpotifyInfo(input) {
  const data = await apiGet(
    API_SPOTIFY_URL,
    buildSpotifyParams(input, "link"),
    REQUEST_TIMEOUT
  );

  const downloadUrl = normalizeApiUrl(
    data?.download_url_full || data?.stream_url_full || data?.download_url || data?.stream_url
  );

  if (!downloadUrl) {
    throw new Error("La API no devolvió el enlace de descarga.");
  }

  return {
    title: safeFileName(data?.title || data?.selected?.title || "spotify"),
    artist: String(data?.artist || data?.selected?.artist || "").trim() || "Artist",
    duration: String(data?.duration || data?.selected?.duration || "").trim() || null,
    thumbnail: data?.thumbnail || data?.selected?.thumbnail || null,
    fileName: normalizeMp3Name(data?.filename || "spotify.mp3"),
    downloadUrl,
  };
}

async function requestYoutubeFallbackInfo(query) {
  const searchData = await apiGet(
    API_YTSEARCH_URL,
    { q: query, limit: 1 },
    REQUEST_TIMEOUT
  );

  const first = searchData?.results?.[0];
  if (!first?.url) {
    throw new Error("No encontrÃ© un audio alternativo en YouTube.");
  }

  const audioData = await apiGet(
    API_AUDIO_URL,
    {
      mode: "link",
      quality: FALLBACK_AUDIO_QUALITY,
      url: first.url,
    },
    REQUEST_TIMEOUT
  );

  const downloadUrl = normalizeApiUrl(
    audioData?.stream_url_full ||
      audioData?.download_url_full ||
      audioData?.stream_url ||
      audioData?.download_url ||
      audioData?.url
  );

  if (!downloadUrl) {
    throw new Error("No se pudo preparar el audio alternativo.");
  }

  return {
    title: safeFileName(audioData?.title || first.title || query || "audio"),
    artist: String(first?.channel || "YouTube").trim() || "YouTube",
    thumbnail: first.thumbnail || null,
    fileName: normalizeMp3Name(audioData?.filename || "audio.mp3"),
    downloadUrl,
  };
}

async function downloadAudioFromInternalLink(downloadUrl, outputPath, suggestedFileName = "audio.mp3") {
  const response = await axios.get(downloadUrl, {
    responseType: "stream",
    timeout: REQUEST_TIMEOUT,
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
        { message: errorText || "No se pudo descargar el audio." },
        response.status
      )
    );
  }

  const contentLength = Number(response.headers?.["content-length"] || 0);
  if (contentLength && contentLength > MAX_AUDIO_BYTES) {
    throw new Error("El audio es demasiado grande para enviarlo por WhatsApp.");
  }

  let downloaded = 0;

  response.data.on("data", (chunk) => {
    downloaded += chunk.length;
    if (downloaded > MAX_AUDIO_BYTES) {
      response.data.destroy(new Error("El audio es demasiado grande para enviarlo por WhatsApp."));
    }
  });

  try {
    await pipeline(response.data, fs.createWriteStream(outputPath));
  } catch (error) {
    deleteFileSafe(outputPath);
    throw error;
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error("No se pudo guardar el audio.");
  }

  const size = fs.statSync(outputPath).size;
  if (!size || size < 50000) {
    deleteFileSafe(outputPath);
    throw new Error("El audio descargado es inválido.");
  }

  if (size > MAX_AUDIO_BYTES) {
    deleteFileSafe(outputPath);
    throw new Error("El audio es demasiado grande para enviarlo por WhatsApp.");
  }

  const detectedName = parseContentDispositionFileName(
    response.headers?.["content-disposition"]
  );
  const audioMeta = buildAudioMeta(
    detectedName || suggestedFileName || path.basename(outputPath),
    response.headers?.["content-type"],
    "audio"
  );

  return {
    tempPath: outputPath,
    size,
    fileName: audioMeta.fileName,
    mimetype: audioMeta.mimetype,
  };
}

async function sendSpotifyAudio(sock, from, quoted, { filePath, fileName, mimetype, title, artist, size, sourceLabel }) {
  if (size > AUDIO_AS_DOCUMENT_THRESHOLD) {
    await sock.sendMessage(
      from,
      {
        document: { url: filePath },
        mimetype,
        fileName,
        caption: `api dvyer\n\n🎵 ${title}\n🎤 ${artist}\n📦 Enviado como documento`,
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

    await sock.sendMessage(
      from,
      {
        text: `api dvyer\n\n🎵 ${title}\n🎤 ${artist}`,
        ...global.channelInfo,
      },
      quoted
    );

    return "audio";
  } catch (e1) {
    console.error("send spotify audio failed:", e1?.message || e1);

    await sock.sendMessage(
      from,
      {
        document: { url: filePath },
        mimetype,
        fileName,
        caption: `api dvyer\n\n🎵 ${title}\n🎤 ${artist}\n📦 Enviado como documento`,
        ...global.channelInfo,
      },
      quoted
    );
    return "document";
  }
}

export default {
  command: ["spotify", "spoti"],
  category: "descarga",

  run: async (ctx) => {
    const { sock, from } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const userId = `${from}:spotify`;

    let tempPath = null;

    const until = cooldowns.get(userId);
    if (until && until > Date.now()) {
      return sock.sendMessage(from, {
        text: `⏳ Espera ${getCooldownRemaining(until)}s`,
        ...global.channelInfo,
      });
    }

    cooldowns.set(userId, Date.now() + COOLDOWN_TIME);

    try {
      const userInput = resolveUserInput(ctx);

      if (!userInput) {
        cooldowns.delete(userId);
        return sock.sendMessage(from, {
          text: "❌ Uso: .spotify <canción, artista o url de Spotify>",
          ...global.channelInfo,
        });
      }

      await sock.sendMessage(
        from,
        {
          text: `🎵 Buscando en Spotify...\n\n🌐 ${API_BASE}\n🔎 ${userInput}`,
          ...global.channelInfo,
        },
        quoted
      );

      const info = await requestSpotifyInfo(userInput);

      if (info.thumbnail) {
        await sock.sendMessage(
          from,
          {
            image: { url: info.thumbnail },
            caption: `api dvyer\n\n🎵 ${info.title}\n🎤 ${info.artist}${info.duration ? `\n⏱️ ${info.duration}` : ""}`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      tempPath = path.join(TMP_DIR, `${Date.now()}-${info.fileName}`);
      let downloaded = null;
      let sourceLabel = "Spotify";

      try {
        downloaded = await downloadAudioFromInternalLink(
          info.downloadUrl,
          tempPath,
          info.fileName
        );
      } catch (primaryError) {
        deleteFileSafe(tempPath);
        tempPath = null;

        console.warn("SPOTIFY fallback:", primaryError?.message || primaryError);

        await sock.sendMessage(
          from,
          {
            text: "âš ï¸ Spotify directo fallÃ³. Intento con tu ruta de audio por YouTube...",
            ...global.channelInfo,
            text: "Spotify directo fallo. Intento con tu ruta de audio por YouTube...",
          },
          quoted
        );

        const fallbackInfo = await requestYoutubeFallbackInfo(
          `${info.title} ${info.artist}`.trim()
        );

        sourceLabel = "Fallback YouTube";
        tempPath = path.join(TMP_DIR, `${Date.now()}-${fallbackInfo.fileName}`);
        downloaded = await downloadAudioFromInternalLink(
          fallbackInfo.downloadUrl,
          tempPath,
          fallbackInfo.fileName
        );
      }

      await sendSpotifyAudio(sock, from, quoted, {
        filePath: downloaded.tempPath,
        fileName: downloaded.fileName,
        mimetype: downloaded.mimetype,
        title: info.title,
        artist: sourceLabel === "Spotify" ? info.artist : `${info.artist} (${sourceLabel})`,
        size: downloaded.size,
        sourceLabel,
      });
    } catch (err) {
      console.error("SPOTIFY ERROR:", err?.message || err);
      cooldowns.delete(userId);

      await sock.sendMessage(from, {
        text: `❌ ${String(err?.message || "No se pudo procesar la canción.")}`,
        ...global.channelInfo,
      });
    } finally {
      deleteFileSafe(tempPath);
    }
  },
};
