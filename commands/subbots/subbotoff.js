import {
  getCurrentChatStatus,
  getSubbotQuoted,
  hasSubbotRuntime,
} from "./_shared.js";

export default {
  name: "subbotoff",
  command: ["subbotoff"],
  category: "subbots",
  description: "Apaga el acceso publico a subbots",

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
          text: "Solo el owner puede apagar el acceso a los subbots.",
          ...global.channelInfo,
        },
        quoted
      );
    }

    const nextState = runtime.setSubbotPublicRequests(false);

    return sock.sendMessage(
      from,
      {
        text:
          `*SUBBOTS APAGADOS*\n\n` +
          `Acceso publico: *APAGADO*\n` +
          `Slots configurables: *${nextState.maxSlots}*\n` +
          `Slots libres: *${nextState.availableSlots}*\n` +
          `En este chat: ${chatStatus}`,
        ...global.channelInfo,
      },
      quoted
    );
  },
};
