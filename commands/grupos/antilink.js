import fs from "fs";
import path from "path";
import {
  getParticipantDisplayTag,
  getParticipantMentionJid,
  runGroupParticipantAction,
} from "../../lib/group-compat.js";

const DB_DIR = path.join(process.cwd(), "database");
const FILE = path.join(DB_DIR, "antilink.json");
const WARNS_FILE = path.join(DB_DIR, "antilink_warns.json");
const LOG_FILE = path.join(DB_DIR, "antilink_logs.json");
const MAX_WARNS = 3;
const MAX_LOGS_PER_GROUP = 200;

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

function normalizeDomain(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

function safeParse(raw) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
  } catch {
    return null;
  }
}

function normalizeConfig(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const hasTypedFlags =
    Object.prototype.hasOwnProperty.call(source, "blockWhatsappGroups") ||
    Object.prototype.hasOwnProperty.call(source, "blockWhatsappChannels") ||
    Object.prototype.hasOwnProperty.call(source, "blockYoutubeLinks") ||
    Object.prototype.hasOwnProperty.call(source, "blockOtherLinks");
  const allowWhatsappLegacy = source.allowWhatsapp !== false;

  return {
    enabled: source.enabled === true,
    mode: String(source.mode || "kick").trim().toLowerCase() === "delete" ? "delete" : "kick",
    allowWhatsapp: allowWhatsappLegacy,
    blockWhatsappGroups: hasTypedFlags
      ? source.blockWhatsappGroups !== false
      : !allowWhatsappLegacy,
    blockWhatsappChannels: hasTypedFlags
      ? source.blockWhatsappChannels !== false
      : !allowWhatsappLegacy,
    blockYoutubeLinks: source.blockYoutubeLinks === true,
    blockOtherLinks: source.blockOtherLinks === true,
    whitelist: Array.isArray(source.whitelist)
      ? source.whitelist.map((item) => normalizeDomain(item)).filter(Boolean)
      : [],
  };
}

function loadStore() {
  try {
    if (!fs.existsSync(FILE)) return {};
    const raw = fs.readFileSync(FILE, "utf-8");
    const data = safeParse(raw);

    if (Array.isArray(data)) {
      return Object.fromEntries(
        data.map((groupId) => [String(groupId), normalizeConfig({ enabled: true })])
      );
    }

    if (!data || typeof data !== "object") {
      return {};
    }

    return Object.fromEntries(
      Object.entries(data).map(([groupId, config]) => [groupId, normalizeConfig(config)])
    );
  } catch {
    return {};
  }
}

function saveStore() {
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
}

function loadWarns() {
  try {
    if (!fs.existsSync(WARNS_FILE)) return {};
    const raw = fs.readFileSync(WARNS_FILE, "utf-8");
    const data = safeParse(raw);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function saveWarns() {
  fs.writeFileSync(WARNS_FILE, JSON.stringify(warnsCache, null, 2));
}

function loadLogs() {
  try {
    if (!fs.existsSync(LOG_FILE)) return {};
    const raw = fs.readFileSync(LOG_FILE, "utf-8");
    const data = safeParse(raw);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function saveLogs() {
  fs.writeFileSync(LOG_FILE, JSON.stringify(logsCache, null, 2));
}

function getGroupConfig(groupId) {
  const key = String(groupId || "").trim();
  if (!store[key]) {
    store[key] = normalizeConfig();
  } else {
    store[key] = normalizeConfig(store[key]);
  }
  return store[key];
}

function getPrefixes(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
  }

  const single = String(settings?.prefix || ".").trim();
  return single ? [single] : ["."];
}

function getPrimaryPrefix(settings) {
  return getPrefixes(settings)[0] || ".";
}

function extractLinks(text = "") {
  const matches = String(text || "").match(
    /((?:https?:\/\/|www\.)[^\s]+|chat\.whatsapp\.com\/[^\s]+|whatsapp\.com\/channel\/[^\s]+|wa\.me\/[^\s]+|youtu\.be\/[^\s]+)/gi
  );

  return (matches || []).map((value) => {
    const raw = String(value || "").trim();
    const normalized = normalizeDomain(raw);
    const lowerRaw = raw.toLowerCase();
    const isWhatsappGroup =
      lowerRaw.includes("chat.whatsapp.com/") || normalized.includes("chat.whatsapp.com");
    const isWhatsappChannel = lowerRaw.includes("whatsapp.com/channel/");
    const isYoutube =
      lowerRaw.includes("youtube.com/") ||
      lowerRaw.includes("youtu.be/") ||
      normalized === "youtube.com" ||
      normalized.endsWith(".youtube.com") ||
      normalized === "youtu.be";
    const linkType = isWhatsappGroup
      ? "wa_group"
      : isWhatsappChannel
        ? "wa_channel"
        : isYoutube
          ? "youtube"
          : "other";

    return {
      raw,
      domain: normalized,
      type: linkType,
    };
  });
}

function isTypeBlocked(link, config) {
  if (link?.type === "wa_group") return config.blockWhatsappGroups === true;
  if (link?.type === "wa_channel") return config.blockWhatsappChannels === true;
  if (link?.type === "youtube") return config.blockYoutubeLinks === true;
  return config.blockOtherLinks === true;
}

function isAllowedLink(link, config = {}) {
  if (!link?.domain) return true;
  if (!isTypeBlocked(link, config)) return true;
  return config.whitelist.some(
    (domain) => link.domain === domain || link.domain.endsWith(`.${domain}`)
  );
}

function formatToggle(value) {
  return value ? "BLOQUEADO 🚫" : "PERMITIDO ✅";
}

function parseToggle(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (["on", "activar", "bloquear", "1", "si"].includes(normalized)) return true;
  if (["off", "desactivar", "permitir", "0", "no"].includes(normalized)) return false;
  if (["toggle", "cambiar", "switch"].includes(normalized)) return null;
  return undefined;
}

function resolveFilterTarget(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (["grupo", "grupos", "group", "groups", "wa", "whatsapp"].includes(normalized)) {
    return "groups";
  }
  if (["canal", "canales", "channel", "channels", "wachannel", "wacanal"].includes(normalized)) {
    return "channels";
  }
  if (["youtube", "yt", "youtubelinks", "videosyt"].includes(normalized)) {
    return "youtube";
  }
  if (["otros", "other", "others", "externos", "links", "enlaces"].includes(normalized)) {
    return "others";
  }
  return "";
}

let store = loadStore();
let warnsCache = loadWarns();
let logsCache = loadLogs();

function getWarnCount(groupId, sender) {
  return Number(warnsCache?.[groupId]?.[sender] || 0);
}

function setWarnCount(groupId, sender, count) {
  if (!warnsCache[groupId]) warnsCache[groupId] = {};
  warnsCache[groupId][sender] = Math.max(0, Number(count || 0));
  saveWarns();
}

function clearWarnCount(groupId, sender) {
  if (!warnsCache[groupId]) return;
  delete warnsCache[groupId][sender];
  if (!Object.keys(warnsCache[groupId]).length) {
    delete warnsCache[groupId];
  }
  saveWarns();
}

function appendAntilinkLog(groupId, payload = {}) {
  const key = String(groupId || "").trim();
  if (!key) return;

  if (!Array.isArray(logsCache[key])) {
    logsCache[key] = [];
  }

  logsCache[key].push({
    at: new Date().toISOString(),
    ...payload,
  });

  if (logsCache[key].length > MAX_LOGS_PER_GROUP) {
    logsCache[key] = logsCache[key].slice(-MAX_LOGS_PER_GROUP);
  }

  saveLogs();
}

export default {
  name: "antilink",
  command: ["antilink", "antilinkyoutube"],
  groupOnly: true,
  adminOnly: true,
  category: "grupo",
  description: "Protege grupos contra links con whitelist y modos configurables",

  async run({ sock, from, args = [], msg, settings }) {
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const config = getGroupConfig(from);
    const prefix = getPrimaryPrefix(settings);
    const invokedCommand = String(msg?.body || msg?.text || "").trim().toLowerCase();
    const commandStartsYoutube = invokedCommand.startsWith(`${prefix}antilinkyoutube`);
    const action = String(args[0] || (commandStartsYoutube ? "statusyoutube" : "status")).trim().toLowerCase();
    const value = String(args.slice(1).join(" ") || "").trim();

    if (!args.length || ["status", "estado", "statusyoutube"].includes(action)) {
      return sock.sendMessage(
        from,
        {
          text:
            `*ANTILINK*\n\n` +
            `Estado: *${config.enabled ? "ON" : "OFF"}*\n` +
            `Modo: *${config.mode.toUpperCase()}*\n` +
            `Avisos antes de expulsar: *${MAX_WARNS}*\n` +
            `Grupos WhatsApp: *${formatToggle(config.blockWhatsappGroups)}*\n` +
            `Canales WhatsApp: *${formatToggle(config.blockWhatsappChannels)}*\n` +
            `YouTube: *${formatToggle(config.blockYoutubeLinks)}*\n` +
            `Otros enlaces: *${formatToggle(config.blockOtherLinks)}*\n` +
            `Whitelist: ${config.whitelist.length ? config.whitelist.join(", ") : "vacia"}\n\n` +
            `Uso:\n` +
            `${prefix}antilink on\n` +
            `${prefix}antilink off\n` +
            `${prefix}antilink mode delete\n` +
            `${prefix}antilink tipo grupos on|off\n` +
            `${prefix}antilink tipo canales on|off\n` +
            `${prefix}antilinkyoutube on|off\n` +
            `${prefix}antilink tipo otros on|off\n` +
            `${prefix}antilink allow youtube.com\n` +
            `${prefix}antilink remove youtube.com\n` +
            `${prefix}antilink list\n` +
            `${prefix}antilink logs`,
          footer: "Selecciona desde el panel para cambiar rapido",
          interactiveButtons: [
            {
              name: "single_select",
              buttonParamsJson: JSON.stringify({
                title: "Panel AntiLink",
                sections: [
                  {
                    title: "Estado general",
                    rows: [
                      {
                        header: "ON",
                        title: "Activar AntiLink",
                        description: "Enciende proteccion de enlaces.",
                        id: `${prefix}antilink on`,
                      },
                      {
                        header: "OFF",
                        title: "Desactivar AntiLink",
                        description: "Apaga proteccion de enlaces.",
                        id: `${prefix}antilink off`,
                      },
                    ],
                  },
                  {
                    title: "Sancion",
                    rows: [
                      {
                        header: "DELETE",
                        title: "Modo borrar mensaje",
                        description: "Borra el mensaje con enlace.",
                        id: `${prefix}antilink mode delete`,
                      },
                      {
                        header: "KICK",
                        title: "Modo expulsar usuario",
                        description: "Expulsa si bot es admin.",
                        id: `${prefix}antilink mode kick`,
                      },
                    ],
                  },
                  {
                    title: "Tipos de enlace",
                    rows: [
                      {
                        header: "WA GRUPOS",
                        title: config.blockWhatsappGroups
                          ? "Permitir enlaces de grupos WhatsApp"
                          : "Bloquear enlaces de grupos WhatsApp",
                        description: config.blockWhatsappGroups
                          ? "Actualmente: bloqueado"
                          : "Actualmente: permitido",
                        id: `${prefix}antilink tipo grupos ${config.blockWhatsappGroups ? "off" : "on"}`,
                      },
                      {
                        header: "WA CANALES",
                        title: config.blockWhatsappChannels
                          ? "Permitir enlaces de canales WhatsApp"
                          : "Bloquear enlaces de canales WhatsApp",
                        description: config.blockWhatsappChannels
                          ? "Actualmente: bloqueado"
                          : "Actualmente: permitido",
                        id: `${prefix}antilink tipo canales ${config.blockWhatsappChannels ? "off" : "on"}`,
                      },
                      {
                        header: "YOUTUBE",
                        title: config.blockYoutubeLinks
                          ? "Permitir enlaces de YouTube"
                          : "Bloquear enlaces de YouTube",
                        description: config.blockYoutubeLinks
                          ? "Actualmente: bloqueado"
                          : "Actualmente: permitido",
                        id: `${prefix}antilinkyoutube ${config.blockYoutubeLinks ? "off" : "on"}`,
                      },
                      {
                        header: "OTROS LINKS",
                        title: config.blockOtherLinks
                          ? "Permitir otros enlaces"
                          : "Bloquear otros enlaces",
                        description: config.blockOtherLinks
                          ? "Actualmente: bloqueado"
                          : "Actualmente: permitido",
                        id: `${prefix}antilink tipo otros ${config.blockOtherLinks ? "off" : "on"}`,
                      },
                    ],
                  },
                ],
              }),
            },
          ],
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "on") {
      if (commandStartsYoutube) {
        config.blockYoutubeLinks = true;
        saveStore();
        return sock.sendMessage(
          from,
          {
            text: "AntiLink YouTube activado. Ahora avisara 3 veces antes de expulsar.",
            ...global.channelInfo,
          },
          quoted
        );
      }
      config.enabled = true;
      saveStore();
      return sock.sendMessage(
        from,
        {
          text: "Anti-link activado para este grupo.",
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "off") {
      if (commandStartsYoutube) {
        config.blockYoutubeLinks = false;
        saveStore();
        return sock.sendMessage(
          from,
          {
            text: "AntiLink YouTube desactivado.",
            ...global.channelInfo,
          },
          quoted
        );
      }
      config.enabled = false;
      saveStore();
      return sock.sendMessage(
        from,
        {
          text: "Anti-link desactivado para este grupo.",
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "mode") {
      const mode = String(args[1] || "").trim().toLowerCase();
      if (!["delete", "kick"].includes(mode)) {
        return sock.sendMessage(
          from,
          {
            text: "Usa: .antilink mode delete o .antilink mode kick",
            ...global.channelInfo,
          },
          quoted
        );
      }

      config.mode = mode;
      saveStore();
      return sock.sendMessage(
        from,
        {
          text: `Modo anti-link actualizado a *${mode.toUpperCase()}*.`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "allow") {
      const target = String(args[1] || "").trim().toLowerCase();
      if (target === "whatsapp" || target === "wa") {
        config.allowWhatsapp = true;
        config.blockWhatsappGroups = false;
        config.blockWhatsappChannels = false;
        saveStore();
        return sock.sendMessage(
          from,
          {
            text: "Los enlaces de WhatsApp (grupos y canales) quedaron permitidos.",
            ...global.channelInfo,
          },
          quoted
        );
      }

      const domain = normalizeDomain(value);
      if (!domain) {
        return sock.sendMessage(
          from,
          {
            text: "Usa: .antilink allow dominio.com",
            ...global.channelInfo,
          },
          quoted
        );
      }

      if (!config.whitelist.includes(domain)) {
        config.whitelist.push(domain);
        config.whitelist.sort();
        saveStore();
      }

      return sock.sendMessage(
        from,
        {
          text: `Dominio permitido: *${domain}*`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "deny") {
      const target = String(args[1] || "").trim().toLowerCase();
      if (target === "whatsapp" || target === "wa") {
        config.allowWhatsapp = false;
        config.blockWhatsappGroups = true;
        config.blockWhatsappChannels = true;
        saveStore();
        return sock.sendMessage(
          from,
          {
            text: "Los enlaces de WhatsApp (grupos y canales) quedaron bloqueados.",
            ...global.channelInfo,
          },
          quoted
        );
      }
    }

    if (action === "tipo" || action === "filtro" || action === "filtros") {
      const target = resolveFilterTarget(args[1]);
      const toggle = parseToggle(args[2]);

      if (!target) {
        return sock.sendMessage(
          from,
          {
            text:
              `Usa:\n` +
              `${prefix}antilink tipo grupos on|off\n` +
              `${prefix}antilink tipo canales on|off\n` +
              `${prefix}antilink tipo otros on|off`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      if (toggle === undefined) {
        return sock.sendMessage(
          from,
          {
            text: "Usa: on o off",
            ...global.channelInfo,
          },
          quoted
        );
      }

      if (target === "groups") {
        config.blockWhatsappGroups = toggle === null ? !config.blockWhatsappGroups : toggle;
        config.allowWhatsapp = !(config.blockWhatsappGroups || config.blockWhatsappChannels);
        saveStore();
        return sock.sendMessage(
          from,
          {
            text: `Grupos de WhatsApp: *${formatToggle(config.blockWhatsappGroups)}*`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      if (target === "channels") {
        config.blockWhatsappChannels = toggle === null ? !config.blockWhatsappChannels : toggle;
        config.allowWhatsapp = !(config.blockWhatsappGroups || config.blockWhatsappChannels);
        saveStore();
        return sock.sendMessage(
          from,
          {
            text: `Canales de WhatsApp: *${formatToggle(config.blockWhatsappChannels)}*`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      if (target === "youtube") {
        config.blockYoutubeLinks = toggle === null ? !config.blockYoutubeLinks : toggle;
        saveStore();
        return sock.sendMessage(
          from,
          {
            text: `YouTube: *${formatToggle(config.blockYoutubeLinks)}*`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      config.blockOtherLinks = toggle === null ? !config.blockOtherLinks : toggle;
      saveStore();
      return sock.sendMessage(
        from,
        {
          text: `Otros enlaces: *${formatToggle(config.blockOtherLinks)}*`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    // Alias cortos para filtros:
    if (["grupos", "grupo", "canales", "canal", "youtube", "yt", "otros", "other"].includes(action)) {
      const target =
        action.startsWith("grupo")
          ? "groups"
          : action.startsWith("canal")
            ? "channels"
            : action.startsWith("y")
              ? "youtube"
              : "others";
      const toggle = parseToggle(args[1]);

      if (toggle === undefined) {
        return sock.sendMessage(
          from,
          {
            text: "Usa: on o off",
            ...global.channelInfo,
          },
          quoted
        );
      }

      if (target === "groups") {
        config.blockWhatsappGroups = toggle === null ? !config.blockWhatsappGroups : toggle;
        config.allowWhatsapp = !(config.blockWhatsappGroups || config.blockWhatsappChannels);
        saveStore();
        return sock.sendMessage(
          from,
          {
            text: `Grupos de WhatsApp: *${formatToggle(config.blockWhatsappGroups)}*`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      if (target === "channels") {
        config.blockWhatsappChannels = toggle === null ? !config.blockWhatsappChannels : toggle;
        config.allowWhatsapp = !(config.blockWhatsappGroups || config.blockWhatsappChannels);
        saveStore();
        return sock.sendMessage(
          from,
          {
            text: `Canales de WhatsApp: *${formatToggle(config.blockWhatsappChannels)}*`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      if (target === "youtube") {
        config.blockYoutubeLinks = toggle === null ? !config.blockYoutubeLinks : toggle;
        saveStore();
        return sock.sendMessage(
          from,
          {
            text: `YouTube: *${formatToggle(config.blockYoutubeLinks)}*`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      config.blockOtherLinks = toggle === null ? !config.blockOtherLinks : toggle;
      saveStore();
      return sock.sendMessage(
        from,
        {
          text: `Otros enlaces: *${formatToggle(config.blockOtherLinks)}*`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "remove" || action === "del") {
      const domain = normalizeDomain(value);
      if (!domain) {
        return sock.sendMessage(
          from,
          {
            text: "Usa: .antilink remove dominio.com",
            ...global.channelInfo,
          },
          quoted
        );
      }

      config.whitelist = config.whitelist.filter((item) => item !== domain);
      saveStore();
      return sock.sendMessage(
        from,
        {
          text: `Dominio removido de la whitelist: *${domain}*`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "list") {
      return sock.sendMessage(
        from,
        {
          text:
            `*WHITELIST ANTILINK*\n\n` +
            `${config.whitelist.length ? config.whitelist.map((item) => `• ${item}`).join("\n") : "Sin dominios permitidos."}`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "logs" || action === "log") {
      const entries = Array.isArray(logsCache[from]) ? logsCache[from].slice(-15).reverse() : [];
      return sock.sendMessage(
        from,
        {
          text:
            `*LOGS ANTILINK*\n\n` +
            (entries.length
              ? entries
                  .map((entry, index) => {
                    const when = String(entry?.at || "").replace("T", " ").replace(/\.\d+Z$/, "Z");
                    const sender = String(entry?.sender || "desconocido");
                    const actionText = String(entry?.action || "detectado");
                    const linkText = String(entry?.link || entry?.domain || "sin enlace");
                    const warns = Number(entry?.warns || 0);
                    return (
                      `${index + 1}. ${actionText.toUpperCase()}\n` +
                      `• Usuario: ${sender}\n` +
                      `• Link: ${linkText}\n` +
                      `• Tipo: ${String(entry?.linkType || "other")}\n` +
                      `• Warns: ${warns}/${MAX_WARNS}\n` +
                      `• Fecha: ${when}`
                    );
                  })
                  .join("\n\n")
              : "Sin registros todavia."),
          ...global.channelInfo,
        },
        quoted
      );
    }

    return sock.sendMessage(
      from,
      {
        text: "Opcion invalida. Usa .antilink status para ver la ayuda.",
        ...global.channelInfo,
      },
      quoted
    );
  },

  async onMessage({ sock, msg, from, esGrupo, esAdmin, esOwner, esBotAdmin, groupMetadata }) {
    if (!esGrupo) return;

    const config = getGroupConfig(from);
    if (!config.enabled) return;

    const texto =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption;

    if (!texto) return;
    if (esAdmin || esOwner) return;

    const links = extractLinks(texto);
    const blockedLink = links.find((link) => !isAllowedLink(link, config));

    if (!blockedLink) return;

    const sender = msg.sender || msg.key?.participant;
    if (!sender) return;
    const mentionJid = getParticipantMentionJid(groupMetadata || {}, null, sender);

    try {
      await sock.sendMessage(from, { delete: msg.key, ...global.channelInfo });
    } catch {}

    const currentWarns = getWarnCount(from, sender) + 1;
    setWarnCount(from, sender, currentWarns);

    const mentionText = getParticipantDisplayTag(null, sender);
    const mentionJids = mentionJid ? [mentionJid] : [];
    const senderLog = String(mentionJid || sender || "").trim();

    if (config.mode === "kick" && currentWarns >= MAX_WARNS && esBotAdmin) {
      try {
        const removeResult = await runGroupParticipantAction(
          sock,
          from,
          groupMetadata || {},
          null,
          [sender],
          "remove"
        );
        if (!removeResult.ok) {
          throw removeResult.error || new Error("No pude expulsar al usuario.");
        }
        clearWarnCount(from, sender);
        appendAntilinkLog(from, {
          sender: senderLog,
          link: blockedLink.raw,
          domain: blockedLink.domain,
          linkType: blockedLink.type,
          warns: currentWarns,
          action: "expulsado",
          mode: config.mode,
        });

        await sock.sendMessage(from, {
          text:
            `🚫 *ANTILINK*\n` +
            `${mentionText} llego a *${MAX_WARNS}/${MAX_WARNS}* advertencias.\n` +
            `🔗 Enlace bloqueado: *${blockedLink.domain || blockedLink.raw}*\n` +
            `✅ Fue expulsado del grupo.`,
          mentions: mentionJids,
          ...global.channelInfo,
        });
        return;
      } catch {}
    }

    if (config.mode === "kick") {
      if (currentWarns >= MAX_WARNS) {
        appendAntilinkLog(from, {
          sender: senderLog,
          link: blockedLink.raw,
          domain: blockedLink.domain,
          linkType: blockedLink.type,
          warns: currentWarns,
          action: "sin_expulsion",
          mode: config.mode,
        });
        await sock.sendMessage(from, {
          text:
            `🚫 *ANTILINK*\n` +
            `${mentionText} llego a *${MAX_WARNS}/${MAX_WARNS}* advertencias.\n` +
            `🔗 Enlace bloqueado: *${blockedLink.domain || blockedLink.raw}*\n` +
            `⚠️ No pude expulsarlo. Verifica si el bot es admin.`,
          mentions: mentionJids,
          ...global.channelInfo,
        });
        return;
      }

      appendAntilinkLog(from, {
        sender: senderLog,
        link: blockedLink.raw,
        domain: blockedLink.domain,
        linkType: blockedLink.type,
        warns: currentWarns,
        action: "advertencia",
        mode: config.mode,
      });
      await sock.sendMessage(from, {
        text:
          `⚠️ *ANTILINK AVISO ${currentWarns}/${MAX_WARNS}*\n` +
          `${mentionText}, no envies este tipo de enlace.\n` +
          `🔗 Detectado: *${blockedLink.domain || blockedLink.raw}*\n` +
          `📌 A la advertencia *${MAX_WARNS}* seras expulsado.`,
        mentions: mentionJids,
        ...global.channelInfo,
      });
      return;
    }

    appendAntilinkLog(from, {
      sender: senderLog,
      link: blockedLink.raw,
      domain: blockedLink.domain,
      linkType: blockedLink.type,
      warns: currentWarns,
      action: "borrado",
      mode: config.mode,
    });
    await sock.sendMessage(from, {
      text:
        `🚫 *ANTILINK*\n` +
        `🔗 Enlace bloqueado: *${blockedLink.domain || blockedLink.raw}*\n` +
        `🗑️ El mensaje fue eliminado por anti-link.`,
      ...global.channelInfo,
    });
  },
};
