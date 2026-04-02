function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }
  return String(settings?.prefix || ".").trim() || ".";
}

function normalizeText(value = "") {
  return String(value || "").trim();
}

function normalizeJid(value = "") {
  return normalizeText(value).toLowerCase();
}

function extractDigits(value = "") {
  return String(value || "").replace(/[^\d]/g, "");
}

function toLidFromNumber(number = "") {
  const digits = extractDigits(number);
  return digits ? `${digits}@lid` : "";
}

function toJidFromNumber(number = "") {
  const digits = extractDigits(number);
  return digits ? `${digits}@s.whatsapp.net` : "";
}

function numberFromJid(jid = "") {
  return extractDigits(String(jid || "").split("@")[0]);
}

function toLidFromJid(jid = "") {
  const clean = normalizeJid(jid);
  if (!clean) return "";
  if (clean.endsWith("@lid")) return clean;
  const number = numberFromJid(clean);
  return number ? `${number}@lid` : "";
}

function parseChannelInviteCode(input = "") {
  const raw = normalizeText(input);
  if (!raw) return "";

  const match = raw.match(
    /(?:https?:\/\/)?(?:www\.)?(?:chat\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]{6,})/i
  );
  if (match?.[1]) return match[1];

  if (/^[A-Za-z0-9_-]{6,}$/.test(raw)) return raw;
  return "";
}

function pick(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return "";
}

function parseEpoch(raw) {
  const number = Number.parseInt(String(raw || ""), 10);
  if (!Number.isFinite(number) || number <= 0) return "";
  const millis = number < 1e12 ? number * 1000 : number;
  const date = new Date(millis);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toISOString();
}

function buildChannelSummary(meta, inviteCode) {
  const thread = meta?.thread_metadata || {};
  const viewer = meta?.viewer_metadata || {};
  const id = pick(meta?.id, meta?.jid);
  const invite = pick(thread?.invite, meta?.invite, inviteCode);
  const owner = pick(meta?.owner, thread?.owner, thread?.owner_jid);
  const ownerLid = toLidFromJid(owner);
  const name = pick(meta?.name, thread?.name?.text, thread?.name);
  const description = pick(meta?.description, thread?.description?.text, thread?.description);
  const subscribers = pick(meta?.subscribers, thread?.subscribers_count);
  const creationIso = parseEpoch(pick(meta?.creation_time, thread?.creation_time));
  const verification = pick(meta?.verification, thread?.verification);
  const muteState = pick(meta?.mute_state, viewer?.mute);

  const lines = [
    "*CANAL WHATSAPP*",
    "",
    `Nombre: *${name || "Sin nombre"}*`,
    `JID: *${id || "No disponible"}*`,
    `Invite: *${invite || "No disponible"}*`,
    invite ? `Link: https://whatsapp.com/channel/${invite}` : "",
    owner ? `Owner JID: *${owner}*` : "",
    ownerLid ? `Owner LID: *${ownerLid}*` : "",
    subscribers ? `Seguidores: *${subscribers}*` : "",
    verification ? `Verificacion: *${verification}*` : "",
    muteState ? `Mute viewer: *${muteState}*` : "",
    creationIso ? `Creado: *${creationIso}*` : "",
    description ? `\nDescripcion:\n${description}` : "",
  ].filter(Boolean);

  return lines.join("\n");
}

function buildNumberSummary(number = "", sourceLabel = "Numero") {
  const digits = extractDigits(number);
  const jid = toJidFromNumber(digits);
  const lid = toLidFromNumber(digits);
  return (
    `*CONVERSION ${String(sourceLabel || "NUMERO").toUpperCase()}*\n\n` +
    `Numero: *+${digits}*\n` +
    `JID: *${jid}*\n` +
    `LID: *${lid}*\n\n` +
    `Nota: el LID puede cambiar por dispositivo/cuenta.`
  );
}

function resolveSenderNumber({ sender = "", msg = {}, from = "" } = {}) {
  const candidates = [
    sender,
    msg?.sender,
    msg?.key?.participant,
    msg?.participant,
    msg?.key?.remoteJid,
    from,
  ];

  for (const candidate of candidates) {
    const digits = extractDigits(candidate);
    if (digits.length >= 8) return digits;
  }
  return "";
}

export default {
  name: "canalinfo",
  command: ["canalinfo", "channelinfo", "newsletterinfo", "jidlid", "lids", "lid", "mylid"],
  category: "herramientas",
  description: "Obtiene JID/LID de canal por enlace o convierte numero a JID/LID",

  run: async ({ sock, msg, from, args = [], settings, sender = "" }) => {
    const prefix = getPrefix(settings);
    const rawInput = normalizeText(Array.isArray(args) ? args.join(" ") : "");
    const senderNumber = resolveSenderNumber({ sender, msg, from });

    if (!rawInput || ["yo", "me", "mio", "mi", "my", "self"].includes(rawInput.toLowerCase())) {
      if (senderNumber) {
        return sock.sendMessage(
          from,
          {
            text: buildNumberSummary(senderNumber, "tu numero"),
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      }

      return sock.sendMessage(
        from,
        {
          text:
            `*CANALINFO*\n\n` +
            `Usa:\n` +
            `- ${prefix}canalinfo yo\n` +
            `- ${prefix}canalinfo https://whatsapp.com/channel/XXXXXX\n` +
            `- ${prefix}canalinfo 51930108242\n` +
            `- ${prefix}canalinfo 51930108242@s.whatsapp.net`,
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }

    const inviteCode = parseChannelInviteCode(rawInput);
    if (inviteCode) {
      if (typeof sock.newsletterMetadata !== "function") {
        return sock.sendMessage(
          from,
          {
            text: "Tu version de Baileys no soporta metadata de canales (newsletterMetadata).",
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      }

      try {
        const meta = await sock.newsletterMetadata("INVITE", inviteCode);
        if (!meta) {
          throw new Error("No recibi metadata del canal.");
        }

        return sock.sendMessage(
          from,
          {
            text: buildChannelSummary(meta, inviteCode),
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      } catch (error) {
        return sock.sendMessage(
          from,
          {
            text: `No pude leer ese canal.\nDetalle: ${error?.message || error}`,
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      }
    }

    const normalizedInput = normalizeJid(rawInput);
    if (normalizedInput.endsWith("@newsletter") && typeof sock.newsletterMetadata === "function") {
      try {
        const meta = await sock.newsletterMetadata("JID", normalizedInput);
        if (!meta) {
          throw new Error("No recibi metadata del canal.");
        }

        return sock.sendMessage(
          from,
          {
            text: buildChannelSummary(meta, ""),
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      } catch (error) {
        return sock.sendMessage(
          from,
          {
            text: `No pude leer ese JID de canal.\nDetalle: ${error?.message || error}`,
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      }
    }

    if (normalizedInput.endsWith("@lid")) {
      const number = numberFromJid(normalizedInput);
      return sock.sendMessage(
        from,
        {
          text:
            `*CONVERSION LID*\n\n` +
            `LID: *${normalizedInput}*\n` +
            `Numero: *${number ? `+${number}` : "No detectable"}*\n` +
            `JID sugerido: *${number ? toJidFromNumber(number) : "No disponible"}*`,
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }

    const detectedNumber = extractDigits(rawInput);
    if (detectedNumber.length >= 8) {
      return sock.sendMessage(
        from,
        {
          text: buildNumberSummary(detectedNumber, "numero"),
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }

    return sock.sendMessage(
      from,
      {
        text: "Entrada invalida. Envia un enlace de canal, JID @newsletter o numero.",
        ...global.channelInfo,
      },
      { quoted: msg }
    );
  },
};
