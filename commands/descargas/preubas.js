export default {
  command: ["panel", "inicio", "start"],
  category: "menu",

  run: async (ctx) => {
    const { sock, from, msg, settings } = ctx;
    const quoted = msg?.key ? { quoted: msg } : undefined;

    // ✅ Obtiene prefijo igual que tu bot (si no tienes, usa ".")
    const usedPrefix = (() => {
      const p = settings?.prefix;
      if (settings?.noPrefix === true) return ".";
      if (Array.isArray(p)) return p[0] || ".";
      if (typeof p === "string") return p || ".";
      return ".";
    })();

    const buttons = [
      {
        buttonId: `${usedPrefix}hosting`,
        buttonText: { displayText: "🤖 TENER BOT / HOSTING" },
        type: 1,
      },
      {
        buttonId: `${usedPrefix}grupos`,
        buttonText: { displayText: "📢 GRUPOS OFICIALES" },
        type: 1,
      },
    ];

    // ✅ IMPORTANTE: no usar ...global.channelInfo aquí
    return sock.sendMessage(
      from,
      {
        text: "👋 *Bienvenido* \nElige una opción:",
        footer: settings?.botName || "DVYER BOT",
        buttons,
        headerType: 1,
      },
      quoted
    );
  },
};
