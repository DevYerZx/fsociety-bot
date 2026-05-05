function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }
  return String(settings?.prefix || ".").trim() || ".";
}

function buildFallbackText(prefix) {
  return (
    `╔════════════════════════════╗\n` +
    `║   FSOCIETY-V1 TOOLKIT HUB  ║\n` +
    `╚════════════════════════════╝\n\n` +
    `Monitoreo:\n` +
    `- ${prefix}status\n` +
    `- ${prefix}ping\n` +
    `- ${prefix}runtime\n` +
    `- ${prefix}sysinfo\n` +
    `- ${prefix}procinfo\n` +
    `- ${prefix}speedtest\n\n` +
    `Utilidades:\n` +
    `- ${prefix}canalinfo yo\n` +
    `- ${prefix}canalinfo <link-canal>\n` +
    `- ${prefix}traducir en Hola\n` +
    `- ${prefix}resumen (responde a un audio)\n` +
    `- ${prefix}idioma es\n\n` +
    `Gestion:\n` +
    `- ${prefix}report texto\n` +
    `- ${prefix}ticket texto\n` +
    `- ${prefix}logs\n` +
    `- ${prefix}clearlogs (owner)\n` +
    `- ${prefix}botinfo\n` +
    `- ${prefix}owner`
  );
}

export default {
  name: "herramientas",
  command: ["herramientas", "tools", "utilidades", "menuherramientas", "toolkit"],
  category: "herramientas",
  description: "Catalogo ordenado de herramientas del bot",

  run: async ({ sock, msg, from, settings }) => {
    const prefix = getPrefix(settings);

    const sections = [
      {
        title: "Monitoreo",
        rows: [
          { header: "Estado", title: "Panel status", description: "Resumen del bot", id: `${prefix}status` },
          { header: "Ping", title: "Medir ping", description: "Latencia actual", id: `${prefix}ping` },
          { header: "Runtime", title: "Ver uptime", description: "Tiempo encendido", id: `${prefix}runtime` },
          { header: "Sistema", title: "Sysinfo", description: "CPU / RAM / host", id: `${prefix}sysinfo` },
          { header: "Proceso", title: "Procinfo", description: "Info del proceso Node", id: `${prefix}procinfo` },
          { header: "Red", title: "Speedtest", description: "Test de red del host", id: `${prefix}speedtest` },
        ],
      },
      {
        title: "Utilidades",
        rows: [
          { header: "LID", title: "Tu JID/LID", description: "Convierte tu numero", id: `${prefix}canalinfo yo` },
          { header: "Canal", title: "Info de canal", description: "Por enlace de canal", id: `${prefix}canalinfo https://whatsapp.com/channel/` },
          { header: "Traduccion", title: "Traducir", description: "Traduce texto rapido", id: `${prefix}traducir en Hola mundo` },
          { header: "Audio IA", title: "Resumen audio", description: "Responde a audio", id: `${prefix}resumen` },
          { header: "Idioma", title: "Cambiar idioma", description: "Idioma por chat", id: `${prefix}idioma es` },
        ],
      },
      {
        title: "Gestion",
        rows: [
          { header: "Soporte", title: "Enviar reporte", description: "Reporta fallos", id: `${prefix}report Hay un error en...` },
          { header: "Ticket", title: "Crear ticket", description: "Soporte interno", id: `${prefix}ticket Necesito ayuda` },
          { header: "Logs", title: "Ver logs", description: "Ultimos errores/logs", id: `${prefix}logs` },
          { header: "Limpiar", title: "Clear logs", description: "Solo owner", id: `${prefix}clearlogs` },
          { header: "Bot", title: "Botinfo", description: "Resumen completo", id: `${prefix}botinfo` },
        ],
      },
    ];

    try {
      return await sock.sendMessage(
        from,
        {
          text:
            "╭━━〔 🧰 TOOLKIT FSOCIETY-V1 〕━━⬣\n" +
            "┃ Monitoreo, utilidades y gestion en un solo panel.\n" +
            "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━⬣",
          title: "FSOCIETY-V1",
          subtitle: "Toolkit operativo",
          footer: "Selecciona la herramienta",
          interactiveButtons: [
            {
              name: "single_select",
              buttonParamsJson: JSON.stringify({
                title: "Abrir toolkit",
                sections,
              }),
            },
          ],
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    } catch {
      return sock.sendMessage(
        from,
        { text: buildFallbackText(prefix), ...global.channelInfo },
        { quoted: msg }
      );
    }
  },
};
