import fs from "fs";
import path from "path";
import { getAntiMediaState } from "./_antiMedia.js";
import { getAntiRaidState } from "./antiraid.js";
import { getGroupSchedule } from "./horariogrupo.js";
import { getModerationConfig } from "../../lib/group-moderation.js";

const DB_DIR = path.join(process.cwd(), "database");

const FILES = {
  antilink: path.join(DB_DIR, "antilink.json"),
  antispam: path.join(DB_DIR, "antispam.json"),
  botoff: path.join(DB_DIR, "botoff_groups.json"),
  welcome: path.join(DB_DIR, "welcome.json"),
  modoadmi: path.join(DB_DIR, "modoadmi.json"),
  antiflood: path.join(DB_DIR, "antiflood.json"),
};

function safeParse(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
  } catch {
    return fallback;
  }
}

function loadAny(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return safeParse(fs.readFileSync(filePath, "utf-8"), fallback);
  } catch {
    return fallback;
  }
}

function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }
  return String(settings?.prefix || ".").trim() || ".";
}

function readSetFlag(filePath, groupId) {
  const data = loadAny(filePath, []);
  if (Array.isArray(data)) return data.includes(groupId);
  if (data && typeof data === "object") {
    const entry = data[groupId];
    if (typeof entry === "boolean") return entry;
    if (entry && typeof entry === "object") return entry.enabled === true;
  }
  return false;
}

function readWelcomeFlags(groupId) {
  const data = loadAny(FILES.welcome, {});
  const entry = data && typeof data === "object" ? data[groupId] : null;
  if (!entry) {
    return { welcomeOn: false, byeOn: false };
  }
  if (typeof entry === "boolean") {
    return { welcomeOn: entry, byeOn: false };
  }
  return {
    welcomeOn: entry.enabled === true || entry.welcomeEnabled === true,
    byeOn: entry.byeEnabled === true || entry.goodbyeEnabled === true,
  };
}

function readAntifloodFlag(groupId) {
  const data = loadAny(FILES.antiflood, {});
  if (!data || typeof data !== "object") return false;
  const group = data.groups && typeof data.groups === "object" ? data.groups[groupId] : null;
  return Boolean(group?.enabled);
}

function readAntiLinkFlag(groupId) {
  const data = loadAny(FILES.antilink, {});
  if (Array.isArray(data)) return data.includes(groupId);
  if (!data || typeof data !== "object") return false;
  const entry = data[groupId];
  if (typeof entry === "boolean") return entry;
  if (!entry || typeof entry !== "object") return false;
  return entry.enabled === true;
}

function badge(value) {
  return value ? "ON ✅" : "OFF ❌";
}

export default {
  name: "panelgrupo",
  command: ["panelgrupo", "paneladmin", "gpanel", "adminpanel"],
  category: "grupo",
  description: "Panel admin unico del grupo con botones de control.",
  groupOnly: true,
  adminOnly: true,

  run: async ({ sock, msg, from, settings }) => {
    const prefix = getPrefix(settings);

    const antilinkOn = readAntiLinkFlag(from);
    const antispamOn = readSetFlag(FILES.antispam, from);
    const botOffOn = readSetFlag(FILES.botoff, from);
    const modeAdmiOn = readSetFlag(FILES.modoadmi, from);
    const antifloodOn = readAntifloodFlag(from);
    const antiMedia = getAntiMediaState(from);
    const antiRaid = getAntiRaidState(from);
    const schedule = getGroupSchedule(from);
    const moderation = getModerationConfig(from);
    const welcome = readWelcomeFlags(from);

    const panelText =
      `╭──〔 🛠️ *GPANEL ADMIN* 〕──⬣\n` +
      `│ AntiLink: *${badge(antilinkOn)}*\n` +
      `│ AntiSpam: *${badge(antispamOn)}*\n` +
      `│ AntiImagen: *${badge(antiMedia.image)}*\n` +
      `│ AntiSticker: *${badge(antiMedia.sticker)}*\n` +
      `│ AntiVideo: *${badge(antiMedia.video)}*\n` +
      `│ AntiAudio: *${badge(antiMedia.audio)}*\n` +
      `│ AntiDocumento: *${badge(antiMedia.document)}*\n` +
      `│ AntiRaid: *${badge(antiRaid.enabled)}*\n` +
      `│ Sanciones: *${badge(moderation.enabled)}*\n` +
      `│ Horario: *${badge(schedule.enabled)}*\n` +
      `│ BotGrupo: *${botOffOn ? "OFF 🔴" : "ON 🟢"}*\n` +
      `│ Welcome: *${badge(welcome.welcomeOn)}*\n` +
      `│ Bye: *${badge(welcome.byeOn)}*\n` +
      `│ ModoAdmin: *${badge(modeAdmiOn)}*\n` +
      `│ AntiFlood: *${badge(antifloodOn)}*\n` +
      `╰────────────⬣\n\n` +
      `Toca una opcion del panel para cambiar estado rapido.`;

    const sections = [
      {
        title: "Seguridad",
        rows: [
          {
            header: "ANTILINK",
            title: antilinkOn ? "Apagar AntiLink" : "Prender AntiLink",
            description: `Estado actual: ${badge(antilinkOn)}`,
            id: `${prefix}antilink ${antilinkOn ? "off" : "on"}`,
          },
          {
            header: "ANTISPAM",
            title: antispamOn ? "Apagar AntiSpam" : "Prender AntiSpam",
            description: `Estado actual: ${badge(antispamOn)}`,
            id: `${prefix}antispam ${antispamOn ? "off" : "on"}`,
          },
          {
            header: "ANTIFLOOD",
            title: antifloodOn ? "Apagar AntiFlood" : "Prender AntiFlood",
            description: `Estado actual: ${badge(antifloodOn)}`,
            id: `${prefix}antiflood ${antifloodOn ? "off" : "on"}`,
          },
        ],
      },
      {
        title: "Contenido multimedia",
        rows: [
          {
            header: "ANTIIMAGEN",
            title: antiMedia.image ? "Permitir imagenes" : "Bloquear imagenes",
            description: `Estado actual: ${badge(antiMedia.image)}`,
            id: `${prefix}antiimagen ${antiMedia.image ? "off" : "on"}`,
          },
          {
            header: "ANTISTICKER",
            title: antiMedia.sticker ? "Permitir stickers" : "Bloquear stickers",
            description: `Estado actual: ${badge(antiMedia.sticker)}`,
            id: `${prefix}antisticker ${antiMedia.sticker ? "off" : "on"}`,
          },
          {
            header: "ANTIVIDEO",
            title: antiMedia.video ? "Permitir videos" : "Bloquear videos",
            description: `Estado actual: ${badge(antiMedia.video)}`,
            id: `${prefix}antivideo ${antiMedia.video ? "off" : "on"}`,
          },
          {
            header: "ANTIAUDIO",
            title: antiMedia.audio ? "Permitir audios" : "Bloquear audios",
            description: `Estado actual: ${badge(antiMedia.audio)}`,
            id: `${prefix}antiaudio ${antiMedia.audio ? "off" : "on"}`,
          },
          {
            header: "ANTIDOCUMENTO",
            title: antiMedia.document ? "Permitir documentos" : "Bloquear documentos",
            description: `Estado actual: ${badge(antiMedia.document)}`,
            id: `${prefix}antidocumento ${antiMedia.document ? "off" : "on"}`,
          },
        ],
      },
      {
        title: "Seguridad avanzada",
        rows: [
          {
            header: "ANTIRAID",
            title: antiRaid.enabled ? "Apagar AntiRaid" : "Activar AntiRaid",
            description: "Protege contra entradas masivas.",
            id: `${prefix}antiraid ${antiRaid.enabled ? "off" : "on"}`,
          },
          {
            header: "SANCIONES",
            title: "Configurar sanciones",
            description: `Limite actual: ${moderation.maxWarnings} advertencias.`,
            id: `${prefix}sanciones`,
          },
          {
            header: "HORARIO",
            title: "Configurar horario",
            description: `${schedule.openAt} - ${schedule.closeAt}`,
            id: `${prefix}horariogrupo`,
          },
          {
            header: "LOGS",
            title: "Ver logs de moderacion",
            description: "Ultimas acciones automaticas y manuales.",
            id: `${prefix}modlogs`,
          },
        ],
      },
      {
        title: "Control de bot",
        rows: [
          {
            header: "BOTGRUPO",
            title: botOffOn ? "Prender bot en grupo" : "Apagar bot en grupo",
            description: `Estado actual: ${botOffOn ? "OFF 🔴" : "ON 🟢"}`,
            id: `${prefix}botgrupo ${botOffOn ? "on" : "off"}`,
          },
          {
            header: "MODOADMIN",
            title: modeAdmiOn ? "Apagar modo admin" : "Prender modo admin",
            description: `Estado actual: ${badge(modeAdmiOn)}`,
            id: `${prefix}modoadmi ${modeAdmiOn ? "off" : "on"}`,
          },
          {
            header: "STATUS",
            title: "Ver estado completo del grupo",
            description: "Abre panel de configuracion del grupo.",
            id: `${prefix}estadogrupo`,
          },
        ],
      },
      {
        title: "Bienvenida y salida",
        rows: [
          {
            header: "WELCOME",
            title: welcome.welcomeOn ? "Apagar bienvenida" : "Prender bienvenida",
            description: `Estado actual: ${badge(welcome.welcomeOn)}`,
            id: `${prefix}welcome ${welcome.welcomeOn ? "off" : "on"}`,
          },
          {
            header: "DESPEDIDA",
            title: welcome.byeOn ? "Apagar despedida" : "Prender despedida",
            description: `Estado actual: ${badge(welcome.byeOn)}`,
            id: `${prefix}welcome bye ${welcome.byeOn ? "off" : "on"}`,
          },
          {
            header: "PANEL WELCOME",
            title: "Abrir ajustes bienvenida/despedida",
            description: "Edita textos, reglas e imagen.",
            id: `${prefix}welcome`,
          },
        ],
      },
    ];

    return sock.sendMessage(
      from,
      {
        text: panelText,
        title: "FSOCIETY BOT",
        subtitle: "Panel de administracion del grupo",
        footer: "Selecciona una accion",
        interactiveButtons: [
          {
            name: "single_select",
            buttonParamsJson: JSON.stringify({
              title: "Abrir panel de grupo",
              sections,
            }),
          },
        ],
        ...global.channelInfo,
      },
      { quoted: msg }
    );
  },
};
