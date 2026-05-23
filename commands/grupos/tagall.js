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

function isOwner(metadata = {}, participant = {}) {
  const owner = cleanText(metadata?.owner || metadata?.subjectOwner || metadata?.descOwner).toLowerCase();
  const id = cleanText(participant?.id).toLowerCase();
  return Boolean(owner && id && owner === id);
}

function participantRole(metadata = {}, participant = {}) {
  if (isOwner(metadata, participant)) return "owner";
  const admin = cleanText(participant?.admin).toLowerCase();
  if (admin === "superadmin") return "owner";
  if (admin) return "admin";
  return "member";
}

function roleSymbol(role = "member") {
  if (role === "owner") return "♛";
  if (role === "admin") return "✦";
  return "◈";
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

function formatPerson(participant = {}, index = 0, getContactName = null, metadata = {}) {
  const id = cleanText(participant?.id);
  const mention = mentionToken(id);
  const name = resolveName(participant, getContactName);
  const label = name && name !== mention ? `${name} ${mention}` : mention;
  const icon = roleSymbol(participantRole(metadata, participant));

  return `│ ${String(index + 1).padStart(2, "0")} ${icon} ${label}`;
}

function buildSection(title = "", participants = [], getContactName = null, metadata = {}) {
  const lines = [`╭┈┈⟬ ${title} ⟭┈┈`];
  const visible = participants.slice(0, MAX_LISTED_PER_SECTION);

  if (!visible.length) {
    lines.push("│ ⊘ Ninguno detectado");
    lines.push("╰┈┈┈┈┈┈┈┈┈┈");
    return lines.join("\n");
  }

  visible.forEach((participant, index) => {
    lines.push(formatPerson(participant, index, getContactName, metadata));
  });

  if (participants.length > visible.length) {
    lines.push(`│ ⋯ y ${participants.length - visible.length} mas`);
  }

  lines.push("╰┈┈┈┈┈┈┈┈┈┈");
  return lines.join("\n");
}

function nowLabel() {
  try {
    return new Date().toLocaleString("es-PE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return new Date().toISOString();
  }
}

function buildCaption(metadata = {}, participants = [], text = "", getContactName = null) {
  const owners = participants.filter((participant) => participantRole(metadata, participant) === "owner");
  const admins = participants.filter((participant) => participantRole(metadata, participant) === "admin");
  const members = participants.filter((participant) => participantRole(metadata, participant) === "member");
  const extra = cleanText(text);

  return [
    "╭━━━〔 ⟁ *LLAMADO DEL GRUPO* ⟁ 〕━━━╮",
    "┃      𝙏𝘼𝙂 𝘼 𝙏𝙊𝘿𝙊𝙎      ┃",
    "╰━━━━━━━━━━━━━━━━━━━━━━━━╯",
    "",
    `╭─⟡ Grupo: *${cleanText(metadata?.subject) || "Grupo"}*`,
    `│ ⟡ Total invocado: *${participants.length}*`,
    `│ ⟡ Dueño: *${owners.length}*`,
    `│ ⟡ Administradores: *${admins.length}*`,
    `│ ⟡ Miembros normales: *${members.length}*`,
    `│ ⟡ Hora: *${nowLabel()}*`,
    `╰─⟡ Aviso: *${extra || "Atención al grupo"}*`,
    "",
    buildSection("♛ DUEÑO DEL GRUPO", owners, getContactName, metadata),
    "",
    buildSection("✦ ADMINISTRADORES", admins, getContactName, metadata),
    "",
    buildSection("◈ MIEMBROS NORMALES", members, getContactName, metadata),
    "",
    "⊹ Las menciones fueron enviadas sin canal ni vista externa.",
    "⊹ Si WhatsApp limita un grupo grande, repite el comando.",
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

export default {
  command: ["tagall", "invocar", "invocartodos", "llamartodos", "mencionartodos", "todos"],
  category: "grupo",
  description: "Invoca y etiqueta a todos los miembros del grupo",
  groupOnly: true,
  adminOnly: true,

  run: async ({ sock, msg, from, args = [], groupMetadata, getContactName }) => {
    await react(sock, msg, "⟁");

    const metadata = groupMetadata || (await sock.groupMetadata(from));
    const participants = uniqueById(Array.isArray(metadata?.participants) ? metadata.participants : []);
    const mentionIds = participants.map((participant) => participant.id).filter(Boolean);
    const text = buildCaption(metadata, participants, args.join(" "), getContactName);

    const result = await sock.sendMessage(
      from,
      {
        text,
        mentions: mentionIds,
        contextInfo: {
          mentionedJid: mentionIds,
        },
      },
      { quoted: msg }
    );

    await react(sock, msg, "☑️");
    return result;
  },
};
