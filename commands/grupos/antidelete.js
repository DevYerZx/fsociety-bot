import fs from "fs";
import path from "path";
import {
  findGroupParticipant,
  getParticipantDisplayTag,
  getParticipantMentionJid,
} from "../../lib/group-compat.js";

const DB_DIR = path.join(process.cwd(), "database");
const FILE = path.join(DB_DIR, "antidelete.json");

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

function readStore() {
  try {
    if (!fs.existsSync(FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveStore(store) {
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
}

function isEnabled(groupId) {
  const store = readStore();
  return store[String(groupId || "")] === true;
}

function getTextFromDeletedMessage(message) {
  if (!message) return "";

  return String(
    message?.text ||
      message?.body ||
      message?.message?.conversation ||
      message?.message?.extendedTextMessage?.text ||
      message?.message?.imageMessage?.caption ||
      message?.message?.videoMessage?.caption ||
      ""
  ).trim();
}

export default {
  name: "antidelete",
  command: ["antidelete"],
  category: "grupo",
  groupOnly: true,
  adminOnly: true,
  description: "Reenvia mensajes borrados en grupos",

  async run({ sock, msg, from, args = [] }) {
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const store = readStore();
    const action = String(args[0] || "status").trim().toLowerCase();

    if (!args.length || action === "status") {
      return sock.sendMessage(
        from,
        {
          text:
            `*ANTIDELETE*\n\n` +
            `Estado: *${store[from] === true ? "ON" : "OFF"}*\n\n` +
            `.antidelete on\n` +
            `.antidelete off`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "on") {
      store[from] = true;
      saveStore(store);
      return sock.sendMessage(
        from,
        {
          text: "Antidelete activado para este grupo.",
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "off") {
      delete store[from];
      saveStore(store);
      return sock.sendMessage(
        from,
        {
          text: "Antidelete desactivado para este grupo.",
          ...global.channelInfo,
        },
        quoted
      );
    }

    return sock.sendMessage(
      from,
      {
        text: "Usa .antidelete on o .antidelete off",
        ...global.channelInfo,
      },
      quoted
    );
  },

  async onMessageDelete({ sock, from, isGroup, deleteKey, deletedMessage }) {
    if (!isGroup || !isEnabled(from)) return;
    if (!deleteKey || deleteKey.fromMe) return;

    const sender =
      deleteKey.participant ||
      deletedMessage?.sender ||
      deletedMessage?.senderLid ||
      deletedMessage?.senderPhone ||
      deleteKey.remoteJid ||
      "";
    let metadata = null;
    try {
      metadata = await sock.groupMetadata(from);
    } catch {}
    const participant = findGroupParticipant(metadata || {}, [sender]);
    const mentionJid = getParticipantMentionJid(metadata || {}, participant, sender);
    const userTag = getParticipantDisplayTag(participant, sender);
    const recoveredText = getTextFromDeletedMessage(deletedMessage);

    let body =
      `*ANTIDELETE*\n\n` +
      `Usuario: ${userTag}\n` +
      `Accion: elimino un mensaje`;

    if (recoveredText) {
      body += `\n\nContenido recuperado:\n${recoveredText}`;
    } else if (deletedMessage?.message?.imageMessage) {
      body += `\n\nTipo: imagen`;
    } else if (deletedMessage?.message?.videoMessage) {
      body += `\n\nTipo: video`;
    } else if (deletedMessage?.message?.audioMessage) {
      body += `\n\nTipo: audio`;
    } else if (deletedMessage?.message?.documentMessage) {
      body += `\n\nTipo: documento`;
    } else {
      body += `\n\nNo pude recuperar el contenido exacto.`;
    }

    await sock.sendMessage(from, {
      text: body,
      mentions: mentionJid ? [mentionJid] : [],

    });
  },
};
