import fs from "fs";
import path from "path";

const DB_DIR = path.join(process.cwd(), "database");

const WORDS_FILE = path.join(DB_DIR, "adulto18_words.json");
const GROUPS_FILE = path.join(DB_DIR, "anti18_groups.json");
const WARNS_FILE = path.join(DB_DIR, "anti18_warns.json");

const MAX_WARNS = 3;

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

function safeJsonParse(raw, fallback) {
  try {
    const a = JSON.parse(raw);
    if (typeof a === "string") return JSON.parse(a);
    return a;
  } catch {
    return fallback;
  }
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf-8");
    return safeJsonParse(raw, fallback);
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadWords() {
  if (!fs.existsSync(WORDS_FILE)) writeJson(WORDS_FILE, []);
  const arr = readJson(WORDS_FILE, []);
  return Array.isArray(arr) ? arr : [];
}

function loadGroupsSet() {
  const arr = readJson(GROUPS_FILE, []);
  return new Set(Array.isArray(arr) ? arr : []);
}

function saveGroupsSet(set) {
  writeJson(GROUPS_FILE, [...set]);
}

function loadWarns() {
  const obj = readJson(WARNS_FILE, {});
  return obj && typeof obj === "object" ? obj : {};
}

function saveWarns(obj) {
  writeJson(WARNS_FILE, obj);
}

function normalizeText(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractText(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    message?.documentMessage?.caption ||
    null
  );
}

function findBadWord(normalizedText, words) {
  const tokens = new Set(normalizedText.split(" ").filter(Boolean));

  for (const w of words) {
    const ww = normalizeText(w);
    if (!ww) continue;
    if (tokens.has(ww)) return w;
  }

  for (const w of words) {
    const ww = normalizeText(w);
    if (!ww) continue;
    if (ww.includes(" ") && normalizedText.includes(ww)) return w;
  }

  return null;
}

function onOff(v) {
  return v ? "ON ✅" : "OFF ❌";
}

let gruposActivos = loadGroupsSet();

export default {
  command: ["anti18", "antiadultos", "antiporno"],
  category: "grupo",
  description: "Anti +18: 3 advertencias y expulsión (solo admins)",
  groupOnly: true,
  adminOnly: true,

  run: async ({ sock, msg, from, args }) => {
    const sub = (args[0] || "").toLowerCase();

    if (!sub) {
      const st = gruposActivos.has(from);
      return sock.sendMessage(
        from,
        {
          text:
            `🔞 *ANTI +18*\n` +
            `• Estado: *${onOff(st)}*\n\n` +
            `⚙️ Uso:\n` +
            `• .anti18 on\n` +
            `• .anti18 off\n\n` +
            `📌 3 advertencias = expulsión`,
          ...global.channelInfo
        },
        { quoted: msg }
      );
    }

    if (sub === "on") {
      gruposActivos.add(from);
      saveGroupsSet(gruposActivos);
      return sock.sendMessage(from, { text: "✅ Anti +18 activado.", ...global.channelInfo }, { quoted: msg });
    }

    if (sub === "off") {
      gruposActivos.delete(from);
      saveGroupsSet(gruposActivos);
      return sock.sendMessage(from, { text: "✅ Anti +18 desactivado.", ...global.channelInfo }, { quoted: msg });
    }

    return sock.sendMessage(from, { text: "❌ Usa: .anti18 on / .anti18 off", ...global.channelInfo }, { quoted: msg });
  },

  onMessage: async ({ sock, msg, from, esGrupo, esAdmin, esOwner }) => {
    if (!esGrupo) return;
    if (!gruposActivos.has(from)) return;

    if (esAdmin || esOwner) return;

    const sender = msg.key.participant;
    if (!sender) return;

    const textRaw = extractText(msg.message);
    if (!textRaw) return;

    const normalized = normalizeText(textRaw);
    if (!normalized) return;

    const words = loadWords();
    if (!words.length) return;

    const bad = findBadWord(normalized, words);
    if (!bad) return;

    try {
      await sock.sendMessage(from, { delete: msg.key, ...global.channelInfo });
    } catch {}

    const warns = loadWarns();
    if (!warns[from]) warns[from] = {};
    const current = Number(warns[from][sender] || 0) + 1;
    warns[from][sender] = current;
    saveWarns(warns);

    if (current >= MAX_WARNS) {
      try {
        await sock.groupParticipantsUpdate(from, [sender], "remove");
        await sock.sendMessage(from, {
          text:
            `🚫 *ANTI +18*\n` +
            `@${sender.split("@")[0]} llegó a *${current}/${MAX_WARNS}* advertencias.\n` +
            `✅ Fue expulsado del grupo.`,
          mentions: [sender],
          ...global.channelInfo
        });
      } catch {
        await sock.sendMessage(from, {
          text:
            `🚫 *ANTI +18*\n` +
            `@${sender.split("@")[0]} llegó a *${current}/${MAX_WARNS}* advertencias.\n` +
            `⚠️ No pude expulsar (¿bot sin admin?).`,
          mentions: [sender],
          ...global.channelInfo
        });
      }

      warns[from][sender] = 0;
      saveWarns(warns);
      return;
    }

    await sock.sendMessage(from, {
      text:
        `⚠️ *ANTI +18*\n` +
        `@${sender.split("@")[0]} contenido no permitido.\n` +
        `📌 Advertencia: *${current}/${MAX_WARNS}*`,
      mentions: [sender],
      ...global.channelInfo
    });
  }
};
