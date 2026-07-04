import path from "path";
import { createScheduledJsonStore, getPrimaryPrefix } from "../../lib/json-store.js";
import { addModerationLog } from "../../lib/group-moderation.js";

const FILE = path.join(process.cwd(), "database", "group_schedule.json");
const store = createScheduledJsonStore(FILE, () => ({ groups: {} }));
const sockets = new Map();

function ensureGroup(groupId) {
  if (!store.state.groups || typeof store.state.groups !== "object") store.state.groups = {};
  if (!store.state.groups[groupId]) {
    store.state.groups[groupId] = {
      enabled: false,
      openAt: "08:00",
      closeAt: "23:00",
      timezone: "America/Lima",
      lastOpenKey: "",
      lastCloseKey: "",
    };
  }
  return store.state.groups[groupId];
}

function validTime(value = "") {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "").trim());
}

function nowParts(timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const read = (type) => parts.find((item) => item.type === type)?.value || "";
  return {
    date: `${read("year")}-${read("month")}-${read("day")}`,
    time: `${read("hour")}:${read("minute")}`,
  };
}

async function applySchedule(sock, groupId) {
  const config = ensureGroup(groupId);
  if (!config.enabled || !sock?.groupSettingUpdate) return;
  const current = nowParts(config.timezone || "America/Lima");

  if (current.time === config.closeAt && config.lastCloseKey !== current.date) {
    await sock.groupSettingUpdate(groupId, "announcement");
    config.lastCloseKey = current.date;
    store.saveNow();
    addModerationLog(groupId, { action: "scheduled_close", source: "schedule" });
    await sock.sendMessage(groupId, {
      text: `🔒 Grupo cerrado automaticamente (${config.closeAt}).`,
      ...global.channelInfo,
    });
  }

  if (current.time === config.openAt && config.lastOpenKey !== current.date) {
    await sock.groupSettingUpdate(groupId, "not_announcement");
    config.lastOpenKey = current.date;
    store.saveNow();
    addModerationLog(groupId, { action: "scheduled_open", source: "schedule" });
    await sock.sendMessage(groupId, {
      text: `🔓 Grupo abierto automaticamente (${config.openAt}).`,
      ...global.channelInfo,
    });
  }
}

const interval = setInterval(() => {
  for (const [groupId, sock] of sockets) {
    void applySchedule(sock, groupId).catch(() => {});
  }
}, 30_000);
interval.unref?.();

export function getGroupSchedule(groupId) {
  return { ...ensureGroup(groupId) };
}

export default {
  name: "horariogrupo",
  command: ["horariogrupo", "gphorario", "autogrupo"],
  category: "grupo",
  description: "Abre y cierra el grupo automaticamente por horario",
  groupOnly: true,
  adminOnly: true,

  async run({ sock, from, msg, args = [], settings }) {
    sockets.set(from, sock);
    const config = ensureGroup(from);
    const prefix = getPrimaryPrefix(settings);
    const action = String(args[0] || "status").toLowerCase();
    const quoted = msg?.key ? { quoted: msg } : undefined;

    if (["on", "off"].includes(action)) {
      config.enabled = action === "on";
      store.saveNow();
    } else if (["abrir", "open"].includes(action) && validTime(args[1])) {
      config.openAt = args[1];
      store.saveNow();
    } else if (["cerrar", "close"].includes(action) && validTime(args[1])) {
      config.closeAt = args[1];
      store.saveNow();
    } else if (action !== "status") {
      return sock.sendMessage(from, { text: "Hora invalida. Usa formato HH:MM.", ...global.channelInfo }, quoted);
    }

    return sock.sendMessage(from, {
      text:
        `⏰ *HORARIO DEL GRUPO*\n\nEstado: *${config.enabled ? "ON" : "OFF"}*\n` +
        `Abrir: *${config.openAt}*\nCerrar: *${config.closeAt}*\nZona: *${config.timezone}*\n\n` +
        `${prefix}horariogrupo on|off\n${prefix}horariogrupo abrir 08:00\n${prefix}horariogrupo cerrar 23:00`,
      ...global.channelInfo,
    }, quoted);
  },

  async onMessage({ sock, from, esGrupo }) {
    if (!esGrupo) return false;
    sockets.set(from, sock);
    await applySchedule(sock, from).catch(() => {});
    return false;
  },
};
