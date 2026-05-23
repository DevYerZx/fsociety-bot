import path from "path";
import { createScheduledJsonStore, normalizeJidUser } from "../../lib/json-store.js";
import {
  getParticipantDisplayTag,
  getParticipantMentionJid,
} from "../../lib/group-compat.js";

const FILE = path.join(process.cwd(), "database", "antiflood.json");
const store = createScheduledJsonStore(FILE, () => ({
  groups: {},
}));
const liveMap = new Map();

function ensureGroup(groupId) {
  const key = String(groupId || "").trim();
  if (!store.state.groups[key]) {
    store.state.groups[key] = {
      enabled: false,
      limit: 6,
      windowSeconds: 8,
    };
  }
  return store.state.groups[key];
}

export default {
  name: "antiflood",
  command: ["antiflood"],
  category: "grupo",
  description: "Controla flood de mensajes en grupos",
  groupOnly: true,
  adminOnly: true,

  run: async ({ sock, msg, from, args = [] }) => {
    const action = String(args[0] || "status").trim().toLowerCase();
    const config = ensureGroup(from);

    if (action === "on" || action === "off") {
      config.enabled = action === "on";
      store.scheduleSave();
      return sock.sendMessage(from, { text: `Antiflood: *${config.enabled ? "ENCENDIDO" : "APAGADO"}*`, ...global.channelInfo }, { quoted: msg });
    }

    if (action === "config") {
      config.limit = Math.max(3, Math.min(20, Number(args[1] || config.limit)));
      config.windowSeconds = Math.max(3, Math.min(60, Number(args[2] || config.windowSeconds)));
      store.scheduleSave();
      return sock.sendMessage(from, { text: `Antiflood actualizado a ${config.limit} mensajes / ${config.windowSeconds}s`, ...global.channelInfo }, { quoted: msg });
    }

    return sock.sendMessage(
      from,
      {
        text:
          `*ANTIFLOOD*\n\n` +
          `Estado: *${config.enabled ? "ENCENDIDO" : "APAGADO"}*\n` +
          `Limite: *${config.limit}*\n` +
          `Ventana: *${config.windowSeconds}s*`,
        ...global.channelInfo,
      },
      { quoted: msg }
    );
  },

  onMessage: async ({ sock, msg, from, sender, esGrupo, esAdmin, esOwner, groupMetadata }) => {
    if (!esGrupo || esAdmin || esOwner) return false;
    const config = ensureGroup(from);
    if (!config.enabled) return false;

    const key = `${from}|${normalizeJidUser(sender)}`;
    const now = Date.now();
    const windowMs = Number(config.windowSeconds || 8) * 1000;
    const bucket = liveMap.get(key) || [];
    const fresh = bucket.filter((timestamp) => now - timestamp <= windowMs);
    fresh.push(now);
    liveMap.set(key, fresh);

    if (fresh.length < Number(config.limit || 6)) return false;

    try {
      await sock.sendMessage(from, { delete: msg.key, ...global.channelInfo });
    } catch {}

    const mentionJid = getParticipantMentionJid(groupMetadata || {}, null, sender);

    await sock.sendMessage(
      from,
      {
        text: `Antiflood: ${getParticipantDisplayTag(null, sender)} baja la velocidad de mensajes.`,
        mentions: mentionJid ? [mentionJid] : [],

      },
      {}
    );
    liveMap.set(key, []);
    return true;
  },
};
