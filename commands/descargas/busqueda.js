function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }
  return String(settings?.prefix || ".").trim() || ".";
}

function buildFallbackText(prefix) {
  return (
    `*MENU BUSQUEDA*\n\n` +
    `YouTube:\n` +
    `- ${prefix}ytsearch believer imagine dragons\n\n` +
    `TikTok:\n` +
    `- ${prefix}ttsearch style tips\n` +
    `- ${prefix}tiktokusuario @username\n\n` +
    `Imagenes:\n` +
    `- ${prefix}pinterest goku`
  );
}

export default {
  name: "busqueda",
  command: ["busqueda", "search", "menubusqueda", "buscar"],
  category: "busqueda",
  description: "Menu de busquedas (YouTube, TikTok e imagenes)",

  run: async ({ sock, msg, from, settings }) => {
    const prefix = getPrefix(settings);

    const sections = [
      {
        title: "YouTube",
        rows: [
          {
            header: "YT Search",
            title: "Buscar en YouTube",
            description: "Resultados para MP3/MP4",
            id: `${prefix}ytsearch believer imagine dragons`,
          },
        ],
      },
      {
        title: "TikTok",
        rows: [
          {
            header: "TT Search",
            title: "Buscar videos TikTok",
            description: "Busqueda general por texto",
            id: `${prefix}ttsearch style tips`,
          },
          {
            header: "TT Usuario",
            title: "Buscar por usuario",
            description: "Videos por username",
            id: `${prefix}tiktokusuario @username`,
          },
        ],
      },
      {
        title: "Imagenes",
        rows: [
          {
            header: "Pinterest",
            title: "Buscar imagenes",
            description: "Busqueda por keyword",
            id: `${prefix}pinterest goku`,
          },
        ],
      },
    ];

    try {
      return await sock.sendMessage(
        from,
        {
          text: "Busqueda del bot",
          title: "FSOCIETY BOT",
          subtitle: "Menu Busqueda",
          footer: "Incluye ytsearch",
          interactiveButtons: [
            {
              name: "single_select",
              buttonParamsJson: JSON.stringify({
                title: "Abrir busquedas",
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
