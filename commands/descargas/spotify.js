import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import { pipeline } from "stream/promises";
import { spawn } from "child_process";
import { buildDvyerUrl, withDvyerApiKey } from "../../lib/api-manager.js";

// Configuración
const API_SPOTIFY_URL = buildDvyerUrl("/spotify");
const API_SPOTIFY_SEARCH_URL = buildDvyerUrl("/spotifysearch");
const TMP_DIR = path.join(os.tmpdir(), "spotify-downloads");
const AUDIO_QUALITY = "128k";
const REQUEST_TIMEOUT = 120000;
const MAX_AUDIO_BYTES = 120 * 1024 * 1024;
const AUDIO_AS_DOCUMENT_THRESHOLD = 60 * 1024 * 1024;

const cooldowns = new Map();

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

// ============ UTILIDADES ============

function ensureTmpDir() {
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  } catch {}
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

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipText(value = "", max = 72) {
  const normalized = cleanText(value);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(1, max - 3))}...`;
}

function normalizeAudioFileName(name, fallbackBase = "spotify", fallbackExt = "mp3") {
  const parsed = path.parse(String(name || "").trim());
  const ext = String(parsed.ext || `.${fallbackExt}`).replace(/^\./, "").toLowerCase() || fallbackExt;
  const base = safeFileName(parsed.name || fallbackBase);
  return `${base}.${ext}`;
}

function getCooldownRemaining(untilMs) {
  return Math.max(0, Math.ceil((untilMs - Date.now()) / 1000));
}

function isSpotifyUrl(value) {
  return /^(https?:\/\/)?(open\.spotify\.com|spotify\.link)\//i.test(
    String(value || "").trim()
  );
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function extractSpotifyEntityType(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  const uriMatch = text.match(/^spotify:([a-z]+):/i);
  if (uriMatch?.[1]) {
    return String(uriMatch[1]).toLowerCase();
  }

  const urlMatch = text.match(/open\.spotify\.com\/(?:intl-[^/]+\/)?([a-z]+)\//i);
  if (urlMatch?.[1]) {
    return String(urlMatch[1]).toLowerCase();
  }

  return "";
}

function resolveUserInput(ctx) {
  try {
    let text = "";

    if (ctx.args && Array.isArray(ctx.args) && ctx.args.length > 0) {
      text = ctx.args.join(" ").trim();
      if (text) return text;
    }

    const msg = ctx.m || ctx.msg;
    if (msg) {
      if (msg.text) return msg.text.trim();
      if (msg.message?.extendedTextMessage?.text) {
        return msg.message.extendedTextMessage.text.trim();
      }
      if (msg.message?.conversation) {
        return msg.message.conversation.trim();
      }
      if (msg.conversation) {
        return msg.conversation.trim();
      }
    }

    const quoted = ctx.quoted || msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (quoted) {
      if (quoted.extendedTextMessage?.text) {
        return quoted.extendedTextMessage.text.trim();
      }
      if (quoted.conversation) {
        return quoted.conversation.trim();
      }
    }

    return "";
  } catch (error) {
    console.error("Error resolviendo input:", error.message);
    return "";
  }
}

function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }
  return String(settings?.prefix || ".").trim() || ".";
}

function deleteFileSafe(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

function detectAudioFormat(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, buffer, 0, 16, 0);
    fs.closeSync(fd);

    const slice = buffer.subarray(0, bytesRead);

    if (slice.length >= 3 && slice.subarray(0, 3).toString("ascii") === "ID3") {
      return { ext: "mp3", mimetype: "audio/mpeg", isMp3: true };
    }

    if (slice.length >= 2 && slice[0] === 0xff && (slice[1] & 0xe0) === 0xe0) {
      return { ext: "mp3", mimetype: "audio/mpeg", isMp3: true };
    }

    if (slice.length >= 8 && slice.subarray(4, 8).toString("ascii") === "ftyp") {
      return { ext: "m4a", mimetype: "audio/mp4", isMp3: false };
    }

    if (slice.length >= 4 && slice[0] === 0x1a && slice[1] === 0x45 && slice[2] === 0xdf && slice[3] === 0xa3) {
      return { ext: "webm", mimetype: "audio/webm", isMp3: false };
    }
  } catch (e) {
    console.warn("Error detectando formato:", e.message);
  }

  return { ext: "bin", mimetype: "application/octet-stream", isMp3: false };
}

// ============ BÚSQUEDA EN SPOTIFY ============

async function searchSpotifyTracks(query, limit = 10) {
  try {
    const cleanQuery = cleanText(query);
    
    if (cleanQuery.length < 2) {
      throw new Error("La búsqueda debe tener al menos 2 caracteres");
    }

    console.log(`[SPOTIFY] Buscando: ${cleanQuery}`);

    const response = await axios.get(API_SPOTIFY_SEARCH_URL, {
      params: withDvyerApiKey({
        q: cleanQuery,
        limit: Math.max(1, Math.min(Number(limit || 10), 20)),
        lang: "es18",
      }),
      timeout: REQUEST_TIMEOUT,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json",
      },
      validateStatus: () => true,
    });

    console.log(`[SPOTIFY] Respuesta API - Status: ${response.status}`);

    if (response.status === 422 || response.status === 400) {
      // Si falla con q, intentar de otra forma
      console.log(`[SPOTIFY] Intentando con parámetros alternativos...`);
      
      const fallbackQuery = new URLSearchParams(
        withDvyerApiKey({
          q: cleanQuery,
          mode: "link",
          limit: Math.max(1, Math.min(Number(limit || 10), 20)),
          lang: "es18",
        })
      ).toString();
      const separator = API_SPOTIFY_URL.includes("?") ? "&" : "?";
      const response2 = await axios.get(`${API_SPOTIFY_URL}${separator}${fallbackQuery}`, {
        timeout: REQUEST_TIMEOUT,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "application/json",
        },
        validateStatus: () => true,
      });

      console.log(`[SPOTIFY] Respuesta 2 - Status: ${response2.status}`);

      if (response2.status >= 400) {
        console.error(`[SPOTIFY] Error detallado:`, JSON.stringify(response2.data));
        throw new Error(`Error en búsqueda: HTTP ${response2.status}`);
      }

      return parseSpotifyResults(response2.data);
    }

    if (response.status >= 400) {
      console.error(`[SPOTIFY] Error detallado:`, JSON.stringify(response.data));
      throw new Error(`Error en búsqueda: HTTP ${response.status}`);
    }

    return parseSpotifyResults(response.data);

  } catch (error) {
    console.error(`[SPOTIFY] Error en búsqueda:`, error.message);
    throw error;
  }
}

function parseSpotifyResults(data) {
  // Manejo flexible de diferentes formatos de respuesta
  
  // Formato 1: results array
  let results = data?.results || [];
  
  // Formato 2: selected result
  if (!results.length && data?.selected) {
    results = [data.selected];
  }
  
  // Formato 3: todo el objeto es un track
  if (!results.length && data?.title && data?.artist) {
    results = [data];
  }

  if (!results.length) {
    throw new Error("No se encontraron resultados");
  }

  console.log(`[SPOTIFY] Resultados encontrados: ${results.length}`);

  return results.slice(0, 10).map((track, index) => ({
    index: index + 1,
    title: cleanText(track.title || "Sin título"),
    artist: cleanText(track.artist || "Spotify"),
    duration: track.duration || "??:??",
    thumbnail: track.thumbnail || null,
    spotifyUrl: track.spotify_url || "",
    downloadUrl: track.download_url_full || track.download_url || track.download_path || "",
    fileName: track.filename || `${track.title} - ${track.artist}.mp3`,
  })).filter(r => r.title && r.spotifyUrl);
}

// ============ OBTENER INFO DE DESCARGA ============

async function getSpotifyDownloadInfo(input) {
  try {
    const cleanInput = cleanText(input);
    console.log(`[SPOTIFY] Obteniendo info para: ${cleanInput}`);

    const params = {
      mode: "link",
      lang: "es18",
    };

    if (isSpotifyUrl(cleanInput)) {
      params.url = cleanInput;
    } else {
      params.q = cleanInput;
    }

    const response = await axios.get(API_SPOTIFY_URL, {
      params: withDvyerApiKey(params),
      timeout: REQUEST_TIMEOUT,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json",
      },
      validateStatus: () => true,
    });

    console.log(`[SPOTIFY] Respuesta - Status: ${response.status}`);

    if (response.status >= 400) {
      const errorMsg = response.data?.message || response.data?.error || `HTTP ${response.status}`;
      throw new Error(`Error API: ${errorMsg}`);
    }

    const data = response.data;
    const selected = data.selected || data;
    const downloadUrl = selected.download_url_full || selected.download_url || data.download_url_full || data.download_url;

    if (!downloadUrl) {
      console.error("[SPOTIFY] Respuesta API:", JSON.stringify(data, null, 2));
      throw new Error("La API no devolvió enlace de descarga");
    }

    const title = cleanText(selected.title || data.title || "spotify");
    const artist = cleanText(selected.artist || data.artist || "Spotify");

    console.log(`[SPOTIFY] Info obtenida - ${title} / ${artist}`);

    return {
      title: title,
      artist: artist,
      duration: selected.duration || data.duration || null,
      thumbnail: selected.thumbnail || data.thumbnail || null,
      spotifyUrl: selected.spotify_url || data.spotify_url || "",
      fileName: normalizeAudioFileName(
        selected.filename || data.filename || `${title} - ${artist}`,
        `${title} - ${artist}`,
        "mp3"
      ),
      downloadUrl: String(downloadUrl).trim(),
    };
  } catch (error) {
    console.error(`[SPOTIFY] Error obteniendo info:`, error.message);
    throw error;
  }
}

// ============ DESCARGA DE AUDIO ============

async function downloadAudio(downloadUrl, outputPath, fileName = "spotify.mp3") {
  ensureTmpDir();

  try {
    console.log(`[SPOTIFY] Descargando desde: ${downloadUrl}`);

    const response = await axios.get(downloadUrl, {
      responseType: "stream",
      timeout: REQUEST_TIMEOUT,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "*/*",
      },
      maxRedirects: 5,
      validateStatus: () => true,
    });

    if (response.status >= 400) {
      throw new Error(`Error descarga: HTTP ${response.status}`);
    }

    const contentLength = Number(response.headers?.["content-length"] || 0);
    console.log(`[SPOTIFY] Tamaño: ${contentLength} bytes`);

    if (contentLength && contentLength > MAX_AUDIO_BYTES) {
      throw new Error(`Audio muy grande: ${Math.round(contentLength / 1024 / 1024)}MB`);
    }

    let downloaded = 0;
    response.data.on("data", (chunk) => {
      downloaded += chunk.length;
      if (downloaded > MAX_AUDIO_BYTES) {
        response.data.destroy(new Error("Archivo excede tamaño máximo"));
      }
    });

    const outputStream = fs.createWriteStream(outputPath);

    await pipeline(response.data, outputStream);

    if (!fs.existsSync(outputPath)) {
      throw new Error("No se pudo guardar el archivo");
    }

    const size = fs.statSync(outputPath).size;
    console.log(`[SPOTIFY] Guardado: ${size} bytes`);

    if (!size || size < 50000) {
      deleteFileSafe(outputPath);
      throw new Error("Archivo inválido o muy pequeño");
    }

    if (size > MAX_AUDIO_BYTES) {
      deleteFileSafe(outputPath);
      throw new Error("Archivo excede tamaño máximo");
    }

    const audioFormat = detectAudioFormat(outputPath);

    return {
      tempPath: outputPath,
      size,
      fileName: normalizeAudioFileName(fileName, "spotify", audioFormat.ext),
      mimetype: audioFormat.mimetype,
      ext: audioFormat.ext,
      isMp3: audioFormat.isMp3,
    };
  } catch (error) {
    console.error(`[SPOTIFY] Error descargando:`, error.message);
    deleteFileSafe(outputPath);
    throw error;
  }
}

// ============ CONVERSIÓN A MP3 ============

async function convertToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`[SPOTIFY] Convirtiendo a MP3...`);

    const ffmpeg = spawn("ffmpeg", [
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
    ]);

    let errorText = "";
    let settled = false;

    ffmpeg.stderr.on("data", (chunk) => {
      errorText += chunk.toString();
    });

    ffmpeg.on("error", (error) => {
      if (settled) return;
      settled = true;
      deleteFileSafe(outputPath);
      console.error(`[SPOTIFY] Error ffmpeg:`, error.message);
      if (error?.code === "ENOENT") {
        reject(new Error("ffmpeg no está instalado"));
        return;
      }
      reject(error);
    });

    ffmpeg.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        console.log(`[SPOTIFY] Conversión completada`);
        resolve();
      } else {
        deleteFileSafe(outputPath);
        reject(new Error(errorText.trim() || `ffmpeg error ${code}`));
      }
    });
  });
}

// ============ ENVÍO DE AUDIO ============

async function sendSpotifyAudio(sock, from, quoted, { filePath, fileName, mimetype, title, artist, size, forceDocument = false }) {
  const artistLabel = cleanText(artist || "Spotify") || "Spotify";
  const shouldSendDocument = forceDocument || size > AUDIO_AS_DOCUMENT_THRESHOLD;

  try {
    console.log(`[SPOTIFY] Enviando como ${shouldSendDocument ? "documento" : "audio"}...`);

    if (shouldSendDocument) {
      await sock.sendMessage(
        from,
        {
          document: { url: filePath },
          mimetype: "audio/mpeg",
          fileName,
          caption: `🎵 *${title}*\n🎤 ${artistLabel}\n\n📦 Documento`,
          ...global.channelInfo,
        },
        quoted
      );
      return "document";
    }

    await sock.sendMessage(
      from,
      {
        audio: { url: filePath },
        mimetype: mimetype || "audio/mpeg",
        ptt: false,
        fileName,
        ...global.channelInfo,
      },
      quoted
    );
    return "audio";
  } catch (error) {
    console.warn(`[SPOTIFY] Error enviando, intentando como documento:`, error.message);
    await sock.sendMessage(
      from,
      {
        document: { url: filePath },
        mimetype: "audio/mpeg",
        fileName,
        caption: `🎵 *${title}*\n🎤 ${artistLabel}\n\n📦 Documento`,
        ...global.channelInfo,
      },
      quoted
    );
    return "document";
  }
}

// ============ PICKER DE BÚSQUEDA ============

async function sendSpotifySearchPicker(ctx, query, results) {
  const { sock, from, quoted, settings } = ctx;
  const prefix = getPrefix(settings);

  const rows = results.slice(0, 10).map((result, index) => ({
    header: `${index + 1}`,
    title: clipText(result.title, 72),
    description: clipText(
      `🎵 Spotify | ⏱ ${result.duration} | 👤 ${result.artist}`,
      72
    ),
    id: `${prefix}spotify ${result.spotifyUrl}`,
  }));

  try {
    if (results[0]?.thumbnail) {
      try {
        const imgResponse = await axios.get(results[0].thumbnail, { responseType: "arraybuffer" });
        if (imgResponse.status === 200) {
          await sock.sendMessage(
            from,
            {
              image: Buffer.from(imgResponse.data),
              caption:
                `🟢 *SPOTIFY SEARCH*\n\n` +
                `🔎 Resultados para: *${clipText(query, 80)}*\n` +
                `📌 Top: *${clipText(results[0].title, 80)}*\n` +
                `🎤 ${clipText(results[0].artist, 60)}\n\n` +
                `Selecciona una canción:`,
              ...global.channelInfo,
            },
            quoted
          );
        }
      } catch (imgError) {
        console.warn("Error cargando imagen:", imgError.message);
      }
    }

    const interactivePayload = {
      text: `Resultados para: ${clipText(query, 80)}`,
      title: "🎵 SPOTIFY",
      subtitle: "Elige una canción",
      footer: "Descargas",
      interactiveButtons: [
        {
          name: "single_select",
          buttonParamsJson: JSON.stringify({
            title: "🎵 Seleccionar canción",
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
      await sock.sendMessage(from, interactivePayload, quoted);
    } catch (buttonError) {
      console.warn("Botones no soportados, enviando lista de texto");
      const fallbackText = rows
        .slice(0, 5)
        .map((row) => `*${row.header}. ${row.title}*\n${row.id}`)
        .join("\n\n");

      await sock.sendMessage(
        from,
        {
          text:
            `Resultados para: ${clipText(query, 80)}\n\n${fallbackText}\n\n` +
            `Copia uno de los comandos para descargar.`,
          ...global.channelInfo,
        },
        quoted
      );
    }
  } catch (error) {
    console.error("Error en picker:", error.message);
  }
}

// ============ COMANDO PRINCIPAL ============

export default {
  name: "spotify",
  command: ["spotify", "spoti", "spotifydl", "spdl"],
  category: "descarga",
  description: "🎵 Busca y descarga canciones de Spotify en MP3 (Downloaderize)",

  run: async (ctx) => {
    const { sock, from, settings } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const userId = `${from}:spotify`;

    let rawAudioPath = null;
    let finalMp3Path = null;

    const COOLDOWN_TIME = 3000;

    console.log(`[SPOTIFY] Comando ejecutado por: ${from}`);

    if (COOLDOWN_TIME > 0) {
      const until = cooldowns.get(userId);
      if (until && until > Date.now()) {
        return sock.sendMessage(
          from,
          {
            text: `⏳ Espera ${getCooldownRemaining(until)}s`,
            ...global.channelInfo,
          },
          quoted
        );
      }
      cooldowns.set(userId, Date.now() + COOLDOWN_TIME);
    }

    try {
      const userInput = resolveUserInput(ctx);

      console.log(`[SPOTIFY] Input recibido: "${userInput}"`);

      if (!userInput) {
        cooldowns.delete(userId);
        return sock.sendMessage(
          from,
          {
            text: `🎵 *Uso:*\n\n.spotify canción\n.spotify https://open.spotify.com/track/...\n\nEjemplos:\n.spotify bohemian rhapsody\n.spotify imagine john lennon`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      const spotifyEntityType = extractSpotifyEntityType(userInput);
      if (spotifyEntityType && spotifyEntityType !== "track") {
        cooldowns.delete(userId);
        return sock.sendMessage(
          from,
          {
            text: "❌ Solo se admiten tracks individuales o búsqueda por texto",
            ...global.channelInfo,
          },
          quoted
        );
      }

      if (isHttpUrl(userInput) && !isSpotifyUrl(userInput)) {
        cooldowns.delete(userId);
        return sock.sendMessage(
          from,
          {
            text: "❌ Solo URLs de Spotify o búsqueda por texto",
            ...global.channelInfo,
          },
          quoted
        );
      }

      if (!isSpotifyUrl(userInput)) {
        await sock.sendMessage(
          from,
          {
            text: `🔎 Buscando: ${clipText(userInput, 80)}\n⏳ Espera...`,
            ...global.channelInfo,
          },
          quoted
        );

        const results = await searchSpotifyTracks(userInput, 10);
        await sendSpotifySearchPicker({ sock, from, quoted, settings }, userInput, results);
        cooldowns.delete(userId);
        return;
      }

      await sock.sendMessage(
        from,
        {
          text: `⬇️ Preparando...\n⏳ Espera`,
          ...global.channelInfo,
        },
        quoted
      );

      const info = await getSpotifyDownloadInfo(userInput);

      await sock.sendMessage(
        from,
        info.thumbnail
          ? {
              image: { url: info.thumbnail },
              caption:
                `🎵 *${clipText(info.title, 80)}*\n` +
                `🎤 ${clipText(info.artist, 60)}\n` +
                `${info.duration ? `⏱ ${info.duration}\n` : ""}` +
                `⬇️ Descargando...`,
              ...global.channelInfo,
            }
          : {
              text:
                `🎵 *${clipText(info.title, 80)}*\n` +
                `🎤 ${clipText(info.artist, 60)}\n` +
                `${info.duration ? `⏱ ${info.duration}\n` : ""}` +
                `⬇️ Descargando...`,
              ...global.channelInfo,
            },
        quoted
      );

      const stamp = Date.now();
      rawAudioPath = path.join(TMP_DIR, `${stamp}-spotify.bin`);
      finalMp3Path = path.join(TMP_DIR, `${stamp}-spotify.mp3`);

      const downloaded = await downloadAudio(info.downloadUrl, rawAudioPath, info.fileName);

      let sendPath = downloaded.tempPath;
      let sendMime = downloaded.mimetype;
      let sendName = downloaded.fileName;

      if (!downloaded.isMp3) {
        try {
          await convertToMp3(rawAudioPath, finalMp3Path);
          sendPath = finalMp3Path;
          sendMime = "audio/mpeg";
          sendName = normalizeAudioFileName(info.fileName, info.title, "mp3");
        } catch (convertError) {
          console.warn("Conversión fallida, enviando original:", convertError.message);
        }
      }

      const sentAs = await sendSpotifyAudio(sock, from, quoted, {
        filePath: sendPath,
        fileName: sendName,
        mimetype: sendMime,
        title: info.title,
        artist: info.artist,
        size: downloaded.size,
      });

      await sock.sendMessage(
        from,
        {
          text: `✅ Descargado como ${sentAs}`,
          ...global.channelInfo,
        },
        quoted
      );

    } catch (error) {
      console.error("SPOTIFY ERROR:", error.message || String(error));
      cooldowns.delete(userId);

      const errorMsg = error?.message || error?.response?.data?.message || String(error) || "Error desconocido";
      await sock.sendMessage(
        from,
        {
          text: `❌ Error: ${errorMsg}`,
          ...global.channelInfo,
        },
        quoted
      );
    } finally {
      deleteFileSafe(rawAudioPath);
      deleteFileSafe(finalMp3Path);
    }
  },
};
