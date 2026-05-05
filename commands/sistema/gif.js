import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import axios from "axios";
import ffmpeg from "fluent-ffmpeg";
import { randomUUID } from "crypto";
import { buildDvyerUrl, getDvyerBaseUrl } from "../../lib/api-manager.js";
import { getPrimaryPrefix } from "../../lib/json-store.js";

const TMP_DIR = path.join(os.tmpdir(), "dvyer-tenor-gif");
const API_TIMEOUT = 45_000;

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function usage(prefix = ".") {
  return [
    "╭━━〔 *🖼️ GIF → STICKER* 〕━━⬣",
    "┃ Usa:",
    `┃ *${prefix}gif <texto>*`,
    "┃",
    `┃ Ejemplo: *${prefix}gif gato bailando*`,
    "╰━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function parseGifInput(args = []) {
  const raw = cleanText(Array.isArray(args) ? args.join(" ") : "");
  if (!raw) return { query: "", more: false };
  const more = /\s--more\s*$/i.test(raw);
  const query = cleanText(raw.replace(/\s--more\s*$/i, ""));
  return { query, more };
}

async function ensureTmpDir() {
  await fsp.mkdir(TMP_DIR, { recursive: true });
}

function ffmpegToWebp(input, output) {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .outputOptions([
        "-vcodec",
        "libwebp",
        "-vf",
        "fps=15,scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000",
        "-lossless",
        "1",
        "-qscale",
        "60",
        "-preset",
        "default",
        "-loop",
        "0",
        "-an",
        "-vsync",
        "0",
      ])
      .toFormat("webp")
      .on("end", resolve)
      .on("error", reject)
      .save(output);
  });
}

async function buildStickerFromGifUrl(gifUrl) {
  await ensureTmpDir();
  const gifPath = path.join(TMP_DIR, `${Date.now()}-${randomUUID()}.gif`);
  const webpPath = path.join(TMP_DIR, `${Date.now()}-${randomUUID()}.webp`);

  try {
    const response = await axios.get(gifUrl, {
      responseType: "arraybuffer",
      timeout: API_TIMEOUT,
      maxContentLength: 20 * 1024 * 1024,
      validateStatus: (status) => status >= 200 && status < 400,
    });
    await fsp.writeFile(gifPath, Buffer.from(response.data || []));
    await ffmpegToWebp(gifPath, webpPath);
    return await fsp.readFile(webpPath);
  } finally {
    await Promise.allSettled([fsp.unlink(gifPath), fsp.unlink(webpPath)]);
  }
}

export default {
  name: "gif",
  command: ["gif"],
  category: "herramientas",
  description: "Busca un GIF en Tenor y lo envia en sticker",

  run: async ({ sock, msg, from, args = [], settings }) => {
    const parsedInput = parseGifInput(args);
    const query = parsedInput.query;
    const isMoreRequest = parsedInput.more;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const prefix = getPrimaryPrefix(settings);

    if (!query) {
      return sock.sendMessage(
        from,
        { text: usage(prefix), ...global.channelInfo },
        quoted
      );
    }

    try {
      const publicApiEndpoint = `${getDvyerBaseUrl().replace(/\/+$/, "")}/search/tenor/gif`;
      await sock.sendMessage(
        from,
        {
          text: `🔎 GIF buscando...\n🌐 API: ${publicApiEndpoint}`,
          ...global.channelInfo,
        },
        quoted
      );

      const endpoint = buildDvyerUrl("/search/tenor/gif");
      const response = await axios.get(endpoint, {
        timeout: API_TIMEOUT,
        params: { q: query, limit: 16 },
        validateStatus: () => true,
      });

      const data = response.data || {};
      if (response.status >= 400 || !data.ok) {
        throw new Error(
          data.detail ||
            data.error?.message ||
            data.message ||
            `HTTP ${response.status}`
        );
      }

      const allResults = Array.isArray(data.results)
        ? data.results.filter((item) => item?.url_full || item?.url || item?.preview_url)
        : [];
      const selectedResults = isMoreRequest
        ? allResults.slice(4, 9)
        : allResults.slice(0, 4);
      if (!selectedResults.length) {
        throw new Error("No encontré un GIF válido para esa búsqueda.");
      }

      for (const item of selectedResults) {
        const gifUrl = String(item?.url_full || item?.url || item?.preview_url || "").trim();
        if (!gifUrl) continue;
        const stickerBuffer = await buildStickerFromGifUrl(gifUrl);
        await sock.sendMessage(
          from,
          { sticker: stickerBuffer, ...global.channelInfo },
          quoted
        );
      }

      if (!isMoreRequest) {
        const moreCommand = `${prefix}gif ${query} --more`;
        try {
          await sock.sendMessage(
            from,
            {
              text: "¿Quieres más resultados?",
              footer: "FSOCIETY GIF",
              interactiveButtons: [
                {
                  name: "quick_reply",
                  buttonParamsJson: JSON.stringify({
                    display_text: "Otros 5",
                    id: moreCommand,
                  }),
                },
              ],
              ...global.channelInfo,
            },
            quoted
          );
        } catch {
          await sock.sendMessage(
            from,
            {
              text: `Para otros 5 usa: *${moreCommand}*`,
              ...global.channelInfo,
            },
            quoted
          );
        }
      }
    } catch (error) {
      const message = cleanText(
        error?.message || "No pude generar el sticker GIF en este momento."
      );
      return sock.sendMessage(
        from,
        { text: `❌ ${message}`, ...global.channelInfo },
        quoted
      );
    }
  },
};
