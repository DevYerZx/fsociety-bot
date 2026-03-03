import fs from "fs";
import path from "path";
import axios from "axios";
import yts from "yt-search";
import { execSync } from "child_process";

const API_URL = "https://mayapi.ooguy.com/ytdl";

// 🔑 SISTEMA MULTI-KEY INTELIGENTE
const API_KEYS = [
  { key: "may-ad025b11", blockedUntil: 0, failures: 0 },
  { key: "may-3e5a03fa", blockedUntil: 0, failures: 0 },
  { key: "may-1285f1e9", blockedUntil: 0, failures: 0 },
  { key: "may-5793b618", blockedUntil: 0, failures: 0 },
  { key: "may-72e941fc", blockedUntil: 0, failures: 0 },
  { key: "may-5d597e52", blockedUntil: 0, failures: 0 },
];

const RETRY_TIME = 30 * 60 * 1000; // 30 minutos

const COOLDOWN_TIME = 15 * 1000;
const DEFAULT_QUALITY = "360p";

const TMP_DIR = path.join(process.cwd(), "tmp");

// límites
const MAX_VIDEO_BYTES = 70 * 1024 * 1024;
const MAX_DOC_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_FREE_BYTES = 350 * 1024 * 1024;
const MIN_VALID_BYTES = 300000;
const CLEANUP_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const cooldowns = new Map();
const locks = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

function safeFileName(name) {
  return (String(name || "video")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "video");
}

function isHttpUrl(s) {
  return /^https?:\/\//i.test(String(s || ""));
}

function parseQuality(args) {
  const q = args.find((a) => /^\d{3,4}p$/i.test(a));
  return (q || DEFAULT_QUALITY).toLowerCase();
}

function withoutQuality(args) {
  return args.filter((a) => !/^\d{3,4}p$/i.test(a));
}

function getCooldownRemaining(untilMs) {
  return Math.max(0, Math.ceil((untilMs - Date.now()) / 1000));
}

function getYoutubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.replace("/", "").trim();
    const v = u.searchParams.get("v");
    if (v) return v.trim();
    return null;
  } catch {
    return null;
  }
}

function cleanupTmp(maxAgeMs = CLEANUP_MAX_AGE_MS) {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(TMP_DIR)) {
      const p = path.join(TMP_DIR, f);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && (now - st.mtimeMs) > maxAgeMs) fs.unlinkSync(p);
      } catch {}
    }
  } catch {}
}

function getFreeBytes(dir) {
  try {
    const out = execSync(`df -k "${dir}" | tail -1 | awk '{print $4}'`).toString().trim();
    const freeKb = Number(out);
    return Number.isFinite(freeKb) ? freeKb * 1024 : null;
  } catch {
    return null;
  }
}

// 🔥 FUNCIÓN INTELIGENTE MULTI-KEY
async function fetchDirectMediaUrl({ videoUrl, quality }) {

  const availableKey = API_KEYS.find(k => Date.now() > k.blockedUntil);

  if (!availableKey) {
    throw new Error("⚠️ Todos los servidores están temporalmente ocupados. Intenta en unos minutos.");
  }

  try {

    console.log("🔑 Usando API KEY:", availableKey.key);

    const { data, status } = await axios.get(API_URL, {
      timeout: 25000,
      params: { url: videoUrl, quality, apikey: availableKey.key },
      validateStatus: (s) => s >= 200 && s < 500,
    });

    if (
      status === 429 ||
      !data?.status ||
      String(data?.message || "").toLowerCase().includes("limit") ||
      String(data?.message || "").toLowerCase().includes("quota")
    ) {

      availableKey.blockedUntil = Date.now() + RETRY_TIME;
      availableKey.failures = 0;

      console.log(`🚫 KEY bloqueada 30 min: ${availableKey.key}`);

      return fetchDirectMediaUrl({ videoUrl, quality });
    }

    availableKey.failures = 0;

    return {
      title: data?.result?.title || "video",
      directUrl: data.result.url,
    };

  } catch (error) {

    availableKey.failures++;

    if (availableKey.failures >= 3) {
      availableKey.blockedUntil = Date.now() + RETRY_TIME;
      availableKey.failures = 0;
      console.log(`🚫 KEY bloqueada por 3 fallos: ${availableKey.key}`);
    }

    throw error;
  }
}

export default {
  command: ["ytmp4"],
  category: "descarga",

  run: async (ctx) => {
    const { sock, from, args } = ctx;
    const msg = ctx.m || ctx.msg || null;
    const userId = from;

    if (locks.has(from)) {
      return sock.sendMessage(from, { text: "⏳ Ya estoy procesando otro video aquí.", ...global.channelInfo });
    }

    const until = cooldowns.get(userId);
    if (until && until > Date.now()) {
      return sock.sendMessage(from, {
        text: `⏳ Espera ${getCooldownRemaining(until)}s`,
        ...global.channelInfo,
      });
    }
    cooldowns.set(userId, Date.now() + COOLDOWN_TIME);

    const quoted = msg?.key ? { quoted: msg } : undefined;
    let outFile = null;

    try {
      locks.add(from);
      cleanupTmp();

      if (!args?.length) {
        cooldowns.delete(userId);
        return sock.sendMessage(from, { text: "❌ Uso: .ytmp4 (360p) <nombre o link>", ...global.channelInfo });
      }

      const quality = parseQuality(args);
      const query = withoutQuality(args).join(" ").trim();
      if (!query) {
        cooldowns.delete(userId);
        return sock.sendMessage(from, { text: "❌ Debes poner un nombre o link.", ...global.channelInfo });
      }

      const meta = await yts(query);
      const first = meta?.videos?.[0];
      if (!first) throw new Error("❌ No se encontró el video.");

      let videoUrl = first.url;
      let title = safeFileName(first.title);

      await sock.sendMessage(from, {
        image: { url: first.thumbnail },
        caption: `⬇️ Procesando...\n\n🎬 ${title}\n🎚️ Calidad: ${quality}`,
        ...global.channelInfo,
      }, quoted);

      const info = await fetchDirectMediaUrl({ videoUrl, quality });
      title = safeFileName(info.title || title);

      await sock.sendMessage(from, {
        video: { url: info.directUrl },
        mimetype: "video/mp4",
        caption: `🎬 ${title}`,
        ...global.channelInfo,
      }, quoted);

    } catch (err) {
      console.error("YTMP4 PRO ERROR:", err?.message || err);
      cooldowns.delete(userId);
      await sock.sendMessage(from, {
        text: `❌ ${String(err?.message || "Error al procesar el video.")}`,
        ...global.channelInfo,
      });
    } finally {
      locks.delete(from);
      try { if (outFile && fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch {}
    }
  },
};