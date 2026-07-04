import path from "path";
import { createScheduledJsonStore, getPrimaryPrefix } from "../../lib/json-store.js";
import { addModerationLog } from "../../lib/group-moderation.js";

const FILE = path.join(process.cwd(), "database", "group_schedule.json");
const store = createScheduledJsonStore(FILE, () => ({ groups: {} }));
const sockets = new Map();

const COUNTRY_PRESETS = {
  peru: {
    label: "Peru",
    timezone: "America/Lima",
    openAt: "07:00",
    closeAt: "23:00",
  },
  argentina: {
    label: "Argentina",
    timezone: "America/Argentina/Buenos_Aires",
    openAt: "07:00",
    closeAt: "23:30",
  },
  chile: {
    label: "Chile",
    timezone: "America/Santiago",
    openAt: "07:00",
    closeAt: "23:00",
  },
  colombia: {
    label: "Colombia",
    timezone: "America/Bogota",
    openAt: "07:00",
    closeAt: "22:30",
  },
  mexico: {
    label: "Mexico",
    timezone: "America/Mexico_City",
    openAt: "08:00",
    closeAt: "23:00",
  },
  brasil: {
    label: "Brasil",
    timezone: "America/Sao_Paulo",
    openAt: "07:00",
    closeAt: "23:30",
  },
  usa: {
    label: "Estados Unidos",
    timezone: "America/New_York",
    openAt: "08:00",
    closeAt: "23:00",
  },
};

const COUNTRY_ORDER = ["peru", "argentina", "chile", "colombia", "mexico", "brasil", "usa"];

function ensureGroup(groupId) {
  if (!store.state.groups || typeof store.state.groups !== "object") store.state.groups = {};
  if (!store.state.groups[groupId]) {
    const preset = COUNTRY_PRESETS.peru;
    store.state.groups[groupId] = {
      enabled: false,
      openAt: preset.openAt,
      closeAt: preset.closeAt,
      timezone: preset.timezone,
      country: "peru",
      label: preset.label,
      lastOpenKey: "",
      lastCloseKey: "",
    };
  }
  const config = store.state.groups[groupId];
  if (!config.country) config.country = "peru";
  if (!config.label) config.label = COUNTRY_PRESETS[config.country]?.label || "Peru";
  return store.state.groups[groupId];
}

function validTime(value = "") {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "").trim());
}

function validTimezone(value = "") {
  const zone = String(value || "").trim();
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function parseCountryKey(value = "") {
  return String(value || "").trim().toLowerCase();
}

function getCountryPreset(value = "") {
  const key = parseCountryKey(value);
  return COUNTRY_PRESETS[key] ? { key, ...COUNTRY_PRESETS[key] } : null;
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

function buildCountrySummary(activeKey = "peru") {
  return COUNTRY_ORDER.map((countryKey) => {
    const preset = COUNTRY_PRESETS[countryKey];
    const current = nowParts(preset.timezone);
    const marker = countryKey === activeKey ? "•" : " ";
    return `${marker} ${preset.label} (${preset.timezone}) -> ${current.time} | abre ${preset.openAt} | cierra ${preset.closeAt}`;
  }).join("\n");
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
    } else if (action === "pais") {
      const preset = getCountryPreset(args[1]);
      if (!preset) {
        return sock.sendMessage(
          from,
          {
            text:
              `Pais invalido. Usa: peru, argentina, chile, colombia, mexico, brasil, usa.\n` +
              `Ejemplo: ${prefix}horariogrupo pais peru`,
            ...global.channelInfo,
          },
          quoted
        );
      }
      config.country = preset.key;
      config.label = preset.label;
      config.timezone = preset.timezone;
      config.openAt = preset.openAt;
      config.closeAt = preset.closeAt;
      store.saveNow();
    } else if (["abrir", "open"].includes(action) && validTime(args[1])) {
      config.openAt = args[1];
      store.saveNow();
    } else if (["cerrar", "close"].includes(action) && validTime(args[1])) {
      config.closeAt = args[1];
      store.saveNow();
    } else if (action === "tz" && validTimezone(args[1])) {
      config.timezone = String(args[1]).trim();
      store.saveNow();
    } else if (action === "tz") {
      return sock.sendMessage(
        from,
        {
          text: `Zona horaria invalida. Ejemplo: ${prefix}horariogrupo tz America/Lima`,
          ...global.channelInfo,
        },
        quoted
      );
    } else if (action === "zona" && validTimezone(args[1])) {
      config.timezone = String(args[1]).trim();
      store.saveNow();
    } else if (action === "zona") {
      return sock.sendMessage(
        from,
        {
          text: `Zona horaria invalida. Ejemplo: ${prefix}horariogrupo zona America/Argentina/Buenos_Aires`,
          ...global.channelInfo,
        },
        quoted
      );
    } else if (action !== "status") {
      return sock.sendMessage(from, { text: "Hora invalida. Usa formato HH:MM.", ...global.channelInfo }, quoted);
    }

    const countrySummary = buildCountrySummary(config.country || "peru");
    return sock.sendMessage(from, {
      text:
        `⏰ *HORARIO DEL GRUPO*\n\n` +
        `Pais activo: *${config.label || "Peru"}*\n` +
        `Estado: *${config.enabled ? "ON" : "OFF"}*\n` +
        `Abrir: *${config.openAt}*\nCerrar: *${config.closeAt}*\nZona: *${config.timezone}*\n\n` +
        `*Resumen rapido por pais*\n${countrySummary}\n\n` +
        `*Uso*\n` +
        `${prefix}horariogrupo on|off\n` +
        `${prefix}horariogrupo pais peru\n` +
        `${prefix}horariogrupo pais argentina\n` +
        `${prefix}horariogrupo abrir 07:00\n` +
        `${prefix}horariogrupo cerrar 23:00\n` +
        `${prefix}horariogrupo tz America/Lima\n` +
        `${prefix}horariogrupo zona America/Argentina/Buenos_Aires`,
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
