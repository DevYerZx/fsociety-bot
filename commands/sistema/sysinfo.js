import os from "os";

function formatBytes(bytes = 0) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function formatUptime(seconds = 0) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatPercent(part = 0, total = 0) {
  const p = Number(part || 0);
  const t = Number(total || 0);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return "0%";
  return `${((p / t) * 100).toFixed(1)}%`;
}

function getRuntimeLabel() {
  if (process.env.pm_id || process.env.PM2_HOME) return "PM2 / VPS";
  if (process.env.RAILWAY_ENVIRONMENT) return "Railway";
  if (process.env.RENDER) return "Render";
  if (process.env.PTERODACTYL_SERVER_UUID || process.env.SERVER_ID) return "Pterodactyl";
  if (process.env.KOYEB_SERVICE_NAME) return "Koyeb";
  if (process.env.DYNO) return "Heroku";
  if (process.env.DOCKER_CONTAINER || process.env.container) return "Docker";
  return "Node directo";
}

function getCpuModel() {
  const cpus = os.cpus() || [];
  return cpus[0]?.model || "Desconocido";
}

function getCpuCount() {
  const cpus = os.cpus() || [];
  return cpus.length || 1;
}

function getLoadAverage() {
  try {
    return os.loadavg().map((value) => value.toFixed(2)).join(" | ");
  } catch {
    return "No disponible";
  }
}

async function react(sock, msg, emoji) {
  try {
    if (!msg?.key) return;
    await sock.sendMessage(msg.key.remoteJid, {
      react: {
        text: emoji,
        key: msg.key,
      },
    });
  } catch {}
}

export default {
  command: ["sysinfo", "system", "hostinfo", "serverinfo"],
  categoria: "sistema",
  description: "Muestra host, CPU, memoria y entorno del bot",

  run: async ({ sock, msg, from }) => {
    try {
      await react(sock, msg, "🖥️");

      const totalMemory = os.totalmem();
      const freeMemory = os.freemem();
      const usedMemory = totalMemory - freeMemory;
      const processMemory = process.memoryUsage();

      const text = [
        "╭━━━〔 🖥️ *SYSINFO FSOCIETY* 〕━━━⬣",
        "┃",
        `┃ 🏷️ *Host:* ${os.hostname()}`,
        `┃ 🌐 *Entorno:* ${getRuntimeLabel()}`,
        `┃ 💻 *Sistema:* ${os.platform()} ${os.release()} ${os.arch()}`,
        `┃ 🟢 *Node:* ${process.version}`,
        "┃",
        `┃ ⚙️ *CPU cores:* ${getCpuCount()}`,
        `┃ 🧠 *CPU:* ${getCpuModel()}`,
        `┃ 📊 *Load avg:* ${getLoadAverage()}`,
        "┃",
        `┃ 💾 *RAM usada:* ${formatBytes(usedMemory)} / ${formatBytes(totalMemory)}`,
        `┃ 📉 *RAM libre:* ${formatBytes(freeMemory)}`,
        `┃ 📌 *Uso RAM:* ${formatPercent(usedMemory, totalMemory)}`,
        "┃",
        `┃ 📦 *RSS proceso:* ${formatBytes(processMemory.rss)}`,
        `┃ 🧱 *Heap usado:* ${formatBytes(processMemory.heapUsed)}`,
        `┃ 🧩 *Heap total:* ${formatBytes(processMemory.heapTotal)}`,
        `┃ 🔗 *External:* ${formatBytes(processMemory.external)}`,
        "┃",
        `┃ ⏳ *Uptime host:* ${formatUptime(os.uptime())}`,
        `┃ 🚀 *Uptime bot:* ${formatUptime(process.uptime())}`,
        "╰━━━━━━━━━━━━━━━━━━━━━━━━⬣",
      ].join("\n");

      await sock.sendMessage(
        from,
        { text, ...global.channelInfo },
        { quoted: msg }
      );

      await react(sock, msg, "✅");
    } catch (error) {
      console.error("SYSINFO ERROR:", error);
      await react(sock, msg, "❌");
      await sock.sendMessage(
        from,
        { text: "Error al obtener la información del sistema.", ...global.channelInfo },
        { quoted: msg }
      );
    }
  },
};