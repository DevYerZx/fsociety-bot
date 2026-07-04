import path from "path";
import { createScheduledJsonStore, getPrimaryPrefix } from "../../lib/json-store.js";
import { addModerationLog } from "../../lib/group-moderation.js";

const FILE = path.join(process.cwd(), "database", "antiraid.json");
const store = createScheduledJsonStore(FILE, () => ({ groups: {} }));
const joins = new Map();
const unlockTimers = new Map();

function ensureGroup(groupId) {
  if (!store.state.groups || typeof store.state.groups !== "object") store.state.groups = {};
  if (!store.state.groups[groupId]) {
    store.state.groups[groupId] = {
      enabled: false,
      limit: 5,
      windowSeconds: 20,
      lockMinutes: 5,
      lockedUntil: 0,
    };
  }
  return store.state.groups[groupId];
}

export function getAntiRaidState(groupId) {
  const config = ensureGroup(groupId);
  return { ...config };
}

async function scheduleUnlock(sock, groupId, config) {
  clearTimeout(unlockTimers.get(groupId));
  const delay = Math.max(1000, Number(config.lockedUntil || 0) - Date.now());
  const timer = setTimeout(async () => {
    try {
      await sock.groupSettingUpdate(groupId, "not_announcement");
      config.lockedUntil = 0;
      store.saveNow();
      addModerationLog(groupId, { action: "antiraid_unlocked", source: "antiraid" });
      await sock.sendMessage(groupId, {
        text: "✅ *ANTIRAID*\nEl grupo fue abierto automaticamente.",
        ...global.channelInfo,
      });
    } catch {}
    unlockTimers.delete(groupId);
  }, delay);
  timer.unref?.();
  unlockTimers.set(groupId, timer);
}

export default {
  name: "antiraid",
  command: ["antiraid"],
  category: "grupo",
  description: "Cierra temporalmente el grupo ante entradas masivas",
  groupOnly: true,
  adminOnly: true,

  async run({ sock, from, msg, args = [], settings }) {
    const config = ensureGroup(from);
    const action = String(args[0] || "status").toLowerCase();
    const prefix = getPrimaryPrefix(settings);
    const quoted = msg?.key ? { quoted: msg } : undefined;

    if (["on", "off"].includes(action)) {
      config.enabled = action === "on";
      store.saveNow();
      return sock.sendMessage(from, {
        text: `🛡️ AntiRaid: *${config.enabled ? "ON ✅" : "OFF ❌"}*`,
        ...global.channelInfo,
      }, quoted);
    }

    if (action === "config") {
      config.limit = Math.max(3, Math.min(30, Number(args[1] || config.limit)));
      config.windowSeconds = Math.max(5, Math.min(120, Number(args[2] || config.windowSeconds)));
      config.lockMinutes = Math.max(1, Math.min(60, Number(args[3] || config.lockMinutes)));
      store.saveNow();
      return sock.sendMessage(from, {
        text: `AntiRaid: *${config.limit} entradas / ${config.windowSeconds}s*, cierre *${config.lockMinutes} min*.`,
        ...global.channelInfo,
      }, quoted);
    }

    return sock.sendMessage(from, {
      text:
        `🛡️ *ANTIRAID*\n\nEstado: *${config.enabled ? "ON" : "OFF"}*\n` +
        `Limite: *${config.limit} entradas / ${config.windowSeconds}s*\n` +
        `Cierre: *${config.lockMinutes} min*\n\n` +
        `${prefix}antiraid on|off\n${prefix}antiraid config 5 20 5`,
      ...global.channelInfo,
    }, quoted);
  },

  async onGroupUpdate({ sock, update }) {
    if (!update?.id || String(update.action).toLowerCase() !== "add") return;
    const config = ensureGroup(update.id);
    if (!config.enabled) return;

    const now = Date.now();
    const windowMs = Number(config.windowSeconds || 20) * 1000;
    const bucket = (joins.get(update.id) || []).filter((at) => now - at <= windowMs);
    for (const _participant of update.participants || []) bucket.push(now);
    joins.set(update.id, bucket);
    if (bucket.length < Number(config.limit || 5) || Number(config.lockedUntil || 0) > now) return;

    try {
      await sock.groupSettingUpdate(update.id, "announcement");
      config.lockedUntil = now + Number(config.lockMinutes || 5) * 60_000;
      store.saveNow();
      joins.set(update.id, []);
      addModerationLog(update.id, {
        action: "antiraid_locked",
        source: "antiraid",
        reason: `${bucket.length} entradas en ${config.windowSeconds}s`,
      });
      await sock.sendMessage(update.id, {
        text:
          `🚨 *ANTIRAID ACTIVADO*\n\n` +
          `Detecte *${bucket.length} entradas* en pocos segundos.\n` +
          `El grupo fue cerrado por *${config.lockMinutes} minutos*.`,
        ...global.channelInfo,
      });
      await scheduleUnlock(sock, update.id, config);
    } catch {
      await sock.sendMessage(update.id, {
        text: "⚠️ AntiRaid detecto entradas masivas, pero el bot necesita ser administrador.",
        ...global.channelInfo,
      });
    }
  },
};
