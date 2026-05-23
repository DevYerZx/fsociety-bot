import fs from "fs";
import path from "path";

const VIP_FILE = path.join(process.cwd(), "settings", "vip.json");

function ensureVipFile() {
  const dir = path.dirname(VIP_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(VIP_FILE)) {
    fs.writeFileSync(VIP_FILE, JSON.stringify({ users: {} }, null, 2));
  }
}

function readVip() {
  ensureVipFile();
  try {
    const raw = fs.readFileSync(VIP_FILE, "utf-8");
    const data = JSON.parse(raw);
    return {
      users: data?.users && typeof data.users === "object" ? data.users : {},
    };
  } catch {
    return { users: {} };
  }
}

function saveVip(data) {
  ensureVipFile();
  fs.writeFileSync(VIP_FILE, JSON.stringify(data, null, 2));
}

function normalizeNumber(value = "") {
  return String(value || "")
    .split("@")[0]
    .split(":")[0]
    .replace(/[^\d]/g, "")
    .trim();
}

function parseSlotToken(value = "", maxSlots = 15) {
  const raw = String(value || "").trim().toLowerCase();
  const direct = Number.parseInt(raw, 10);
  if (String(direct) === raw && direct >= 1 && direct <= maxSlots) return direct;

  const match = raw.match(/^(?:subbot|slot)(\d{1,2})$/);
  if (!match) return null;

  const parsed = Number.parseInt(match[1], 10);
  return parsed >= 1 && parsed <= maxSlots ? parsed : null;
}

function parseVipPairingArgs(args = [], maxSlots = 15) {
  const tokens = (Array.isArray(args) ? args : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  const first = tokens[0] || "";
  const slot = parseSlotToken(first, maxSlots);
  if (slot) {
    return {
      slot,
      number: normalizeNumber(tokens[1] || ""),
      valid: Boolean(normalizeNumber(tokens[1] || "")),
    };
  }

  const number = normalizeNumber(first);
  return {
    slot: null,
    number,
    valid: Boolean(number),
  };
}

function detectRequesterNumber(msg, sender) {
  const candidates = [
    msg?.senderPhone,
    msg?.key?.participantPn,
    msg?.sender,
    sender,
    msg?.key?.participant,
    msg?.key?.remoteJid,
  ];

  for (const candidate of candidates) {
    const digits = normalizeNumber(candidate);
    if (digits.length >= 8) return digits;
  }

  return "";
}

function canRequestVipPairing({ esOwner, requesterNumber, sock, settings }) {
  if (esOwner) return true;

  const requester = normalizeNumber(requesterNumber);
  if (!requester) return false;

  return [
    settings?.pairingNumber,
    settings?.ownerNumber,
    sock?.user?.id,
    sock?.user?.lid,
  ]
    .map((value) => normalizeNumber(value))
    .filter(Boolean)
    .some((number) => number === requester);
}

function parseDurationToMs(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "inf" || raw === "infinito" || raw === "forever") {
    return 0;
  }

  const match = raw.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return -1;

  const amount = Number(match[1] || 0);
  const unit = match[2];
  const multiplier =
    unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;

  return amount > 0 ? amount * multiplier : -1;
}

function formatDuration(ms = 0) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function cleanupSubbotVip(data) {
  const now = Date.now();
  for (const [number, info] of Object.entries(data.users || {})) {
    if (!info || typeof info !== "object") continue;
    if (info.subbotVip !== true) continue;
    if (Number.isFinite(Number(info.expiresAt)) && Number(info.expiresAt) > 0 && Number(info.expiresAt) <= now) {
      delete data.users[number];
    }
  }
}

function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }
  return String(settings?.prefix || ".").trim() || ".";
}

export default {
  name: "subbotvip",
  command: ["subbotvip"],
  category: "admin",
  description: "Crea subbot VIP sin limite de tiempo y administra VIP especial",

  run: async ({ sock, msg, from, args = [], settings, esOwner, sender }) => {
    const prefix = getPrefix(settings);
    const runtime = global.botRuntime;
    const action = String(args[0] || "").trim().toLowerCase();
    const adminActions = new Set(["help", "add", "del", "delete", "rm", "check", "list"]);

    if (!adminActions.has(action)) {
      const subbotState = runtime?.getSubbotRequestState?.() || {};
      const parsed = parseVipPairingArgs(args, Number(subbotState?.maxSlots || 15));
      const requesterNumber = detectRequesterNumber(msg, sender);

      if (!canRequestVipPairing({ esOwner, requesterNumber, sock, settings })) {
        return sock.sendMessage(
          from,
          {
            text:
              `*SUBBOT VIP BLOQUEADO*\n\n` +
              `Solo el owner o el numero principal del bot pueden pedir subbot VIP.\n` +
              `Usuarios normales pueden usar: *${prefix}subbot 51912345678*`,
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      }

      if (!runtime?.requestBotPairingCode || !parsed.valid) {
        return sock.sendMessage(
          from,
          {
            text:
              `╭━━〔 💎 *SUBBOT VIP* 〕━━⬣\n` +
              `┃ ${prefix}subbotvip 519xxxxxxxx\n` +
              `┃ ${prefix}subbotvip 3 519xxxxxxxx\n` +
              `┃ Tipo: VIP sin limite de tiempo\n` +
              `╰━━━━━━━━━━━━━━━━━━━━⬣`,
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      }

      await sock.sendMessage(
        from,
        {
          text:
            `Preparando subbot VIP para *${parsed.number}*...\n` +
            `Tipo: *VIP sin limite de tiempo*`,
          ...global.channelInfo,
        },
        { quoted: msg }
      );

      const result = await runtime.requestBotPairingCode(
        parsed.slot ? `subbot${parsed.slot}` : "subbot",
        {
          number: parsed.number,
          requesterNumber: parsed.number,
          requesterJid: String(sender || ""),
          subbotMode: "vip",
          bypassPublicRequests: true,
          useCache: true,
        }
      );

      if (!result?.ok) {
        return sock.sendMessage(
          from,
          {
            text: result?.message || "No pude obtener el codigo del subbot VIP.",
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      }

      const slotLabel = result.slot ? ` ${result.slot}` : "";
      return sock.sendMessage(
        from,
        {
          text:
            `╭━━〔 💎 *CODIGO SUBBOT VIP${slotLabel}* 〕━━⬣\n` +
            `┃ Bot: *${result.displayName}*\n` +
            `┃ Numero: *${result.number}*\n` +
            `┃ Tipo: *VIP SIN LIMITE*\n` +
            `┃ Codigo: *${result.code}*\n` +
            `┃ Expira aprox: *${formatDuration(result.expiresInMs)}*\n` +
            `╰━━━━━━━━━━━━━━━━━━━━⬣\n\n` +
            `Abre WhatsApp > Dispositivos vinculados > Vincular con numero de telefono.`,
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }

    if (!esOwner) {
      return sock.sendMessage(
        from,
        {
          text: "Solo el owner puede administrar la lista VIP.",
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }

    const adminAction = action || "help";
    const data = readVip();
    cleanupSubbotVip(data);
    saveVip(data);

    if (adminAction === "help") {
      return sock.sendMessage(
        from,
        {
          text:
            `╭━━〔 💎 *PANEL SUBBOT VIP* 〕━━⬣\n` +
            `┃ ${prefix}subbotvip add 519xxxxxxxx 30d\n` +
            `┃ ${prefix}subbotvip add 519xxxxxxxx inf\n` +
            `┃ ${prefix}subbotvip del 519xxxxxxxx\n` +
            `┃ ${prefix}subbotvip check 519xxxxxxxx\n` +
            `┃ ${prefix}subbotvip list\n` +
            `╰━━━━━━━━━━━━━━━━━━━━⬣`,
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }

    if (adminAction === "list") {
      const now = Date.now();
      const users = Object.entries(data.users || {})
        .filter(([, info]) => info?.subbotVip === true)
        .sort((a, b) => a[0].localeCompare(b[0]));

      return sock.sendMessage(
        from,
        {
          text:
            `╭━━〔 💎 *SUBBOT VIP ACTIVOS* 〕━━⬣\n` +
            (users.length
              ? users
                  .map(([number, info]) => {
                    const left = Number.isFinite(Number(info.expiresAt)) && Number(info.expiresAt) > 0
                      ? formatDuration(Number(info.expiresAt) - now)
                      : "∞";
                    return `┃ • ${number} | vence: ${left} | sin limite: SI`;
                  })
                  .join("\n")
              : "┃ No hay subbot VIP activos.") +
            `\n╰━━━━━━━━━━━━━━━━━━━━⬣`,
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }

    if (adminAction === "check") {
      const number = normalizeNumber(args[1]);
      const info = data.users[number];
      if (!number || !info || info.subbotVip !== true) {
        return sock.sendMessage(
          from,
          { text: "Ese numero no tiene subbot VIP.", ...global.channelInfo },
          { quoted: msg }
        );
      }

      return sock.sendMessage(
        from,
        {
          text:
            `╭━━〔 🔎 *SUBBOT VIP CHECK* 〕━━⬣\n` +
            `┃ Numero: *${number}*\n` +
            `┃ Sin limite: *SI*\n` +
            `┃ Vence en: *${
              Number.isFinite(Number(info.expiresAt)) && Number(info.expiresAt) > 0
                ? formatDuration(Number(info.expiresAt) - Date.now())
                : "∞"
            }*\n` +
            `╰━━━━━━━━━━━━━━━━━━━━⬣`,
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }

    if (adminAction === "del" || adminAction === "delete" || adminAction === "rm") {
      const number = normalizeNumber(args[1]);
      if (!number || !data.users[number] || data.users[number]?.subbotVip !== true) {
        return sock.sendMessage(
          from,
          { text: "Ese numero no tiene subbot VIP.", ...global.channelInfo },
          { quoted: msg }
        );
      }

      delete data.users[number];
      saveVip(data);
      return sock.sendMessage(
        from,
        {
          text: `Subbot VIP eliminado para *${number}*.`,
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }

    if (adminAction === "add") {
      const number = normalizeNumber(args[1]);
      const durationMs = parseDurationToMs(args[2] || "inf");

      if (!number || durationMs < 0) {
        return sock.sendMessage(
          from,
          {
            text: `Uso: ${prefix}subbotvip add 519xxxxxxxx 30d\nO: ${prefix}subbotvip add 519xxxxxxxx inf`,
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      }

      data.users[number] = {
        ...(data.users[number] && typeof data.users[number] === "object" ? data.users[number] : {}),
        subbotVip: true,
        usesLeft: null,
        expiresAt: durationMs > 0 ? Date.now() + durationMs : null,
      };
      saveVip(data);

      return sock.sendMessage(
        from,
        {
          text:
            `╭━━〔 ✅ *SUBBOT VIP ACTIVO* 〕━━⬣\n` +
            `┃ Numero: *${number}*\n` +
            `┃ Sin limite de descarga: *SI*\n` +
            `┃ Vence: *${durationMs > 0 ? formatDuration(durationMs) : "∞"}*\n` +
            `╰━━━━━━━━━━━━━━━━━━━━⬣`,
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }

    return sock.sendMessage(
      from,
      {
        text:
          `Usa:\n` +
          `${prefix}subbotvip add 519xxxxxxxx 30d\n` +
          `${prefix}subbotvip add 519xxxxxxxx inf\n` +
          `${prefix}subbotvip del 519xxxxxxxx\n` +
          `${prefix}subbotvip check 519xxxxxxxx\n` +
          `${prefix}subbotvip list`,
        ...global.channelInfo,
      },
      { quoted: msg }
    );
  },
};
