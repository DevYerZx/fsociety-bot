import fs from "fs";
import path from "path";
import {
  findGroupParticipant,
  getParticipantDisplayTag,
  getParticipantMentionJid,
} from "../../lib/group-compat.js";
import { createWelcomeCard } from "../../lib/welcome-card.js";

const DB_DIR = path.join(process.cwd(), "database");
const FILE = path.join(DB_DIR, "welcome.json");

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }
  return String(settings?.prefix || ".").trim() || ".";
}

function createDefaultConfig() {
  return {
    enabled: false,
    welcomeEnabled: false,
    byeEnabled: false,
    text: "",
    byeText: "",
    rules: "",
    image: "",
  };
}

function normalizeConfig(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const welcomeEnabled = source.enabled === true || source.welcomeEnabled === true;
  const byeEnabled =
    source.byeEnabled === true ||
    source.goodbyeEnabled === true ||
    source.leaveEnabled === true;

  return {
    enabled: welcomeEnabled,
    welcomeEnabled,
    byeEnabled,
    text: String(source.text || "").trim().slice(0, 700),
    byeText: String(source.byeText || source.goodbyeText || "").trim().slice(0, 700),
    rules: String(source.rules || "").trim().slice(0, 700),
    image: String(source.image || "").trim(),
  };
}

function safeParse(raw) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
  } catch {
    return null;
  }
}

function readStore() {
  try {
    if (!fs.existsSync(FILE)) return {};
    const parsed = safeParse(fs.readFileSync(FILE, "utf-8"));
    if (!parsed || typeof parsed !== "object") return {};

    if (Array.isArray(parsed)) {
      return Object.fromEntries(
        parsed.map((groupId) => [
          String(groupId),
          normalizeConfig({ enabled: true, welcomeEnabled: true }),
        ])
      );
    }

    return Object.fromEntries(
      Object.entries(parsed).map(([groupId, config]) => {
        if (typeof config === "boolean") {
          return [
            groupId,
            normalizeConfig({ enabled: config, welcomeEnabled: config }),
          ];
        }
        return [groupId, normalizeConfig(config)];
      })
    );
  } catch {
    return {};
  }
}

function saveStore(store) {
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
}

function getConfig(groupId, store) {
  const source = store || readStore();
  const key = String(groupId || "").trim();
  if (!source[key]) {
    source[key] = createDefaultConfig();
    saveStore(source);
  } else {
    source[key] = normalizeConfig(source[key]);
  }
  return source[key];
}

function boolLabel(value) {
  return value ? "ON" : "OFF";
}

function buildStatusText(config, prefix) {
  const imageLabel = config.image ? "CONFIGURADA" : "FOTO DEL GRUPO";
  return (
    `*WELCOME Y DESPEDIDA*\n\n` +
    `Bienvenida: *${boolLabel(config.welcomeEnabled)}*\n` +
    `Despedida: *${boolLabel(config.byeEnabled)}*\n` +
    `Imagen: *${imageLabel}*\n` +
    `Texto de bienvenida: *${config.text ? "SI" : "NO"}*\n` +
    `Texto de despedida: *${config.byeText ? "SI" : "NO"}*\n` +
    `Reglas: *${config.rules ? "SI" : "NO"}*\n\n` +
    `Comandos:\n` +
    `- ${prefix}welcome on\n` +
    `- ${prefix}welcome off\n` +
    `- ${prefix}welcome bye on\n` +
    `- ${prefix}welcome bye off\n` +
    `- ${prefix}welcome text Bienvenido @user a @group\n` +
    `- ${prefix}welcome byetext Hasta luego @user\n` +
    `- ${prefix}welcome rules Respeta | No spam | Lee fijados\n` +
    `- ${prefix}welcome image https://...\n` +
    `- ${prefix}welcome reset\n\n` +
    `Variables disponibles: @user, @group, @members, @bot`
  );
}

async function getGroupImageUrl(sock, groupId, fallbackImage = "") {
  try {
    const groupImage = await sock.profilePictureUrl(groupId, "image");
    if (groupImage) return groupImage;
  } catch {}

  const fallback = String(fallbackImage || "").trim();
  if (/^https?:\/\//i.test(fallback)) return fallback;
  return "";
}

async function getProfileImageUrl(sock, jid = "") {
  try {
    return await sock.profilePictureUrl(jid, "image");
  } catch {
    return "";
  }
}

function buildWelcomeMessage({
  userTag,
  groupName,
  totalMembers,
  botName,
  customText,
  rules,
  prefix,
}) {
  const mainText =
    customText || `Bienvenido @user a @group. Esperamos que disfrutes tu estancia.`;
  const renderedMainText = renderTemplate(mainText, {
    userTag,
    groupName,
    totalMembers,
    botName,
  });
  const renderedRules = renderTemplate(rules, {
    userTag,
    groupName,
    totalMembers,
    botName,
  });
  const rulesBlock = renderedRules ? `\n\n*Reglas del grupo*\n${renderedRules}` : "";

  return (
    `*BIENVENIDO/A*\n\n` +
    `Hola ${userTag}\n` +
    `Grupo: *${groupName}*\n` +
    `Miembro numero: *${Math.max(1, totalMembers)}*\n` +
    `Bot: *${botName}*\n\n` +
    `${renderedMainText}` +
    `${rulesBlock}\n\n` +
    `Comandos utiles:\n` +
    `- ${prefix}menu\n` +
    `- ${prefix}owner\n` +
    `- ${prefix}infochannel`
  );
}

function buildByeMessage({
  userTag,
  groupName,
  totalMembers,
  botName,
  byeText,
  prefix,
}) {
  const mainText = byeText || `Hasta luego @user. Te esperamos de vuelta en @group.`;
  const renderedMainText = renderTemplate(mainText, {
    userTag,
    groupName,
    totalMembers,
    botName,
  });

  return (
    `*DESPEDIDA*\n\n` +
    `Grupo: *${groupName}*\n` +
    `Miembros ahora: *${Math.max(0, totalMembers)}*\n` +
    `Bot: *${botName}*\n\n` +
    `${renderedMainText}\n\n` +
    `Comandos utiles:\n` +
    `- ${prefix}reglas\n` +
    `- ${prefix}infochannel`
  );
}

function renderTemplate(template, { userTag, groupName, totalMembers, botName }) {
  return String(template || "")
    .trim()
    .replace(/@user/gi, userTag)
    .replace(/@group/gi, groupName)
    .replace(/@members/gi, String(Math.max(0, totalMembers)))
    .replace(/@bot/gi, botName);
}

function buildCardText(action, config, userTag, groupName, totalMembers, botName) {
  if (action === "remove") {
    return renderTemplate(
      config.byeText || `Hasta luego @user. Te esperamos de vuelta en @group.`,
      {
        userTag,
        groupName,
        totalMembers,
        botName,
      }
    );
  }

  return renderTemplate(
    config.text || `Bienvenido @user a @group. Esperamos que disfrutes tu estancia.`,
    {
      userTag,
      groupName,
      totalMembers,
      botName,
    }
  );
}

export default {
  name: "welcome",
  command: ["welcome", "bienvenida", "despedida"],
  groupOnly: true,
  adminOnly: true,
  category: "grupo",
  description: "Bienvenida y despedida con diseno, botones y foto del grupo",

  async run({ sock, from, args = [], msg, settings }) {
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const store = readStore();
    const config = getConfig(from, store);
    const action = String(args[0] || "status").trim().toLowerCase();
    const value = String(args.slice(1).join(" ") || "").trim();
    const prefix = getPrefix(settings);

    if (!args.length || ["status", "estado", "menu"].includes(action)) {
      return sock.sendMessage(
        from,
        {
          text: buildStatusText(config, prefix),
          title: "FSOCIETY BOT",
          subtitle: "Panel Welcome & Bye",
          footer: "Selecciona una opcion",
          interactiveButtons: [
            {
              name: "single_select",
              buttonParamsJson: JSON.stringify({
                title: "Configurar Welcome/Bye",
                sections: [
                  {
                    title: "Bienvenida",
                    rows: [
                      {
                        header: "WELCOME ON",
                        title: "Activar bienvenida",
                        description: "Envia mensaje cuando entra alguien.",
                        id: `${prefix}welcome on`,
                      },
                      {
                        header: "WELCOME OFF",
                        title: "Desactivar bienvenida",
                        description: "Apaga mensaje de entrada.",
                        id: `${prefix}welcome off`,
                      },
                    ],
                  },
                  {
                    title: "Despedida",
                    rows: [
                      {
                        header: "BYE ON",
                        title: "Activar despedida",
                        description: "Envia mensaje cuando alguien sale.",
                        id: `${prefix}welcome bye on`,
                      },
                      {
                        header: "BYE OFF",
                        title: "Desactivar despedida",
                        description: "Apaga mensaje de salida.",
                        id: `${prefix}welcome bye off`,
                      },
                    ],
                  },
                  {
                    title: "Estado",
                    rows: [
                      {
                        header: "STATUS",
                        title: "Ver estado actual",
                        description: "Muestra configuracion de welcome/bye.",
                        id: `${prefix}welcome status`,
                      },
                    ],
                  },
                ],
              }),
            },
          ],
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "on") {
      store[from] = { ...config, enabled: true, welcomeEnabled: true };
      saveStore(store);
      return sock.sendMessage(
        from,
        {
          text: "✅ Bienvenida activada.",
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "off") {
      store[from] = { ...config, enabled: false, welcomeEnabled: false };
      saveStore(store);
      return sock.sendMessage(
        from,
        {
          text: "✅ Bienvenida desactivada.",
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (["bye", "despedida", "leave"].includes(action)) {
      const subAction = String(args[1] || "").trim().toLowerCase();
      if (!subAction || ["status", "estado"].includes(subAction)) {
        return sock.sendMessage(
          from,
          {
            text:
              `Despedida actual: *${boolLabel(config.byeEnabled)}*\n` +
              `Usa: ${prefix}welcome bye on | ${prefix}welcome bye off`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      if (subAction === "on") {
        store[from] = { ...config, byeEnabled: true };
        saveStore(store);
        return sock.sendMessage(
          from,
          {
            text: "✅ Despedida activada.",
            ...global.channelInfo,
          },
          quoted
        );
      }

      if (subAction === "off") {
        store[from] = { ...config, byeEnabled: false };
        saveStore(store);
        return sock.sendMessage(
          from,
          {
            text: "✅ Despedida desactivada.",
            ...global.channelInfo,
          },
          quoted
        );
      }

      return sock.sendMessage(
        from,
        {
          text: `Usa: ${prefix}welcome bye on | ${prefix}welcome bye off`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "text") {
      store[from] = { ...config, text: value.slice(0, 700) };
      saveStore(store);
      return sock.sendMessage(
        from,
        {
          text: "✅ Texto de bienvenida actualizado.",
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "byetext" || action === "despedidatext") {
      store[from] = { ...config, byeText: value.slice(0, 700) };
      saveStore(store);
      return sock.sendMessage(
        from,
        {
          text: "✅ Texto de despedida actualizado.",
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "rules") {
      store[from] = { ...config, rules: value.slice(0, 700) };
      saveStore(store);
      return sock.sendMessage(
        from,
        {
          text: "✅ Reglas de bienvenida actualizadas.",
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "image") {
      store[from] = { ...config, image: value };
      saveStore(store);
      return sock.sendMessage(
        from,
        {
          text: "✅ Imagen guardada (se usa como respaldo si falla la foto del grupo).",
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "reset") {
      store[from] = createDefaultConfig();
      saveStore(store);
      return sock.sendMessage(
        from,
        {
          text: "✅ Welcome & Bye reiniciado.",
          ...global.channelInfo,
        },
        quoted
      );
    }

    return sock.sendMessage(
      from,
      {
        text: `❌ Opcion invalida.\nUsa: ${prefix}welcome`,
        ...global.channelInfo,
      },
      quoted
    );
  },

  async onGroupUpdate({ sock, update, settings }) {
    if (!update?.id) return;

    const action = String(update.action || "").trim().toLowerCase();
    if (!["add", "remove"].includes(action)) return;

    const store = readStore();
    const config = getConfig(update.id, store);
    if (action === "add" && !config.welcomeEnabled) return;
    if (action === "remove" && !config.byeEnabled) return;

    let metadata = null;
    try {
      metadata = await sock.groupMetadata(update.id);
    } catch {}

    const groupName = metadata?.subject || "Grupo";
    const totalMembers = Array.isArray(metadata?.participants) ? metadata.participants.length : 0;
    const botName = String(settings?.botName || "Bot").trim() || "Bot";
    const prefix = getPrefix(settings);
    const imageUrl = await getGroupImageUrl(sock, update.id, config.image);

    for (const participant of update.participants || []) {
      const metadataParticipant = findGroupParticipant(metadata || {}, [participant]);
      const mentionJid = getParticipantMentionJid(metadata || {}, metadataParticipant, participant);
      const userTag = getParticipantDisplayTag(metadataParticipant, participant);
      const profileImageUrl = await getProfileImageUrl(sock, mentionJid || participant);

      const text =
        action === "add"
          ? buildWelcomeMessage({
              userTag,
              groupName,
              totalMembers,
              botName,
              customText: config.text,
              rules: config.rules,
              prefix,
            })
          : buildByeMessage({
              userTag,
              groupName,
              totalMembers,
              botName,
              byeText: config.byeText,
              prefix,
            });

      let cardBuffer = null;
      try {
        cardBuffer = await createWelcomeCard({
          action,
          userTag,
          groupName,
          totalMembers,
          botName,
          mainText: buildCardText(action, config, userTag, groupName, totalMembers, botName),
          avatarUrl: profileImageUrl,
          groupImageUrl: imageUrl,
        });
      } catch {}

      if (cardBuffer) {
        await sock.sendMessage(update.id, {
          image: cardBuffer,
          caption: text,
          mentions: mentionJid ? [mentionJid] : [],
          ...global.channelInfo,
        });
        continue;
      }

      if (imageUrl) {
        await sock.sendMessage(update.id, {
          image: { url: imageUrl },
          caption: text,
          mentions: mentionJid ? [mentionJid] : [],
          ...global.channelInfo,
        });
        continue;
      }

      await sock.sendMessage(update.id, {
        text,
        mentions: mentionJid ? [mentionJid] : [],
        ...global.channelInfo,
      });
    }
  },
};
