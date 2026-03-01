import fs from "fs";
import path from "path";

const DB_DIR = path.join(process.cwd(), "database");

function safeJsonParse(raw) {
  try {
    const a = JSON.parse(raw);
    if (typeof a === "string") return JSON.parse(a); // por si quedó "[]"
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
    return new Set(Array.isArray(data) ? data : []);
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
    // Archivos (si alguno no existe, lo toma como OFF/TEMP)
    const welcomeFile = path.join(DB_DIR, "welcome.json");
    const modoAdmiFile = path.join(DB_DIR, "modoadmi.json");

    const antilinkFile = path.join(DB_DIR, "antilink.json"); // si usas persistente
    const antispamFile = path.join(DB_DIR, "antispam.json"); // persistente

    // NUEVO: Anti-Tóxicos
    const antitoxicosFile = path.join(DB_DIR, "antitoxicos_groups.json");

    const welcomeSet = readSetFromFile(welcomeFile);
    const modoAdmiSet = readSetFromFile(modoAdmiFile);
    const antilinkSet = readSetFromFile(antilinkFile);
    const antispamSet = readSetFromFile(antispamFile);
    const antitoxicosSet = readSetFromFile(antitoxicosFile);

    const welcomeOn = welcomeSet.has(from);
    const modoAdmiOn = modoAdmiSet.has(from);

    const antilinkExists = fs.existsSync(antilinkFile);
    const antilinkLabel = antilinkExists ? onOff(antilinkSet.has(from)) : "TEMP ♻️ (no guardado)";

    const antispamOn = antispamSet.has(from);
    const antitoxicosOn = antitoxicosSet.has(from);

    const caption =
      `🧩 *ESTADO DEL GRUPO*\n\n` +
      `• Welcome: ${onOff(welcomeOn)}\n` +
      `• ModoAdmin: ${onOff(modoAdmiOn)}\n` +
      `• Antilink: ${antilinkLabel}\n` +
      `• Antispam: ${onOff(antispamOn)}\n` +
      `• Anti-Tóxicos: ${onOff(antitoxicosOn)}\n\n` +
      `👮 Solo admins pueden usar este comando.`;

    // Foto del grupo + caption
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
