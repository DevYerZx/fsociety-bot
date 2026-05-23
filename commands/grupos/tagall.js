const VERSION = "1.3.4";
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
  return cleanText(participant?.admin).toLowerCase() === "superadmin" ? "♛" : "◆";
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
  const icon = isAdmin(participant) ? adminIcon(participant) : "◇";

  return `│ ${String(index + 1).padStart(2, "0")} ${icon} ${label}`;
}

function buildSection(title = "", participants = [], getContactName = null) {
  const lines = [`╭─ ${title}`];
  const visible = participants.slice(0, MAX_LISTED_PER_SECTION);

  if (!visible.length) {
    lines.push("│ Ninguno detectado");
    lines.push("╰────────────");
    return lines.join("\n");
  }

  visible.forEach((participant, index) => {
    lines.push(formatPerson(participant, index, getContactName));
  });

  if (participants.length > visible.length) {
    lines.push(`│ ... y ${participants.length - visible.length} mas`);
  }

  lines.push("╰────────────");
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
  const admins = participants.filter(isAdmin);
  const members = participants.filter((participant) => !isAdmin(participant));
  const extra = cleanText(text);

  return [
    "╔══════════════════════╗",
    "║     *LLAMADO GENERAL*     ║",
    "╚══════════════════════╝",
    "",
    `▸ Grupo: *${cleanText(metadata?.subject) || "Grupo"}*`,
    `▸ Etiquetados: *${participants.length}*`,
    `▸ Admins: *${admins.length}*`,
    `▸ Miembros: *${members.length}*`,
    `▸ Hora: *${nowLabel()}*`,
    extra ? `▸ Aviso: *${extra}*` : "▸ Aviso: *Atención al grupo*",
    "",
    buildSection("ADMINISTRADORES", admins, getContactName),
    "",
    buildSection("MIEMBROS", members, getContactName),
    "",
    `⌁ FsOCIETY TagAll v${VERSION}`,
    "⌁ Menciones enviadas al grupo.",
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
    await react(sock, msg, "📣");

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

    await react(sock, msg, "✅");
    return result;
  },
};
