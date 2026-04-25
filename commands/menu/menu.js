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
    search: "busqueda",
    buscar: "busqueda",

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
    ia: "INTELIGENCIA ARTIFICIAL",
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

function getCommandDescription(cmd) {
  return (
    cleanText(cmd?.description) ||
    cleanText(cmd?.descripcion) ||
    cleanText(cmd?.desc) ||
    "Sin descripción disponible."
  );
}

function getCommandCategory(cmd) {
  return normalizeCategoryKey(cmd?.categoria || cmd?.category || "otros");
}

function isHiddenCommand(cmd) {
  return Boolean(cmd?.hidden || cmd?.hide || cmd?.oculto);
}

function collectCommandData(comandos) {
  const categories = {};

  for (const cmd of new Set(comandos.values())) {
    if (!cmd || isHiddenCommand(cmd)) continue;

    const main = getMainCommand(cmd);
    if (!main) continue;

    const category = getCommandCategory(cmd);
    const names = getCommandNames(cmd);
    const aliases = names.filter((name) => name !== main);
    const description = getCommandDescription(cmd);

    if (!categories[category]) {
      categories[category] = [];
    }

    const exists = categories[category].some((item) => item.main === main);
    if (exists) continue;

    categories[category].push({
      main,
      aliases,
      description,
      owner: Boolean(cmd?.owner || cmd?.isOwner),
      admin: Boolean(cmd?.admin || cmd?.isAdmin),
      premium: Boolean(cmd?.premium || cmd?.isPremium),
      group: Boolean(cmd?.group || cmd?.isGroup),
    });
  }

  for (const category of Object.keys(categories)) {
    categories[category].sort((a, b) => a.main.localeCompare(b.main));
  }

  return categories;
}

function buildBadgeLine(item) {
  const badges = [];

  if (item.owner) badges.push("Owner");
  if (item.admin) badges.push("Admin");
  if (item.premium) badges.push("VIP");
  if (item.group) badges.push("Grupo");

  return badges.length ? ` │ ${badges.join(" • ")}` : "";
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
    "┃ _Usa el prefijo + comando para ejecutar._",
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function buildCategoryIndex(categoryNames, categories) {
  const lines = [
    "╭━━〔 🧭 *ÍNDICE DE CATEGORÍAS* 〕━━⬣",
  ];

  for (const category of categoryNames) {
    const icon = getCategoryIcon(category);
    const label = normalizeCategoryLabel(category);
    const count = categories[category]?.length || 0;

    lines.push(`┃ ${icon} *${label}* — ${count}`);
  }

  lines.push("╰━━━━━━━━━━━━━━━━━━━━⬣");

  return lines.join("\n");
}

function buildCommandLine(item, primaryPrefix) {
  const command = `${primaryPrefix}${item.main}`;
  const badges = buildBadgeLine(item);

  const lines = [
    `┃ ✦ *${command}*${badges}`,
    `┃   _${item.description}_`,
  ];

  if (item.aliases.length) {
    const aliasText = item.aliases
      .slice(0, 6)
      .map((alias) => `${primaryPrefix}${alias}`)
      .join(" • ");

    lines.push(`┃   ↳ Alias: ${aliasText}`);
  }

  return lines.join("\n");
}

function buildCategoryBlock(category, commands, primaryPrefix) {
  const icon = getCategoryIcon(category);
  const title = normalizeCategoryLabel(category);

  const lines = [
    `╭━━〔 ${icon} *${title}* 〕━━⬣`,
    `┃ 📌 Total: ${commands.length}`,
    "┃",
  ];

  for (const item of commands) {
    lines.push(buildCommandLine(item, primaryPrefix));
    lines.push("┃");
  }

  lines.push("╰━━━━━━━━━━━━━━━━━━━━⬣");

  return lines.join("\n");
}

function buildFooter(primaryPrefix) {
  return [
    "╭━━〔 💡 *AYUDA RÁPIDA* 〕━━⬣",
    `┃ 📜 *${primaryPrefix}menu*`,
    "┃   _Muestra este menú principal._",
    "┃",
    `┃ ⚙️ *${primaryPrefix}status*`,
    "┃   _Muestra el estado del bot._",
    "┃",
    `┃ 👑 *${primaryPrefix}owner*`,
    "┃   _Muestra contacto o soporte del dueño._",
    "┃",
    "┃ ⚡ *Tip:* escribe el comando tal como aparece.",
    "╰━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function splitLongText(text, maxLength = 3800) {
  const parts = [];
  let current = "";

  const blocks = String(text || "").split("\n\n");

  for (const block of blocks) {
    const next = current ? `${current}\n\n${block}` : block;

    if (next.length > maxLength) {
      if (current) parts.push(current);
      current = block;
    } else {
      current = next;
    }
  }

  if (current) parts.push(current);

  return parts;
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

export default {
  command: ["menu", "help", "comandos"],
  categoria: "menu",
  description: "Muestra el menú principal con categorías, comandos y descripción.",

  run: async ({ sock, msg, from, settings, comandos, botId, botLabel }) => {
    try {
      await react(sock, msg, "📜");

      if (!comandos) {
        await react(sock, msg, "❌");

        return await sock.sendMessage(
          from,
          {
            text: "❌ Error interno: no se encontró la lista de comandos.",
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

      const categoryNames = Object.keys(categories).sort((a, b) => {
        const byOrder = getCategorySortIndex(a) - getCategorySortIndex(b);
        if (byOrder !== 0) return byOrder;
        return String(a).localeCompare(String(b));
      });

      const totalCommands = categoryNames.reduce(
        (sum, category) => sum + categories[category].length,
        0
      );

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

      if (imageBuffer && fullCaption.length <= 3800) {
        await sock.sendMessage(
          from,
          {
            image: imageBuffer,
            caption: fullCaption,
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      } else if (imageBuffer) {
        await sock.sendMessage(
          from,
          {
            image: imageBuffer,
            caption: topPanel,
            ...global.channelInfo,
          },
          { quoted: msg }
        );

        const chunks = splitLongText(
          [
            buildCategoryIndex(categoryNames, categories),
            ...categoryNames.map((category) =>
              buildCategoryBlock(category, categories[category], primaryPrefix)
            ),
            buildFooter(primaryPrefix),
          ].join("\n\n"),
          3800
        );

        for (const chunk of chunks) {
          await sock.sendMessage(
            from,
            {
              text: chunk,
              ...global.channelInfo,
            },
            { quoted: msg }
          );
        }
      } else {
        const chunks = splitLongText(fullCaption, 3800);

        for (const chunk of chunks) {
          await sock.sendMessage(
            from,
            {
              text: chunk,
              ...global.channelInfo,
            },
            { quoted: msg }
          );
        }
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