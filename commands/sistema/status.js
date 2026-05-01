import fs from "fs";
import os from "os";
import path from "path";

function safeJsonParse(raw) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
  } catch {
    return null;
  }
}

function formatUptime(seconds) {
  seconds = Math.floor(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

function formatBytes(bytes = 0) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function estimateCpuLoadPercent() {
  try {
    const load = os.loadavg()?.[0] || 0;
    const cores = (os.cpus() || []).length || 1;
    const normalized = Math.max(0, (load / cores) * 100);
    return `${normalized.toFixed(2)}%`;
  } catch {
    return "N/A";
  }
}

function getPrefixLabel(settings) {
  const noPrefix = settings?.noPrefix === true;
  const p = settings?.prefix;

  if (noPrefix) return "SIN PREFIJO";
  if (Array.isArray(p) && p.length) return p.join(" | ");
  if (typeof p === "string" && p.trim()) return p.trim();
  return "SIN PREFIJO";
}

function readFileState(filePath, groupId, fallback = false) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = safeJsonParse(raw);

    if (Array.isArray(data)) {
      return data.includes(groupId);
    }

    if (data && typeof data === "object") {
      const entry = data[groupId];
      if (typeof entry === "boolean") return entry;
      if (entry && typeof entry === "object" && "enabled" in entry) {
        return entry.enabled === true;
      }
    }

    return fallback;
  } catch {
    return fallback;
  }
}

function countVipUsers() {
  const vipFile = path.join(process.cwd(), "settings", "vip.json");
  try {
    if (!fs.existsSync(vipFile)) return 0;
    const raw = fs.readFileSync(vipFile, "utf-8");
    const data = safeJsonParse(raw) || {};
    const users = data.users && typeof data.users === "object" ? data.users : {};
    return Object.keys(users).length;
  } catch {
    return 0;
  }
}

function getSubbotLabel() {
  const bots = global.botRuntime?.listBots?.({ includeMain: true }) || [];
  const connected = bots.filter((bot) => bot.connected).length;
  const total = bots.length;
  return `${connected}/${total}`;
}

function buildMainPanel({ settings, comandos, vipCount }) {
  const mem = process.memoryUsage();
  const totalRam = os.totalmem();
  const freeRam = os.freemem();
  const usedRam = Math.max(0, totalRam - freeRam);
  const host = os.hostname();
  const uptime = formatUptime(process.uptime());
  const hostUptime = formatUptime(os.uptime());
  const cpuLoad = estimateCpuLoadPercent();

  return [
    "╭━━〔 TERMINAL FSOCIETY 〕━━⬣",
    "┃  .-=-=-=-=-=-=-=-=-=-=-=-.",
    "┃  |      FSOCIETY NODE    |",
    "┃  '=-=-=-=-=-=-=-=-=-=-=-='",
    "┃",
    `┃ 👑 Owner      : ${settings.ownerName || "Owner"}`,
    `┃ 🤖 Bot        : ${settings.botName || "BOT"}`,
    `┃ 🌐 Host       : ${host}`,
    `┃ 🧩 Comandos   : ${comandos?.size ?? "?"}`,
    `┃ 🤖 Sesiones   : ${getSubbotLabel()}`,
    `┃ 💎 VIP        : ${vipCount}`,
    "┃",
    `┃ ⏱ Uptime Bot : ${uptime}`,
    `┃ ⌛ Uptime VPS : ${hostUptime}`,
    `┃ ⚙ CPU Load   : ${cpuLoad}`,
    `┃ 🧠 RAM Host   : ${formatBytes(usedRam)} / ${formatBytes(totalRam)}`,
    `┃ 📦 RAM Node   : ${formatBytes(mem.rss)}`,
    `┃ 🔧 Prefix     : ${getPrefixLabel(settings)}`,
    `┃ 📰 News       : ${settings?.newsletter?.enabled ? "ON" : "OFF"}`,
    "╰━━━━━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function buildGroupPanel({ welcomeOn, modoAdmiOn, antilinkOn, antifakeOn }) {
  return [
    "╭─〔 CONTROL GRUPO 〕",
    `│ Welcome    : ${welcomeOn ? "ON" : "OFF"}`,
    `│ ModoAdmin  : ${modoAdmiOn ? "ON" : "OFF"}`,
    `│ Antilink   : ${antilinkOn ? "ON" : "OFF"}`,
    `│ Antifake   : ${antifakeOn ? "ON" : "OFF"}`,
    "╰──────────────⬣",
  ].join("\n");
}

export default {
  name: "status",
  command: ["status", "estado"],
  category: "sistema",
  description: "Panel de estado del bot",

  run: async ({ sock, msg, from, settings, comandos, esGrupo }) => {
    const dbDir = path.join(process.cwd(), "database");
    const welcomeOn = readFileState(path.join(dbDir, "welcome.json"), from, false);
    const modoAdmiOn = readFileState(path.join(dbDir, "modoadmi.json"), from, false);
    const antilinkOn = readFileState(path.join(dbDir, "antilink.json"), from, false);
    const antifakeOn = readFileState(path.join(dbDir, "antifake.json"), from, false);
    const vipCount = countVipUsers();

    const sections = [
      buildMainPanel({ settings, comandos, vipCount }),
      esGrupo
        ? buildGroupPanel({ welcomeOn, modoAdmiOn, antilinkOn, antifakeOn })
        : [
            "╭─〔 CHAT PRIVADO 〕",
            "│ Panel abierto en mensaje privado.",
            "╰──────────────⬣",
          ].join("\n"),
    ];

    return sock.sendMessage(
      from,
      {
        text: sections.join("\n\n"),
        ...global.channelInfo,
      },
      { quoted: msg }
    );
  },
};
