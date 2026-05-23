import {
  findGroupParticipant,
  getParticipantActionCandidates,
  getParticipantDisplayTag,
  resolveGroupTarget,
  runGroupParticipantAction,
  isParticipantAdmin,
  isParticipantSuperAdmin,
} from "../../lib/group-compat.js";

export default {
  command: ["kick"],
  groupOnly: true,
  adminOnly: true,
  category: "grupo",

  async run({ sock, from, msg, args, m }) {
    try {
      const metadata = await sock.groupMetadata(from);
      const { participant, jid: targetJid, candidates } = resolveGroupTarget(
        metadata,
        msg || m || {},
        args
      );

      if (!targetJid) {
        return await sock.sendMessage(
          from,
          {
            text:
`⚠️ *¿A quién expulso?*

✅ *Formas de usarlo:*
• Responde al mensaje del usuario y escribe: *.kick*
• Menciona al usuario: *.kick @usuario*`,
            ...global.channelInfo
          }
        );
      }

      const botParticipant = findGroupParticipant(metadata, [sock?.user?.id]);
      const botCandidates = getParticipantActionCandidates(
        metadata,
        botParticipant,
        [sock?.user?.id]
      );

      // Evitar expulsar al bot
      if (botCandidates.includes(targetJid)) {
        return await sock.sendMessage(from, {
          text: "🤖 *No puedo expulsarme a mí mismo.*",
          ...global.channelInfo
        });
      }

      if (!participant) {
        return await sock.sendMessage(from, {
          text: "❌ *Usuario no encontrado en este grupo.*",
          ...global.channelInfo
        });
      }

      // 🚫 No expulsar al creador (superadmin)
      if (isParticipantSuperAdmin(participant)) {
        return await sock.sendMessage(from, {
          text: "👑 *No puedes expulsar al creador del grupo.*",
          ...global.channelInfo
        });
      }

      // 🚫 No expulsar a otro admin
      if (isParticipantAdmin(participant)) {
        return await sock.sendMessage(from, {
          text: "🛡️ *No puedes expulsar a otro administrador.*",
          ...global.channelInfo
        });
      }

      const removeResult = await runGroupParticipantAction(
        sock,
        from,
        metadata,
        participant,
        candidates,
        "remove"
      );

      if (!removeResult.ok) {
        throw removeResult.error || new Error("No pude expulsar al usuario.");
      }

      await sock.sendMessage(from, {
        text:
`✅ *Expulsado correctamente.*

👤 Usuario: ${getParticipantDisplayTag(participant, targetJid)}`,
        mentions: [removeResult.jid],

      });

    } catch (e) {
      await sock.sendMessage(from, {
        text:
`❌ *No pude expulsarlo.*

✅ Verifica:
• Que el bot sea *administrador*
• Que yo tenga permisos suficientes`,
        ...global.channelInfo
      });
    }
  }
};
