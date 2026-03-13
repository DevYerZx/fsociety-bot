export function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }

  return String(settings?.prefix || ".").trim() || ".";
}

export function normalizeNumber(value) {
  return String(value || "").replace(/\D/g, "");
}

export function normalizeTimestamp(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function formatDateTime(value) {
  if (!value) return "Sin registro";

  try {
    return new Date(value).toLocaleString("es-PE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  } catch {
    return "Sin registro";
  }
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

export function getCurrentChatStatus({ isGroup, botId, botLabel }) {
  if (!isGroup) {
    return "Panel abierto por privado.";
  }

  if (String(botId || "").toLowerCase() === "main") {
    return "YA BOT principal activo aqui.";
  }

  return `${String(botLabel || "SUBBOT").toUpperCase()} activo aqui.`;
}

export function getSubbotStateLabel(bot) {
  if (bot.connected) return "ACTIVO AHORA";
  if (bot.connecting) return "CONECTANDO";
  if (bot.registered) return "VINCULADO";
  if (bot.pairingPending) return "ESPERANDO CODIGO";
  if (!bot.enabled) return "LIBRE";
  return "RESERVADO";
}

export function buildSubbotCard(bot) {
  const requesterNumber = bot.requesterNumber || "Sin solicitante";
  const linkedNumber = bot.configuredNumber || "No configurado";
  const requestedAt = normalizeTimestamp(bot.requestedAt);
  const releasedAt = normalizeTimestamp(bot.releasedAt);
  const connectedFor = bot.connectedForMs
    ? formatDuration(bot.connectedForMs)
    : "No conectado";
  const requestedFor = requestedAt
    ? formatDateTime(requestedAt)
    : "Sin solicitud";
  const releasedText = releasedAt
    ? formatDateTime(releasedAt)
    : "Sin liberar aun";
  const horaActiva = bot.connectedAt ? formatDateTime(bot.connectedAt) : "No conectado";
  const ultimaSalida = bot.lastDisconnectAt
    ? formatDateTime(bot.lastDisconnectAt)
    : "Sin desconexion reciente";

  let extra = "";

  if (bot.cachedPairingCode) {
    extra =
      `\nCodigo en cache: ${bot.cachedPairingCode}` +
      `\nExpira en: ${formatDuration(bot.cachedPairingExpiresInMs)}`;
  }

  return (
    `*Slot ${bot.slot} - ${bot.label}*\n` +
    `Estado: ${getSubbotStateLabel(bot)}\n` +
    `Bot: ${bot.displayName}\n` +
    `Solicitante: ${requesterNumber}\n` +
    `Numero vinculado: ${linkedNumber}\n` +
    `Solicitado: ${requestedFor}\n` +
    `Conectado desde: ${horaActiva}\n` +
    `Tiempo conectado: ${connectedFor}\n` +
    `Ultima salida: ${ultimaSalida}\n` +
    `Liberado: ${releasedText}\n` +
    `Sesion: ${bot.authFolder}${extra}`
  );
}

export function parseSlotToken(value, maxSlots) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;

  const directNumber = Number.parseInt(raw, 10);
  if (String(directNumber) === raw && directNumber >= 1 && directNumber <= maxSlots) {
    return directNumber;
  }

  const match = raw.match(/^(?:subbot|slot)(\d{1,2})$/);
  if (!match) return null;

  const parsed = Number.parseInt(match[1], 10);
  if (parsed >= 1 && parsed <= maxSlots) {
    return parsed;
  }

  return null;
}

export function parseSubbotRequestArgs(args = [], maxSlots = 15) {
  const tokens = (Array.isArray(args) ? args : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  if (!tokens.length) {
    return { slot: null, number: "", invalid: false };
  }

  const slot = parseSlotToken(tokens[0], maxSlots);

  if (slot) {
    if (tokens.length === 1) {
      return { slot, number: "", invalid: false };
    }

    if (tokens.length === 2) {
      const number = normalizeNumber(tokens[1]);
      if (number) {
        return { slot, number, invalid: false };
      }
    }

    return { slot: null, number: "", invalid: true };
  }

  if (tokens.length === 1) {
    const number = normalizeNumber(tokens[0]);
    if (number) {
      return { slot: null, number, invalid: false };
    }
  }

  return { slot: null, number: "", invalid: true };
}

export function hasSubbotRuntime(runtime) {
  return Boolean(
    runtime?.requestBotPairingCode &&
      runtime?.listBots &&
      runtime?.getSubbotRequestState &&
      runtime?.setSubbotPublicRequests
  );
}

export function getSubbotQuoted(msg) {
  return msg?.key ? { quoted: msg } : undefined;
}
