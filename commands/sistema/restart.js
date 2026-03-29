export default {
  name: "restart",
  command: ["restart", "reiniciar", "reboot"],
  category: "sistema",
  description: "Reinicia el bot sin perder la sesion",

  run: async ({ sock, msg, from, esOwner }) => {
    if (!esOwner) {
      return sock.sendMessage(
        from,
        {
          text: "Solo el owner puede reiniciar el bot.",
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }

    const runtime = global.botRuntime;
    if (!runtime?.restartProcess || !runtime?.getRestartMode) {
      return sock.sendMessage(
        from,
        {
          text: "No pude acceder al reinicio interno del bot.",
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }

    const restartMode = runtime.getRestartMode();
    if (restartMode?.allowsInternalRestart === false) {
      return sock.sendMessage(
        from,
        {
          text:
            `*RESTART BLOQUEADO*\n\n` +
            `Entorno: *${restartMode.label}*\n` +
            "Para no tumbar tu hosting, el reinicio interno esta desactivado aqui.\n" +
            "Reinicia desde tu panel, PM2 o consola cuando quieras recargar el bot.",
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }

    await sock.sendMessage(
      from,
      {
        text:
          `*RESTART BOT*\n\n` +
          `Entorno: *${restartMode.label}*\n` +
          "Reiniciando en unos segundos.\n" +
          "La sesion de WhatsApp se conserva, aunque puede haber una reconexion breve.",
        ...global.channelInfo,
      },
      { quoted: msg }
    );

    runtime.restartProcess();
  },
};
