import path from "path";
import {
  ensureDir as ensureDirectory,
  readJson as readJsonFile,
  writeJsonAtomic,
} from "../../lib/json-store.js";
import {
  normalizeJidDigits as normalizeCompatJidDigits,
  normalizeJidUser as normalizeCompatJidUser,
} from "../../lib/group-compat.js";
import {
  markProfileMutationFailure,
  markProfileMutationSuccess,
  shouldSkipProfileMutation,
} from "../../lib/profile-rate-limit.js";

const DB_DIR = path.join(process.cwd(), "database");

export function ensureDir(dirPath) {
  ensureDirectory(dirPath);
}

export function ensureDatabaseDir() {
  ensureDir(DB_DIR);
  return DB_DIR;
}

export function safeParseJson(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
  } catch {
    return fallback;
  }
}

export function readJson(filePath, fallback) {
  return readJsonFile(filePath, fallback);
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  writeJsonAtomic(filePath, value);
}

export function getQuoted(msg) {
  return msg?.key ? { quoted: msg } : undefined;
}

export function normalizeJidUser(value = "") {
  return normalizeCompatJidUser(value);
}

export function normalizeNumber(value = "") {
  return normalizeCompatJidDigits(value);
}

export function formatUserNumber(value = "") {
  const normalized = normalizeNumber(value);
  return normalized ? `+${normalized}` : "Desconocido";
}

export function extractTargetUser({ args = [], msg, sender = "", includeSenderFallback = false } = {}) {
  const rawArgs = Array.isArray(args) ? args : [];
  const firstToken = String(rawArgs[0] || "").trim();
  const argNumber = normalizeNumber(firstToken);

  if (argNumber) {
    return {
      jid: `${argNumber}@s.whatsapp.net`,
      number: argNumber,
      restArgs: rawArgs.slice(1),
    };
  }

  const quotedParticipant =
    msg?.quoted?.senderLid ||
    msg?.quoted?.senderPhone ||
    msg?.quoted?.sender ||
    msg?.quoted?.key?.participant ||
    msg?.quoted?.key?.participantAlt ||
    msg?.quoted?.key?.participantPn ||
    msg?.quoted?.key?.participantLid ||
    msg?.quoted?.participant ||
    msg?.quoted?.key?.remoteJid ||
    "";
  const quotedNumber = normalizeNumber(quotedParticipant);

  if (quotedNumber) {
    return {
      jid: `${quotedNumber}@s.whatsapp.net`,
      number: quotedNumber,
      restArgs: rawArgs,
    };
  }

  const senderNumber = normalizeNumber(sender);
  if (includeSenderFallback && senderNumber) {
    return {
      jid: `${senderNumber}@s.whatsapp.net`,
      number: senderNumber,
      restArgs: rawArgs,
    };
  }

  return {
    jid: "",
    number: "",
    restArgs: rawArgs,
  };
}

export function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }

  return String(settings?.prefix || ".").trim() || ".";
}

export function formatCooldownMs(ms = 0) {
  const totalSeconds = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function isProfileRateOverlimitError(error) {
  const detail = String(error?.message || error || "").trim().toLowerCase();
  return (
    detail.includes("rate-overlimit") ||
    detail.includes("rate overlimit") ||
    detail.includes("too many requests") ||
    detail.includes("429")
  );
}

export function guardProfileMutation(botId = "", operation = "", minIntervalMs = 0) {
  return shouldSkipProfileMutation(botId, operation, minIntervalMs);
}

export function noteProfileMutationSuccess(botId = "", operation = "") {
  return markProfileMutationSuccess(botId, operation);
}

export function noteProfileMutationFailure(botId = "", operation = "", error) {
  return markProfileMutationFailure(botId, operation, error);
}
