import fs from "fs";
import path from "path";
import axios from "axios";
import { pipeline } from "stream/promises";
import { spawn } from "child_process";

const API_BASE = "https://dv-yer-api.online";
const API_AUDIO_URL = `${API_BASE}/ytdlmp3`;
const API_SEARCH_URL = `${API_BASE}/ytsearch`;

const COOLDOWN_TIME = 15 * 1000;
const AUDIO_QUALITY = "128k";
const REQUEST_TIMEOUT = 120000;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const TMP_DIR = path.join(process.cwd(), "tmp");

const cooldowns = new Map();

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
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

function buildAudioMeta(fileName, contentType, fallbackBase = "audio") {
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
    isMp3: finalExt === "mp3",
  };
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
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

async function apiGet(url, params, timeout = 35000) {
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

async function downloadAudioFromApi(videoUrl, outputPath) {
  const response = await axios.get(API_AUDIO_URL, {
    responseType: "stream",
    timeout: REQUEST_TIMEOUT,
    params: {
      mode: "file",
      quality: AUDIO_QUALITY,
      url: videoUrl,
    },
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

  await pipeline(response.data, fs.createWriteStream(outputPath));

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
  const audioMeta = buildAudioMeta(
    detectedName || path.basename(outputPath),
    response.headers?.["content-type"],
    "audio"
  );

  return {
    path: outputPath,
    size,
    fileName: audioMeta.fileName,
    mimetype: audioMeta.mimetype,
    isMp3: audioMeta.isMp3,
  };
}

async function convertToMp3(inputPath, outputPath) {
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
        resolve();
        return;
      }
      reject(new Error(errorText.trim() || `ffmpeg salió con código ${code}`));
    });
  });
}

async function sendAudioFile(sock, from, quoted, { filePath, fileName, mimetype, title }) {
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
    console.error("send audio failed:", e1?.message || e1);

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
  command: ["ytmp3", "play", "ytdlmp3"],
  category: "descarga",

  run: async (ctx) => {
    const { sock, from } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const userId = `${from}:audio`;

    let sourceFile = null;
    let finalMp3 = null;

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

        const search = await resolveSearch(rawInput);
        videoUrl = search.videoUrl;
        title = search.title;
        thumbnail = search.thumbnail;
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
      sourceFile = path.join(TMP_DIR, `${stamp}-source.bin`);
      finalMp3 = path.join(TMP_DIR, `${stamp}-audio.mp3`);

      const finalTitle = safeFileName(title || "audio");
      const downloadedAudio = await downloadAudioFromApi(videoUrl, sourceFile);

      let filePathToSend = downloadedAudio.path;
      let fileNameToSend = downloadedAudio.fileName;
      let mimeToSend = downloadedAudio.mimetype;

      if (!downloadedAudio.isMp3) {
        try {
          await convertToMp3(sourceFile, finalMp3);
          filePathToSend = finalMp3;
          fileNameToSend = `${finalTitle}.mp3`;
          mimeToSend = "audio/mpeg";
        } catch (convertError) {
          console.warn(
            "YTMP3 conversion fallback:",
            convertError?.message || convertError
          );
        }
      }

      await sendAudioFile(sock, from, quoted, {
        filePath: filePathToSend,
        fileName: fileNameToSend,
        mimetype: mimeToSend,
        title: finalTitle,
      });
    } catch (err) {
      console.error("YTMP3 ERROR:", err?.message || err);
      cooldowns.delete(userId);

      await sock.sendMessage(from, {
        text: `❌ ${String(err?.message || "Error al procesar el audio.")}`,
        ...global.channelInfo,
      });
    } finally {
      try {
        if (sourceFile && fs.existsSync(sourceFile)) {
          fs.unlinkSync(sourceFile);
        }
      } catch {}

      try {
        if (finalMp3 && fs.existsSync(finalMp3)) {
          fs.unlinkSync(finalMp3);
        }
      } catch {}
    }
  },
};
