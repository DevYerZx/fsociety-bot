import path from "path";
import { getQuoted, getPrefix } from "./_shared.js";
import { writeJsonAtomic } from "../../lib/json-store.js";
import { humanBytes } from "../../lib/subbot-download-policy.js";

const SETTINGS_FILE = path.join(process.cwd(), "settings", "settings.json");
const SIZE_PATTERN = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i;

function ensureSubbotDownloads(settings) {
  settings.system = settings.system && typeof settings.system === "object" ? settings.system : {};
  settings.system.subbotDownloads =
    settings.system.subbotDownloads && typeof settings.system.subbotDownloads === "object"
      ? settings.system.subbotDownloads
      : {};

  if (settings.system.subbotDownloads.enabled !== false) {
    settings.system.subbotDownloads.enabled = true;
  }

  const currentMax = Math.floor(
    Number(settings.system.subbotDownloads.maxBytes || 35 * 1024 * 1024)
  );
  settings.system.subbotDownloads.maxBytes = Number.isFinite(currentMax) && currentMax > 0
    ? currentMax
    : 35 * 1024 * 1024;

  if (settings.system.subbotDownloads.vipUnlimited !== false) {
    settings.system.subbotDownloads.vipUnlimited = true;
  }

  if (!Array.isArray(settings.system.subbotDownloads.blockedCommands)) {
    settings.system.subbotDownloads.blockedCommands = [];
  }

  return settings.system.subbotDownloads;
}

function saveSettings(settings) {
  writeJsonAtomic(SETTINGS_FILE, settings);
}

function parseSizeToBytes(value = "") {
  const match = String(value || "")
    .trim()
    .toLowerCase()
    .match(SIZE_PATTERN);

  if (!match) return 0;

  const amount = Number(match[1] || 0);
  const unit = String(match[2] || "mb").toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  const multiplier =
    unit === "b"
      ? 1
      : unit === "kb"
        ? 1024
        : unit === "gb"
          ? 1024 * 1024 * 1024
          : 1024 * 1024;

  return Math.floor(amount * multiplier);
}

function formatStatus(settings) {
  const policy = ensureSubbotDownloads(settings);
  return (
    `╭━━〔 ⚙️ *SUBBOT LIMIT* 〕━━⬣\n` +
    `┃ Estado: *${policy.enabled ? "ACTIVO" : "APAGADO"}*\n` +
    `┃ Limite actual: *${humanBytes(policy.maxBytes)}*\n` +
    `┃ VIP sin limite: *${policy.vipUnlimited ? "SI" : "NO"}*\n` +
    `┃ Bloqueados: *${policy.blockedCommands.length || "por defecto"}*\n` +
    `╰━━━━━━━━━━━━━━━━━━━━⬣`
  );
}

export default {
  name: "subbotlimit",
  command: ["subbotlimit", "limitsubbot", "subbotdl"],
  category: "admin",
  description: "Configura el limite de descargas para subbots desde el bot principal",
  ownerOnly: true,

  run: async ({ sock, msg, from, args = [], settings, botId }) => {
    const quoted = getQuoted(msg);
    const prefix = getPrefix(settings);

    if (String(botId || "").toLowerCase() !== "main") {
      return sock.sendMessage(
        from,
        {
          text: "Este comando solo se puede usar desde el bot principal (MAIN).",
          ...global.channelInfo,
        },
        quoted
      );
    }

    const policy = ensureSubbotDownloads(settings);
    const action = String(args[0] || "status").trim().toLowerCase();

    if (action === "status" || action === "info" || action === "ver") {
      return sock.sendMessage(from, { text: formatStatus(settings), ...global.channelInfo }, quoted);
    }

    if (action === "on" || action === "activar") {
      policy.enabled = true;
      saveSettings(settings);
      return sock.sendMessage(
        from,
        {
          text:
            `╭━━〔 ✅ *SUBBOT LIMIT* 〕━━⬣\n` +
            `┃ Limite activado correctamente\n` +
            `┃ Actual: *${humanBytes(policy.maxBytes)}*\n` +
            `╰━━━━━━━━━━━━━━━━━━━━⬣`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "off" || action === "desactivar") {
      policy.enabled = false;
      saveSettings(settings);
      return sock.sendMessage(
        from,
        {
          text:
            `╭━━〔 ⚠️ *SUBBOT LIMIT* 〕━━⬣\n` +
            `┃ Limite desactivado para subbots\n` +
            `╰━━━━━━━━━━━━━━━━━━━━⬣`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "vip") {
      const mode = String(args[1] || "").trim().toLowerCase();
      if (!["on", "off", "si", "no"].includes(mode)) {
        return sock.sendMessage(
          from,
          {
            text:
              `Usa:\n` +
              `${prefix}subbotlimit vip on\n` +
              `${prefix}subbotlimit vip off`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      policy.vipUnlimited = mode === "on" || mode === "si";
      saveSettings(settings);
      return sock.sendMessage(
        from,
        {
          text:
            `╭━━〔 💎 *SUBBOT LIMIT VIP* 〕━━⬣\n` +
            `┃ VIP sin limite: *${policy.vipUnlimited ? "ACTIVADO" : "DESACTIVADO"}*\n` +
            `╰━━━━━━━━━━━━━━━━━━━━⬣`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    const sizeInput = action;
    const nextBytes = parseSizeToBytes(sizeInput);
    if (!nextBytes) {
      return sock.sendMessage(
        from,
        {
          text:
            `Usa:\n` +
            `${prefix}subbotlimit 50mb\n` +
            `${prefix}subbotlimit 100mb\n` +
            `${prefix}subbotlimit status\n` +
            `${prefix}subbotlimit vip on`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    policy.enabled = true;
    policy.maxBytes = Math.max(1 * 1024 * 1024, Math.min(nextBytes, 2 * 1024 * 1024 * 1024));
    saveSettings(settings);

    return sock.sendMessage(
      from,
      {
        text:
          `╭━━〔 ✅ *NUEVO LIMITE* 〕━━⬣\n` +
          `┃ Subbots: *${humanBytes(policy.maxBytes)}*\n` +
          `┃ VIP sin limite: *${policy.vipUnlimited ? "SI" : "NO"}*\n` +
          `╰━━━━━━━━━━━━━━━━━━━━⬣`,
        ...global.channelInfo,
      },
      quoted
    );
  },
};
