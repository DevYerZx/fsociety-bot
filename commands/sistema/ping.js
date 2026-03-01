export default {
  command: ["ping", "speed"],
  category: "sistema",
  description: "Muestra la latencia del bot",

  run: async ({ sock, msg, from }) => {
    const t0 = Date.now();
    const sent = await sock.sendMessage(
      from,
      { text: "🏓 Pong...", ...global.channelInfo },
      { quoted: msg }
    );
    const ms = Date.now() - t0;

    // Editar no siempre funciona en WA, así que enviamos otro mensaje corto
    return sock.sendMessage(
      from,
      { text: `✅ *Ping:* ${ms}ms`, ...global.channelInfo },
      { quoted: sent }
    );
  }
};
