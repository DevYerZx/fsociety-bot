function getQuoted(msg) {
  return msg?.key ? { quoted: msg } : undefined;
}

function extractInviteCode(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";

  const match = text.match(/chat\.whatsapp\.com\/([0-9A-Za-z]{20,})/i);
  if (match?.[1]) {
    return match[1];
  }

  return text.replace(/[^0-9A-Za-z]/g, "");
}

function isAlreadyJoinedError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("already") ||
    message.includes("is already") ||
    message.includes("already a participant") ||
    message.includes("ya eres") ||
    message.includes("ya esta") ||
    message.includes("ya está") ||
    message.includes("participante")
  );
}

export default {
  name: "join",
  command: ["join", "entrargrupo", "unirme"],
  category: "admin",
  description: "Une el bot actual a un grupo por enlace",

  run: async ({ sock, msg, from, args = [], esOwner, botLabel }) => {
    if (!esOwner) {
      return sock.sendMessage(
        from,
        {
          text: "Solo el owner puede usar este comando.",
          ...global.channelInfo,
        },
        getQuoted(msg)
      );
    }

    const rawInput = String(args.join(" ") || "").trim();
    const inviteCode = extractInviteCode(rawInput);

    if (!inviteCode) {
      return sock.sendMessage(
        from,
        {
          text:
            "*USO JOIN*\n\n" +
            "Usa un enlace o codigo de invitacion.\n" +
            "Ejemplo:\n" +
            ".join https://chat.whatsapp.com/XXXXXXXXXXXXXXX",
          ...global.channelInfo,
        },
        getQuoted(msg)
      );
    }

    try {
      const groupJid = await sock.groupAcceptInvite(inviteCode);

      await sock.sendMessage(
        from,
        {
          text:
            `*${String(botLabel || "BOT").toUpperCase()} UNIDO AL GRUPO*\n\n` +
            `Grupo: ${groupJid}`,
          ...global.channelInfo,
        },
        getQuoted(msg)
      );
    } catch (error) {
      if (isAlreadyJoinedError(error)) {
        return sock.sendMessage(
          from,
          {
            text:
              `*${String(botLabel || "BOT").toUpperCase()} YA ESTA EN EL GRUPO*\n\n` +
              "Ese bot ya pertenece a ese grupo o la invitacion ya fue usada por esta cuenta.",
            ...global.channelInfo,
          },
          getQuoted(msg)
        );
      }

      await sock.sendMessage(
        from,
        {
          text:
            "*ERROR JOIN*\n\n" +
            `${error?.message || "No pude unirme al grupo con ese enlace."}`,
          ...global.channelInfo,
        },
        getQuoted(msg)
      );
    }
  },
};
