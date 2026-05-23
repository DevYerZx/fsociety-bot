const MAX_VISIBLE_MEMBERS = 220;
const MAX_TEXT_CHARS = 3600;
const MENTIONS_PER_MESSAGE = 80;

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

function displayNameFromParticipant(participant = {}) {
  return cleanText(
    participant?.notify ||
      participant?.name ||
      participant?.pushName ||
      participant?.verifiedName ||
      participant?.verifiedBizName ||
      participant?.subject ||
      participant?.displayName ||
      ""
  );
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
  const lids = values.filter((item) => /@lid$/i.test(item));
  const phones = values.filter((item) => /@s\.whatsapp\.net$/i.test(item));
  const anyJids = values.filter((item) => item.includes("@"));
  const phoneDigits = values
    .filter((item) => !/@lid$/i.test(item))
    .map(digitsFrom)
    .find(Boolean);

  // Para menciones en texto, WhatsApp suele resolver mejor el JID telefonico.
  return phones[0] || (phoneDigits ? `${phoneDigits}@s.whatsapp.net` : "") || lids[0] || anyJids[0] || "";
}

function mentionText(jid = "", participant = {}) {
  const digits = digitsFrom(jid) || collectParticipantValues(participant).map(digitsFrom).find(Boolean);
  const user = jidUser(jid) || collectParticipantValues(participant).map(jidUser).find(Boolean);

  if (digits) return `@${digits}`;
  if (user) return `@${user}`;
  return "@usuario";
}

function displayLabel(jid = "", participant = {}, getContactName = null) {
  const contactName = typeof getContactName === "function"
    ? cleanText(getContactName(jid, ...collectParticipantValues(participant)))
    : "";
  const name = contactName || displayNameFromParticipant(participant);
  const mention = mentionText(jid, participant);

  if (!name || name === mention || name.startsWith("@")) {
    return mention;
  }

  return `${name} (${mention})`;
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

function normalizeParticipants(metadata = {}, getContactName = null) {
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
        mention: mentionText(jid, participant),
        label: displayLabel(jid, participant, getContactName),
        rank: participantRank(participant),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

function buildMembersBlock(items = [], title = "MIEMBROS") {
  const lines = [];
  let used = 0;

  lines.push(`┣━━〔 ${title} 〕`);

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const line = `┃ ${String(index + 1).padStart(2, "0")} ${roleIcon(item.participant)} ${item.label}`;
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
  const adminItems = items.filter((item) => item.rank < 2);
  const memberItems = items.filter((item) => item.rank >= 2);

  return [
    "╭━━━〔 📢 INVOCACION GENERAL 〕━━━⬣",
    `┃ Grupo: *${groupName}*`,
    `┃ Miembros etiquetados: *${items.length}*`,
    `┃ Administradores: *${adminItems.length}*`,
    `┃ Miembros normales: *${memberItems.length}*`,
    `┃ Fecha: *${nowLabel()}*`,
    "┣━━━━━━━━━━━━━━━━━━━━━━⬣",
    `┃ ${bodyNotice}`,
    "╰━━━━━━━━━━━━━━━━━━━━━━⬣",
    "",
    "╭━━━〔 👥 LLAMADO DEL GRUPO 〕━━━⬣",
    adminItems.length ? buildMembersBlock(adminItems, "ADMINISTRADORES") : "┣━━〔 ADMINISTRADORES 〕\n┃ Sin administradores detectados",
    memberItems.length ? buildMembersBlock(memberItems, "MIEMBROS") : "┣━━〔 MIEMBROS 〕\n┃ Sin miembros normales detectados",
    "╰━━━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function chunkItems(items = [], size = MENTIONS_PER_MESSAGE) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function buildCompactChunkText(metadata = {}, items = [], chunkIndex = 0, totalChunks = 1, notice = "") {
  if (chunkIndex === 0) {
    return buildMessage(metadata, items, notice);
  }

  return [
    `╭━━━〔 📢 INVOCACION GENERAL ${chunkIndex + 1}/${totalChunks} 〕━━━⬣`,
    `┃ Grupo: *${cleanText(metadata?.subject) || "Grupo"}*`,
    `┃ Continuacion de menciones: *${items.length}*`,
    "┣━━━━━━━━━━━━━━━━━━━━━━⬣",
    buildMembersBlock(items, "CONTINUACION"),
    "╰━━━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

export default {
  command: ["tagall", "invocar", "invocartodos", "llamartodos", "mencionartodos"],
  category: "grupo",
  description: "Invoca y etiqueta a todos los miembros del grupo",
  groupOnly: true,
  adminOnly: true,

  run: async ({ sock, msg, from, args = [], groupMetadata, getContactName }) => {
    const metadata = groupMetadata || (await sock.groupMetadata(from));
    const items = normalizeParticipants(metadata, getContactName);
    const chunks = chunkItems(items);
    const notice = args.join(" ");

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      await sock.sendMessage(
        from,
        {
          text: buildCompactChunkText(metadata, chunk, index, chunks.length, notice),
          mentions: chunk.map((item) => item.jid),
          ...global.channelInfo,
        },
        index === 0 ? { quoted: msg } : undefined
      );
    }

    return null;
  },
};
