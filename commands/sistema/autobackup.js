import path from "path";
import { createScheduledJsonStore } from "../../lib/json-store.js";
import { createBotBackup } from "./backup.js";

const FILE = path.join(process.cwd(), "database", "autobackup.json");
const store = createScheduledJsonStore(FILE, () => ({
  enabled: true,
  hour: 4,
  lastDate: "",
  lastBackup: "",
}));

function limaNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const read = (type) => parts.find((item) => item.type === type)?.value || "";
  return { date: `${read("year")}-${read("month")}-${read("day")}`, hour: Number(read("hour")) };
}

function runAutomaticBackup() {
  if (!store.state.enabled) return;
  const now = limaNow();
  if (now.hour !== Number(store.state.hour || 4) || store.state.lastDate === now.date) return;
  const result = createBotBackup();
  store.state.lastDate = now.date;
  store.state.lastBackup = result.backupName;
  store.saveNow();
}

const timer = setInterval(() => {
  try {
    runAutomaticBackup();
  } catch (error) {
    console.error("AutoBackup:", error);
  }
}, 15 * 60_000);
timer.unref?.();

export default {
  name: "autobackup",
  command: ["autobackup", "backupauto"],
  category: "sistema",
  description: "Configura el respaldo diario automatico",
  ownerOnly: true,

  async run({ sock, from, msg, args = [] }) {
    const action = String(args[0] || "status").toLowerCase();
    if (["on", "off"].includes(action)) store.state.enabled = action === "on";
    if (action === "hora") {
      store.state.hour = Math.max(0, Math.min(23, Number(args[1] || 4)));
    }
    store.saveNow();
    return sock.sendMessage(from, {
      text:
        `💾 *BACKUP AUTOMATICO*\n\nEstado: *${store.state.enabled ? "ON" : "OFF"}*\n` +
        `Hora: *${String(store.state.hour).padStart(2, "0")}:00 America/Lima*\n` +
        `Ultimo: *${store.state.lastBackup || "Pendiente"}*\n\n` +
        `.autobackup on|off\n.autobackup hora 4`,
      ...global.channelInfo,
    }, msg?.key ? { quoted: msg } : undefined);
  },
};
