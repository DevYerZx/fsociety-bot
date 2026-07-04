import path from "path";
import { createScheduledJsonStore, getPrimaryPrefix } from "../../lib/json-store.js";
import {
  findGroupParticipant,
  getParticipantDisplayTag,
  getParticipantMentionJid,
  runGroupParticipantAction,
} from "../../lib/group-compat.js";
import { isWhitelistedUser } from "../../lib/group-whitelist.js";
import { deleteMessageForModeration } from "../../lib/moderation-delete.js";
import { addWarning, clearWarnings } from "../../lib/group-moderation.js";

const FILE = path.join(process.cwd(), "database", "anti_media.json");
const store = createScheduledJsonStore(FILE, () => ({ groups: {} }));
const permissionWarnings = new Map();
const PERMISSION_WARNING_MS = 60_000;

const MEDIA_CONFIG = {
  image: {
    name: "antiimagen",
    commands: ["antiimagen", "antiimage"],
    label: "AntiImagen",
    itemLabel: "imagen",
    pluralLabel: "imagenes",
    messageKey: "imageMessage",
    icon: "🖼️",
  },
  sticker: {
    name: "antisticker",
    commands: ["antisticker", "antistiker", "antistickers"],
    label: "AntiSticker",
    itemLabel: "sticker",
    pluralLabel: "stickers",
    messageKey: "stickerMessage",
    icon: "🏷️",
  },
  video: {
    name: "antivideo",
    commands: ["antivideo", "antivideos"],
    label: "AntiVideo",
    itemLabel: "video",
    pluralLabel: "videos",
    messageKey: "videoMessage",
    icon: "🎬",
  },
  audio: {
    name: "antiaudio",
    commands: ["antiaudio", "antiaudios"],
    label: "AntiAudio",
    itemLabel: "audio",
    pluralLabel: "audios",
    messageKey: "audioMessage",
    icon: "🎧",
  },
  document: {
    name: "antidocumento",
    commands: ["antidocumento", "antiarchivo", "antidoc"],
    label: "AntiDocumento",
    itemLabel: "documento",
    pluralLabel: "documentos",
    messageKey: "documentMessage",
    icon: "📄",
  },
};

function ensureGroups() {
  if (!store.state.groups || typeof store.state.groups !== "object") {
    store.state.groups = {};
  }
}

function ensureGroup(groupId) {
  ensureGroups();
  const key = String(groupId || "").trim();
  if (!store.state.groups[key] || typeof store.state.groups[key] !== "object") {
    store.state.groups[key] = {
      image: false,
      sticker: false,
      video: false,
      audio: false,
      document: false,
    };
  }
  return store.state.groups[key];
}

function parseToggle(value = "") {
  const action = String(value || "").trim().toLowerCase();
  if (["on", "activar", "enable", "1", "si"].includes(action)) return true;
  if (["off", "desactivar", "disable", "0", "no"].includes(action)) return false;
  return null;
}

function isUserWhitelisted(groupId, sender, metadata = {}) {
  const participant = findGroupParticipant(metadata, [sender]);
  return [
    sender,
    participant?.id,
    participant?.lid,
    participant?.jid,
    participant?.pn,
    participant?.phoneNumber,
  ]
    .filter(Boolean)
    .some((value) => isWhitelistedUser(groupId, value));
}

function hasMediaType(message = {}, config = {}) {
  if (message?.message?.[config.messageKey]) return true;

  const documentMime = String(
    message?.message?.documentMessage?.mimetype || ""
  ).toLowerCase();
  if (config.name === "antiimagen" && documentMime.startsWith("image/")) return true;
  if (config.name === "antivideo" && documentMime.startsWith("video/")) return true;
  if (config.name === "antidocumento" && documentMime) {
    return !documentMime.startsWith("image/") && !documentMime.startsWith("video/");
  }
  return false;
}

async function warnMissingPermission(sock, from, config, msg) {
  const key = `${from}:${config.name}`;
  const now = Date.now();
  if (now < Number(permissionWarnings.get(key) || 0)) return;
  permissionWarnings.set(key, now + PERMISSION_WARNING_MS);

  await sock.sendMessage(
    from,
    {
      text:
        `⚠️ *${config.label.toUpperCase()}*\n\n` +
        `Detecte una ${config.itemLabel}, pero no pude borrarla.\n` +
        `Convierte al bot en administrador del grupo.`,
      ...global.channelInfo,
    },
    msg?.key ? { quoted: msg } : undefined
  );
}

export function getAntiMediaState(groupId = "") {
  const config = ensureGroup(groupId);
  return {
    image: config.image === true,
    sticker: config.sticker === true,
    video: config.video === true,
    audio: config.audio === true,
    document: config.document === true,
  };
}

export function buildAntiMediaCommand(kind) {
  const config = MEDIA_CONFIG[kind];
  if (!config) throw new Error(`Tipo anti-media invalido: ${kind}`);

  return {
    name: config.name,
    command: config.commands,
    category: "grupo",
    description: `Borra ${config.pluralLabel} enviados por miembros normales`,
    groupOnly: true,
    adminOnly: true,

    async run({ sock, msg, from, args = [], settings }) {
      const group = ensureGroup(from);
      const prefix = getPrimaryPrefix(settings);
      const toggle = parseToggle(args[0]);
      const quoted = msg?.key ? { quoted: msg } : undefined;

      if (toggle !== null) {
        group[kind] = toggle;
        store.saveNow();
        return sock.sendMessage(
          from,
          {
            text:
              `${config.icon} *${config.label.toUpperCase()}*\n\n` +
              `Estado: *${toggle ? "ACTIVADO ✅" : "DESACTIVADO ❌"}*\n` +
              `${toggle ? `Los ${config.pluralLabel} de miembros normales seran eliminados.` : "El contenido vuelve a estar permitido."}\n` +
              `Admins, owner y whitelist quedan protegidos.`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      const enabled = group[kind] === true;
      return sock.sendMessage(
        from,
        {
          text:
            `${config.icon} *${config.label.toUpperCase()}*\n\n` +
            `Estado: *${enabled ? "ON ✅" : "OFF ❌"}*\n` +
            `Accion: borrar ${config.pluralLabel} de miembros normales.\n\n` +
            `Usa:\n${prefix}${config.name} on\n${prefix}${config.name} off`,
          footer: "Selecciona una opcion",
          interactiveButtons: [
            {
              name: "single_select",
              buttonParamsJson: JSON.stringify({
                title: `Configurar ${config.label}`,
                sections: [
                  {
                    title: "Estado",
                    rows: [
                      {
                        header: "ON",
                        title: `Activar ${config.label}`,
                        description: `Borra ${config.pluralLabel} de miembros normales.`,
                        id: `${prefix}${config.name} on`,
                      },
                      {
                        header: "OFF",
                        title: `Desactivar ${config.label}`,
                        description: `Permite ${config.pluralLabel} nuevamente.`,
                        id: `${prefix}${config.name} off`,
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
    },

    async onMessage(context) {
      const {
        sock,
        msg,
        from,
        sender,
        esGrupo,
        esAdmin,
        esOwner,
        esBotAdmin,
        groupMetadata,
      } = context;
      if (!esGrupo || esAdmin || esOwner) return false;
      if (!ensureGroup(from)[kind]) return false;
      if (!hasMediaType(msg, config)) return false;

      const senderId = sender || msg?.sender || msg?.key?.participant;
      if (!senderId || isUserWhitelisted(from, senderId, groupMetadata || {})) {
        return false;
      }

      if (!esBotAdmin) {
        await warnMissingPermission(sock, from, config, msg);
        return false;
      }

      const deleted = await deleteMessageForModeration(sock, from, msg?.key);
      if (!deleted) {
        await warnMissingPermission(sock, from, config, msg);
        return false;
      }

      const participant = findGroupParticipant(groupMetadata || {}, [senderId]);
      const mentionJid = getParticipantMentionJid(
        groupMetadata || {},
        participant,
        senderId
      );
      const warning = addWarning(from, mentionJid || senderId, {
        reason: `${config.itemLabel} bloqueado`,
        source: config.name,
      });
      let kicked = false;

      if (warning.shouldKick) {
        const removal = await runGroupParticipantAction(
          sock,
          from,
          groupMetadata || {},
          participant,
          [mentionJid || senderId],
          "remove"
        );
        kicked = removal.ok;
        if (kicked) clearWarnings(from, mentionJid || senderId);
      }

      await sock.sendMessage(from, {
        text:
          `${config.icon} *${config.label.toUpperCase()}*\n` +
          `${getParticipantDisplayTag(participant, senderId)}, los ${config.pluralLabel} no estan permitidos.\n` +
          `Advertencia: *${warning.count}/${warning.maxWarnings}*` +
          (kicked ? "\n🚫 Usuario expulsado al alcanzar el limite." : ""),
        mentions: mentionJid ? [mentionJid] : [],
        ...global.channelInfo,
      });
      return true;
    },
  };
}
