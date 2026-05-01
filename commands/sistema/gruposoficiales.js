export default {
  command: ["gruposoficiales", "grupooficial", "comunidad", "soportebot"],
  category: "sistema",
  description: "Muestra los grupos oficiales del bot.",

  run: async ({ sock, msg, from }) => {
    const lines = [
      "╭━━〔 🌐 *GRUPOS OFICIALES FSOCIETY* 〕━━⬣",
      "┃ *Comunidad (DVYER):*",
      "┃ https://chat.whatsapp.com/GuLWXlFUdy3BJA9OXcc1Hj",
      "┃",
      "┃ *Grupo oficial del bot:*",
      "┃ https://chat.whatsapp.com/ItdJRKVJGCsIXZjviN3MZO",
      "┃",
      "┃ *Grupo de soporte del bot:*",
      "┃ https://chat.whatsapp.com/FsrlWXVdG3RCLYbZ5LazBO",
      "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━⬣",
    ];

    return sock.sendMessage(
      from,
      { text: lines.join("\n"), ...global.channelInfo },
      { quoted: msg }
    );
  },
};
