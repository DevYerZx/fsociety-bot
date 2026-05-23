import fs from "fs";
import path from "path";
import {
  findGroupParticipant,
  getParticipantMentionJid,
  normalizeJidDigits,
  runGroupParticipantAction,
} from "../../lib/group-compat.js";

const DB_DIR = path.join(process.cwd(), "database");
const FILE = path.join(DB_DIR, "antifake.json");
const DEFAULT_PREFIXES = ["51", "52", "53", "54", "55", "56", "57", "58", "591", "593", "595", "598"];

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

function normalizePrefix(value = "") {
  return String(value || "").replace(/[^\d]/g, "");
}

function normalizeConfig(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    enabled: source.enabled === true,
    prefixes: Array.isArray(source.prefixes)
      ? source.prefixes.map((item) => normalizePrefix(item)).filter(Boolean)
      : [...DEFAULT_PREFIXES],
  };
}

function readStore() {
  try {
    if (!fs.existsSync(FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).map(([groupId, config]) => [groupId, normalizeConfig(config)])
    );
  } catch {
    return {};
  }
}

function saveStore(store) {
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
}

function getConfig(groupId) {
  const store = readStore();
  if (!store[groupId]) {
    store[groupId] = normalizeConfig();
    saveStore(store);
  }
  return store[groupId];
}

function isAllowed(number = "", config = {}) {
  const normalized = String(number || "").replace(/[^\d]/g, "");
  return config.prefixes.some((prefix) => normalized.startsWith(prefix));
}

export default {
  name: "antifake",
  command: ["antifake"],
  category: "grupo",
  groupOnly: true,
  adminOnly: true,
  description: "Bloquea numeros fuera de los prefijos permitidos",

  async run({ sock, msg, from, args = [] }) {
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const store = readStore();
    const config = store[from] || normalizeConfig();
    const action = String(args[0] || "status").trim().toLowerCase();
    const value = normalizePrefix(args[1] || args[0] || "");

    if (!args.length || action === "status") {
      return sock.sendMessage(
        from,
        {
          text:
            `*ANTIFAKE*\n\n` +
            `Estado: *${config.enabled ? "ON" : "OFF"}*\n` +
            `Prefijos permitidos: *${config.prefixes.join(", ")}*\n\n` +
            `.antifake on\n` +
            `.antifake off\n` +
            `.antifake add 52\n` +
            `.antifake remove 52\n` +
            `.antifake list`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "on") {
      store[from] = { ...config, enabled: true };
      saveStore(store);
      return sock.sendMessage(
        from,
        { text: "Antifake activado.", ...global.channelInfo },
        quoted
      );
    }

    if (action === "off") {
      store[from] = { ...config, enabled: false };
      saveStore(store);
      return sock.sendMessage(
        from,
        { text: "Antifake desactivado.", ...global.channelInfo },
        quoted
      );
    }

    if (action === "list") {
      return sock.sendMessage(
        from,
        {
          text: `Prefijos permitidos:\n${config.prefixes.map((item) => `- ${item}`).join("\n")}`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "add") {
      if (!value) {
        return sock.sendMessage(
          from,
          { text: "Usa: .antifake add 52", ...global.channelInfo },
          quoted
        );
      }
      const next = Array.from(new Set([...config.prefixes, value])).sort();
      store[from] = { ...config, prefixes: next };
      saveStore(store);
      return sock.sendMessage(
        from,
        { text: `Prefijo agregado: ${value}`, ...global.channelInfo },
        quoted
      );
    }

    if (action === "remove" || action === "del") {
      if (!value) {
        return sock.sendMessage(
          from,
          { text: "Usa: .antifake remove 52", ...global.channelInfo },
          quoted
        );
      }
      store[from] = {
        ...config,
        prefixes: config.prefixes.filter((item) => item !== value),
      };
      saveStore(store);
      return sock.sendMessage(
        from,
        { text: `Prefijo removido: ${value}`, ...global.channelInfo },
        quoted
      );
    }

    return sock.sendMessage(
      from,
      { text: "Opcion invalida.", ...global.channelInfo },
      quoted
    );
  },

  async onGroupUpdate({ sock, update, settings }) {
    if (!update?.id || update.action !== "add") return;

    const config = getConfig(update.id);
    if (!config.enabled) return;
    const ownerNumbers = [
      settings?.ownerNumber,
      ...(Array.isArray(settings?.ownerNumbers) ? settings.ownerNumbers : []),
    ]
      .map((item) => normalizePrefix(item))
      .filter(Boolean);
    const botNumber = normalizeJidDigits(sock?.user?.id || "") || normalizePrefix(sock?.user?.id || "");

    let botIsAdmin = false;
    let metadata = null;
    try {
      metadata = await sock.groupMetadata(update.id);
      const botParticipant = findGroupParticipant(metadata, [sock?.user?.id]);
      botIsAdmin = Boolean(botParticipant?.admin);
    } catch {}

    for (const participant of update.participants || []) {
      const metadataParticipant = findGroupParticipant(metadata || {}, [participant]);
      const mentionJid = getParticipantMentionJid(
        metadata || {},
        metadataParticipant,
        participant
      );
      const number = normalizeJidDigits(participant);
      if (!number || isAllowed(number, config) || ownerNumbers.includes(number) || number === botNumber) {
        continue;
      }

      if (botIsAdmin) {
        try {
          await runGroupParticipantAction(
            sock,
            update.id,
            metadata || {},
            metadataParticipant,
            [participant],
            "remove"
          );
        } catch {}
      }

      await sock.sendMessage(update.id, {
        text:
          `*ANTIFAKE*\n\n` +
          `Numero detectado: *+${number}*\n` +
          `No coincide con los prefijos permitidos del grupo.`,
        mentions: mentionJid ? [mentionJid] : [],

      });
    }
  },
};
