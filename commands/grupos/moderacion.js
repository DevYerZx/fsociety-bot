import { getPrimaryPrefix } from "../../lib/json-store.js";
import {
  clearWarnings,
  getModerationConfig,
  getModerationLogs,
  setModerationConfig,
} from "../../lib/group-moderation.js";
import { resolveGroupTarget, getParticipantDisplayTag } from "../../lib/group-compat.js";

export default {
  name: "moderacion",
  command: ["sanciones", "moderacion", "modlogs", "unwarn"],
  category: "grupo",
  description: "Configura sanciones, limpia advertencias y muestra logs",
  groupOnly: true,
  adminOnly: true,

  async run({ sock, from, msg, args = [], commandName, settings, groupMetadata }) {
    const prefix = getPrimaryPrefix(settings);
    const invoked = String(commandName || "").toLowerCase();
    const action = String(args[0] || "status").toLowerCase();
    const quoted = msg?.key ? { quoted: msg } : undefined;

    if (invoked === "modlogs" || action === "logs") {
      const logs = getModerationLogs(from, 15);
      return sock.sendMessage(from, {
        text:
          `📋 *LOGS DE MODERACION*\n\n` +
          (logs.length
            ? logs.map((item, i) => `${i + 1}. ${item.action || "evento"} | ${item.user || "-"} | ${item.reason || item.source || "-"}`).join("\n")
            : "Sin eventos registrados."),
        ...global.channelInfo,
      }, quoted);
    }

    if (invoked === "unwarn" || action === "clear" || action === "limpiar") {
      const metadata = groupMetadata || (await sock.groupMetadata(from));
      const target = resolveGroupTarget(metadata, msg || {}, invoked === "unwarn" ? args : args.slice(1));
      if (!target.jid) {
        return sock.sendMessage(from, { text: `Usa: ${prefix}unwarn @usuario`, ...global.channelInfo }, quoted);
      }
      clearWarnings(from, target.jid);
      return sock.sendMessage(from, {
        text: `✅ Advertencias limpiadas para ${getParticipantDisplayTag(target.participant, target.jid)}.`,
        mentions: [target.jid],
        ...global.channelInfo,
      }, quoted);
    }

    if (["on", "off"].includes(action)) {
      const config = setModerationConfig(from, { enabled: action === "on" });
      return sock.sendMessage(from, { text: `Sanciones automaticas: *${config.enabled ? "ON" : "OFF"}*`, ...global.channelInfo }, quoted);
    }

    if (["limite", "limit"].includes(action)) {
      const config = setModerationConfig(from, { maxWarnings: args[1] });
      return sock.sendMessage(from, { text: `Limite de advertencias: *${config.maxWarnings}*`, ...global.channelInfo }, quoted);
    }

    const config = getModerationConfig(from);
    return sock.sendMessage(from, {
      text:
        `🛡️ *SANCIONES DEL GRUPO*\n\n` +
        `Estado: *${config.enabled ? "ON" : "OFF"}*\n` +
        `Expulsion: *${config.maxWarnings} advertencias*\n\n` +
        `${prefix}sanciones on|off\n${prefix}sanciones limite 3\n` +
        `${prefix}warn @usuario motivo\n${prefix}unwarn @usuario\n${prefix}modlogs`,
      ...global.channelInfo,
    }, quoted);
  },
};
