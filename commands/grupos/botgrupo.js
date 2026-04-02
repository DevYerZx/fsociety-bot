import fs from "fs";
import path from "path";
import { getParticipantMentionJid } from "../../lib/group-compat.js";

const DB_DIR = path.join(process.cwd(), "database");
const FILE = path.join(DB_DIR, "botoff_groups.json");
const COMMAND_ALIASES = new Set([
  "botgrupo",
  "botestado",
  "botoff",
  "boton",
  "botgroup",
  "botmode",
]);
const WARN_COOLDOWN_MS = 12_000;

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

function safeParse(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
  } catch {
    return fallback;
  }
}

function loadSet() {
  try {
    if (!fs.existsSync(FILE)) return new Set();
    const parsed = safeParse(fs.readFileSync(FILE, "utf-8"), []);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveSet(set) {
  fs.writeFileSync(FILE, JSON.stringify([...set], null, 2));
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

function extractCommandName(text = "", settings = {}, commandMap = null) {
  const value = String(text || "").trim();
  if (!value) return "";

  const prefixes = getPrefixes(settings);
  const noPrefix =
    settings?.noPrefix === true || !prefixes.length || !String(prefixes[0] || "").trim();

  if (noPrefix) {
    const [candidateRaw] = value.split(/\s+/);
    const candidate = String(candidateRaw || "").trim().toLowerCase();
    if (!candidate) return "";
    if (commandMap instanceof Map && !commandMap.has(candidate)) return "";
    return candidate;
  }

  const matchedPrefix = prefixes.find((item) => value.startsWith(item));
  if (!matchedPrefix) return "";

  const body = value.slice(matchedPrefix.length).trim();
  if (!body) return "";

  const [commandRaw] = body.split(/\s+/);
  const commandName = String(commandRaw || "").trim().toLowerCase();
  if (!commandName) return "";
  if (commandMap instanceof Map && !commandMap.has(commandName)) return "";
  return commandName;
}

function toAction(value = "") {
  const normalized = String(value || "").trim().toLowerCase();

  if (["on", "encender", "prender", "activar", "enable", "1", "si"].includes(normalized)) {
    return "on";
  }

  if (["off", "apagar", "desactivar", "disable", "0", "no"].includes(normalized)) {
    return "off";
  }

  if (["status", "estado", "info"].includes(normalized)) {
    return "status";
  }

  return "";
}

function resolveAction(args = [], commandName = "") {
  const cmd = String(commandName || "").trim().toLowerCase();
  if (cmd === "botoff") return "off";
  if (cmd === "boton") return "on";
  if (cmd === "botestado") return "status";
  return toAction(args[0]);
}

function buildPanelMessage(prefix, isOff) {
  const statusText = isOff ? "OFF 🔴" : "ON 🟢";
  const modeText = isOff
    ? "Ahora el bot no respondera comandos en este grupo."
    : "El bot respondera normalmente en este grupo.";

  return (
    `🤖 *CONTROL BOT DEL GRUPO*\n\n` +
    `Estado actual: *${statusText}*\n` +
    `${modeText}\n\n` +
    `Comandos rapidos:\n` +
    `• *${prefix}botgrupo on*\n` +
    `• *${prefix}botgrupo off*\n` +
    `• *${prefix}botgrupo estado*`
  );
}

function buildInteractiveRows(prefix) {
  return [
    {
      header: "ON",
      title: "Encender bot en este grupo",
      description: "Permite respuestas y comandos normales.",
      id: `${prefix}botgrupo on`,
    },
    {
      header: "OFF",
      title: "Apagar bot en este grupo",
      description: "Bloquea comandos en este grupo.",
      id: `${prefix}botgrupo off`,
    },
    {
      header: "ESTADO",
      title: "Ver estado actual",
      description: "Muestra si el bot esta ON u OFF en este grupo.",
      id: `${prefix}botgrupo estado`,
    },
  ];
}

const disabledGroups = loadSet();
const warnCooldown = new Map();

export default {
  name: "botgrupo",
  command: ["botgrupo", "botestado", "botoff", "boton", "botgroup", "botmode"],
  category: "grupo",
  description: "Enciende o apaga el bot por grupo (solo admin/owner).",
  groupOnly: true,
  adminOnly: true,

  run: async ({ sock, msg, from, args = [], settings, commandName = "" }) => {
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const prefix = getPrimaryPrefix(settings);
    const action = resolveAction(args, commandName);
    const isOff = disabledGroups.has(from);

    if (!action) {
      return sock.sendMessage(
        from,
        {
          text: buildPanelMessage(prefix, isOff),
          title: "FSOCIETY BOT",
          subtitle: "Control de grupo",
          footer: isOff ? "Estado: BOT OFF" : "Estado: BOT ON",
          interactiveButtons: [
            {
              name: "single_select",
              buttonParamsJson: JSON.stringify({
                title: "Configurar bot del grupo",
                sections: [
                  {
                    title: "Acciones",
                    rows: buildInteractiveRows(prefix),
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

    if (action === "status") {
      return sock.sendMessage(
        from,
        {
          text:
            `🤖 *ESTADO BOT EN ESTE GRUPO*\n\n` +
            `• Estado: *${isOff ? "OFF 🔴" : "ON 🟢"}*\n` +
            `• Cambiar: *${prefix}botgrupo on/off*`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "on") {
      if (!isOff) {
        return sock.sendMessage(
          from,
          {
            text: "✅ El bot ya estaba *ON* en este grupo.",
            ...global.channelInfo,
          },
          quoted
        );
      }

      disabledGroups.delete(from);
      saveSet(disabledGroups);

      return sock.sendMessage(
        from,
        {
          text:
            `✅ *BOT ON ACTIVADO EN ESTE GRUPO*\n\n` +
            `El bot vuelve a responder comandos normalmente.`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "off") {
      if (isOff) {
        return sock.sendMessage(
          from,
          {
            text: "ℹ️ El bot ya estaba *OFF* en este grupo.",
            ...global.channelInfo,
          },
          quoted
        );
      }

      disabledGroups.add(from);
      saveSet(disabledGroups);

      return sock.sendMessage(
        from,
        {
          text:
            `🛑 *BOT OFF ACTIVADO EN ESTE GRUPO*\n\n` +
            `Desde ahora no respondere comandos aqui.\n` +
            `Para encender: *${prefix}botgrupo on*`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    return sock.sendMessage(
      from,
      {
        text:
          `❌ Opcion invalida.\n` +
          `Usa: *${prefix}botgrupo on*, *${prefix}botgrupo off* o *${prefix}botgrupo estado*`,
        ...global.channelInfo,
      },
      quoted
    );
  },

  onMessage: async ({ sock, msg, from, esGrupo, esAdmin, esOwner, text, settings, comandos, groupMetadata }) => {
    if (!esGrupo) return;
    if (!disabledGroups.has(from)) return;

    const commandName = extractCommandName(text, settings, comandos);
    if (!commandName) {
      // Si el grupo esta en BOT OFF, no dejamos que otros hooks respondan.
      return true;
    }

    const isControlCommand = COMMAND_ALIASES.has(commandName);
    if (isControlCommand && (esAdmin || esOwner)) {
      // Permite que admin/owner enciendan el bot aun estando apagado.
      return;
    }

    // Usuario normal: bloquear en silencio (sin avisos).
    if (!esAdmin && !esOwner) {
      return true;
    }

    const sender =
      msg?.sender ||
      msg?.key?.participant ||
      msg?.key?.remoteJid ||
      from;
    const key = `${from}|${sender}`;
    const now = Date.now();

    if (now > Number(warnCooldown.get(key) || 0)) {
      warnCooldown.set(key, now + WARN_COOLDOWN_MS);
      const prefix = getPrimaryPrefix(settings);
      const mentionJid = getParticipantMentionJid(groupMetadata || {}, null, sender);

      const warningText =
        `🚫 *BOT OFF EN ESTE GRUPO*\n\n` +
        `Este grupo tiene el bot apagado.\n` +
        `Activalo con: *${prefix}botgrupo on*`;

      await sock.sendMessage(
        from,
        {
          text: warningText,
          mentions: mentionJid ? [mentionJid] : [],
          ...global.channelInfo,
        },
        msg?.key ? { quoted: msg } : undefined
      );
    }

    return true;
  },
};
