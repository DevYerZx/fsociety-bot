import { getPrimaryPrefix } from "../../lib/json-store.js";
import { getParticipantDisplayTag, resolveGroupTarget } from "../../lib/group-compat.js";
import {
  addWhitelistedUser,
  clearGroupWhitelist,
  getGroupWhitelist,
  removeWhitelistedUser,
} from "../../lib/group-whitelist.js";

function formatList(values = []) {
  if (!values.length) return "Sin usuarios en whitelist.";
  return values.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

export default {
  name: "whitelist",
  command: ["whitelist", "wl"],
  category: "grupo",
  description: "Gestiona whitelist por grupo para antispam y filtros",
  groupOnly: true,
  adminOnly: true,

  run: async ({ sock, from, msg, m, args = [], settings, groupMetadata }) => {
    const quoted = (msg || m)?.key ? { quoted: msg || m } : undefined;
    const prefix = getPrimaryPrefix(settings);
    const action = String(args[0] || "").trim().toLowerCase();

    if (!action || ["list", "lista", "status", "estado"].includes(action)) {
      const list = getGroupWhitelist(from);
      return sock.sendMessage(
        from,
        {
          text:
            `🛡️ *WHITELIST DEL GRUPO*\n` +
            `Total: *${list.length}*\n\n` +
            `${formatList(list)}\n\n` +
            `Uso:\n` +
            `• ${prefix}whitelist add @usuario\n` +
            `• ${prefix}whitelist del @usuario\n` +
            `• ${prefix}whitelist clear`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (["clear", "limpiar", "reset"].includes(action)) {
      clearGroupWhitelist(from);
      return sock.sendMessage(
        from,
        {
          text: "✅ Whitelist limpiada para este grupo.",
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (["add", "agregar", "set"].includes(action)) {
      const metadata = groupMetadata || (await sock.groupMetadata(from));
      const { participant, jid } = resolveGroupTarget(metadata, msg || m || {}, args.slice(1));
      const fallback = String(args[1] || "").trim();
      const target = String(jid || fallback || "").trim();

      if (!target) {
        return sock.sendMessage(
          from,
          {
            text:
              `⚠️ Indica usuario.\n` +
              `Ejemplo: ${prefix}whitelist add @usuario\n` +
              `Tambien puedes responder un mensaje.`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      const result = addWhitelistedUser(from, target);
      if (!result.ok) {
        return sock.sendMessage(
          from,
          {
            text: "❌ No pude agregar ese usuario a whitelist.",
            ...global.channelInfo,
          },
          quoted
        );
      }

      return sock.sendMessage(
        from,
        {
          text:
            `${result.existed ? "ℹ️ Ya estaba" : "✅ Agregado"} en whitelist: ` +
            `${getParticipantDisplayTag(participant, target)}\n` +
            `Total: ${result.total}`,
          mentions: jid ? [jid] : [],

        },
        quoted
      );
    }

    if (["del", "remove", "rm", "quitar"].includes(action)) {
      const metadata = groupMetadata || (await sock.groupMetadata(from));
      const { participant, jid } = resolveGroupTarget(metadata, msg || m || {}, args.slice(1));
      const fallback = String(args[1] || "").trim();
      const target = String(jid || fallback || "").trim();

      if (!target) {
        return sock.sendMessage(
          from,
          {
            text:
              `⚠️ Indica usuario.\n` +
              `Ejemplo: ${prefix}whitelist del @usuario\n` +
              `Tambien puedes responder un mensaje.`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      const result = removeWhitelistedUser(from, target);
      return sock.sendMessage(
        from,
        {
          text:
            `${result.removed ? "✅ Removido" : "ℹ️ No estaba"} de whitelist: ` +
            `${getParticipantDisplayTag(participant, target)}\n` +
            `Total: ${result.total}`,
          mentions: jid ? [jid] : [],

        },
        quoted
      );
    }

    return sock.sendMessage(
      from,
      {
        text:
          `Uso:\n` +
          `• ${prefix}whitelist list\n` +
          `• ${prefix}whitelist add @usuario\n` +
          `• ${prefix}whitelist del @usuario\n` +
          `• ${prefix}whitelist clear`,
        ...global.channelInfo,
      },
      quoted
    );
  },
};
