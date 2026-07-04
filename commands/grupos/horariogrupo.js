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
const DAY_NAMES = {
  monday: "Lunes",
  tuesday: "Martes",
  wednesday: "Miercoles",
  thursday: "Jueves",
  friday: "Viernes",
  saturday: "Sabado",
  sunday: "Domingo",
};
const DAY_ALIASES = {
  lunes: "monday",
  martes: "tuesday",
  miercoles: "wednesday",
  miércoles: "wednesday",
  jueves: "thursday",
  viernes: "friday",
  sabado: "saturday",
  sábado: "saturday",
  domingo: "sunday",
  mon: "monday",
  tue: "tuesday",
  wed: "wednesday",
  thu: "thursday",
  fri: "friday",
  sat: "saturday",
  sun: "sunday",
};

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
      weeklyEnabled: false,
      weekly: {},
      lastOpenKey: "",
      lastCloseKey: "",
    };
  }
  const config = store.state.groups[groupId];
  if (!config.country) config.country = "peru";
  if (!config.label) config.label = COUNTRY_PRESETS[config.country]?.label || "Peru";
  if (!config.weekly || typeof config.weekly !== "object") config.weekly = {};
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

function resolveDayKey(value = "") {
  const key = String(value || "").trim().toLowerCase();
  if (DAY_NAMES[key]) return key;
  return DAY_ALIASES[key] || "";
}

function getDayName(dayKey = "") {
  return DAY_NAMES[dayKey] || dayKey;
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

function getWeekdayKey(timezone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
  }).formatToParts(now);
  const weekday = parts.find((item) => item.type === "weekday")?.value?.toLowerCase() || "";
  return {
    monday: "monday",
    tuesday: "tuesday",
    wednesday: "wednesday",
    thursday: "thursday",
    friday: "friday",
    saturday: "saturday",
    sunday: "sunday",
  }[weekday] || "monday";
}

function getActiveSchedule(config) {
  const dayKey = getWeekdayKey(config.timezone || "America/Lima");
  const weeklyEntry = config.weeklyEnabled ? config.weekly?.[dayKey] : null;
  const openAt = validTime(weeklyEntry?.openAt) ? weeklyEntry.openAt : config.openAt;
  const closeAt = validTime(weeklyEntry?.closeAt) ? weeklyEntry.closeAt : config.closeAt;
  return { dayKey, openAt, closeAt, weeklyEntry };
}

function buildCountrySummary(activeKey = "peru") {
  return COUNTRY_ORDER.map((countryKey) => {
    const preset = COUNTRY_PRESETS[countryKey];
    const current = nowParts(preset.timezone);
    const marker = countryKey === activeKey ? "•" : " ";
    return `${marker} ${preset.label} (${preset.timezone}) -> ${current.time} | abre ${preset.openAt} | cierra ${preset.closeAt}`;
  }).join("\n");
}

function buildWeeklySummary(config) {
  const timezone = config.timezone || "America/Lima";
  const nowDayKey = getWeekdayKey(timezone);
  return Object.keys(DAY_NAMES)
    .map((dayKey) => {
      const entry = config.weekly?.[dayKey];
      const marker = dayKey === nowDayKey ? "•" : " ";
      const label = getDayName(dayKey);
      if (!entry) {
        return `${marker} ${label}: usa horario base (${config.openAt} - ${config.closeAt})`;
      }
      return `${marker} ${label}: ${entry.openAt} - ${entry.closeAt}`;
    })
    .join("\n");
}

async function applySchedule(sock, groupId) {
  const config = ensureGroup(groupId);
  if (!config.enabled || !sock?.groupSettingUpdate) return;
  const current = nowParts(config.timezone || "America/Lima");
  const schedule = getActiveSchedule(config);

  if (current.time === schedule.closeAt && config.lastCloseKey !== `${current.date}:${schedule.dayKey}`) {
    await sock.groupSettingUpdate(groupId, "announcement");
    config.lastCloseKey = `${current.date}:${schedule.dayKey}`;
    store.saveNow();
    addModerationLog(groupId, {
      action: "scheduled_close",
      source: "schedule",
      reason: `${config.label || "Peru"} ${getDayName(schedule.dayKey)} ${schedule.closeAt}`,
    });
    await sock.sendMessage(groupId, {
      text: `🔒 Grupo cerrado automaticamente (${schedule.closeAt}).`,
      ...global.channelInfo,
    });
  }

  if (current.time === schedule.openAt && config.lastOpenKey !== `${current.date}:${schedule.dayKey}`) {
    await sock.groupSettingUpdate(groupId, "not_announcement");
    config.lastOpenKey = `${current.date}:${schedule.dayKey}`;
    store.saveNow();
    addModerationLog(groupId, {
      action: "scheduled_open",
      source: "schedule",
      reason: `${config.label || "Peru"} ${getDayName(schedule.dayKey)} ${schedule.openAt}`,
    });
    await sock.sendMessage(groupId, {
      text: `🔓 Grupo abierto automaticamente (${schedule.openAt}).`,
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
    } else if (action === "semana" && ["on", "off"].includes(String(args[1] || "").toLowerCase())) {
      config.weeklyEnabled = String(args[1]).toLowerCase() === "on";
      store.saveNow();
    } else if (action === "dia") {
      const dayKey = resolveDayKey(args[1]);
      if (!dayKey) {
        return sock.sendMessage(
          from,
          {
            text:
              `Dia invalido. Usa: lunes, martes, miercoles, jueves, viernes, sabado, domingo.\n` +
              `Ejemplo: ${prefix}horariogrupo dia lunes 08:00 23:00`,
            ...global.channelInfo,
          },
          quoted
        );
      }
      if (String(args[2] || "").toLowerCase() === "borrar") {
        delete config.weekly[dayKey];
        store.saveNow();
      } else if (validTime(args[2]) && validTime(args[3])) {
        config.weekly[dayKey] = { openAt: args[2], closeAt: args[3] };
        config.weeklyEnabled = true;
        store.saveNow();
      } else {
        return sock.sendMessage(
          from,
          {
            text:
              `Formato invalido. Usa: ${prefix}horariogrupo dia lunes 08:00 23:00\n` +
              `O para borrar: ${prefix}horariogrupo dia lunes borrar`,
            ...global.channelInfo,
          },
          quoted
        );
      }
    } else if (action === "dias") {
      const weeklySummary = buildWeeklySummary(config);
      const countrySummary = buildCountrySummary(config.country || "peru");
      return sock.sendMessage(
        from,
        {
          text:
            `📅 *HORARIO SEMANAL*\n\n` +
            `Pais activo: *${config.label || "Peru"}*\n` +
            `Estado semanal: *${config.weeklyEnabled ? "ON" : "OFF"}*\n` +
            `${weeklySummary}\n\n` +
            `*Resumen por pais*\n${countrySummary}\n\n` +
            `Uso:\n` +
            `${prefix}horariogrupo semana on\n` +
            `${prefix}horariogrupo dia lunes 08:00 23:00\n` +
            `${prefix}horariogrupo dia lunes borrar`,
          ...global.channelInfo,
        },
        quoted
      );
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
    const weeklySummary = buildWeeklySummary(config);
    const activeSchedule = getActiveSchedule(config);
    return sock.sendMessage(from, {
      text:
        `⏰ *HORARIO DEL GRUPO*\n\n` +
        `Pais activo: *${config.label || "Peru"}*\n` +
        `Estado: *${config.enabled ? "ON" : "OFF"}*\n` +
        `Abrir: *${activeSchedule.openAt}*\nCerrar: *${activeSchedule.closeAt}*\nZona: *${config.timezone}*\n` +
        `Semanal: *${config.weeklyEnabled ? "ON" : "OFF"}*\n\n` +
        `*Resumen rapido por pais*\n${countrySummary}\n\n` +
        `*Resumen semanal*\n${weeklySummary}\n\n` +
        `*Uso*\n` +
        `${prefix}horariogrupo on|off\n` +
        `${prefix}horariogrupo pais peru\n` +
        `${prefix}horariogrupo pais argentina\n` +
        `${prefix}horariogrupo semana on\n` +
        `${prefix}horariogrupo dia lunes 08:00 23:00\n` +
        `${prefix}horariogrupo dias\n` +
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
