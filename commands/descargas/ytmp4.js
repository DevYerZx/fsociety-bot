import axios from "axios";

const API_BASE = "https://dv-yer-api.online";
const API_VIDEO_URL = `${API_BASE}/ytdlmp4`;
const API_SEARCH_URL = `${API_BASE}/ytsearch`;

const COOLDOWN_TIME = 15 * 1000;
const VIDEO_QUALITY = "360p";
const cooldowns = new Map();

function safeFileName(name) {
  return (
    String(name || "video")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "video"
  );
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function getCooldownRemaining(untilMs) {
  return Math.max(0, Math.ceil((untilMs - Date.now()) / 1000));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractApiError(data, status) {
  return (
    data?.detail ||
    data?.error?.message ||
    data?.message ||
    (status ? `HTTP ${status}` : "Error de API")
  );
}

function pickDownloadUrl(data) {
  return (
    data?.download_url_full ||
    data?.download_url ||
    data?.url ||
    data?.result?.download_url_full ||
    data?.result?.download_url ||
    data?.result?.url ||
    ""
  );
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
    throw new Error("No se encontró el video.");
  }

  return {
    videoUrl: first.url,
    title: safeFileName(first.title || "video"),
    thumbnail: first.thumbnail || null,
  };
}

async function resolveRedirectTarget(url) {
  let lastError = "No se pudo resolver la redirección final.";

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: 35000,
        maxRedirects: 0,
        validateStatus: () => true,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.location;
        if (location) return location;
      }

      if (response.status >= 200 && response.status < 300) {
        return url;
      }

      lastError = extractApiError(response.data, response.status);
    } catch (error) {
      lastError = error?.message || "redirect failed";
    }

    await sleep(700 * attempt);
  }

  throw new Error(lastError);
}

async function requestVideoLink(videoUrl) {
  let lastError = "No se pudo obtener el video.";

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await apiGet(API_VIDEO_URL, {
        mode: "link",
        quality: VIDEO_QUALITY,
        url: videoUrl,
      });

      const redirectUrl = pickDownloadUrl(data);
      if (!redirectUrl) {
        throw new Error("La API no devolvió download_url.");
      }

      const directUrl = await resolveRedirectTarget(redirectUrl);

      return {
        title: safeFileName(data?.title || data?.result?.title || "video"),
        directUrl,
      };
    } catch (error) {
      lastError = error?.message || "Error desconocido";
      await sleep(900 * attempt);
    }
  }

  throw new Error(lastError);
}

async function sendVideoByUrl(sock, from, quoted, { directUrl, title }) {
  try {
    await sock.sendMessage(
      from,
      {
        video: { url: directUrl },
        mimetype: "video/mp4",
        caption: `🎬 ${title}`,
        ...global.channelInfo,
      },
      quoted
    );
    return "video";
  } catch (e1) {
    console.error("send video by url failed:", e1?.message || e1);

    await sock.sendMessage(
      from,
      {
        document: { url: directUrl },
        mimetype: "video/mp4",
        fileName: `${title}.mp4`,
        caption: `📄 Enviado como documento\n🎬 ${title}`,
        ...global.channelInfo,
      },
      quoted
    );
    return "document";
  }
}

export default {
  command: ["ytmp4"],
  category: "descarga",

  run: async (ctx) => {
    const { sock, from, args } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const userId = from;

    const until = cooldowns.get(userId);
    if (until && until > Date.now()) {
      return sock.sendMessage(from, {
        text: `⏳ Espera ${getCooldownRemaining(until)}s`,
        ...global.channelInfo,
      });
    }

    cooldowns.set(userId, Date.now() + COOLDOWN_TIME);

    try {
      if (!args?.length) {
        cooldowns.delete(userId);
        return sock.sendMessage(from, {
          text: "❌ Uso: .ytmp4 <nombre o link>",
          ...global.channelInfo,
        });
      }

      const query = args.join(" ").trim();
      let videoUrl = query;
      let title = "video";
      let thumbnail = null;

      if (!isHttpUrl(query)) {
        const search = await resolveSearch(query);
        videoUrl = search.videoUrl;
        title = search.title;
        thumbnail = search.thumbnail;
      }

      await sock.sendMessage(
        from,
        thumbnail
          ? {
              image: { url: thumbnail },
              caption: `⬇️ Preparando video...\n\n🎬 ${title}\n🎚️ Calidad: ${VIDEO_QUALITY}`,
              ...global.channelInfo,
            }
          : {
              text: `⬇️ Preparando video...\n\n🎬 ${title}\n🎚️ Calidad: ${VIDEO_QUALITY}`,
              ...global.channelInfo,
            },
        quoted
      );

      const info = await requestVideoLink(videoUrl);
      title = safeFileName(info.title || title);

      await sendVideoByUrl(sock, from, quoted, {
        directUrl: info.directUrl,
        title,
      });
    } catch (err) {
      console.error("YTMP4 ERROR:", err?.message || err);
      cooldowns.delete(userId);

      await sock.sendMessage(from, {
        text: `❌ ${String(err?.message || "Error al procesar el video.")}`,
        ...global.channelInfo,
      });
    }
  },
};

