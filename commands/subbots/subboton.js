import {
  getCurrentChatStatus,
  getSubbotQuoted,
  hasSubbotRuntime,
} from "./_shared.js";

export default {
  name: "subboton",
  command: ["subboton"],
  category: "subbots",
  description: "Activa el acceso publico a subbots",

  run: async ({ sock, msg, from, esOwner, isGroup, botId, botLabel }) => {
    const quoted = getSubbotQuoted(msg);
    const runtime = global.botRuntime;
    const chatStatus = getCurrentChatStatus({ isGroup, botId, botLabel });

    if (!hasSubbotRuntime(runtime)) {
      return sock.sendMessage(
        from,
        {
          text: "No pude acceder al control interno del subbot.",
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (!esOwner) {
      return sock.sendMessage(
        from,
        {
          text: "Solo el owner puede activar el subbot para todos.",
          ...global.channelInfo,
        },
        quoted
      );
    }

    const nextState = runtime.setSubbotPublicRequests(true);

    return sock.sendMessage(
      from,
      {
        text:
          `*SUBBOTS ACTIVADOS*\n\n` +
          `Acceso publico: *ENCENDIDO*\n` +
          `Capacidad total: *${nextState.maxSlots} slots*\n` +
          `Slots libres: *${nextState.availableSlots}*\n` +
          `En este chat: ${chatStatus}`,
        ...global.channelInfo,
      },
      quoted
    );
  },
};
