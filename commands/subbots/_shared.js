import fs from "fs";
import path from "path";

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

export function formatMoment(value, fallback = "Sin registro") {
  const timestamp = normalizeTimestamp(value);
  if (!timestamp) {
    return fallback;
  }

  const diffMs = Date.now() - timestamp;
  const relative = diffMs >= 0
    ? `hace ${formatDuration(diffMs)}`
    : `en ${formatDuration(Math.abs(diffMs))}`;

  return `${formatDateTime(timestamp)} | ${relative}`;
}

export function maskSubbotNumber(value, fallback = "No configurado") {
  const digits = normalizeNumber(value);
  if (!digits) {
    return fallback;
  }

  if (digits.length <= 4) {
    return digits;
  }

  const visiblePrefix = digits.slice(0, Math.min(3, digits.length - 4));
  const visibleSuffix = digits.slice(-4);
  const hiddenCount = Math.max(2, digits.length - visiblePrefix.length - visibleSuffix.length);

  return `${visiblePrefix}${"*".repeat(hiddenCount)}${visibleSuffix}`;
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

export function getSubbotStatusTone(bot) {
  if (bot.connected) return "ACTIVO";
  if (bot.connecting) return "CONECTANDO";
  if (bot.pairingPending) return "EN ESPERA";
  if (bot.registered) return "VINCULADO";
  if (!bot.enabled) return "LIBRE";
  return "RESERVADO";
}

export function getSubbotActivityText(bot) {
  if (bot.connected) {
    return formatDuration(bot.connectedForMs || 0);
  }

  if (bot.connecting) {
    return "iniciando";
  }

  if (bot.pairingPending) {
    return "esperando codigo";
  }

  if (bot.registered) {
    return "sin conexion ahora";
  }

  if (!bot.enabled) {
    return "libre";
  }

  return "reservado";
}

function getAssignedSubbotNumber(bot) {
  return normalizeNumber(
    bot?.configuredNumber ||
      bot?.requesterNumber ||
      bot?.cachedPairingNumber ||
      bot?.lastPairingRequestNumber ||
      ""
  );
}

function getSubbotCompactLines(bot) {
  const assignedNumber = getAssignedSubbotNumber(bot);
  const lines = [
    `◆ [${bot.slot}] ${bot.label || `SUBBOT${bot.slot}`} | ${getSubbotStatusTone(bot)}`,
    `Nombre: ${bot.displayName}`,
    `Numero: ${assignedNumber || "Sin numero"}`,
    `Tiempo: ${getSubbotActivityText(bot)}`,
  ];

  if (bot.connected) {
    lines.push(`Desde: ${formatMoment(bot.connectedAt, "Sin conexion activa")}`);
    return lines;
  }

  if (bot.pairingPending || bot.connecting || (!bot.connected && bot.requestedAt)) {
    lines.push(`Solicitud: ${formatMoment(bot.requestedAt, "Sin solicitud reciente")}`);
    return lines;
  }

  if (bot.lastDisconnectAt) {
    lines.push(`Ultima salida: ${formatMoment(bot.lastDisconnectAt, "Sin desconexion reciente")}`);
    return lines;
  }

  return lines;
}

export function buildSubbotCard(bot, options = {}) {
  const compact = options?.compact !== false;
  const showSensitive = options?.showSensitive === true;
  const assignedNumber = getAssignedSubbotNumber(bot);

  if (compact) {
    return getSubbotCompactLines(bot).join("\n");
  }

  const lines = [
    `╭─ INFO SUBBOT ${bot.slot} ─`,
    `Estado: ${getSubbotStatusTone(bot)}`,
    `Nombre: ${bot.displayName}`,
    `Label: ${bot.label || `SUBBOT${bot.slot}`}`,
    `Numero actual: ${assignedNumber || "Sin numero"}`,
    `Tiempo activo: ${bot.connected ? formatDuration(bot.connectedForMs || 0) : "No activo ahora"}`,
    `Conectado desde: ${formatMoment(bot.connectedAt, "Sin conexion activa")}`,
    `Solicitud detectada: ${formatMoment(bot.requestedAt, "Sin solicitud reciente")}`,
    `Ultima salida: ${formatMoment(bot.lastDisconnectAt, "Sin desconexion reciente")}`,
    `Liberado: ${formatMoment(bot.releasedAt, "Sin liberar aun")}`,
    `╰────────────────`,
  ];

  if (showSensitive) {
    lines.push(`Solicitante: ${maskSubbotNumber(bot.requesterNumber, "Sin solicitante")}`);
    lines.push(`Numero vinculado: ${maskSubbotNumber(bot.configuredNumber, "No configurado")}`);
    lines.push(`Sesion: ${String(bot.authFolder || "Sin carpeta")}`);

    if (bot.cachedPairingCode) {
      lines.push(`Codigo en cache: ${bot.cachedPairingCode}`);
      lines.push(`Expira aprox: ${formatDuration(bot.cachedPairingExpiresInMs || 0)}`);
    }
  }

  return lines.join("\n");
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

export function buildSubbotMediaMessage(fileName, caption) {
  const imagePath = path.join(process.cwd(), "imagenes", fileName);

  if (fs.existsSync(imagePath)) {
    return {
      image: fs.readFileSync(imagePath),
      caption,
      ...global.channelInfo,
    };
  }

  return {
    text: caption,
    ...global.channelInfo,
  };
}
