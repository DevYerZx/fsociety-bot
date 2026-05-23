import { getParticipantMentionJid } from "../../lib/group-compat.js";

export default {
  command: ["hidetag"],
  category: "grupo",
  description: "Etiqueta a todos sin listar",
  groupOnly: true,
  adminOnly: true,

  run: async ({ sock, msg, from, args }) => {
    const meta = await sock.groupMetadata(from);
    const members = (Array.isArray(meta?.participants) ? meta.participants : [])
      .map((participant) => getParticipantMentionJid(meta, participant, participant?.id))
      .filter(Boolean);

    const texto = args.length
      ? args.join(" ")
      : "ㅤ"; // invisible

    return sock.sendMessage(
      from,
      { text: texto, mentions: members },
      { quoted: msg }
    );
  }
};
