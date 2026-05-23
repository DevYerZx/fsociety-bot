import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import { pipeline } from "stream/promises";

import {
  appendDvyerApiKeyToUrl,
  buildDvyerUrl,
  withDvyerApiKey,
  withDvyerApiKeyHeader,
} from "../../lib/api-manager.js";
import {
  assertDownloadWithinPolicy,
  getDownloadExecutionPolicy,
} from "../../lib/subbot-download-policy.js";
import { sanitizeProviderMessage } from "./_errorMessages.js";

const API_SEARCH_URL = buildDvyerUrl("/applemusicsearch");
const API_DOWNLOAD_URL = buildDvyerUrl("/applemusicdl");
const TMP_DIR = path.join(os.tmpdir(), "applemusic-downloads");
const REQUEST_TIMEOUT = 15 * 60 * 1000;
const SEARCH_TIMEOUT = 30_000;
const MAX_AUDIO_BYTES = 120 * 1024 * 1024;
const AUDIO_AS_DOCUMENT_THRESHOLD = 16 * 1024 * 1024;
const PICK_TOKEN_PATTERN = /^--pick=(\d{1,2})$/i;

const cooldowns = new Map();

function ensureTmpDir() {
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  } catch {}
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipText(value = "", max = 72) {
  const text = cleanText(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 3))}...`;
}

function safeFileName(name) {
  return (
    String(name || "applemusic")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "applemusic"
  );
}

function normalizeAudioFileName(name, fallbackBase = "applemusic") {
  const parsed = path.parse(String(name || "").trim());
  const base = safeFileName(parsed.name || fallbackBase);
  return `${base}.mp3`;
}

function improveAppleArtworkUrl(url = "") {
  const value = String(url || "").trim();
  if (!value) return "";

  return value.replace(
    /\/\d+x\d+(bb|cc)?\.(jpg|jpeg|png|webp)(?=([?#]|$))/i,
    "/1200x1200$1.$2"
  );
}

function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }

  return String(settings?.prefix || ".").trim() || ".";
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function isAppleMusicUrl(value) {
  return /^https?:\/\/music\.apple\.com\//i.test(String(value || "").trim());
}

function extractTextFromMessage(message) {
  return (
    message?.text ||
    message?.caption ||
    message?.body ||
    message?.message?.conversation ||
    message?.message?.extendedTextMessage?.text ||
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    ""
  );
}

function resolveUserInput(ctx) {
  const argsText = Array.isArray(ctx.args) ? ctx.args.join(" ").trim() : "";
  if (argsText) return argsText;

  const msg = ctx.m || ctx.msg || null;
  const quoted = msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage || ctx.quoted;
  return cleanText(extractTextFromMessage(quoted));
}

function parseInput(value) {
  const parts = cleanText(value).split(/\s+/).filter(Boolean);
  let pick = 1;
  const queryParts = [];

  for (const part of parts) {
    const match = part.match(PICK_TOKEN_PATTERN);
    if (match) {
      pick = Math.max(1, Math.min(40, Number(match[1] || 1)));
      continue;
    }

    queryParts.push(part);
  }

  return {
    pick,
    target: queryParts.join(" ").trim(),
    explicitPick: pick > 1,
  };
}

function durationLabel(durationMs) {
  const ms = Number(durationMs || 0);
  if (!Number.isFinite(ms) || ms <= 0) return "??:??";

  const total = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function pickDownloadUrl(data) {
  return (
    data?.download_url_full ||
    data?.stream_url_full ||
    data?.full_url ||
    data?.download_url ||
    data?.stream_url ||
    data?.url ||
    data?.results?.[0]?.full_url ||
    data?.results?.[0]?.url ||
    data?.links?.[0]?.full_url ||
    data?.links?.[0]?.url ||
    data?.download_links?.[0]?.full_url ||
    data?.download_links?.[0]?.url ||
    ""
  );
}

function normalizeApiUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;

  const base = new URL(API_DOWNLOAD_URL);
  return new URL(value, base.origin).toString();
}

function deleteFileSafe(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
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

async function searchAppleMusic(query) {
  const response = await axios.get(API_SEARCH_URL, {
    params: withDvyerApiKey({ q: query, limit: 10 }),
    timeout: SEARCH_TIMEOUT,
    headers: withDvyerApiKeyHeader({
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0",
    }),
    validateStatus: () => true,
  });

  if (response.status >= 400 || response.data?.ok === false) {
    throw new Error(response.data?.message || response.data?.error || `HTTP ${response.status}`);
  }

  const results = Array.isArray(response.data?.results) ? response.data.results : [];
  return results.slice(0, 10).map((item, index) => ({
    index: index + 1,
    title: cleanText(item.title || "Sin título"),
    artist: cleanText(item.artist || "Apple Music"),
    album: cleanText(item.album || ""),
    duration: durationLabel(item.duration_ms),
    artwork: improveAppleArtworkUrl(item.artwork || item.image_url || ""),
    url: item.apple_music_url || item.song_url || item.url || "",
  })).filter((item) => item.title && item.url);
}

async function getAppleMusicInfo(input, pick = 1) {
  const params = {
    pick: Math.max(1, Math.min(40, Number(pick || 1))),
  };

  if (isAppleMusicUrl(input)) {
    params.url = input;
  } else {
    params.q = input;
  }

  const response = await axios.get(API_DOWNLOAD_URL, {
    params: withDvyerApiKey(params),
    timeout: SEARCH_TIMEOUT,
    headers: withDvyerApiKeyHeader({
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0",
    }),
    validateStatus: () => true,
  });

  if (response.status >= 400 || response.data?.ok === false) {
    throw new Error(response.data?.message || response.data?.error || `HTTP ${response.status}`);
  }

  const data = response.data || {};
  const downloadUrl = normalizeApiUrl(pickDownloadUrl(data));
  if (!downloadUrl) {
    throw new Error("La API no devolvió enlace de descarga.");
  }

  const title = cleanText(data.title || "Apple Music");
  const artist = cleanText(data.artist || "Apple Music");

  return {
    title,
    artist,
    artwork: improveAppleArtworkUrl(normalizeApiUrl(data.image_url_full || data.image_url || "")),
    fileName: normalizeAudioFileName(data.filename || `${title} - ${artist}`, `${title} - ${artist}`),
    downloadUrl,
  };
}

async function downloadAudio(downloadUrl, outputPath, maxBytes) {
  const response = await axios.get(appendDvyerApiKeyToUrl(downloadUrl), {
    responseType: "stream",
    timeout: REQUEST_TIMEOUT,
    maxRedirects: 5,
    headers: withDvyerApiKeyHeader({
      Accept: "*/*",
      "User-Agent": "Mozilla/5.0",
    }),
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    throw new Error(`Error descarga: HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers?.["content-length"] || 0);
  if (contentLength && contentLength > maxBytes) {
    throw new Error("Audio demasiado grande para enviarlo por WhatsApp.");
  }

  let downloaded = 0;
  response.data.on("data", (chunk) => {
    downloaded += chunk.length;
    if (downloaded > maxBytes) {
      response.data.destroy(new Error("Audio demasiado grande para enviarlo por WhatsApp."));
    }
  });

  await pipeline(response.data, fs.createWriteStream(outputPath));

  const size = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
  if (!size || size < 50_000) {
    throw new Error("El audio descargado es inválido.");
  }

  if (size > maxBytes) {
    throw new Error("Audio demasiado grande para enviarlo por WhatsApp.");
  }

  return size;
}

async function sendSearchPicker(ctx, query, results) {
  const { sock, from, quoted, settings } = ctx;
  const prefix = getPrefix(settings);

  const rows = results.map((result, index) => ({
    header: `${index + 1}`,
    title: clipText(result.title, 72),
    description: clipText(`🍎 Apple Music | ${result.duration} | ${result.artist}`, 72),
    id: `${prefix}applemusic ${result.url}`,
  }));

  let imageBuffer = null;

  if (results[0]?.artwork) {
    try {
      const image = await axios.get(results[0].artwork, {
        responseType: "arraybuffer",
        timeout: 12_000,
      });
      imageBuffer = Buffer.from(image.data);
    } catch {}
  }

  const caption =
    `╭━━〔 🍎 *APPLE MUSIC* 〕━━⬣\n` +
    `┃ 🔎 Resultado para: *${clipText(query, 80)}*\n` +
    `┃ ⭐ Top: *${clipText(results[0]?.title || "Sin título", 80)}*\n` +
    `┃ 🎤 ${clipText(results[0]?.artist || "Apple Music", 60)}\n` +
    `┃ 📌 Selecciona una canción para descargar\n` +
    `╰━━━━━━━━━━━━━━━━━━⬣`;

  const payload = {
    ...(imageBuffer ? { image: imageBuffer, caption } : { text: caption }),
    title: "🍎 APPLE MUSIC",
    subtitle: "Elige una canción",
    footer: "Descargas",
    ...global.channelInfo,
    interactiveButtons: [
      {
        name: "single_select",
        buttonParamsJson: JSON.stringify({
          title: "🍎 Seleccionar canción",
          sections: [
            {
              title: "Resultados de búsqueda",
              rows,
            },
          ],
        }),
      },
    ],
  };

  try {
    await sock.sendMessage(from, payload, quoted);
  } catch {
    if (imageBuffer) {
      try {
        await sock.sendMessage(
          from,
          {
            image: imageBuffer,
            caption,
            ...global.channelInfo,
          },
          quoted
        );
      } catch {}
    }

    const fallbackText = rows
      .slice(0, 5)
      .map((row) => `*${row.header}. ${row.title}*\n${row.id}`)
      .join("\n\n");

    await sock.sendMessage(
      from,
      {
        text: `${caption}\n\n${fallbackText}`,
        ...global.channelInfo,
      },
      quoted
    );
  }
}

async function sendAudio(sock, from, quoted, filePath, info, size) {
  if (size > AUDIO_AS_DOCUMENT_THRESHOLD) {
    await sock.sendMessage(
      from,
      {
        document: { url: filePath },
        mimetype: "audio/mpeg",
        fileName: info.fileName,
        caption: `🍎 *${info.title}*\n🎤 ${info.artist}`,
        ...global.channelInfo,
      },
      quoted
    );
    return;
  }

  await sock.sendMessage(
    from,
    {
      audio: fs.readFileSync(filePath),
      mimetype: "audio/mpeg",
      ptt: false,
      fileName: info.fileName,
      ...global.channelInfo,
    },
    quoted
  );
}

function resolveMaxAudioBytes(ctx) {
  const policy = getDownloadExecutionPolicy(ctx, "applemusic");
  return Math.min(MAX_AUDIO_BYTES, Number(policy?.maxBytes || MAX_AUDIO_BYTES));
}

export default {
  name: "applemusic",
  command: ["applemusic", "apple", "applemusicdl", "amdl"],
  category: "descarga",
  description: "Busca y descarga canciones de Apple Music en MP3.",

  run: async (ctx) => {
    const { sock, from, settings } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const userId = `${from}:applemusic`;
    const maxAudioBytes = resolveMaxAudioBytes(ctx);
    let tempPath = null;

    try {
      ensureTmpDir();

      const until = cooldowns.get(userId);
      if (until && until > Date.now()) {
        return sock.sendMessage(from, { text: "⏳ Espera unos segundos.", ...global.channelInfo }, quoted);
      }
      cooldowns.set(userId, Date.now() + 3000);

      const parsed = parseInput(resolveUserInput(ctx));
      if (!parsed.target) {
        cooldowns.delete(userId);
        return sock.sendMessage(
          from,
          {
            text:
              "🍎 *Uso:*\n\n" +
              ".applemusic canción artista\n" +
              ".applemusic https://music.apple.com/...\n" +
              ".applemusic --pick=2 bad bunny",
            ...global.channelInfo,
          },
          quoted
        );
      }

      if (isHttpUrl(parsed.target) && !isAppleMusicUrl(parsed.target)) {
        cooldowns.delete(userId);
        return sock.sendMessage(
          from,
          { text: "❌ Solo URLs de Apple Music o búsqueda por texto.", ...global.channelInfo },
          quoted
        );
      }

      if (!isAppleMusicUrl(parsed.target) && !parsed.explicitPick) {
        const results = await searchAppleMusic(parsed.target);
        await sendSearchPicker({ sock, from, quoted, settings }, parsed.target, results);
        cooldowns.delete(userId);
        return;
      }

      await reactToMessage(sock, msg, "⏳");

      const info = await getAppleMusicInfo(parsed.target, parsed.pick);
      tempPath = path.join(TMP_DIR, `${Date.now()}-${info.fileName}`);
      const size = await downloadAudio(info.downloadUrl, tempPath, maxAudioBytes);
      assertDownloadWithinPolicy(ctx, size, "audios");

      await sendAudio(sock, from, quoted, tempPath, info, size);
      await reactToMessage(sock, msg, "✅");
    } catch (error) {
      console.error("APPLEMUSIC ERROR:", error?.message || error);
      cooldowns.delete(userId);
      await reactToMessage(sock, msg, "❌");

      await sock.sendMessage(
        from,
        {
          text: `❌ ${sanitizeProviderMessage(error, { kind: "audio", fallback: "No se pudo procesar Apple Music." })}`,
          ...global.channelInfo,
        },
        quoted
      );
    } finally {
      deleteFileSafe(tempPath);
    }
  },
};
