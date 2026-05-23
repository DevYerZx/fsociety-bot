import fs from "fs";
import path from "path";
import {
  getParticipantDisplayTag,
  getParticipantMentionJid,
  runGroupParticipantAction,
} from "../../lib/group-compat.js";
import { isWhitelistedUser } from "../../lib/group-whitelist.js";

const DB_DIR = path.join(process.cwd(), "database");
const FILE = path.join(DB_DIR, "antibot_groups.json");

const WINDOW_MS = 15 * 1000;
const LIMIT = 4;
const MAX_STRIKES = 2;

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

function extractCommandName(text = "", settings = {}) {
  const value = String(text || "").trim();
  if (!value) return "";

  const prefix = getPrefixes(settings).find((item) => value.startsWith(item));
  if (!prefix) return "";

  const body = value.slice(prefix.length).trim();
  if (!body) return "";

  const [command] = body.split(/\s+/);
  return String(command || "").trim().toLowerCase();
}

function looksLikeBotName(name = "") {
  const value = String(name || "").trim().toLowerCase();
  if (!value) return false;

  return /(bot|assistant|robot|autoresponder|auto|ia|ai)/i.test(value);
}

const enabledGroups = loadSet();
const suspectMap = new Map();

export default {
  name: "antibot",
  command: ["antibot", "anticlone"],
  category: "grupo",
  description: "Detecta clones/bots por comportamiento de comandos y nombre",
  groupOnly: true,
  adminOnly: true,

  run: async ({ sock, from, msg, args = [] }) => {
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const action = String(args[0] || "").trim().toLowerCase();

    if (!action) {
      return sock.sendMessage(
        from,
        {
          text:
            `🤖 *ANTIBOT CLONE*\n` +
            `Estado: *${enabledGroups.has(from) ? "ON ✅" : "OFF ❌"}*\n\n` +
            `Uso:\n` +
            `• .antibot on\n` +
            `• .antibot off`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "on") {
      enabledGroups.add(from);
      saveSet(enabledGroups);
      return sock.sendMessage(
        from,
        { text: "✅ Antibot clone activado en este grupo.", ...global.channelInfo },
        quoted
      );
    }

    if (action === "off") {
      enabledGroups.delete(from);
      saveSet(enabledGroups);
      return sock.sendMessage(
        from,
        { text: "✅ Antibot clone desactivado en este grupo.", ...global.channelInfo },
        quoted
      );
    }

    return sock.sendMessage(
      from,
      { text: "❌ Opcion invalida. Usa: on / off", ...global.channelInfo },
      quoted
    );
  },

  onMessage: async ({ sock, msg, from, esGrupo, esAdmin, esOwner, groupMetadata, text, settings, comandos }) => {
    if (!esGrupo) return;
    if (!enabledGroups.has(from)) return;
    if (esAdmin || esOwner) return;

    const sender = msg?.sender || msg?.key?.participant;
    if (!sender) return;
    if (isWhitelistedUser(from, sender)) return;

    const commandName = extractCommandName(text, settings);
    if (!commandName) return;

    if (!(comandos instanceof Map) || !comandos.get(commandName)) {
      return;
    }

    const pushName = String(msg?.pushName || "").trim();
    if (!looksLikeBotName(pushName)) {
      return;
    }

    const key = `${from}|${sender}`;
    const now = Date.now();
    const state = suspectMap.get(key) || { times: [], strikes: 0 };
    state.times = state.times.filter((item) => now - item <= WINDOW_MS);
    state.times.push(now);

    if (state.times.length >= LIMIT) {
      state.strikes += 1;
      state.times = [];

      const mentionJid = getParticipantMentionJid(groupMetadata || {}, null, sender);
      const tag = getParticipantDisplayTag(null, sender);

      try {
        await sock.sendMessage(from, { delete: msg.key, ...global.channelInfo });
      } catch {}

      if (state.strikes > MAX_STRIKES) {
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
            throw removeResult.error || new Error("No pude expulsar.");
          }

          await sock.sendMessage(
            from,
            {
              text: `🚫 Antibot: ${tag} expulsado por comportamiento de bot clone.`,
              mentions: mentionJid ? [mentionJid] : [],

            }
          );
        } catch {
          await sock.sendMessage(
            from,
            {
              text: `⚠️ Antibot: ${tag} detectado como bot clone, pero no pude expulsar.`,
              mentions: mentionJid ? [mentionJid] : [],

            }
          );
        }
      } else {
        await sock.sendMessage(
          from,
          {
            text:
              `⚠️ Antibot: ${tag} comportamiento sospechoso.\n` +
              `Strike: ${state.strikes}/${MAX_STRIKES + 1}`,
            mentions: mentionJid ? [mentionJid] : [],

          }
        );
      }
    }

    suspectMap.set(key, state);
  },
};
