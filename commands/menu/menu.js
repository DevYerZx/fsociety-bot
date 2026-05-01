import fs from "fs";
import path from "path";

let menuImageCache = null;
let menuImageCacheKey = "";

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function formatUptime(seconds = 0) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);

  if (d > 0) return `${d}d ${h}h ${m}m`;
  return `${h}h ${m}m`;
}

function getPrimaryPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => cleanText(value)) || ".";
  }

  return cleanText(settings?.prefix || ".") || ".";
}

function getPrefixLabel(settings) {
  if (Array.isArray(settings?.prefix)) {
    const values = settings.prefix.map((value) => cleanText(value)).filter(Boolean);
    return values.length ? values.join(" | ") : ".";
  }

  return cleanText(settings?.prefix || ".") || ".";
}

function normalizeCategoryKey(value = "") {
  const key = cleanText(value).toLowerCase();

  const aliases = {
    descarga: "descargas",
    download: "descargas",
    downloads: "descargas",

    busquedas: "busqueda",
    buscar: "busqueda",
    search: "busqueda",

    grupo: "grupos",
    group: "grupos",
    groups: "grupos",

    herramienta: "herramientas",
    tool: "herramientas",
    tools: "herramientas",

    game: "juegos",
    games: "juegos",

    economy: "economia",
    banco: "economia",

    ia: "ia",
    ai: "ia",

    system: "sistema",

    owner: "owner",
    dueño: "owner",
    dueno: "owner",

    admin: "admin",
  };

  return aliases[key] || key || "otros";
}

function normalizeCategoryLabel(value = "") {
  const key = normalizeCategoryKey(value);

  const labels = {
    menu: "MENÚ",
    descargas: "DESCARGAS",
    busqueda: "BÚSQUEDA",
    freefire: "FREE FIRE",
    juegos: "JUEGOS",
    herramientas: "HERRAMIENTAS",
    grupos: "GRUPOS",
    subbots: "SUBBOTS",
    economia: "ECONOMÍA",
    sistema: "SISTEMA",
    ia: "IA",
    media: "MULTIMEDIA",
    anime: "ANIME",
    admin: "ADMIN",
    owner: "OWNER",
    vip: "VIP",
    otros: "OTROS",
  };

  return labels[key] || cleanText(value).replace(/_/g, " ").toUpperCase();
}

function getCategoryIcon(category = "") {
  const key = normalizeCategoryKey(category);

  const icons = {
    menu: "📜",
    descargas: "📥",
    busqueda: "🔎",
    freefire: "🔥",
    juegos: "🎮",
    herramientas: "🧰",
    grupos: "🛡️",
    subbots: "🤖",
    economia: "💰",
    sistema: "⚙️",
    ia: "🧠",
    media: "🖼️",
    anime: "🌸",
    admin: "👑",
    owner: "🛠️",
    vip: "💎",
    otros: "✦",
  };

  return icons[key] || "✦";
}

function getCategorySortIndex(category = "") {
  const order = [
    "menu",
    "descargas",
    "busqueda",
    "freefire",
    "juegos",
    "herramientas",
    "grupos",
    "subbots",
    "economia",
    "sistema",
    "ia",
    "media",
    "anime",
    "admin",
    "owner",
    "vip",
    "otros",
  ];

  const index = order.indexOf(normalizeCategoryKey(category));
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function getSubbotSlot(botId = "") {
  const match = cleanText(botId).toLowerCase().match(/^subbot(\d{1,2})$/);
  return match?.[1] ? Number.parseInt(match[1], 10) : 0;
}

function getMenuContext({ settings, botId = "", botLabel = "" }) {
  const normalizedBotId = cleanText(botId).toLowerCase();

  if (!normalizedBotId || normalizedBotId === "main") {
    return {
      title: "FSOCIETY BOT",
      subtitle: "MENÚ PRINCIPAL",
      botLine: settings?.botName || "Fsociety Bot",
    };
  }

  const slot = getSubbotSlot(normalizedBotId);

  const subbotName =
    (slot >= 1 && Array.isArray(settings?.subbots) && settings.subbots[slot - 1]?.name) ||
    cleanText(botLabel) ||
    `Fsociety Subbot ${slot || 1}`;

  return {
    title: `FSOCIETY SUBBOT ${slot || 1}`,
    subtitle: "MENÚ SUBBOT",
    botLine: subbotName,
  };
}

function resolveMenuImagePath() {
  const base = path.join(process.cwd(), "imagenes", "menu");

  const candidates = [
    `${base}.png`,
    `${base}.jpg`,
    `${base}.jpeg`,
    `${base}.webp`,
  ];

  return candidates.find((filePath) => fs.existsSync(filePath)) || "";
}

function getMenuImageBuffer() {
  const imagePath = resolveMenuImagePath();
  if (!imagePath) return null;

  try {
    const stat = fs.statSync(imagePath);
    const cacheKey = `${imagePath}:${stat.mtimeMs}:${stat.size}`;

    if (menuImageCache && menuImageCacheKey === cacheKey) {
      return menuImageCache;
    }

    const buffer = fs.readFileSync(imagePath);

    menuImageCache = buffer;
    menuImageCacheKey = cacheKey;

    return buffer;
  } catch {
    return null;
  }
}

function getCommandNames(cmd) {
  const commandRaw = cmd?.command || cmd?.commands || cmd?.cmd;

  if (Array.isArray(commandRaw)) {
    return commandRaw
      .map((value) => cleanText(value).toLowerCase())
      .filter(Boolean);
  }

  const single = cleanText(commandRaw).toLowerCase();
  return single ? [single] : [];
}

function getMainCommand(cmd) {
  const names = getCommandNames(cmd);
  return names[0] || "";
}

function getCommandAliases(cmd) {
  const names = getCommandNames(cmd);
  return names.length > 1 ? names.slice(1) : [];
}

function getCommandCategory(cmd) {
  return normalizeCategoryKey(cmd?.categoria || cmd?.category || "otros");
}

function isHiddenCommand(cmd) {
  return Boolean(cmd?.hidden || cmd?.hide || cmd?.oculto);
}

function getCommandDescription(cmd) {
  return cleanText(cmd?.description || cmd?.desc || cmd?.help || "");
}

function getCommandAccessLabel(cmd) {
  if (cmd?.ownerOnly) return "OWNER";
  if (cmd?.adminOnly) return "ADMIN";
  return "PUBLICO";
}

function getPluginKey(cmd, fallback = "") {
  return (
    cleanText(cmd?.__pluginKey) ||
    cleanText(cmd?.__sourceFile) ||
    cleanText(cmd?.name) ||
    cleanText(fallback)
  );
}

function collectCommandData(comandos) {
  const categories = {};
  const seenPlugins = new Set();

  for (const cmd of new Set(comandos.values())) {
    if (!cmd || isHiddenCommand(cmd)) continue;

    const main = getMainCommand(cmd);
    if (!main) continue;

    const pluginKey = getPluginKey(cmd, main).toLowerCase();
    if (!pluginKey || seenPlugins.has(pluginKey)) continue;
    seenPlugins.add(pluginKey);

    const category = getCommandCategory(cmd);

    if (!categories[category]) {
      categories[category] = new Map();
    }

    categories[category].set(main, {
      name: main,
      description: getCommandDescription(cmd),
      pluginKey,
      aliases: getCommandAliases(cmd),
      access: getCommandAccessLabel(cmd),
    });
  }

  const cleanCategories = {};

  for (const [category, map] of Object.entries(categories)) {
    cleanCategories[category] = Array.from(map.values()).sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""))
    );
  }

  return cleanCategories;
}

function getCategoryDescription(category = "", count = 0) {
  const key = normalizeCategoryKey(category);

  const descriptions = {
    menu: "Panel principal del bot",
    descargas: "Audio, video y descargas",
    busqueda: "Busqueda y resultados rapidos",
    freefire: "Utilidades para Free Fire",
    juegos: "Diversion y minijuegos",
    herramientas: "Herramientas y utilidades",
    grupos: "Ajustes y control de grupos",
    subbots: "Gestion de subbots",
    economia: "Sistema economico del bot",
    sistema: "Estado, update y control",
    ia: "Funciones de inteligencia artificial",
    media: "Imagen, stickers y multimedia",
    anime: "Comandos de anime",
    admin: "Comandos administrativos",
    owner: "Funciones exclusivas owner",
    vip: "Funciones premium o vip",
    otros: "Otros comandos disponibles",
  };

  const base = descriptions[key] || "Categoria del bot";
  return `${base} · ${count} comandos reales`;
}

function chunkRows(rows, size = 10) {
  const list = Array.isArray(rows) ? rows : [];
  const chunkSize = Math.max(1, Number(size || 10));
  const chunks = [];

  for (let index = 0; index < list.length; index += chunkSize) {
    chunks.push(list.slice(index, index + chunkSize));
  }

  return chunks;
}

function buildDensityBar(current = 0, total = 0, size = 6) {
  const safeTotal = Math.max(1, Number(total || 0));
  const ratio = Math.max(0, Math.min(1, Number(current || 0) / safeTotal));
  const filled = Math.max(1, Math.round(ratio * size));
  return `${"■".repeat(filled)}${"□".repeat(Math.max(0, size - filled))}`;
}

function getCategoryHighlight(commands = [], primaryPrefix = ".") {
  const items = Array.isArray(commands) ? commands : [];
  const accessCounts = {
    PUBLICO: items.filter((item) => item.access === "PUBLICO").length,
    ADMIN: items.filter((item) => item.access === "ADMIN").length,
    OWNER: items.filter((item) => item.access === "OWNER").length,
  };

  const mainAccess =
    Object.entries(accessCounts)
      .sort((a, b) => b[1] - a[1])
      .find(([, count]) => count > 0)?.[0] || "PUBLICO";

  return {
    accessCounts,
    mainAccess,
    quick: items.slice(0, 3).map((item) => `${primaryPrefix}${item.name}`),
  };
}

function buildTopPanel({
  settings,
  uptime,
  totalCategories,
  totalCommands,
  prefixLabel,
  menuTitle,
  menuSubtitle,
  botLine,
}) {
  return [
    "╭━〔 ⚡ *FSOCIETY CONTROL CENTER* 〕━⬣",
    `┃ *${menuTitle}*`,
    `┃ _${menuSubtitle}_`,
    "┣━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "┃",
    `┃ 🧬 *Bot:* _${botLine || settings?.botName || "Fsociety Bot"}_`,
    `┃ 👑 *Owner:* _${settings?.ownerName || "Owner"}_`,
    `┃ 🛠️ *Prefijos:* *${prefixLabel}*`,
    `┃ ⏱️ *Activo:* _${uptime}_`,
    `┃ 📚 *Categorías:* *${totalCategories}*`,
    `┃ 🚀 *Comandos reales:* *${totalCommands}*`,
    "┃",
    "┃ _Conteo limpio por plugin, sin inflar alias._",
    "╰━━━━━━━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function buildCategoryIndex(categoryNames, categories) {
  const totalCommands = categoryNames.reduce(
    (sum, category) => sum + (categories[category]?.length || 0),
    0
  );

  const list = categoryNames
    .map((category) => {
      const icon = getCategoryIcon(category);
      const label = normalizeCategoryLabel(category);
      const count = categories[category]?.length || 0;
      const density = buildDensityBar(count, totalCommands, 5);
      return `${icon} ${label} ${density} ${count}`;
    })
    .join("\n┃ ");

  return [
    "╭─〔 🧭 *MAPA DE CATEGORÍAS* 〕",
    `┃ ${list}`,
    "╰────────────────────────⬣",
  ].join("\n");
}

function buildCategoryBlock(category, commands, primaryPrefix) {
  const icon = getCategoryIcon(category);
  const title = normalizeCategoryLabel(category);
  const highlight = getCategoryHighlight(commands, primaryPrefix);

  const lines = [
    `╭─〔 ${icon} *${title}* 〕`,
    `┃ ${getCategoryDescription(category, commands.length)}`,
    `┃ Modo dominante: *${highlight.mainAccess}*`,
  ];

  const commandLines = commands
    .slice(0, 5)
    .map((item) => `┃ ✦ *${primaryPrefix}${item.name}*`);
  lines.push(...commandLines);

  if (commands.length > 5) {
    lines.push(`┃ … y *${commands.length - 5}* mas`);
  }

  if (highlight.quick.length) {
    lines.push(`┃ Preview: ${highlight.quick.join(" • ")}`);
  }

  lines.push("╰────────────────────────⬣");

  return lines.join("\n");
}

function buildFooter(primaryPrefix) {
  return [
    "╭─〔 💡 *ACCESOS RÁPIDOS* 〕",
    `┃ ✦ ${primaryPrefix}menu → abrir panel`,
    `┃ ✦ ${primaryPrefix}menu descargas → ver categoria`,
    `┃ ✦ ${primaryPrefix}status → ver estado`,
    `┃ ✦ ${primaryPrefix}owner → soporte`,
    "╰────────────────────────⬣",
  ].join("\n");
}

function makeSingleCaption(fullCaption, primaryPrefix) {
  const maxLength = 3900;

  if (fullCaption.length <= maxLength) {
    return fullCaption;
  }

  return (
    `${fullCaption.slice(0, 3800)}\n\n` +
    "╭─〔 ⚠️ *MENÚ RECORTADO* 〕\n" +
    "┃ Hay demasiados comandos para un solo mensaje.\n" +
    `┃ Usa ${primaryPrefix}menu para ver lo principal.\n` +
    "╰────────────⬣"
  );
}

async function react(sock, msg, emoji) {
  try {
    if (!msg?.key) return;

    await sock.sendMessage(msg.key.remoteJid, {
      react: {
        text: emoji,
        key: msg.key,
      },
    });
  } catch {}
}

function buildCategoryRows(categoryNames, categories, primaryPrefix) {
  return categoryNames.map((category) => {
    const icon = getCategoryIcon(category);
    const label = normalizeCategoryLabel(category);
    const items = categories[category] || [];
    const count = items.length;
    const highlight = getCategoryHighlight(items, primaryPrefix);
    const preview = items
      .slice(0, 3)
      .map((item) => `${primaryPrefix}${item.name}`)
      .join(" • ");

    return {
      header: icon,
      title: label,
      description: `${count} cmds · ${highlight.mainAccess}${preview ? ` · ${preview}` : ""}`.slice(0, 72),
      id: `${primaryPrefix}menu ${category}`,
    };
  });
}

function buildCategorySections(categoryNames, categories, primaryPrefix) {
  const rowByCategory = new Map(
    buildCategoryRows(categoryNames, categories, primaryPrefix).map((row) => [
      normalizeCategoryKey(row?.id?.replace(`${primaryPrefix}menu`, "").trim()),
      row,
    ])
  );

  const pick = (key) => rowByCategory.get(normalizeCategoryKey(key));
  const sections = [];

  const mainRows = [
    pick("menu"),
    pick("descargas"),
    pick("grupos"),
  ].filter(Boolean);
  if (mainRows.length) {
    sections.push({
      title: "⚡ MENU PRINCIPAL",
      highlight_label: "POPULAR",
      rows: mainRows,
    });
  }

  const gameRows = [
    pick("juegos"),
    pick("freefire"),
    pick("economia"),
  ].filter(Boolean);
  if (gameRows.length) {
    sections.push({
      title: "🎮 ENTRETENIMIENTO",
      highlight_label: "FUN",
      rows: gameRows,
    });
  }

  const toolRows = [
    pick("ia"),
    pick("herramientas"),
    pick("media"),
    pick("anime"),
  ].filter(Boolean);
  if (toolRows.length) {
    sections.push({
      title: "🤖 IA Y TOOLS",
      highlight_label: "SMART",
      rows: toolRows,
    });
  }

  const adminRows = [
    pick("sistema"),
    pick("subbots"),
    pick("admin"),
    pick("owner"),
    pick("vip"),
  ].filter(Boolean);
  if (adminRows.length) {
    sections.push({
      title: "🛡️ ADMINISTRACION",
      highlight_label: "CONTROL",
      rows: adminRows,
    });
  }

  if (!sections.length) {
    return [{ title: "Categorias del bot", rows: buildCategoryRows(categoryNames, categories, primaryPrefix) }];
  }

  return sections;
}

function buildMenuButtons(primaryPrefix, categoryNames, categories) {
  const sections = buildCategorySections(categoryNames, categories, primaryPrefix);

  const flowButton = {
    buttonId: "menu_action_select",
    buttonText: {
      displayText: "☷ SELECT MENU",
    },
    type: 4,
    nativeFlowInfo: {
      name: "single_select",
      paramsJson: JSON.stringify({
        title: "☠️ FSOCIETY SELECT MENU",
        sections,
      }),
    },
  };

  const quickButtons = [
    {
      buttonId: `${primaryPrefix}reglas`,
      buttonText: { displayText: "↩ RULES | MENU" },
      type: 1,
    },
    {
      buttonId: `${primaryPrefix}sewa`,
      buttonText: { displayText: "↩ SEWA | FSOCIETY" },
      type: 1,
    },
  ];

  return [flowButton, ...quickButtons];
}

function buildMenuLandingText(menuContext, settings, uptime, totalCategories, totalCommands, prefixLabel) {
  return [
    "╭━━〔 ☠️ *FSOCIETY BOT* 〕━━⬣",
    `┃ 👋 Hola, *${menuContext.botLine || settings?.botName || "usuario"}*`,
    "┃ Bienvenido al panel principal",
    "╰━━━━━━━━━━━━━━━━━━━━━━⬣",
    "",
    "╭━━〔 👤 *INFO USER* 〕━━⬣",
    `┃ ⦿ Perfil: *${menuContext.subtitle}*`,
    `┃ ⦿ Prefijos: *${prefixLabel}*`,
    "╰━━━━━━━━━━━━━━━━━━━━━━⬣",
    "",
    "╭━━〔 🤖 *INFO BOT* 〕━━⬣",
    `┃ ⦿ Bot: *${menuContext.title}*`,
    `┃ ⦿ Owner: *${settings?.ownerName || "Owner"}*`,
    `┃ ⦿ Runtime: *${uptime}*`,
    `┃ ⦿ Categorias: *${totalCategories}*`,
    `┃ ⦿ Comandos: *${totalCommands}*`,
    "╰━━━━━━━━━━━━━━━━━━━━━━⬣",
    "",
    "Pulsa *SELECT MENU* para abrir la lista completa.",
    `Tip: ${getPrimaryPrefix(settings)}menu descargas`,
  ].join("\n");
}

function buildCategoryMenuText(category, commands, primaryPrefix) {
  const icon = getCategoryIcon(category);
  const label = normalizeCategoryLabel(category);
  const count = commands.length;
  const highlight = getCategoryHighlight(commands, primaryPrefix);
  const commandBlocks = chunkRows(commands, 8).map((chunk, index) => {
    const title =
      commands.length > 8
        ? `╭─〔 ${icon} *${label} ${index + 1}/${Math.ceil(commands.length / 8)}* 〕`
        : `╭─〔 ${icon} *${label}* 〕`;

    const lines = [title];

    for (const item of chunk) {
      const aliasText = item.aliases?.length
        ? `Alias: ${item.aliases.slice(0, 3).join(", ")}`
        : "";
      lines.push(`┃ ✦ *${primaryPrefix}${item.name}* [${item.access}]`);
      lines.push(`┃   ${item.description || "Comando disponible del bot."}`);
      if (aliasText) {
        lines.push(`┃   ${aliasText}`);
      }
      lines.push("┃");
    }

    if (lines[lines.length - 1] === "┃") {
      lines.pop();
    }

    lines.push("╰────────────⬣");
    return lines.join("\n");
  });

  return [
    `╭━━〔 ${icon} *${label}* 〕━━⬣`,
    `┃ ${getCategoryDescription(category, count)}`,
    "┃",
    `┃ 📌 *Comandos:* ${count}`,
    `┃ 🔓 *Publicos:* ${highlight.accessCounts.PUBLICO}`,
    `┃ 🛡️ *Admin:* ${highlight.accessCounts.ADMIN}`,
    `┃ 👑 *Owner:* ${highlight.accessCounts.OWNER}`,
    "┃",
    highlight.quick.length
      ? `┃ ⚡ *Inicio rapido:* ${highlight.quick.join(" • ")}`
      : "┃ ⚡ *Inicio rapido:* categoria lista para usar",
    "┃ Usa el prefijo + comando para ejecutarlo.",
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
    "",
    ...commandBlocks,
    "",
    buildFooter(primaryPrefix),
  ].join("\n");
}

async function sendInteractiveMenu(sock, from, quoted, payload, fallbackText) {
  try {
    return await sock.sendMessage(
      from,
      {
        ...payload,
        ...global.channelInfo,
      },
      quoted
    );
  } catch {
    return await sock.sendMessage(
      from,
      {
        text: fallbackText,
        ...global.channelInfo,
      },
      quoted
    );
  }
}

export default {
  command: ["menu", "help", "comandos", "menucat"],
  categoria: "menu",
  description: "Muestra el menú principal del bot.",

  run: async ({ sock, msg, from, settings, comandos, botId, botLabel, args = [] }) => {
    try {
      await react(sock, msg, "📜");

      if (!comandos) {
        await react(sock, msg, "❌");

        return await sock.sendMessage(
          from,
          {
            text:
              "╭━━〔 ❌ *ERROR MENÚ* 〕━━⬣\n" +
              "┃ No se encontró la lista de comandos.\n" +
              "╰━━━━━━━━━━━━━━━━━━━━⬣",
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      }

      const imageBuffer = getMenuImageBuffer();
      const uptime = formatUptime(process.uptime());
      const primaryPrefix = getPrimaryPrefix(settings);
      const prefixLabel = getPrefixLabel(settings);
      const menuContext = getMenuContext({ settings, botId, botLabel });
      const categories = collectCommandData(comandos);
      const requestedCategory = normalizeCategoryKey(args.join(" "));

      const categoryNames = Object.keys(categories).sort((a, b) => {
        const byOrder = getCategorySortIndex(a) - getCategorySortIndex(b);
        if (byOrder !== 0) return byOrder;
        return String(a).localeCompare(String(b));
      });

      const totalCommands = categoryNames.reduce(
        (sum, category) => sum + categories[category].length,
        0
      );

      if (requestedCategory && requestedCategory !== "menu" && categories[requestedCategory]) {
        const commandList = categories[requestedCategory];
        const categoryText = buildCategoryMenuText(
          requestedCategory,
          commandList,
          primaryPrefix
        );

        await sock.sendMessage(
          from,
          {
            text: makeSingleCaption(categoryText, primaryPrefix),
            ...global.channelInfo,
          },
          { quoted: msg }
        );

        await react(sock, msg, "✅");
        return;
      }

      const topPanel = buildTopPanel({
        settings,
        uptime,
        totalCategories: categoryNames.length,
        totalCommands,
        prefixLabel,
        menuTitle: menuContext.title,
        menuSubtitle: menuContext.subtitle,
        botLine: menuContext.botLine,
      });

      const textParts = [
        topPanel,
        buildCategoryIndex(categoryNames, categories),
        ...categoryNames.map((category) =>
          buildCategoryBlock(category, categories[category], primaryPrefix)
        ),
        buildFooter(primaryPrefix),
      ];

      const fullCaption = textParts.join("\n\n").trim();
      const finalCaption = makeSingleCaption(fullCaption, primaryPrefix);
      const landingText = buildMenuLandingText(
        menuContext,
        settings,
        uptime,
        categoryNames.length,
        totalCommands,
        prefixLabel
      );

      if (imageBuffer) {
        await sock.sendMessage(
          from,
          {
            image: imageBuffer,
          },
          { quoted: msg }
        );
      }

      const buttons = buildMenuButtons(primaryPrefix, categoryNames, categories);

      try {
        await sock.sendMessage(
          from,
          {
            text: landingText,
            footer: `© ${settings?.ownerName || "Fsociety"}`,
            buttons,
            headerType: 1,
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      } catch {
        await sendInteractiveMenu(
          sock,
          from,
          { quoted: msg },
          {
            text: landingText,
            title: menuContext.title,
            subtitle: menuContext.subtitle,
            footer: `© ${settings?.ownerName || "Fsociety"}`,
            interactiveButtons: [
              {
                name: "single_select",
                buttonParamsJson: JSON.stringify({
                  title: "☷ SELECT MENU",
                  sections: buildCategorySections(
                    categoryNames,
                    categories,
                    primaryPrefix
                  ),
                }),
              },
            ],
          },
          finalCaption
        );
      }

      await react(sock, msg, "✅");
    } catch (error) {
      console.error("MENU ERROR:", error);

      await react(sock, msg, "❌");

      await sock.sendMessage(
        from,
        {
          text:
            "╭━━〔 ❌ *ERROR MENÚ* 〕━━⬣\n" +
            "┃ No se pudo mostrar el menú.\n" +
            `┃ ${String(error?.message || "Error desconocido")}\n` +
            "╰━━━━━━━━━━━━━━━━━━━━⬣",
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }
  },
};
