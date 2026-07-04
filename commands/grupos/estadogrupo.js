import fs from "fs";
import path from "path";
import { getAntiMediaState } from "./_antiMedia.js";
import { getAntiRaidState } from "./antiraid.js";
import { getGroupSchedule } from "./horariogrupo.js";
import { getModerationConfig } from "../../lib/group-moderation.js";

const DB_DIR = path.join(process.cwd(), "database");

function safeJsonParse(raw) {
  try {
    const a = JSON.parse(raw);
    if (typeof a === "string") return JSON.parse(a);
    return a;
  } catch {
    return null;
  }
}

function readSetFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return new Set();
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = safeJsonParse(raw);
    if (Array.isArray(data)) {
      return new Set(data);
    }

    if (data && typeof data === "object") {
      const enabledKeys = Object.entries(data)
        .filter(([, value]) => {
          if (typeof value === "boolean") return value;
          if (!value || typeof value !== "object") return false;
          if (value.enabled === true) return true;
          if (value.welcomeEnabled === true) return true;
          return false;
        })
        .map(([groupId]) => groupId);
      return new Set(enabledKeys);
    }

    return new Set();
  } catch {
    return new Set();
  }
}

function onOff(v) {
  return v ? "ON ✅" : "OFF ❌";
}

export default {
  command: ["estadogrupo", "configgrupo", "gpstatus"],
  category: "grupo",
  description: "Muestra funciones activas del grupo (solo admins)",
  groupOnly: true,
  adminOnly: true,

  run: async ({ sock, msg, from }) => {
    const welcomeFile = path.join(DB_DIR, "welcome.json");
    const modoAdmiFile = path.join(DB_DIR, "modoadmi.json");
    const botOffFile = path.join(DB_DIR, "botoff_groups.json");
    const antilinkFile = path.join(DB_DIR, "antilink.json");
    const antispamFile = path.join(DB_DIR, "antispam.json");
    const antiInsultosFile = path.join(DB_DIR, "antiinsultos_groups.json");

    const welcomeSet = readSetFromFile(welcomeFile);
    const modoAdmiSet = readSetFromFile(modoAdmiFile);
    const botOffSet = readSetFromFile(botOffFile);
    const antilinkSet = readSetFromFile(antilinkFile);
    const antispamSet = readSetFromFile(antispamFile);
    const antiInsultosSet = readSetFromFile(antiInsultosFile);

    const welcomeOn = welcomeSet.has(from);
    const modoAdmiOn = modoAdmiSet.has(from);
    const botOffOn = botOffSet.has(from);

    const antilinkExists = fs.existsSync(antilinkFile);
    const antilinkLabel = antilinkExists
      ? onOff(antilinkSet.has(from))
      : "TEMP ♻️ (no guardado)";

    const antispamOn = antispamSet.has(from);
    const antiInsultosOn = antiInsultosSet.has(from);
    const antiMedia = getAntiMediaState(from);
    const antiRaid = getAntiRaidState(from);
    const schedule = getGroupSchedule(from);
    const moderation = getModerationConfig(from);

    const caption =
      `🧩 *ESTADO DEL GRUPO*\n\n` +
      `• Welcome: ${onOff(welcomeOn)}\n` +
      `• ModoAdmin: ${onOff(modoAdmiOn)}\n` +
      `• BotOff: ${onOff(botOffOn)}\n` +
      `• Antilink: ${antilinkLabel}\n` +
      `• Antispam: ${onOff(antispamOn)}\n` +
      `• AntiImagen: ${onOff(antiMedia.image)}\n` +
      `• AntiSticker: ${onOff(antiMedia.sticker)}\n` +
      `• AntiVideo: ${onOff(antiMedia.video)}\n` +
      `• AntiAudio: ${onOff(antiMedia.audio)}\n` +
      `• AntiDocumento: ${onOff(antiMedia.document)}\n` +
      `• AntiRaid: ${onOff(antiRaid.enabled)}\n` +
      `• Sanciones: ${onOff(moderation.enabled)} (${moderation.maxWarnings})\n` +
      `• Horario: ${onOff(schedule.enabled)} (${schedule.label || "Peru"})\n` +
      `• Anti-Insultos: ${onOff(antiInsultosOn)}\n\n` +
      `👮 Solo admins pueden usar este comando.`;

    try {
      const ppUrl = await sock.profilePictureUrl(from, "image");
      return sock.sendMessage(
        from,
        { image: { url: ppUrl }, caption, ...global.channelInfo },
        { quoted: msg }
      );
    } catch {
      return sock.sendMessage(
        from,
        { text: caption, ...global.channelInfo },
        { quoted: msg }
      );
    }
  }
};
