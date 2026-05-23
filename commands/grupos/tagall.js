import axios from "axios";

const TAGALL_IMAGE = "https://files.catbox.moe/4bvpl0.jpg";
const CHANNEL_URL = "https://whatsapp.com/channel/120363354701957370";
const VERSION = "1.3.3";
const MAX_LISTED_PER_SECTION = 160;

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function jidUser(jid = "") {
  return String(jid || "").split("@")[0].split(":")[0].trim();
}

function mentionToken(jid = "") {
  const user = jidUser(jid);
  return user ? `@${user}` : "@usuario";
}

function uniqueById(participants = []) {
  const seen = new Set();
  const output = [];

  for (const participant of participants) {
    const id = cleanText(participant?.id);
    if (!id || seen.has(id.toLowerCase())) continue;

    seen.add(id.toLowerCase());
    output.push(participant);
  }

  return output;
}

function isAdmin(participant = {}) {
  return Boolean(participant?.admin);
}

function adminIcon(participant = {}) {
  return cleanText(participant?.admin).toLowerCase() === "superadmin" ? "👑" : "⭐";
}

function resolveName(participant = {}, getContactName = null) {
  const id = cleanText(participant?.id);
  const contactName = typeof getContactName === "function" ? cleanText(getContactName(id)) : "";
  return cleanText(
    contactName ||
      participant?.notify ||
      participant?.name ||
      participant?.pushName ||
      participant?.verifiedName ||
      participant?.verifiedBizName ||
      ""
  );
}

function formatPerson(participant = {}, index = 0, getContactName = null) {
  const id = cleanText(participant?.id);
  const mention = mentionToken(id);
  const name = resolveName(participant, getContactName);
  const label = name && name !== mention ? `${name} ${mention}` : mention;
  const icon = isAdmin(participant) ? adminIcon(participant) : "•";

  return `┃ ${String(index + 1).padStart(2, "0")} ${icon} ${label}`;
}

function buildSection(title = "", participants = [], getContactName = null) {
  const lines = [`┣━━〔 ${title} 〕`];
  const visible = participants.slice(0, MAX_LISTED_PER_SECTION);

  if (!visible.length) {
    lines.push("┃ Ninguno detectado");
    return lines.join("\n");
  }

  visible.forEach((participant, index) => {
    lines.push(formatPerson(participant, index, getContactName));
  });

  if (participants.length > visible.length) {
    lines.push(`┃ ... y ${participants.length - visible.length} mas`);
  }

  return lines.join("\n");
}

function buildCaption(metadata = {}, participants = [], text = "", getContactName = null) {
  const admins = participants.filter(isAdmin);
  const members = participants.filter((participant) => !isAdmin(participant));
  const extra = cleanText(text);

  return [
    "┏━━━━━━━━━━━━━━━━━━━┓",
    "⚔️ *Invocación General* ⚔️",
    "┗━━━━━━━━━━━━━━━━━━━┛",
    "",
    `✐ Grupo: *${cleanText(metadata?.subject) || "Grupo"}*`,
    `ⴵ Miembros: *${participants.length}*`,
    `✦ Administradores: *${admins.length}*`,
    `✦ Miembros normales: *${members.length}*`,
    extra ? `✰ Mensaje: *${extra}*` : "",
    "",
    buildSection("ADMINISTRADORES", admins, getContactName),
    buildSection("MIEMBROS", members, getContactName),
    "",
    `🌌 Versión: *${VERSION}*`,
    "『☽』 Todos responden al llamado.",
  ].filter(Boolean).join("\n");
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

async function getThumbnail() {
  try {
    const response = await axios.get(TAGALL_IMAGE, {
      responseType: "arraybuffer",
      timeout: 12_000,
      validateStatus: () => true,
    });

    if (response.status >= 400 || !response.data) return undefined;
    return Buffer.from(response.data);
  } catch {
    return undefined;
  }
}

export default {
  command: ["tagall", "invocar", "invocartodos", "llamartodos", "mencionartodos", "todos"],
  category: "grupo",
  description: "Invoca y etiqueta a todos los miembros del grupo",
  groupOnly: true,
  adminOnly: true,

  run: async ({ sock, msg, from, args = [], groupMetadata, getContactName }) => {
    await react(sock, msg, "🌑");

    const metadata = groupMetadata || (await sock.groupMetadata(from));
    const participants = uniqueById(Array.isArray(metadata?.participants) ? metadata.participants : []);
    const mentionIds = participants.map((participant) => participant.id).filter(Boolean);
    const caption = buildCaption(metadata, participants, args.join(" "), getContactName);
    const thumbnail = await getThumbnail();

    return sock.sendMessage(
      from,
      {
        image: { url: TAGALL_IMAGE },
        caption,
        mentions: mentionIds,
        contextInfo: {
          mentionedJid: mentionIds,
          forwardingScore: 999999,
          isForwarded: true,
          externalAdReply: {
            title: "⚔️ Invocación General ⚔️",
            body: "El llamado fue emitido para todo el grupo.",
            previewType: "PHOTO",
            thumbnail,
            sourceUrl: CHANNEL_URL,
            showAdAttribution: true,
          },
        },
        ...global.channelInfo,
      },
      { quoted: msg }
    );
  },
};
