import fs from "fs";
import path from "path";

const ROOT_DIR = process.cwd();
const BACKUPS_DIR = path.join(ROOT_DIR, "backups");

function getQuoted(msg) {
  return msg?.key ? { quoted: msg } : undefined;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getBackupName() {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `backup-${stamp}`;
}

function collectSessionDirs() {
  return fs
    .readdirSync(ROOT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("dvyer-session"))
    .map((entry) => entry.name);
}

function copyIfExists(source, target) {
  if (!fs.existsSync(source)) return false;
  fs.cpSync(source, target, { recursive: true, force: true });
  return true;
}

export function createBotBackup() {
  ensureDir(BACKUPS_DIR);
  const backupName = getBackupName();
  const backupPath = path.join(BACKUPS_DIR, backupName);
  ensureDir(backupPath);

  const copied = [];
  if (copyIfExists(path.join(ROOT_DIR, "settings"), path.join(backupPath, "settings"))) copied.push("settings");
  if (copyIfExists(path.join(ROOT_DIR, "database"), path.join(backupPath, "database"))) copied.push("database");
  if (copyIfExists(path.join(ROOT_DIR, "videos"), path.join(backupPath, "videos"))) copied.push("videos");

  for (const dirName of collectSessionDirs()) {
    if (copyIfExists(path.join(ROOT_DIR, dirName), path.join(backupPath, dirName))) copied.push(dirName);
  }

  fs.writeFileSync(
    path.join(backupPath, "manifest.json"),
    JSON.stringify({ name: backupName, createdAt: new Date().toISOString(), copied }, null, 2)
  );
  return { backupName, backupPath, copied };
}

export default {
  name: "backup",
  command: ["backup"],
  category: "sistema",
  description: "Crea un respaldo del bot",

  run: async ({ sock, msg, from, esOwner }) => {
    if (!esOwner) {
      return sock.sendMessage(
        from,
        { text: "Solo el owner puede usar este comando.", ...global.channelInfo },
        getQuoted(msg)
      );
    }

    const { backupName, copied } = createBotBackup();

    await sock.sendMessage(
      from,
      {
        text:
          `*BACKUP COMPLETADO*\n\n` +
          `Nombre: *${backupName}*\n` +
          `Contenido: ${copied.join(", ") || "Sin contenido"}`,
        ...global.channelInfo,
      },
      getQuoted(msg)
    );
  },
};
