import { formatBytes, formatDuration, getPrimaryPrefix } from "../../lib/json-store.js";

function formatTmpLimit(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "DESACTIVADO";
  return formatBytes(value);
}

export default {
  name: "autoclean",
  command: ["autoclean", "autolimpieza", "cleaner"],
  category: "sistema",
  description: "Limpia temporales y backups viejos automaticamente",
  ownerOnly: true,

  run: async ({ sock, msg, from, args = [], settings }) => {
    const runtime = global.botRuntime;
    const prefix = getPrimaryPrefix(settings);
    const action = String(args[0] || "status").trim().toLowerCase();

    if (!runtime?.getAutoCleanState || !runtime?.setAutoCleanConfig || !runtime?.runAutoClean) {
      return sock.sendMessage(from, { text: "No pude abrir el autoclean.", ...global.channelInfo }, { quoted: msg });
    }

    if (action === "on" || action === "off") {
      const state = runtime.setAutoCleanConfig({ enabled: action === "on" });
      return sock.sendMessage(
        from,
        {
          text: `Autoclean: *${state.enabled ? "ENCENDIDO" : "APAGADO"}*`,
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }

    if (action === "run" || action === "now") {
      const result = runtime.runAutoClean();
      return sock.sendMessage(
        from,
        {
          text:
            `*AUTO CLEAN EJECUTADO*\n\n` +
            `Archivos borrados: *${result.removedFiles}*\n` +
            `Carpetas vacias borradas: *${result.removedDirs || 0}*\n` +
            `Espacio liberado: *${result.freedLabel}*\n` +
            `TMP descargas limpiado: *${result.managedTempRemovedFiles || 0} archivos / ${result.managedTempFreedLabel || formatBytes(0)}*`,
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }

    if (action === "config") {
      const intervalMinutes = Number(args[1] || 30);
      const ageMinutes = Number(args[2] || 360);
      const tmpLimitMb = args[3] == null ? null : Number(args[3]);
      const state = runtime.setAutoCleanConfig({
        intervalMs: intervalMinutes * 60 * 1000,
        maxFileAgeMs: ageMinutes * 60 * 1000,
        ...(Number.isFinite(tmpLimitMb) ? { maxTmpTotalBytes: tmpLimitMb * 1024 * 1024 } : {}),
      });

      return sock.sendMessage(
        from,
        {
          text:
            `Autoclean actualizado.\n` +
            `Intervalo: *${formatDuration(state.intervalMs)}*\n` +
            `Edad maxima: *${formatDuration(state.maxFileAgeMs)}*\n` +
            `Limite TMP: *${formatTmpLimit(state.maxTmpTotalBytes)}*`,
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }

    const state = runtime.getAutoCleanState();

    return sock.sendMessage(
      from,
      {
        text:
          `*AUTO CLEAN*\n\n` +
          `Estado: *${state.enabled ? "ENCENDIDO" : "APAGADO"}*\n` +
          `Intervalo: *${formatDuration(state.intervalMs)}*\n` +
          `Edad maxima: *${formatDuration(state.maxFileAgeMs)}*\n` +
          `Limite TMP: *${formatTmpLimit(state.maxTmpTotalBytes)}*\n` +
          `Ultima ejecucion: *${state.lastRunAt ? new Date(state.lastRunAt).toLocaleString("es-PE") : "Nunca"}*\n` +
          `Ultimo borrado: *${state.lastSummary.removedFiles} archivos / ${formatBytes(state.lastSummary.freedBytes)}*\n` +
          `TMP descargas: *${state.lastSummary.managedTempRemovedFiles || 0} archivos / ${state.lastSummary.managedTempFreedLabel || formatBytes(0)}*\n` +
          `TMP: *${formatBytes(state.lastSummary.tmpTotalBytes)}* / *${formatTmpLimit(state.lastSummary.tmpLimitBytes || state.maxTmpTotalBytes)}*` +
          `${state.lastSummary.tmpOverLimit ? " (recorte por limite)" : ""}\n\n` +
          `Uso:\n` +
          `${prefix}autoclean on\n` +
          `${prefix}autoclean off\n` +
          `${prefix}autoclean run\n` +
          `${prefix}autoclean config 30 360 0`,
        ...global.channelInfo,
      },
      { quoted: msg }
    );
  },
};
