import fs from "fs";
import path from "path";

const BOX_INNER_WIDTH = 40;

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function repeat(char, count) {
  return char.repeat(Math.max(0, count));
}

function padLine(content = "") {
  return `| ${String(content).padEnd(BOX_INNER_WIDTH)} |`;
}

function centerLine(content = "") {
  const text = String(content);
  const totalPadding = Math.max(0, BOX_INNER_WIDTH - text.length);
  const left = Math.floor(totalPadding / 2);
  const right = totalPadding - left;
  return `|${repeat(" ", left + 1)}${text}${repeat(" ", right + 1)}|`;
}

function topBorder(char = "=") {
  return `+${repeat(char, BOX_INNER_WIDTH + 2)}+`;
}

function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }

  return String(settings?.prefix || ".").trim() || ".";
}

function getCategoryLabel(category) {
  const labels = {
    admin: "ADMIN",
    ai: "AI",
    busqueda: "BUSQUEDA",
    descarga: "DESCARGAS",
    grupo: "GRUPOS",
    media: "MEDIA",
    menu: "MENU",
    sistema: "SISTEMA",
    subbots: "SUBBOTS",
    vip: "VIP",
  };

  return labels[String(category || "").toLowerCase()] || String(category || "").toUpperCase();
}

function buildCategoryMap(comandos) {
  const categories = new Map();

  for (const cmd of new Set(comandos.values())) {
    if (!cmd?.category || !cmd?.command) continue;

    const category = String(cmd.category).toLowerCase();
    const primaryCommand = Array.isArray(cmd.command) ? cmd.command[0] : cmd.command;
    const description = String(cmd.description || "").trim();

    if (!primaryCommand) continue;
    if (!categories.has(category)) categories.set(category, []);

    categories.get(category).push({
      command: String(primaryCommand).toLowerCase(),
      description,
    });
  }

  for (const items of categories.values()) {
    items.sort((a, b) => a.command.localeCompare(b.command));
  }

  return categories;
}

function sortCategories(categories) {
  const preferredOrder = [
    "menu",
    "subbots",
    "descarga",
    "busqueda",
    "grupo",
    "admin",
    "sistema",
    "media",
    "ai",
    "vip",
  ];

  return Array.from(categories.keys()).sort((a, b) => {
    const aIndex = preferredOrder.indexOf(a);
    const bIndex = preferredOrder.indexOf(b);

    if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  });
}

function renderStandardCategory(category, items, prefix) {
  const lines = items.map((item) => padLine(`- \`${prefix}${item.command}\``));

  return [
    topBorder("-"),
    centerLine(getCategoryLabel(category)),
    topBorder("-"),
    ...lines,
    topBorder("-"),
  ].join("\n");
}

function renderSubbotsCategory(items, prefix) {
  const preferredOrder = ["subbot", "subbots", "subboton", "subbotoff"];
  const labels = {
    subbot: "Pide codigo para un nuevo subbot",
    subbots: "Mira slots, tiempos y estados activos",
    subboton: "Activa el acceso publico a subbots",
    subbotoff: "Apaga el acceso publico a subbots",
  };

  const itemMap = new Map(items.map((item) => [item.command, item]));
  const orderedItems = [
    ...preferredOrder
      .filter((command) => itemMap.has(command))
      .map((command) => itemMap.get(command)),
    ...items.filter((item) => !preferredOrder.includes(item.command)),
  ];

  const lines = orderedItems.map((item, index) => {
    const title = labels[item.command] || item.description || "Control de subbots";
    return padLine(
      `${String(index + 1).padStart(2, "0")}. \`${prefix}${item.command}\` -> ${title}`
    );
  });

  return [
    topBorder("="),
    centerLine("SUBBOTS CONTROL"),
    centerLine("Crea, revisa y administra tus slots"),
    topBorder("="),
    ...lines,
    padLine(""),
    padLine(`Tip: \`${prefix}subbot 519xxxxxxxxx\` pide un codigo nuevo`),
    padLine(`Tip: \`${prefix}subbots\` muestra quien esta conectado`),
    topBorder("="),
  ].join("\n");
}

function buildMenuCaption(settings, comandos) {
  const prefix = getPrefix(settings);
  const uptime = formatUptime(process.uptime());
  const categories = buildCategoryMap(comandos);
  const sections = [];

  for (const category of sortCategories(categories)) {
    const items = categories.get(category) || [];
    if (!items.length) continue;

    sections.push(
      category === "subbots"
        ? renderSubbotsCategory(items, prefix)
        : renderStandardCategory(category, items, prefix)
    );
  }

  return [
    topBorder("="),
    centerLine(String(settings.botName || "BOT")),
    topBorder("="),
    padLine(`Prefijo : ${prefix}`),
    padLine("Estado  : online"),
    padLine(`Uptime  : ${uptime}`),
    topBorder("="),
    centerLine("MENU DE COMANDOS"),
    topBorder("="),
    ...sections,
    topBorder("="),
    centerLine("bot premium activo"),
    topBorder("="),
  ].join("\n");
}

export default {
  command: ["menu"],
  category: "menu",
  description: "Menu principal con estilo premium",

  run: async ({ sock, msg, from, settings, comandos }) => {
    try {
      if (!comandos) {
        return sock.sendMessage(
          from,
          { text: "error interno", ...global.channelInfo },
          { quoted: msg }
        );
      }

      const videoPath = path.join(process.cwd(), "videos", "menu-video.mp4");
      if (!fs.existsSync(videoPath)) {
        return sock.sendMessage(
          from,
          { text: "video del menu no encontrado", ...global.channelInfo },
          { quoted: msg }
        );
      }

      const caption = buildMenuCaption(settings, comandos);

      await sock.sendMessage(
        from,
        {
          video: fs.readFileSync(videoPath),
          mimetype: "video/mp4",
          gifPlayback: true,
          caption,
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    } catch (err) {
      console.error("MENU ERROR:", err);
      await sock.sendMessage(
        from,
        { text: "error al mostrar el menu", ...global.channelInfo },
        { quoted: msg }
      );
    }
  },
};
