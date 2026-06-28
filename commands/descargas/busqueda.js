import {
  buildSectionFallbackText,
  buildSelectorCaption,
  buildSelectorPayload,
} from "./_downloadUi.js";

function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }
  return String(settings?.prefix || ".").trim() || ".";
}

function buildFallbackText(prefix) {
  const sections = buildSections(prefix);
  const caption = buildMenuCaption();
  return buildSectionFallbackText(caption, sections);
}

function buildSections(prefix) {
  return [
    {
      title: "YouTube",
      rows: [
        {
          header: "1",
          title: "Buscar en YouTube",
          description: "MP3, MP4 y resultados rapidos",
          id: `${prefix}ytsearch believer imagine dragons`,
        },
        {
          header: "2",
          title: "Selector Play",
          description: "Musica con portada y formato",
          id: `${prefix}play bad bunny`,
        },
      ],
    },
    {
      title: "TikTok",
      rows: [
        {
          header: "1",
          title: "Buscar videos TikTok",
          description: "Resultados por texto con selector",
          id: `${prefix}ttsearch style tips`,
        },
        {
          header: "2",
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
          header: "1",
          title: "Pinterest HD",
          description: "Busqueda por keyword e imagenes",
          id: `${prefix}pinterest goku`,
        },
      ],
    },
  ];
}

function buildMenuCaption() {
  return buildSelectorCaption({
    title: "🔎 *FSOCIETY BUSQUEDA*",
    query: "Accesos rapidos del bot",
    lead: "🎯 Buscadores de YouTube, TikTok e imagenes",
    featuredTitle: "Descargas con selector visual",
    featuredLines: [
      "🎧 Play, Apple Music y Spotify con portada",
      "📱 Apps, videos e imagenes en un solo menu",
    ],
    actionLines: [
      "Abre el selector y entra al buscador que quieras usar",
    ],
  });
}

export default {
  name: "busqueda",
  command: ["busqueda", "search", "menubusqueda", "buscar"],
  category: "busqueda",
  description: "Menu de busquedas (YouTube, TikTok e imagenes)",

  run: async ({ sock, msg, from, settings }) => {
    const prefix = getPrefix(settings);
    const sections = buildSections(prefix);
    const caption = buildMenuCaption();

    try {
      return await sock.sendMessage(
        from,
        buildSelectorPayload({
          caption,
          title: "🔎 FSOCIETY BUSQUEDA",
          subtitle: "Menu inteligente",
          footer: "Busquedas y descargas",
          selectorTitle: "Abrir buscadores",
          sections,
        }),
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
