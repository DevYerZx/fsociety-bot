import {
  buildSubbotCard,
  formatDateTime,
  getCurrentChatStatus,
  getPrefix,
  getSubbotQuoted,
  hasSubbotRuntime,
} from "./_shared.js";

export default {
  name: "subbots",
  command: ["subbots", "codigosubbots", "estadosubbots", "subbotsactivos"],
  category: "subbots",
  description: "Muestra el panel de subbots",

  run: async ({ sock, msg, from, settings, isGroup, botId, botLabel }) => {
    const quoted = getSubbotQuoted(msg);
    const prefix = getPrefix(settings);
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

    const subbotAccess = runtime.getSubbotRequestState();
    const bots = runtime
      .listBots()
      .slice()
      .sort((a, b) => Number(a.slot || 0) - Number(b.slot || 0));
    const publicLabel = subbotAccess.publicRequests ? "ENCENDIDO" : "APAGADO";
    const activeCount = bots.filter((bot) => bot.connected).length;
    const linkedCount = bots.filter((bot) => bot.registered).length;
    const enabledCount = bots.filter((bot) => bot.enabled).length;
    const lines = bots.length
      ? bots.map((bot) => buildSubbotCard(bot))
      : ["No hay slots de subbot disponibles."];

    return sock.sendMessage(
      from,
      {
        text:
          `*PANEL SUBBOTS*\n\n` +
          `Modo publico: *${publicLabel}*\n` +
          `Capacidad: *${subbotAccess.maxSlots} slots*\n` +
          `Slots libres: *${subbotAccess.availableSlots}*\n` +
          `Slots activados: *${enabledCount}*\n` +
          `Subbots vinculados: *${linkedCount}*\n` +
          `Activos ahora: *${activeCount}*\n` +
          `Hora actual: ${formatDateTime(Date.now())}\n` +
          `En este chat: ${chatStatus}\n\n` +
          `${lines.join("\n\n")}\n\n` +
          `Comandos:\n` +
          `${prefix}subbot 519xxxxxxxxx\n` +
          `${prefix}subbot 3 519xxxxxxxxx\n` +
          `${prefix}subbots\n` +
          `${prefix}subboton\n` +
          `${prefix}subbotoff`,
        ...global.channelInfo,
      },
      quoted
    );
  },
};
