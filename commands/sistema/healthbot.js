import os from "os";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { buildDvyerUrl, getDvyerBaseUrl } from "../../lib/api-manager.js";
import { getPrefix, formatBytes, formatDuration } from "./_shared.js";

function percent(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

function healthColor(value) {
  if (value === "red") return "🔴";
  if (value === "yellow") return "🟡";
  return "🟢";
}

function evaluateLevel({ apiOk, latencyMs, ramPercent, connectedBots, totalBots }) {
  let level = "green";

  if (!apiOk) return "red";
  if (latencyMs > 2500 || ramPercent >= 90) return "red";
  if (latencyMs > 1200 || ramPercent >= 75) level = "yellow";

  if (totalBots > 0 && connectedBots <= 0) return "red";
  if (totalBots > 0 && connectedBots < totalBots) level = "yellow";

  return level;
}

async function checkApiHealth() {
  const startedAt = Date.now();
  const endpoint = buildDvyerUrl("/health");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("timeout")), 8000);

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "FsocietyBot/healthbot",
      },
    });

    const latencyMs = Math.max(1, Date.now() - startedAt);
    const ok = response.ok;
    return {
      ok,
      statusCode: response.status,
      latencyMs,
      endpoint,
    };
  } catch {
    return {
      ok: false,
      statusCode: 0,
      latencyMs: Math.max(1, Date.now() - startedAt),
      endpoint,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  name: "saludbot",
  command: ["saludbot", "salud", "estadosalud", "healthbot", "health", "bothealth", "diagnostico"],
  category: "sistema",
  description: "Chequea salud del bot, API, latencia, memoria y subbots.",

  run: async ({ sock, msg, from, settings, esGrupo, esBotAdmin }) => {
    const prefix = getPrefix(settings);
    const runtime = global.botRuntime;

    const api = await checkApiHealth();
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const rssPercent = percent(mem.rss, totalMem);
    const uptimeMs = Math.floor(process.uptime() * 1000);
    const bots = runtime?.listBots?.({ includeMain: true }) || [];
    const connectedBots = bots.filter((item) => item?.connected).length;
    const totalBots = bots.length;
    let databaseWritable = true;
    try {
      fs.accessSync(path.join(process.cwd(), "database"), fs.constants.W_OK);
    } catch {
      databaseWritable = false;
    }
    const ffmpegOk = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
    let diskFree = 0;
    try {
      const disk = fs.statfsSync(process.cwd());
      diskFree = Number(disk.bavail || 0) * Number(disk.bsize || 0);
    } catch {}

    const level = evaluateLevel({
      apiOk: api.ok,
      latencyMs: api.latencyMs,
      ramPercent: rssPercent,
      connectedBots,
      totalBots,
    });

    const healthIcon = healthColor(level);
    const statusText =
      `╭──〔 ${healthIcon} *SALUD DEL BOT* 〕──⬣\n` +
      `│ Semaforo: *${healthIcon} ${level.toUpperCase()}*\n` +
      `│ Uptime: *${formatDuration(uptimeMs)}*\n` +
      `│ API: *${api.ok ? `OK (${api.statusCode})` : "DOWN"}*\n` +
      `│ Latencia API: *${api.latencyMs} ms*\n` +
      `│ Memoria RSS: *${formatBytes(mem.rss)} (${rssPercent}%)*\n` +
      `│ Heap usado: *${formatBytes(mem.heapUsed)}*\n` +
      `│ Base de datos: *${databaseWritable ? "ESCRIBIBLE ✅" : "SIN PERMISO ❌"}*\n` +
      `│ FFmpeg: *${ffmpegOk ? "INSTALADO ✅" : "NO DISPONIBLE ❌"}*\n` +
      `│ Disco libre: *${diskFree ? formatBytes(diskFree) : "N/D"}*\n` +
      (esGrupo ? `│ Admin en grupo: *${esBotAdmin ? "SI ✅" : "NO ❌"}*\n` : "") +
      `│ Subbots conectados: *${connectedBots}/${totalBots}*\n` +
      `│ Base API: *${getDvyerBaseUrl()}*\n` +
      `╰────────────⬣\n\n` +
      `Tip: usa *${prefix}antierror on* para ver errores limpios en chat.`;

    return sock.sendMessage(
      from,
      {
        text: statusText,
        title: "FSOCIETY BOT",
        subtitle: "Diagnostico en tiempo real",
        footer: "Pulsa para refrescar",
        interactiveButtons: [
          {
            name: "single_select",
            buttonParamsJson: JSON.stringify({
              title: "Opciones de salud",
              sections: [
                {
                  title: "Diagnostico",
                  rows: [
                    {
                      header: "REFRESH",
                      title: "Actualizar estado",
                      description: "Vuelve a medir API, latencia y memoria.",
                      id: `${prefix}saludbot`,
                    },
                    {
                      header: "CONTROL",
                      title: "Abrir panel admin de grupo",
                      description: "Gestiona antilink, antispam y mas.",
                      id: `${prefix}gpanel`,
                    },
                  ],
                },
              ],
            }),
          },
        ],
        ...global.channelInfo,
      },
      { quoted: msg }
    );
  },
};
