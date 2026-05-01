import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";
import { getDvyerBaseUrl, withDvyerApiKey } from "../../lib/api-manager.js";
import { sanitizeProviderMessage } from "./_errorMessages.js";

const RESULT_LIMIT = 10;
const DEFAULT_TIMEOUT_MS = 20000;
const LEGACY_DVYER_BASE_URL = "https://dv-yer-api.online";
const PREFERRED_DVYER_BASE_URL = "https://dvyer-api.onrender.com";
const TMP_DIR = path.join(os.tmpdir(), "dvyer-cuevana");
const MAX_VIDEO_BYTES = 120 * 1024 * 1024;
const VIDEO_AS_DOCUMENT_THRESHOLD = 60 * 1024 * 1024;
const MIN_FILE_BYTES = 20000;

function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }
  return String(settings?.prefix || ".").trim() || ".";
}

function clipText(value = "", max = 72) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(1, max - 3))}...`;
}

function apiBaseLabel() {
  const configured = String(getDvyerBaseUrl() || "")
    .trim()
    .replace(/\/+$/, "");

  if (!configured || configured === LEGACY_DVYER_BASE_URL) {
    return PREFERRED_DVYER_BASE_URL;
  }

  return configured;
}

function buildApiUrl(endpoint, params = {}) {
  const base = apiBaseLabel();
  const suffix = String(endpoint || "").trim();
  const full =
    !suffix ? base : suffix.startsWith("/") ? `${base}${suffix}` : `${base}/${suffix}`;
  const url = new URL(full);
  const authParams = withDvyerApiKey(params);
  for (const [key, value] of Object.entries(authParams)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function fetchJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = null;
    }
    if (!res.ok) {
      const detail = data?.detail || data?.error || text || res.statusText;
      throw new Error(`HTTP ${res.status}: ${detail}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function safeFileName(value = "") {
  return String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function parseFileNameFromDisposition(value = "") {
  const text = String(value || "");
  const utfMatch = /filename\*=UTF-8''([^;]+)/i.exec(text);
  if (utfMatch?.[1]) {
    try {
      return decodeURIComponent(utfMatch[1]);
    } catch {}
  }
  const match = /filename="?([^\";]+)"?/i.exec(text);
  return match?.[1] || "";
}

async function downloadVideo(url, title = "cuevana") {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }

  const tempName = `${Date.now()}-${randomUUID()}.mp4`;
  const tempPath = path.join(TMP_DIR, tempName);

  const response = await axios.get(url, {
    responseType: "stream",
    timeout: DEFAULT_TIMEOUT_MS * 6,
    maxRedirects: 5,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
      Accept: "*/*",
      Referer: `${apiBaseLabel()}/`,
    },
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    throw new Error(`Error al descargar: HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers?.["content-length"] || 0);
  if (contentLength && contentLength > MAX_VIDEO_BYTES) {
    throw new Error("El video es demasiado grande para enviarlo por WhatsApp.");
  }

  let downloaded = 0;
  response.data.on("data", (chunk) => {
    downloaded += chunk.length;
    if (downloaded > MAX_VIDEO_BYTES) {
      response.data.destroy(new Error("El video es demasiado grande para enviarlo por WhatsApp."));
    }
  });

  try {
    await pipeline(response.data, fs.createWriteStream(tempPath));
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    throw error;
  }

  if (!fs.existsSync(tempPath)) {
    throw new Error("No se pudo guardar el video.");
  }

  const size = fs.statSync(tempPath).size;
  if (!size || size < MIN_FILE_BYTES) {
    fs.unlinkSync(tempPath);
    throw new Error("El archivo descargado es invalido.");
  }

  const rawName = parseFileNameFromDisposition(response.headers?.["content-disposition"]) || `${title}.mp4`;
  const fileName = safeFileName(rawName.endsWith(".mp4") ? rawName : `${rawName}.mp4`) || "cuevana.mp4";

  return { filePath: tempPath, fileName, size };
}

async function sendVideoMessage(sock, from, quoted, info) {
  if (info.size > VIDEO_AS_DOCUMENT_THRESHOLD) {
    await sock.sendMessage(
      from,
      {
        document: { url: info.filePath },
        mimetype: "video/mp4",
        fileName: info.fileName,
        caption: `*FSOCIETY BOT*\n\n🎬 ${info.title || "Cuevana"}\n📦 Enviado como documento`,
        ...global.channelInfo,
      },
      quoted
    );
    return;
  }

  await sock.sendMessage(
    from,
    {
      video: { url: info.filePath },
      mimetype: "video/mp4",
      fileName: info.fileName,
      caption: `*FSOCIETY BOT*\n\n🎬 ${info.title || "Cuevana"}`,
      ...global.channelInfo,
    },
    quoted
  );
}

async function downloadImageBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("No se pudo descargar imagen.");
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function onlyLatino(items = []) {
  return items.filter((item) => String(item?.language || "").toLowerCase().includes("lat"));
}

function buildSearchRows(results, prefix) {
  return results.map((item, idx) => ({
    header: `${idx + 1}`,
    title: clipText(item.title || "Sin titulo", 72),
    description: clipText(
      `${String(item.type || "contenido").toUpperCase()} | ${item.slug || "sin slug"}`,
      72
    ),
    id: `${prefix}cuevanadl ${item.slug} ${item.type || "auto"}`,
  }));
}

function buildEpisodeRows(detail, prefix, maxRows = 40) {
  const rows = [];
  const seasons = Array.isArray(detail?.seasons) ? detail.seasons : [];
  for (const season of seasons) {
    const seasonNumber = season?.number || "?";
    const episodes = Array.isArray(season?.episodes) ? season.episodes : [];
    for (const episode of episodes) {
      const episodeSlug = String(episode?.episode_path || "").trim().split("/").pop();
      if (!episodeSlug) continue;
      const episodeNumber = episode?.episode || "?";
      rows.push({
        header: `T${seasonNumber}E${episodeNumber}`,
        title: clipText(episode?.title || `Episodio ${episodeNumber}`, 72),
        description: clipText(`Serie | Temporada ${seasonNumber}`, 72),
        id: `${prefix}cuevanadl ${episodeSlug} episode`,
      });
      if (rows.length >= maxRows) return rows;
    }
  }
  return rows;
}

function buildServerRows(downloadsAll, directUrl, prefix) {
  const rows = [];
  if (directUrl) {
    rows.push({
      header: "FAST",
      title: "Descarga rapida (Latino)",
      description: "Servidor mas rapido",
      id: `${prefix}cuevanalink ${directUrl}`,
    });
  }

  const latino = onlyLatino(downloadsAll);
  const list = latino.length ? latino : downloadsAll;
  list.forEach((item) => {
    rows.push({
      header: `#${item.index || rows.length + 1}`,
      title: clipText(item.server || "Servidor", 72),
      description: clipText(`${item.language || "Idioma"} | ${item.quality || "Calidad"}`, 72),
      id: `${prefix}cuevanalink ${item.url}`,
    });
  });
  return rows;
}

export default {
  name: "cuevana",
  command: ["cuevana", "cuevanadl", "cuevanalink", "cv"],
  category: "descarga",
  description: "Busca en Cuevana y muestra botones para descargar",

  async run(ctx) {
    const { sock: conn, m, msg, from, args, settings, commandName } = ctx;
    const quoted = (m || msg)?.key ? { quoted: m || msg } : undefined;
    const prefix = getPrefix(settings);
    const cmd = String(commandName || "").toLowerCase();

    if (cmd === "cuevanalink") {
      const rawUrl = String(args.join(" ") || "").trim();
      if (!rawUrl) {
        return conn.sendMessage(
          from,
          { text: `Uso: ${prefix}cuevanalink <url>` },
          quoted
        );
      }
      const apiLink = buildApiUrl("/cuevana/download", { url: rawUrl, lang: "lat" });

      await conn.sendMessage(
        from,
        {
          text: "*FSOCIETY BOT*\n\nDescargando video, espera un momento...",
          ...global.channelInfo,
        },
        quoted
      );

      let downloaded;
      try {
        downloaded = await downloadVideo(apiLink, "cuevana-video");
      } catch (error) {
        console.error("Cuevana download error:", error?.message || error);
        return conn.sendMessage(
          from,
          {
            text: `No pude descargar el video.\n${sanitizeProviderMessage(error, { kind: "video", fallback: "No se pudo descargar el video." })}`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      try {
        await sendVideoMessage(conn, from, quoted, {
          ...downloaded,
          title: "Cuevana",
        });
      } finally {
        if (downloaded?.filePath && fs.existsSync(downloaded.filePath)) {
          fs.unlinkSync(downloaded.filePath);
        }
      }
      return;
    }

    if (cmd === "cuevanadl") {
      const target = String(args[0] || "").trim();
      const type = String(args[1] || "auto").trim().toLowerCase();
      if (!target) {
        return conn.sendMessage(
          from,
          { text: `Uso: ${prefix}cuevanadl <slug> <movie|series|episode>` },
          quoted
        );
      }

      const params = { mode: "detail", lang: "lat", pick: "fast", type };
      if (/^https?:\/\//i.test(target)) params.url = target;
      else params.slug = target;

      const apiUrl = buildApiUrl("/cuevana", params);
      const data = await fetchJson(apiUrl);

      if (!data?.ok) {
        return conn.sendMessage(
          from,
          { text: "No pude obtener el detalle de Cuevana.", ...global.channelInfo },
          quoted
        );
      }

      const contentType = String(data.content_type || data.detail?.type || "").toLowerCase();
      if (contentType === "series") {
        const rows = buildEpisodeRows(data.detail, prefix);
        if (!rows.length) {
          return conn.sendMessage(
            from,
            {
              text: "No encontre episodios para esta serie.",
              ...global.channelInfo,
            },
            quoted
          );
        }

        return conn.sendMessage(
          from,
          {
            text: `Episodios disponibles: ${clipText(data.title || "Serie", 80)}`,
            title: "FSOCIETY BOT",
            subtitle: "Selecciona episodio",
            footer: "Cuevana",
            interactiveButtons: [
              {
                name: "single_select",
                buttonParamsJson: JSON.stringify({
                  title: "Ver episodios",
                  sections: [{ title: "Episodios", rows }],
                }),
              },
            ],
            ...global.channelInfo,
          },
          quoted
        );
      }

      const downloadsAll = Array.isArray(data.downloads_all) ? data.downloads_all : [];
      const rows = buildServerRows(downloadsAll, data.direct_url, prefix);
      if (!rows.length) {
        return conn.sendMessage(
          from,
          {
            text: "No encontre enlaces de descarga.",
            ...global.channelInfo,
          },
          quoted
        );
      }

      return conn.sendMessage(
        from,
        {
          text: `Descargas para: ${clipText(data.title || "Contenido", 80)}`,
          title: "FSOCIETY BOT",
          subtitle: "Selecciona servidor",
          footer: "Cuevana",
          interactiveButtons: [
            {
              name: "single_select",
              buttonParamsJson: JSON.stringify({
                title: "Ver servidores",
                sections: [{ title: "Servidores (Latino)", rows }],
              }),
            },
          ],
          ...global.channelInfo,
        },
        quoted
      );
    }

    const query = Array.isArray(args) ? args.join(" ").trim() : "";
    if (!query) {
      return conn.sendMessage(
        from,
        {
          text: `Uso:\n${prefix}cuevana <titulo>\nEj: ${prefix}cuevana mr robot`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    const apiUrl = buildApiUrl("/cuevana", { mode: "search", q: query, limit: RESULT_LIMIT });
    const data = await fetchJson(apiUrl);
    const results = Array.isArray(data?.results) ? data.results : [];

    if (!results.length) {
      return conn.sendMessage(
        from,
        { text: "No encontre resultados en Cuevana.", ...global.channelInfo },
        quoted
      );
    }

    let thumbBuffer = null;
    try {
      const thumbUrl = results[0]?.poster || results[0]?.backdrop;
      if (thumbUrl) {
        thumbBuffer = await downloadImageBuffer(thumbUrl);
      }
    } catch (error) {
      console.error("Cuevana thumb error:", error?.message || error);
    }

    const rows = buildSearchRows(results, prefix);
    const introPayload = thumbBuffer
      ? {
          image: thumbBuffer,
          caption:
            `*FSOCIETY BOT*\n\n` +
            `Resultado para: *${clipText(query, 80)}*\n` +
            `Primer resultado: *${clipText(results[0]?.title || "Sin titulo", 80)}*\n\n` +
            `Selecciona el contenido que quieres.`,
        }
      : {
        text:
          `*FSOCIETY BOT*\n\n` +
          `Resultado para: *${clipText(query, 80)}*\n\n` +
          `Selecciona el contenido que quieres.`,
      };

    await conn.sendMessage(
      from,
      {
        ...introPayload,
        ...global.channelInfo,
      },
      quoted
    );

    return conn.sendMessage(
      from,
      {
        text: `Resultados para: ${clipText(query, 80)}`,
        title: "FSOCIETY BOT",
        subtitle: "Selecciona contenido",
        footer: "Cuevana",
        interactiveButtons: [
          {
            name: "single_select",
            buttonParamsJson: JSON.stringify({
              title: "Ver resultados",
              sections: [{ title: "Resultados", rows }],
            }),
          },
        ],
        ...global.channelInfo,
      },
      quoted
    );
  },
};
