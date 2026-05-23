const MAX_VISIBLE_MEMBERS = 180;
const MAX_TEXT_CHARS = 3500;

function nowLabel() {
  try {
    return new Date().toLocaleString("es-PE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return new Date().toISOString();
  }
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unique(values = []) {
  return Array.from(new Set(values.map((item) => String(item || "").trim()).filter(Boolean)));
}

function jidUser(value = "") {
  return String(value || "").split("@")[0].split(":")[0].trim();
}

function digitsFrom(value = "") {
  return jidUser(value).replace(/[^\d]/g, "");
}

function collectParticipantValues(participant = {}) {
  return unique([
    participant?.id,
    participant?.jid,
    participant?.lid,
    participant?.pn,
    participant?.phoneNumber,
    participant?.phone_number,
    participant?.participant,
    participant?.participantAlt,
    participant?.participantPn,
    participant?.participantLid,
  ]);
}

function normalizeJid(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";

  if (raw.includes("@")) return raw;

  const digits = raw.replace(/[^\d]/g, "");
  if (digits) return `${digits}@s.whatsapp.net`;

  return "";
}

function resolveMentionJid(metadata = {}, participant = {}) {
  const values = collectParticipantValues(participant);
  const preferLid = cleanText(metadata?.addressingMode).toLowerCase() === "lid";
  const lids = values.filter((item) => /@lid$/i.test(item));
  const phones = values.filter((item) => /@s\.whatsapp\.net$/i.test(item));
  const anyJids = values.filter((item) => item.includes("@"));
  const digits = values.map(digitsFrom).find(Boolean);

  if (preferLid) {
    return lids[0] || phones[0] || anyJids[0] || (digits ? `${digits}@s.whatsapp.net` : "");
  }

  return phones[0] || lids[0] || anyJids[0] || normalizeJid(digits);
}

function displayMention(jid = "", participant = {}) {
  const digits = digitsFrom(jid) || collectParticipantValues(participant).map(digitsFrom).find(Boolean);
  const user = jidUser(jid) || collectParticipantValues(participant).map(jidUser).find(Boolean);

  if (digits) return `@${digits}`;
  if (user) return `@${user}`;
  return "@usuario";
}

function participantRank(participant = {}) {
  const role = cleanText(participant?.admin).toLowerCase();
  if (role === "superadmin") return 0;
  if (role) return 1;
  return 2;
}

function roleIcon(participant = {}) {
  const role = cleanText(participant?.admin).toLowerCase();
  if (role === "superadmin") return "👑";
  if (role) return "⭐";
  return "•";
}

function normalizeParticipants(metadata = {}) {
  const participants = Array.isArray(metadata?.participants) ? metadata.participants : [];
  const seen = new Set();

  return participants
    .map((participant) => {
      const jid = resolveMentionJid(metadata, participant);
      const key = jid.toLowerCase();
      if (!jid || seen.has(key)) return null;
      seen.add(key);

      return {
        participant,
        jid,
        tag: displayMention(jid, participant),
        rank: participantRank(participant),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank || a.tag.localeCompare(b.tag));
}

function buildMembersBlock(items = []) {
  const lines = [];
  let used = 0;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const line = `┃ ${String(index + 1).padStart(2, "0")} ${roleIcon(item.participant)} ${item.tag}`;
    const nextSize = used + line.length + 1;

    if (index >= MAX_VISIBLE_MEMBERS || nextSize > MAX_TEXT_CHARS) {
      lines.push(`┃ ... y ${items.length - index} miembro(s) mas etiquetados`);
      break;
    }

    lines.push(line);
    used = nextSize;
  }

  return lines.join("\n");
}

function buildMessage(metadata = {}, items = [], notice = "") {
  const groupName = cleanText(metadata?.subject) || "Grupo";
  const bodyNotice = cleanText(notice) || "Convocatoria general del grupo";
  const admins = items.filter((item) => item.rank < 2).length;

  return [
    "╭━━━〔 📢 INVOCACION GENERAL 〕━━━⬣",
    `┃ Grupo: *${groupName}*`,
    `┃ Miembros etiquetados: *${items.length}*`,
    `┃ Admins: *${admins}*`,
    `┃ Fecha: *${nowLabel()}*`,
    "┣━━━━━━━━━━━━━━━━━━━━━━⬣",
    `┃ ${bodyNotice}`,
    "╰━━━━━━━━━━━━━━━━━━━━━━⬣",
    "",
    "╭━━━〔 👥 LLAMADO DEL GRUPO 〕━━━⬣",
    buildMembersBlock(items) || "┃ No pude resolver miembros para etiquetar.",
    "╰━━━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

export default {
  command: ["tagall", "invocar", "invocartodos", "llamartodos", "mencionartodos"],
  category: "grupo",
  description: "Invoca y etiqueta a todos los miembros del grupo",
  groupOnly: true,
  adminOnly: true,

  run: async ({ sock, msg, from, args = [], groupMetadata }) => {
    const metadata = groupMetadata || (await sock.groupMetadata(from));
    const items = normalizeParticipants(metadata);
    const mentions = items.map((item) => item.jid);
    const text = buildMessage(metadata, items, args.join(" "));

    return sock.sendMessage(
      from,
      {
        text,
        mentions,
        ...global.channelInfo,
      },
      { quoted: msg }
    );
  },
};
