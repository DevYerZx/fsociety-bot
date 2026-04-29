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

function getCommandCategory(cmd) {
  return normalizeCategoryKey(cmd?.categoria || cmd?.category || "otros");
}

function isHiddenCommand(cmd) {
  return Boolean(cmd?.hidden || cmd?.hide || cmd?.oculto);
}

function getCommandDescription(cmd) {
  return cleanText(cmd?.description || cmd?.desc || cmd?.help || "");
}

function collectCommandData(comandos) {
  const categories = {};

  for (const cmd of new Set(comandos.values())) {
    if (!cmd || isHiddenCommand(cmd)) continue;

    const main = getMainCommand(cmd);
    if (!main) continue;

    const category = getCommandCategory(cmd);

    if (!categories[category]) {
      categories[category] = new Map();
    }

    categories[category].set(main, {
      name: main,
      description: getCommandDescription(cmd),
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
  return `${base} · ${count} comandos`;
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
    `╭━━〔 ⚡ *${menuTitle}* ⚡ 〕━━⬣`,
    `┃ ${menuSubtitle}`,
    "┃",
    `┃ 🤖 *Bot:* ${botLine || settings?.botName || "Fsociety Bot"}`,
    `┃ 👑 *Owner:* ${settings?.ownerName || "Owner"}`,
    `┃ 🔰 *Prefijo:* ${prefixLabel}`,
    `┃ ⏳ *Activo:* ${uptime}`,
    `┃ 🗂️ *Categorías:* ${totalCategories}`,
    `┃ 📌 *Comandos:* ${totalCommands}`,
    "┃",
    "┃ _Escribe el prefijo + comando._",
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function buildCategoryIndex(categoryNames, categories) {
  const list = categoryNames
    .map((category) => {
      const icon = getCategoryIcon(category);
      const label = normalizeCategoryLabel(category);
      const count = categories[category]?.length || 0;
      return `${icon} ${label}(${count})`;
    })
    .join(" • ");

  return [
    "╭─〔 🧭 *CATEGORÍAS* 〕",
    `┃ ${list}`,
    "╰────────────⬣",
  ].join("\n");
}

function buildCategoryBlock(category, commands, primaryPrefix) {
  const icon = getCategoryIcon(category);
  const title = normalizeCategoryLabel(category);

  const lines = [
    `╭─〔 ${icon} *${title}* 〕`,
  ];

  const commandLines = commands.map((item) => `┃ ✦ *${primaryPrefix}${item.name}*`);
  lines.push(...commandLines);

  lines.push("╰────────────⬣");

  return lines.join("\n");
}

function buildFooter(primaryPrefix) {
  return [
    "╭─〔 💡 *AYUDA* 〕",
    `┃ ${primaryPrefix}menu → ver menú`,
    `┃ ${primaryPrefix}menu descargas → abrir categoría`,
    `┃ ${primaryPrefix}status → estado`,
    `┃ ${primaryPrefix}owner → soporte`,
    "╰────────────⬣",
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
    const count = categories[category]?.length || 0;

    return {
      header: icon,
      title: label,
      description: getCategoryDescription(category, count),
      id: `${primaryPrefix}menu ${category}`,
    };
  });
}

function buildCategorySections(categoryNames, categories, primaryPrefix) {
  const rows = buildCategoryRows(categoryNames, categories, primaryPrefix);
  return [{ title: "Categorias del bot", rows }];
}

function buildMenuLandingText(menuContext, settings, uptime, totalCategories, totalCommands, prefixLabel) {
  return [
    `╭━━〔 ⚡ *${menuContext.title}* ⚡ 〕━━⬣`,
    `┃ ${menuContext.subtitle}`,
    "┃",
    `┃ 🤖 *Bot:* ${menuContext.botLine || settings?.botName || "Fsociety Bot"}`,
    `┃ 👑 *Owner:* ${settings?.ownerName || "Owner"}`,
    `┃ 🔰 *Prefijo:* ${prefixLabel}`,
    `┃ ⏳ *Activo:* ${uptime}`,
    `┃ 🗂️ *Categorías:* ${totalCategories}`,
    `┃ 📌 *Comandos:* ${totalCommands}`,
    "┃",
    "┃ Presiona la lista para abrir categorías.",
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function buildCategoryMenuText(category, commands, primaryPrefix) {
  const icon = getCategoryIcon(category);
  const label = normalizeCategoryLabel(category);
  const count = commands.length;
  const commandBlocks = chunkRows(commands, 8).map((chunk, index) => {
    const title =
      commands.length > 8
        ? `╭─〔 ${icon} *${label} ${index + 1}/${Math.ceil(commands.length / 8)}* 〕`
        : `╭─〔 ${icon} *${label}* 〕`;

    const lines = [title];

    for (const item of chunk) {
      lines.push(`┃ ✦ *${primaryPrefix}${item.name}*`);
      lines.push(`┃   ${item.description || "Comando disponible del bot."}`);
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
    `┃ 🧾 *Detalle:* uso rapido y funcion`,
    "┃",
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

      await sendInteractiveMenu(
        sock,
        from,
        { quoted: msg },
        {
          text: landingText,
          title: menuContext.title,
          subtitle: menuContext.subtitle,
          footer: "Selecciona una categoria",
          interactiveButtons: [
            {
              name: "single_select",
              buttonParamsJson: JSON.stringify({
                title: "Abrir menu",
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
