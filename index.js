// =========================
// FSOCIETY BOT - INDEX (MULTI BOT)
//OWNDER DVYER 
//LICENCIA CON DERECHOS (DVYER) 
//NO BORRAR DERECHOS YA QUE NO ERES CREADOR DE LA BASE RESPETA AL DUEÑO 
// =========================

import * as baileys from "@dvyer/baileys";
import pino from "pino";
import chalk from "chalk";
import dotenv from "dotenv";
import readline from "readline";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import { spawn } from "child_process";
import crypto from "crypto";
import { fileURLToPath, pathToFileURL } from "url";
import { buildDvyerUrl } from "./lib/api-manager.js";
import {
  recordWeeklyCommand,
  recordWeeklyMessage,
  getWeeklySnapshot,
} from "./lib/weekly.js";
import {
  recordCommandFailure,
  recordCommandSuccess,
  isCommandTemporarilyBlocked,
  getResilienceSnapshot,
  setResilienceConfig,
  clearResilienceCommand,
} from "./lib/resilience.js";
import {
  runAutoClean,
  getAutoCleanState,
  setAutoCleanConfig,
} from "./lib/autoclean.js";
import { cleanupManagedTempRoots } from "./lib/temp-cleanup.js";
import {
  findGroupParticipant as findCompatGroupParticipant,
  isGroupMetadataOwner as isCompatGroupMetadataOwner,
  normalizeJidDigits as normalizeCompatJidDigits,
  normalizeJidUser as normalizeCompatJidUser,
} from "./lib/group-compat.js";
import { applyStoredRuntimeVars } from "./lib/runtime-vars.js";
import { writeJsonAtomic as writeAtomicJsonFile } from "./lib/json-store.js";
import { getProviderGuardSnapshot } from "./lib/provider-guard.js";
import { assertSubbotCommandAllowed } from "./lib/subbot-download-policy.js";
import {
  markProfileMutationFailure,
  markProfileMutationSuccess,
  shouldSkipProfileMutation,
} from "./lib/profile-rate-limit.js";
import { touchEconomyProfile } from "./commands/economia/_shared.js";
import { setGroupBotDisabled } from "./commands/grupos/botgrupo.js";

dotenv.config();

const makeWASocket =
  (typeof baileys.makeWASocket === "function" && baileys.makeWASocket) ||
  (typeof baileys.default === "function" && baileys.default) ||
  (baileys.default &&
    typeof baileys.default.makeWASocket === "function" &&
    baileys.default.makeWASocket);

if (typeof makeWASocket !== "function") {
  throw new Error("makeWASocket no compatible con este hosting");
}

const {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  makeInMemoryStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = baileys;

// ================= CONFIG =================

const DEFAULT_AUTH_FOLDER = "dvyer-session";
const DEFAULT_SUBBOT_AUTH_FOLDER = "dvyer-session-subbot";
const DEFAULT_SUBBOT_SLOTS = 15;
const MAX_SUBBOT_SLOTS = 50;
const PAIRING_CODE_CACHE_MS = 60_000;
const PROCESS_RESTART_DELAY_MS = 3000;
const SETTINGS_SYNC_INTERVAL_MS = 4000;
const BOT_RUNTIME_STATE_TTL_MS = Math.max(
  60_000,
  parseNumberEnv("BOT_RUNTIME_STATE_TTL_MS", 120_000) || 120_000
);
const REMOTE_PAIRING_WAIT_MS = 18_000;
const PANEL_SUBBOT_CALLBACK_WAIT_MS = 90_000;
const PANEL_SUBBOT_CALLBACK_POLL_MS = 4_000;
const SESSION_REPLACED_BLOCK_MS = 15 * 60 * 1000;
const PROFILE_APPLY_DELAY_MS = 15 * 1000;
const PROFILE_AUTO_APPLY_COOLDOWN_MS = Math.max(
  30 * 60 * 1000,
  parseNumberEnv("PROFILE_AUTO_APPLY_COOLDOWN_MS", 6 * 60 * 60 * 1000) || 6 * 60 * 60 * 1000
);
const COMMAND_TIMEOUT_MS = 3 * 60 * 1000;
const DOWNLOAD_COMMAND_TIMEOUT_MS = 12 * 60 * 1000;
const HOOK_TIMEOUT_MS = 20 * 1000;
const PAIRING_SOCKET_WAIT_MS = 15 * 1000;
const PAIRING_REQUEST_TIMEOUT_MS = 25 * 1000;
const BOT_HEALTHCHECK_INTERVAL_MS = 30 * 1000;
const BOT_CONNECTING_STALE_MS = 2 * 60 * 1000;
const BOT_PAIRING_STALE_MS = 2 * 60 * 1000;
const BOT_DEGRADED_SOCKET_STALE_MS = 90 * 1000;
const SECONDARY_BOT_START_DELAY_MS = 2500;
const FATAL_ERROR_WINDOW_MS = 2 * 60 * 1000;
const FATAL_ERROR_THRESHOLD = 3;
const RECONNECT_JITTER_RATIO = 0.2;
const RECONNECT_BASE_DELAY_MS = 2500;
const RECONNECT_MAX_DELAY_MS = 45 * 1000;
const RECONNECT_CODE0_MIN_DELAY_MS = 6000;
const SUBBOT_RECONNECT_STAGGER_MS = 700;
const SUBBOT_RECONNECT_STAGGER_MAX_MS = 8000;
const CONNECTING_LOG_THROTTLE_MS = 8 * 1000;
const MESSAGE_UPSERT_LOG_THROTTLE_MS = 12 * 1000;
const MESSAGE_UPSERT_SUMMARY_MIN_COUNT = 10;
const CONTACT_NAME_CACHE_TTL_MS = 10 * 60 * 1000;
const CONTACT_NAME_CACHE_MAX_ENTRIES = 3000;
const APPEND_UPSERT_RECENT_WINDOW_MS = 3 * 60 * 1000;
const MESSAGE_DEDUP_TTL_MS = 10 * 60 * 1000;
const MESSAGE_DEDUP_MAX_ENTRIES = 4000;
const DEFAULT_PAIRING_COUNTRY_CODE = String(
  process.env.PAIRING_COUNTRY_CODE || process.env.DEFAULT_COUNTRY_CODE || "51"
)
  .replace(/\D/g, "")
  .slice(0, 4);
const logger = pino({ level: "silent" });
const FIXED_BROWSER = ["Windows", "Chrome", "114.0.5735.198"];

applyStoredRuntimeVars();

const settings = JSON.parse(
  fs.readFileSync("./settings/settings.json", "utf-8")
);

const INTERNAL_WEBHOOK_TOKEN = String(
  process.env.INTERNAL_WEBHOOK_TOKEN || process.env.BOT_WEBHOOK_TOKEN || ""
).trim();
const PANEL_CALLBACK_URL = (() => {
  const explicitUrl = String(process.env.PANEL_CALLBACK_URL || "").trim();

  if (explicitUrl) {
    return explicitUrl;
  }

  const panelBaseUrl = String(process.env.PANEL_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");

  return panelBaseUrl ? `${panelBaseUrl}/api/bot/pairing` : "";
})();
const PANEL_CALLBACK_TOKEN = String(
  process.env.PANEL_CALLBACK_TOKEN ||
    process.env.PANEL_BOT_API_TOKEN ||
    process.env.BOT_API_TOKEN ||
    ""
).trim();
const INTERNAL_ALLOWED_IPS = new Set(
  String(process.env.INTERNAL_WEBHOOK_ALLOWED_IPS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
);
const DASHBOARD_TOKEN = String(process.env.DASHBOARD_TOKEN || "").trim();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETTINGS_FILE = path.join(__dirname, "settings", "settings.json");
const DATABASE_DIR = path.join(process.cwd(), "database");
const USAGE_STATS_FILE = path.join(DATABASE_DIR, "usage-stats.json");
const RUNTIME_DIR = path.join(DATABASE_DIR, "runtime");
const BOT_RUNTIME_STATE_DIR = path.join(RUNTIME_DIR, "bot-states");
const RUNTIME_LOG_DIR = path.join(RUNTIME_DIR, "logs");
const STRUCTURED_LOG_FILE = path.join(RUNTIME_LOG_DIR, "events.ndjson");
const GROUP_COMMAND_CLAIM_DIR = path.join(RUNTIME_DIR, "group-command-claims");
const GROUP_UPDATE_CLAIM_DIR = path.join(RUNTIME_DIR, "group-update-claims");

function normalizeProcessBotId(value = "") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (!normalized || normalized === "all" || normalized === "*") {
    return "all";
  }

  if (normalized === "main" || normalized === "principal") {
    return "main";
  }

  const slotMatch = normalized.match(/^(?:subbot|slot)?(\d{1,2})$/);
  if (slotMatch) {
    return `subbot${Number.parseInt(slotMatch[1], 10)}`;
  }

  const compact = normalized.replace(/[-_\s]/g, "");
  if (/^subbot\d{1,2}$/.test(compact)) {
    return compact;
  }

  return "all";
}

function isManagedHostingEnvironment(env = process.env) {
  return Boolean(
    env?.RAILWAY_ENVIRONMENT ||
      env?.RENDER ||
      env?.PTERODACTYL_SERVER_UUID ||
      env?.SERVER_ID ||
      env?.KOYEB_SERVICE_NAME ||
      env?.DYNO
  );
}

function isPm2Environment(env = process.env) {
  return Boolean(env?.pm_id || env?.PM2_HOME);
}

function detectProcessBotIdFromPm2Name(env = process.env) {
  const rawName = String(env?.name || env?.pm_name || "").trim().toLowerCase();
  if (!rawName) return "all";

  const normalizedName = rawName
    .replace(/^dvyer[-_\s]*/, "")
    .replace(/^bot[-_\s]*/, "");

  const direct = normalizeProcessBotId(normalizedName);
  if (direct !== "all") {
    return direct;
  }

  const slotMatch = rawName.match(/subbot[-_\s]?(\d{1,2})$/);
  if (slotMatch) {
    return `subbot${Number.parseInt(slotMatch[1], 10)}`;
  }

  if (rawName.endsWith("main")) {
    return "main";
  }

  return "all";
}

function resolveProcessRuntime(env = process.env) {
  const explicitBotId = normalizeProcessBotId(
    env?.BOT_ID || env?.BOT_INSTANCE || env?.DVYER_BOT_ID || "all"
  );

  if (explicitBotId !== "all") {
    return {
      processBotId: explicitBotId,
      splitProcessMode: true,
      modeLabel: `SEPARADO (${explicitBotId})`,
      autoDetected: false,
    };
  }

  if (isManagedHostingEnvironment(env)) {
    return {
      processBotId: "all",
      splitProcessMode: false,
      modeLabel: "AUTO HOSTING (UNICO)",
      autoDetected: true,
    };
  }

  if (isPm2Environment(env)) {
    const pm2BotId = detectProcessBotIdFromPm2Name(env);
    if (pm2BotId !== "all") {
      return {
        processBotId: pm2BotId,
        splitProcessMode: true,
        modeLabel: `AUTO VPS (${pm2BotId})`,
        autoDetected: true,
      };
    }
  }

  return {
    processBotId: "all",
    splitProcessMode: false,
    modeLabel: isPm2Environment(env) ? "PM2 UNICO" : "UNICO",
    autoDetected: true,
  };
}

const PROCESS_RUNTIME = resolveProcessRuntime(process.env);
const PROCESS_BOT_ID = PROCESS_RUNTIME.processBotId;
const SPLIT_PROCESS_MODE = PROCESS_RUNTIME.splitProcessMode;
const PROCESS_MODE_LABEL = PROCESS_RUNTIME.modeLabel;

function clampSubbotSlots(value) {
  const parsed = Number(value || 0);

  if (!Number.isFinite(parsed)) {
    return DEFAULT_SUBBOT_SLOTS;
  }

  return Math.max(1, Math.min(MAX_SUBBOT_SLOTS, Math.floor(parsed)));
}

function getConfiguredSubbotSlotsCount(currentSettings) {
  return clampSubbotSlots(currentSettings?.subbot?.maxSlots || DEFAULT_SUBBOT_SLOTS);
}

function normalizeMaintenanceMode(value) {
  const normalized = String(value || "off").trim().toLowerCase();

  if (normalized === "on" || normalized === "owner" || normalized === "owner_only") {
    return "owner_only";
  }

  if (
    normalized === "downloads" ||
    normalized === "downloads_off" ||
    normalized === "descargas"
  ) {
    return "downloads_off";
  }

  return "off";
}

function normalizeErrorVisibilityMode(value) {
  const normalized = String(value || "off").trim().toLowerCase();

  if (["on", "visible", "user", "public"].includes(normalized)) {
    return "user";
  }

  if (["owner", "debug", "full", "detallado"].includes(normalized)) {
    return "owner";
  }

  return "off";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getDefaultSubbotAuthFolder(slotNumber) {
  return slotNumber === 1
    ? DEFAULT_SUBBOT_AUTH_FOLDER
    : `${DEFAULT_SUBBOT_AUTH_FOLDER}-${slotNumber}`;
}

function getDefaultSubbotLabel(slotNumber) {
  return `SUBBOT${slotNumber}`;
}

function getDefaultSubbotName(currentSettings, slotNumber) {
  return `${currentSettings?.botName || "DVYER"} Subbot ${slotNumber}`;
}

function normalizeTimestamp(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeSubbotSlotConfig(
  slotConfig,
  slotNumber,
  currentSettings,
  legacySubbot = {}
) {
  const source = isPlainObject(slotConfig) ? slotConfig : {};
  const fallback = slotNumber === 1 && isPlainObject(legacySubbot)
    ? legacySubbot
    : {};

  const enabled =
    typeof source.enabled === "boolean"
      ? source.enabled
      : typeof fallback.enabled === "boolean"
        ? fallback.enabled
        : slotNumber === 1;

  const label =
    String(
      source.label ||
        fallback.label ||
        getDefaultSubbotLabel(slotNumber)
    )
      .trim()
      .toUpperCase() || getDefaultSubbotLabel(slotNumber);

  const name =
    String(
      source.name ||
        fallback.name ||
        getDefaultSubbotName(currentSettings, slotNumber)
    ).trim() || getDefaultSubbotName(currentSettings, slotNumber);

  const authFolder =
    String(
      source.authFolder ||
        fallback.authFolder ||
        getDefaultSubbotAuthFolder(slotNumber)
    ).trim() || getDefaultSubbotAuthFolder(slotNumber);

  const pairingNumber =
    sanitizePhoneNumber(
      source.pairingNumber ||
        source.botNumber ||
        fallback.pairingNumber ||
        fallback.botNumber ||
        ""
    ) || "";

  const requesterNumber =
    sanitizePhoneNumber(
      source.requesterNumber ||
        source.ownerNumber ||
        fallback.requesterNumber ||
        fallback.ownerNumber ||
        pairingNumber
    ) || "";

  const requesterJid =
    String(
      source.requesterJid ||
        source.ownerJid ||
        fallback.requesterJid ||
        fallback.ownerJid ||
        ""
    ).trim() || "";

  const requestedAt = normalizeTimestamp(
    source.requestedAt || fallback.requestedAt || 0
  );

  const releasedAt = normalizeTimestamp(
    source.releasedAt || fallback.releasedAt || 0
  );

  return {
    slot: slotNumber,
    id: `subbot${slotNumber}`,
    enabled,
    label,
    name,
    authFolder,
    pairingNumber,
    requesterNumber,
    requesterJid,
    requestedAt,
    releasedAt,
  };
}

function buildSubbotSlotConfigs(currentSettings) {
  const legacySubbot = isPlainObject(currentSettings?.subbot)
    ? currentSettings.subbot
    : {};
  const rawSlots = Array.isArray(currentSettings?.subbots)
    ? currentSettings.subbots
    : [];
  const slotCount = getConfiguredSubbotSlotsCount(currentSettings);

  return Array.from({ length: slotCount }, (_, index) =>
    normalizeSubbotSlotConfig(
      rawSlots[index],
      index + 1,
      currentSettings,
      legacySubbot
    )
  );
}

function ensureSubbotSettings(currentSettings) {
  if (!isPlainObject(currentSettings?.subbot)) {
    currentSettings.subbot = {};
  }

  if (typeof currentSettings.subbot.publicRequests !== "boolean") {
    currentSettings.subbot.publicRequests = true;
  }

  currentSettings.subbot.maxSlots = getConfiguredSubbotSlotsCount(currentSettings);

  currentSettings.subbots = buildSubbotSlotConfigs(currentSettings).map((slot) => ({
    slot: slot.slot,
    enabled: slot.enabled,
    label: slot.label,
    name: slot.name,
    authFolder: slot.authFolder,
    pairingNumber: slot.pairingNumber,
    requesterNumber: slot.requesterNumber,
    requesterJid: slot.requesterJid,
    requestedAt: slot.requestedAt,
    releasedAt: slot.releasedAt,
  }));
}

function ensureSystemSettings(currentSettings) {
  if (!isPlainObject(currentSettings?.system)) {
    currentSettings.system = {};
  }

  currentSettings.system.maintenanceMode = normalizeMaintenanceMode(
    currentSettings.system.maintenanceMode
  );
  currentSettings.system.maintenanceMessage =
    String(currentSettings.system.maintenanceMessage || "").trim().slice(0, 240);
  currentSettings.system.autoProfileOnConnect = currentSettings.system.autoProfileOnConnect !== false;
  currentSettings.system.mainBotBio =
    String(currentSettings.system.mainBotBio || `Ya conectado bot ${currentSettings?.botName || "Fsociety bot"}`)
      .trim()
      .slice(0, 139);
  currentSettings.system.mainBotPhoto = String(currentSettings.system.mainBotPhoto || "").trim();
  currentSettings.system.subbotBioTemplate =
    String(currentSettings.system.subbotBioTemplate || "Subbot Fsociety activo")
      .trim()
      .slice(0, 139);
  currentSettings.system.subbotPhoto = String(currentSettings.system.subbotPhoto || "").trim();
  if (!isPlainObject(currentSettings.system.autoJoinGroups)) {
    currentSettings.system.autoJoinGroups = {};
  }
  currentSettings.system.autoJoinGroups.enabled =
    currentSettings.system.autoJoinGroups.enabled !== false;
  currentSettings.system.autoJoinGroups.mainInvite = normalizeInviteCode(
    currentSettings.system.autoJoinGroups.mainInvite || ""
  );
  currentSettings.system.autoJoinGroups.subbotInvite = normalizeInviteCode(
    currentSettings.system.autoJoinGroups.subbotInvite || ""
  );
  currentSettings.system.errorVisibilityMode = normalizeErrorVisibilityMode(
    currentSettings.system.errorVisibilityMode
  );
  if (!isPlainObject(currentSettings.system.subbotDownloads)) {
    currentSettings.system.subbotDownloads = {};
  }
  currentSettings.system.subbotDownloads.enabled =
    currentSettings.system.subbotDownloads.enabled !== false;
  currentSettings.system.subbotDownloads.maxBytes = Math.max(
    1 * 1024 * 1024,
    Math.min(
      200 * 1024 * 1024,
      Math.floor(
        Number(currentSettings.system.subbotDownloads.maxBytes || 35 * 1024 * 1024)
      )
    )
  );
  currentSettings.system.subbotDownloads.vipUnlimited =
    currentSettings.system.subbotDownloads.vipUnlimited !== false;
  currentSettings.system.subbotDownloads.blockedCommands = Array.isArray(
    currentSettings.system.subbotDownloads.blockedCommands
  )
    ? currentSettings.system.subbotDownloads.blockedCommands
        .map((item) => String(item || "").trim().toLowerCase())
        .filter(Boolean)
    : [];

  if (!isPlainObject(currentSettings.system.economy)) {
    currentSettings.system.economy = {};
  }

  currentSettings.system.economy.downloadBillingEnabled =
    currentSettings.system.economy.downloadBillingEnabled === true;
  currentSettings.system.economy.dailyDownloadRequests = Math.max(
    0,
    Math.min(5000, Math.floor(Number(currentSettings.system.economy.dailyDownloadRequests || 50)))
  );
  currentSettings.system.economy.requestPrice = Math.max(
    1,
    Math.min(100000, Math.floor(Number(currentSettings.system.economy.requestPrice || 25)))
  );
}

function saveSettingsFile() {
  writeAtomicJsonFile(SETTINGS_FILE, settings);
}

function refreshChannelInfo() {
  global.channelInfo = settings?.newsletter?.enabled
    ? {
        contextInfo: {
          forwardingScore: 999,
          isForwarded: true,
          forwardedNewsletterMessageInfo: {
            newsletterJid: settings.newsletter.jid,
            newsletterName: settings.newsletter.name,
            serverMessageId: -1,
          },
        },
      }
    : {};
}

ensureSubbotSettings(settings);
ensureSystemSettings(settings);

// ================= INFO CHANNEL =================

refreshChannelInfo();

// ================= TMP =================

const TMP_DIR = path.join(process.cwd(), "tmp");

try {
  if (!fs.existsSync(DATABASE_DIR)) {
    fs.mkdirSync(DATABASE_DIR, { recursive: true });
  }
  if (!fs.existsSync(RUNTIME_DIR)) {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  }
  if (!fs.existsSync(BOT_RUNTIME_STATE_DIR)) {
    fs.mkdirSync(BOT_RUNTIME_STATE_DIR, { recursive: true });
  }
  if (!fs.existsSync(GROUP_COMMAND_CLAIM_DIR)) {
    fs.mkdirSync(GROUP_COMMAND_CLAIM_DIR, { recursive: true });
  }
  if (!fs.existsSync(GROUP_UPDATE_CLAIM_DIR)) {
    fs.mkdirSync(GROUP_UPDATE_CLAIM_DIR, { recursive: true });
  }
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
} catch {}

process.env.TMPDIR = TMP_DIR;
process.env.TMP = TMP_DIR;
process.env.TEMP = TMP_DIR;

// ================= UTIL =================

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBotSlot(botId = "") {
  const match = String(botId || "")
    .trim()
    .toLowerCase()
    .match(/^subbot(\d{1,2})$/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function sanitizePhoneNumber(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeIdentityKeys(value = "") {
  const output = new Set();
  const raw = String(value || "").trim();
  if (!raw) return output;

  const normalizedUser = String(normalizeJidUser(raw) || "")
    .trim()
    .toLowerCase();
  if (normalizedUser) {
    output.add(normalizedUser);
  }

  const normalizedDigits =
    String(normalizeCompatJidDigits(raw) || "").trim() || sanitizePhoneNumber(raw);
  if (normalizedDigits) {
    output.add(normalizedDigits);
  }

  return output;
}

function buildGroupParticipantIdentitySet(metadata = {}) {
  const identities = new Set();
  const participants = Array.isArray(metadata?.participants) ? metadata.participants : [];

  for (const participant of participants) {
    const values = [
      participant,
      participant?.id,
      participant?.lid,
      participant?.jid,
      participant?.participant,
      participant?.participantAlt,
      participant?.participantPn,
      participant?.participantLid,
      participant?.phoneNumber,
      participant?.phone_number,
    ];

    for (const value of values) {
      for (const key of normalizeIdentityKeys(value)) {
        identities.add(key);
      }
    }
  }

  return identities;
}

function buildBotIdentitySet(summary = {}) {
  const identities = new Set();
  const values = [
    summary?.waNumber,
    summary?.configuredNumber,
  ];

  for (const value of values) {
    for (const key of normalizeIdentityKeys(value)) {
      identities.add(key);
    }
  }

  return identities;
}

function buildBotLiveIdentitySet(summary = {}) {
  const identities = new Set();
  for (const key of normalizeIdentityKeys(summary?.waNumber)) {
    identities.add(key);
  }
  return identities;
}

function isSummaryRuntimeReady(summary = {}) {
  return Boolean(
    summary?.connected ||
      summary?.hasSocket ||
      summary?.connectionState === "open" ||
      summary?.connecting
  );
}

function setsIntersect(left = new Set(), right = new Set()) {
  if (!(left instanceof Set) || !(right instanceof Set) || !left.size || !right.size) {
    return false;
  }

  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const value of small) {
    if (large.has(value)) {
      return true;
    }
  }

  return false;
}

function resolveLinkedIdentityLeaderBotId(targetBotId = "") {
  const normalizedTargetId = String(targetBotId || "")
    .trim()
    .toLowerCase();
  if (!normalizedTargetId) return "";

  const targetConfig = getBotConfigById(normalizedTargetId);
  if (!targetConfig) return normalizedTargetId;
  const targetSummary = summarizeBotConfig(targetConfig);
  const targetIdentities = buildBotLiveIdentitySet(targetSummary);
  if (!targetIdentities.size) return normalizedTargetId;

  const candidates = [];
  const allConfigs = [buildMainBotConfig(settings), ...(SUBBOT_SLOT_CONFIGS || [])];
  for (const config of allConfigs) {
    if (!config?.id) continue;
    const summary = summarizeBotConfig(config);
    if (!summary?.id) continue;
    if (summary?.enabled === false) continue;
    if (!isSummaryRuntimeReady(summary)) continue;

    const candidateIdentities = buildBotLiveIdentitySet(summary);
    if (!setsIntersect(targetIdentities, candidateIdentities)) continue;

    const normalizedCandidateId = String(summary.id || "")
      .trim()
      .toLowerCase();
    candidates.push({
      botId: normalizedCandidateId,
      priority: getBotGroupCommandPriority(normalizedCandidateId),
      slot: Number(summary?.slot || getBotSlot(normalizedCandidateId) || 0),
    });
  }

  if (!candidates.length) return normalizedTargetId;

  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.slot !== b.slot) return a.slot - b.slot;
    return String(a.botId).localeCompare(String(b.botId));
  });

  return String(candidates[0]?.botId || normalizedTargetId).trim().toLowerCase();
}

function shouldCurrentBotHandleLinkedIdentity(botState) {
  const botId = String(botState?.config?.id || "main")
    .trim()
    .toLowerCase();
  const leaderBotId = resolveLinkedIdentityLeaderBotId(botId);
  if (!leaderBotId) {
    return { allowed: true, reason: "leader_unknown" };
  }

  return {
    allowed: leaderBotId === botId,
    reason: leaderBotId === botId ? "linked_identity_leader" : "linked_identity_shadow",
    leaderBotId,
  };
}

function isBotPresentInGroup(metadata = {}, summary = {}) {
  const participantIdentitySet = buildGroupParticipantIdentitySet(metadata);
  if (!participantIdentitySet.size) return false;

  // Importante: solo usamos identidad WA real en vivo para evitar
  // falsos positivos con numeros configurados de owners/requesters.
  const botIdentitySet = buildBotLiveIdentitySet(summary);
  if (!botIdentitySet.size) return false;

  for (const identity of botIdentitySet) {
    if (participantIdentitySet.has(identity)) {
      return true;
    }
  }

  return false;
}

function resolveGroupCommandLeaderBotId(metadata = {}) {
  const participants = Array.isArray(metadata?.participants) ? metadata.participants : [];
  if (!participants.length) return "";

  const mainSummary = summarizeBotConfig(buildMainBotConfig(settings));
  if (isSummaryRuntimeReady(mainSummary) && isBotPresentInGroup(metadata, mainSummary)) {
    return "main";
  }

  const candidates = [];
  for (const config of SUBBOT_SLOT_CONFIGS || []) {
    if (config?.enabled === false) continue;
    const summary = summarizeBotConfig(config);
    const slot = Number(summary?.slot || config?.slot || 0);
    if (!summary?.id || slot < 1) continue;
    if (!isSummaryRuntimeReady(summary)) continue;
    if (!isBotPresentInGroup(metadata, summary)) continue;
    candidates.push({
      botId: String(summary.id || "").trim().toLowerCase(),
      slot,
    });
  }

  candidates.sort((a, b) => a.slot - b.slot);
  return String(candidates?.[0]?.botId || "").trim().toLowerCase();
}

function shouldCurrentBotHandleGroupCommand(botState, metadata = null) {
  const botId = String(botState?.config?.id || "main")
    .trim()
    .toLowerCase();
  const participants = Array.isArray(metadata?.participants) ? metadata.participants : [];
  if (!participants.length) {
    return { allowed: true, reason: "missing_metadata" };
  }

  const leaderBotId = resolveGroupCommandLeaderBotId(metadata);
  if (!leaderBotId) {
    return { allowed: true, reason: "leader_unknown" };
  }

  return {
    allowed: leaderBotId === botId,
    reason: leaderBotId === botId ? "leader" : "not_leader",
    leaderBotId,
  };
}

function normalizePairingPhoneNumber(value) {
  let digits = sanitizePhoneNumber(value);
  if (!digits) return "";

  if (digits.startsWith("00") && digits.length > 2) {
    digits = digits.slice(2);
  }

  if (digits.startsWith("0") && digits.length >= 10) {
    digits = digits.replace(/^0+/, "");
  }

  if (digits.length === 9 && DEFAULT_PAIRING_COUNTRY_CODE) {
    digits = `${DEFAULT_PAIRING_COUNTRY_CODE}${digits}`;
  }

  if (digits.length < 10 || digits.length > 15) {
    return "";
  }

  return digits;
}

function resolveConfiguredBotName(config = {}) {
  if (String(config?.id || "").toLowerCase() === "main") {
    return String(settings?.botName || "Fsociety bot").trim() || "Fsociety bot";
  }

  const slot = getBotSlot(config?.id || config?.slot);
  const slotConfig =
    slot >= 1 && Array.isArray(settings?.subbots) ? settings.subbots[slot - 1] : null;

  return (
    String(slotConfig?.name || config?.displayName || `Fsociety Subbot ${slot || 1}`)
      .trim() || `Fsociety Subbot ${slot || 1}`
  );
}

function resolveConfiguredBotBio(config = {}) {
  ensureSystemSettings(settings);

  if (String(config?.id || "").toLowerCase() === "main") {
    return (
      String(settings?.system?.mainBotBio || `Ya conectado bot ${resolveConfiguredBotName(config)}`)
        .trim()
        .slice(0, 139) || `Ya conectado bot ${resolveConfiguredBotName(config)}`
    );
  }

  const slot = getBotSlot(config?.id || config?.slot);
  const slotConfig =
    slot >= 1 && Array.isArray(settings?.subbots) ? settings.subbots[slot - 1] : null;

  return (
    String(slotConfig?.bio || settings?.system?.subbotBioTemplate || "Subbot Fsociety activo")
      .trim()
      .slice(0, 139) || "Subbot Fsociety activo"
  );
}

function resolveConfiguredBotPhoto(config = {}) {
  ensureSystemSettings(settings);

  if (String(config?.id || "").toLowerCase() === "main") {
    return String(settings?.system?.mainBotPhoto || "").trim();
  }

  const slot = getBotSlot(config?.id || config?.slot);
  const slotConfig =
    slot >= 1 && Array.isArray(settings?.subbots) ? settings.subbots[slot - 1] : null;

  return String(slotConfig?.photo || settings?.system?.subbotPhoto || "").trim();
}

function resolveLocalProfilePhotoPath(input = "") {
  const rawInput = String(input || "").trim();
  if (!rawInput || /^https?:\/\//i.test(rawInput)) {
    return null;
  }

  const basePath = path.isAbsolute(rawInput) ? rawInput : path.join(process.cwd(), rawInput);
  const extension = path.extname(basePath).toLowerCase();
  const candidates = extension
    ? [basePath]
    : [".jpg", ".jpeg", ".png", ".webp"].map((suffix) => `${basePath}${suffix}`);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function resolveBotProfilePhotoSource(config = {}) {
  const input = resolveConfiguredBotPhoto(config);
  if (!input) return null;

  if (/^https?:\/\//i.test(input)) {
    const response = await fetch(input, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });

    if (!response.ok) {
      throw new Error(`No pude descargar la foto de perfil (${response.status}).`);
    }

    const tempFile = path.join(TMP_DIR, `auto-profile-${Date.now()}.jpg`);
    fs.writeFileSync(tempFile, Buffer.from(await response.arrayBuffer()));
    return {
      path: tempFile,
      temporary: true,
    };
  }

  const localPath = resolveLocalProfilePhotoPath(input);
  if (!localPath || !fs.existsSync(localPath)) {
    throw new Error("La ruta local de la foto de perfil no existe o no encontre una imagen compatible.");
  }

  return {
    path: localPath,
    temporary: false,
  };
}

async function applyConfiguredBotProfile(botState, sock) {
  ensureSystemSettings(settings);

  if (!settings?.system?.autoProfileOnConnect || !sock?.user?.id) {
    return;
  }

  const desiredName = resolveConfiguredBotName(botState?.config);
  const desiredBio = resolveConfiguredBotBio(botState?.config);
  const desiredPhoto = resolveConfiguredBotPhoto(botState?.config);
  const signature = JSON.stringify({
    desiredName,
    desiredBio,
    desiredPhoto,
  });

  if (
    botState?.lastProfileSignature === signature &&
    Date.now() - Number(botState?.lastProfileAppliedAt || 0) < 10 * 60 * 1000
  ) {
    return;
  }

  let hadAppStateError = false;
  const mutationBotId = String(botState?.config?.id || "main").trim().toLowerCase() || "main";
  const captureProfileError = (kind, error) => {
    const detail = String(error?.message || error || "").trim();
    if (!detail) return;
    const normalizedDetail = detail.toLowerCase();

    if (/app state key not present/i.test(detail)) {
      hadAppStateError = true;
      return;
    }

    if (kind === "foto" && /no image processing library available/i.test(detail)) {
      // En hosting sin libreria de imagen esta advertencia es esperada; la omitimos para evitar ruido.
      return;
    }

    if (
      normalizedDetail.includes("rate-overlimit") ||
      normalizedDetail.includes("rate overlimit") ||
      normalizedDetail.includes("too many requests") ||
      normalizedDetail.includes("http 429")
    ) {
      return;
    }

    if (kind === "nombre") {
      markProfileMutationFailure(mutationBotId, "name", error);
    } else if (kind === "bio") {
      markProfileMutationFailure(mutationBotId, "status", error);
    } else if (kind === "foto") {
      markProfileMutationFailure(mutationBotId, "photo", error);
    }

    logBotEvent(botState, "warn", `No pude actualizar ${kind} del perfil: ${detail}`);
  };

  if (typeof sock.updateProfileName === "function" && desiredName) {
    const cooldown = shouldSkipProfileMutation(
      mutationBotId,
      "name",
      PROFILE_AUTO_APPLY_COOLDOWN_MS
    );
    if (!cooldown.skip) {
      try {
        await sock.updateProfileName(desiredName);
        markProfileMutationSuccess(mutationBotId, "name");
      } catch (error) {
        captureProfileError("nombre", error);
      }
    }
  }

  if (typeof sock.updateProfileStatus === "function" && desiredBio) {
    const cooldown = shouldSkipProfileMutation(
      mutationBotId,
      "status",
      PROFILE_AUTO_APPLY_COOLDOWN_MS
    );
    if (!cooldown.skip) {
      try {
        await sock.updateProfileStatus(desiredBio);
        markProfileMutationSuccess(mutationBotId, "status");
      } catch (error) {
        captureProfileError("bio", error);
      }
    }
  }

  if (typeof sock.updateProfilePicture === "function" && desiredPhoto) {
    let photoSource = null;
    const cooldown = shouldSkipProfileMutation(
      mutationBotId,
      "photo",
      PROFILE_AUTO_APPLY_COOLDOWN_MS
    );

    try {
      if (!cooldown.skip) {
        photoSource = await resolveBotProfilePhotoSource(botState?.config);
        if (photoSource?.path) {
          await sock.updateProfilePicture(sock.user.id, { url: photoSource.path });
          markProfileMutationSuccess(mutationBotId, "photo");
        }
      }
    } catch (error) {
      captureProfileError("foto", error);
    } finally {
      if (photoSource?.temporary) {
        try {
          fs.rmSync(photoSource.path, { force: true });
        } catch {}
      }
    }
  }

  if (hadAppStateError) {
    return;
  }

  botState.lastProfileSignature = signature;
  botState.lastProfileAppliedAt = Date.now();
}

function scheduleProfileApply(botState, sock, delayMs = PROFILE_APPLY_DELAY_MS) {
  if (!botState || !sock) return;

  clearProfileApplyTimer(botState);
  botState.profileApplyTimer = setTimeout(() => {
    botState.profileApplyTimer = null;
    applyConfiguredBotProfile(botState, sock).catch((error) => {
      console.log(`${getBotTag(botState)} No pude aplicar el perfil automatico: ${error?.message || error}`);
    });
  }, Math.max(1000, Number(delayMs || PROFILE_APPLY_DELAY_MS)));

  botState.profileApplyTimer.unref?.();
}

function runPm2Command(args = [], extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(getPm2Executable(), args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk || "");
    });

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk || "");
    });

    child.on("error", (error) => {
      resolve({
        ok: false,
        code: -1,
        stdout,
        stderr,
        error,
      });
    });

    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        code: Number(code || 0),
        stdout,
        stderr,
      });
    });
  });
}

function normalizeJidUser(value = "") {
  return normalizeCompatJidUser(value);
}

function tipoChat(jid = "") {
  if (jid.endsWith("@g.us")) return "Grupo";
  if (jid.endsWith("@s.whatsapp.net")) return "Privado";
  return "Desconocido";
}

function shouldIgnoreJid(jid = "") {
  return (
    !jid ||
    jid === "status@broadcast" ||
    jid.endsWith("@broadcast") ||
    jid.endsWith("@newsletter")
  );
}

function normalizeMessageContent(message = {}) {
  let content = message;

  while (true) {
    if (content?.ephemeralMessage?.message) {
      content = content.ephemeralMessage.message;
      continue;
    }
    if (content?.viewOnceMessage?.message) {
      content = content.viewOnceMessage.message;
      continue;
    }
    if (content?.viewOnceMessageV2?.message) {
      content = content.viewOnceMessageV2.message;
      continue;
    }
    if (content?.viewOnceMessageV2Extension?.message) {
      content = content.viewOnceMessageV2Extension.message;
      continue;
    }
    break;
  }

  return content || {};
}

function obtenerTexto(message) {
  const msg = normalizeMessageContent(message);
  let interactiveSelectedId = "";

  function extractSelectedId(value) {
    if (!value) return "";

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return "";

      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          return extractSelectedId(JSON.parse(trimmed));
        } catch {}
      }

      return "";
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const selectedId = extractSelectedId(item);
        if (selectedId) return selectedId;
      }
      return "";
    }

    if (typeof value === "object") {
      const directKeys = [
        "id",
        "selectedId",
        "selectedID",
        "selectedRowId",
        "selected_row_id",
        "selectedButtonId",
        "selected_button_id",
        "selectedItemId",
        "selected_item_id",
      ];

      for (const key of directKeys) {
        const selectedId = String(value?.[key] || "").trim();
        if (selectedId) return selectedId;
      }

      const nestedKeys = [
        "singleSelectReply",
        "single_select_reply",
        "listResponse",
        "list_response",
        "response_json",
        "buttonParamsJson",
        "paramsJson",
        "nativeFlowResponseMessage",
      ];

      for (const key of nestedKeys) {
        const selectedId = extractSelectedId(value?.[key]);
        if (selectedId) return selectedId;
      }
    }

    return "";
  }

  try {
    const rawParams =
      msg?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
      msg?.interactiveResponseMessage?.paramsJson ||
      "";

    if (rawParams) {
      interactiveSelectedId = extractSelectedId(rawParams);
    }
  } catch {}

  return (
    msg?.conversation ||
    msg?.extendedTextMessage?.text ||
    msg?.imageMessage?.caption ||
    msg?.videoMessage?.caption ||
    msg?.documentMessage?.caption ||
    interactiveSelectedId ||
    msg?.buttonsResponseMessage?.selectedButtonId ||
    msg?.templateButtonReplyMessage?.selectedId ||
    msg?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    msg?.buttonsResponseMessage?.selectedDisplayText ||
    msg?.listResponseMessage?.title ||
    ""
  );
}

function getContextInfo(message = {}) {
  const msg = normalizeMessageContent(message);
  const type = Object.keys(msg || {})[0];
  if (!type) return {};
  return msg?.[type]?.contextInfo || {};
}

function serializeMessage(raw) {
  const message = normalizeMessageContent(raw?.message || {});
  const text = String(obtenerTexto(message) || "").trim();
  const contextInfo = getContextInfo(raw?.message || {});
  const from = raw?.key?.remoteJid || "";
  const keyParticipant = String(raw?.key?.participant || "").trim();
  const keyParticipantAlt = String(
    raw?.key?.participantAlt || raw?.key?.remoteJidAlt || ""
  ).trim();
  const contextParticipant = String(contextInfo?.participant || "").trim();
  const contextParticipantAlt = String(
    contextInfo?.participantAlt || contextInfo?.participantPn || ""
  ).trim();
  const sender =
    keyParticipant ||
    contextParticipant ||
    raw?.key?.remoteJid ||
    "";
  const senderPhone =
    String(raw?.key?.participantPn || raw?.key?.senderPn || "").trim() ||
    keyParticipantAlt ||
    contextParticipantAlt ||
    (String(sender).endsWith("@s.whatsapp.net") ? String(sender) : "");
  const senderLid =
    String(raw?.key?.participantLid || raw?.key?.senderLid || "").trim() ||
    (String(sender).endsWith("@lid") ? String(sender) : "") ||
    (keyParticipantAlt.endsWith("@lid") ? keyParticipantAlt : "") ||
    (contextParticipant.endsWith("@lid") ? contextParticipant : "");

  let quoted = null;

  if (contextInfo?.quotedMessage) {
    const quotedText = obtenerTexto(contextInfo.quotedMessage);
    const quotedParticipant = contextParticipant || sender;
    const quotedParticipantAlt = contextParticipantAlt || senderPhone;
    const quotedParticipantLid =
      String(contextInfo?.participantLid || "").trim() ||
      (quotedParticipant.endsWith("@lid") ? quotedParticipant : "") ||
      (quotedParticipantAlt.endsWith("@lid") ? quotedParticipantAlt : "");
    quoted = {
      key: {
        remoteJid: from,
        fromMe: false,
        id: contextInfo?.stanzaId || "",
        participant: quotedParticipant,
        participantAlt: quotedParticipantAlt,
        participantPn: quotedParticipantAlt,
        participantLid: quotedParticipantLid,
      },
      message: contextInfo.quotedMessage,
      text: quotedText,
      body: quotedText,
      sender: quotedParticipant,
      senderPhone:
        quotedParticipantAlt && quotedParticipantAlt.endsWith("@s.whatsapp.net")
          ? quotedParticipantAlt
          : senderPhone,
      senderLid: quotedParticipantLid,
    };
  }

  return {
    ...raw,
    message,
    text,
    body: text,
    from,
    sender,
    chat: from,
    isGroup: from.endsWith("@g.us"),
    pushName: String(raw?.pushName || raw?.notifyName || raw?.verifiedBizName || "").trim(),
    senderPhone,
    senderLid,
    quoted,
  };
}

function parseMessageTimestampToMs(value) {
  if (value == null) return 0;

  let rawNumber = 0;
  if (typeof value === "number") {
    rawNumber = value;
  } else if (typeof value === "string") {
    rawNumber = Number(value);
  } else if (typeof value?.toNumber === "function") {
    rawNumber = Number(value.toNumber());
  } else if (typeof value === "object") {
    rawNumber = Number(value?.low ?? value?.value ?? 0);
  }

  if (!Number.isFinite(rawNumber) || rawNumber <= 0) {
    return 0;
  }

  return rawNumber > 1_000_000_000_000 ? rawNumber : Math.floor(rawNumber * 1000);
}

function getMessageDedupKey(raw = {}) {
  const remoteJid = String(raw?.key?.remoteJid || "").trim();
  const id = String(raw?.key?.id || "").trim();

  if (!remoteJid || !id) {
    return "";
  }

  // Dedup by chat + message id only. participant can vary across upsert variants.
  return `${remoteJid}|${id}`;
}

function markAndCheckRecentMessage(botState, raw = {}) {
  if (!botState) return false;

  if (!(botState.recentMessageIds instanceof Map)) {
    botState.recentMessageIds = new Map();
  }

  const key = getMessageDedupKey(raw);
  if (!key) {
    return false;
  }

  const now = Date.now();

  for (const [savedKey, savedAt] of botState.recentMessageIds) {
    if (!savedAt || now - Number(savedAt) > MESSAGE_DEDUP_TTL_MS) {
      botState.recentMessageIds.delete(savedKey);
    }
  }

  const existingAt = Number(botState.recentMessageIds.get(key) || 0);
  if (existingAt && now - existingAt <= MESSAGE_DEDUP_TTL_MS) {
    return true;
  }

  botState.recentMessageIds.set(key, now);

  while (botState.recentMessageIds.size > MESSAGE_DEDUP_MAX_ENTRIES) {
    const oldestKey = botState.recentMessageIds.keys().next().value;
    if (!oldestKey) break;
    botState.recentMessageIds.delete(oldestKey);
  }

  return false;
}

function getBotGroupCommandPriority(botId = "") {
  const normalized = String(botId || "")
    .trim()
    .toLowerCase();
  if (normalized === "main") return 0;
  const slot = getBotSlot(normalized);
  if (slot >= 1) return slot;
  return 99;
}

function getGroupCommandDelayMs(botId = "") {
  if (getBotGroupCommandPriority(botId) === 0) return 0;

  const slot = Math.max(1, getBotSlot(botId));
  const computedDelay =
    GROUP_COMMAND_SUBBOT_BASE_DELAY_MS +
    Math.max(0, slot - 1) * GROUP_COMMAND_SUBBOT_STEP_DELAY_MS;

  return Math.max(0, Math.min(GROUP_COMMAND_SUBBOT_MAX_DELAY_MS, computedDelay));
}

function normalizeGroupCommandText(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeGroupCommandSender(raw = {}) {
  const senderCandidate =
    raw?.key?.participant ||
    raw?.key?.participantPn ||
    raw?.key?.participantLid ||
    raw?.key?.remoteJid ||
    "";
  const normalized = String(normalizeJidUser(senderCandidate) || "")
    .trim()
    .toLowerCase();
  if (normalized) return normalized;
  return String(senderCandidate || "").trim().toLowerCase();
}

function buildGroupCommandClaimKey(raw = {}, commandData = {}) {
  const rawMessageKey = String(getMessageDedupKey(raw) || "")
    .trim()
    .toLowerCase();
  if (rawMessageKey) {
    return `message|${rawMessageKey}`;
  }

  const chatId = String(raw?.key?.remoteJid || "")
    .trim()
    .toLowerCase();
  const commandName = normalizeGroupCommandText(commandData?.commandName || "");
  if (!chatId || !commandName) return "";

  const sender = normalizeGroupCommandSender(raw) || "unknown";
  const commandBody = normalizeGroupCommandText(
    commandData?.body ||
      (Array.isArray(commandData?.args) ? commandData.args.join(" ") : "") ||
      ""
  );
  const commandBodyHash = crypto.createHash("sha1").update(commandBody).digest("hex").slice(0, 16);
  const timestampMs = parseMessageTimestampToMs(raw?.messageTimestamp);
  const timestampSeconds = timestampMs ? Math.floor(timestampMs / 1000) : 0;

  return `${chatId}|${sender}|${commandName}|${commandBodyHash}|${timestampSeconds}`;
}

function buildGroupCommandSemanticKey(raw = {}, commandData = {}) {
  const chatId = String(raw?.key?.remoteJid || "")
    .trim()
    .toLowerCase();
  const commandName = normalizeGroupCommandText(commandData?.commandName || "");
  if (!chatId || !commandName) return "";

  const sender = normalizeGroupCommandSender(raw) || "unknown";
  const commandBody = normalizeGroupCommandText(
    commandData?.body ||
      (Array.isArray(commandData?.args) ? commandData.args.join(" ") : "") ||
      ""
  );
  const commandBodyHash = crypto.createHash("sha1").update(commandBody).digest("hex").slice(0, 16);
  return `semantic|${chatId}|${sender}|${commandName}|${commandBodyHash}`;
}

function buildCommandReplayKey(raw = {}, commandData = {}) {
  const chatId = String(raw?.key?.remoteJid || "")
    .trim()
    .toLowerCase();
  const commandName = normalizeGroupCommandText(commandData?.commandName || "");
  if (!chatId || !commandName) return "";

  const sender = normalizeGroupCommandSender(raw) || "unknown";
  const commandBody = normalizeGroupCommandText(
    commandData?.body ||
      (Array.isArray(commandData?.args) ? commandData.args.join(" ") : "") ||
      ""
  );
  const commandBodyHash = crypto.createHash("sha1").update(commandBody).digest("hex").slice(0, 16);
  const timestampMs = parseMessageTimestampToMs(raw?.messageTimestamp);
  const timestampSeconds = timestampMs ? Math.floor(timestampMs / 1000) : 0;
  const entropy = timestampSeconds || "no_ts";
  return `cmd_replay|${chatId}|${sender}|${commandName}|${commandBodyHash}|${entropy}`;
}

function cleanupCommandReplayCache(botState, now = Date.now()) {
  if (!(botState?.commandReplayCache instanceof Map)) {
    botState.commandReplayCache = new Map();
    return;
  }

  for (const [key, seenAt] of botState.commandReplayCache) {
    if (!seenAt || now - Number(seenAt) > COMMAND_REPLAY_CACHE_TTL_MS) {
      botState.commandReplayCache.delete(key);
    }
  }
}

function shouldSkipCommandReplay(botState, raw = {}, commandData = {}) {
  const replayKey = buildCommandReplayKey(raw, commandData);
  if (!replayKey) return false;

  const now = Date.now();
  cleanupCommandReplayCache(botState, now);
  const seenAt = Number(botState?.commandReplayCache?.get?.(replayKey) || 0);
  if (seenAt && now - seenAt <= COMMAND_REPLAY_CACHE_TTL_MS) {
    return true;
  }

  botState?.commandReplayCache?.set?.(replayKey, now);
  return false;
}

function getGroupCommandClaimFilePath(claimKey = "") {
  const normalizedKey = String(claimKey || "").trim();
  if (!normalizedKey) return "";
  const digest = crypto.createHash("sha1").update(normalizedKey).digest("hex");
  return path.join(GROUP_COMMAND_CLAIM_DIR, `${digest}.json`);
}

function readGroupCommandClaim(filePath = "") {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }

    const parsed = safeReadJson(fs.readFileSync(filePath, "utf-8"), null);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function reserveGroupClaimFile(filePath = "", payload = {}, ttlMs = GROUP_COMMAND_CLAIM_TTL_MS, options = {}) {
  const safeTtlMs = Math.max(500, Number(ttlMs || 0) || GROUP_COMMAND_CLAIM_TTL_MS);
  const failOpen = options?.failOpen !== false;
  const logLabel = String(options?.logLabel || "group-claim").trim() || "group-claim";

  for (let attempt = 0; attempt < 2; attempt++) {
    let fileHandle = null;
    try {
      fileHandle = fs.openSync(filePath, "wx");
      fs.writeFileSync(fileHandle, JSON.stringify(payload, null, 2), "utf-8");
      return {
        allowed: true,
        reason: "claimed",
      };
    } catch (error) {
      const code = String(error?.code || "").trim().toUpperCase();
      if (code !== "EEXIST") {
        if (!failOpen) {
          return {
            allowed: false,
            reason: "claim_error_strict",
          };
        }
        console.error(`[${logLabel}] No pude reservar claim:`, error?.message || error);
        return {
          allowed: true,
          reason: "claim_error_fail_open",
        };
      }

      const existingClaim = readGroupCommandClaim(filePath);
      const existingClaimedAt = Number(
        existingClaim?.claimedAt || existingClaim?.updatedAt || 0
      );

      if (!existingClaimedAt || Date.now() - existingClaimedAt > safeTtlMs) {
        try {
          fs.rmSync(filePath, { force: true });
          continue;
        } catch {}
      }

      return {
        allowed: false,
        reason: "already_claimed",
        winnerBotId: String(existingClaim?.botId || "").trim().toLowerCase(),
      };
    } finally {
      if (fileHandle !== null) {
        try {
          fs.closeSync(fileHandle);
        } catch {}
      }
    }
  }

  return failOpen
    ? {
        allowed: true,
        reason: "retry_exhausted_fail_open",
      }
    : {
        allowed: false,
        reason: "retry_exhausted_strict",
      };
}

let lastGroupCommandClaimCleanupAt = 0;

function cleanupGroupCommandClaimFiles(now = Date.now()) {
  if (!GROUP_COMMAND_CLAIM_ENABLED) return;
  if (now - lastGroupCommandClaimCleanupAt < GROUP_COMMAND_CLAIM_CLEANUP_INTERVAL_MS) {
    return;
  }

  lastGroupCommandClaimCleanupAt = now;

  try {
    const entries = fs.readdirSync(GROUP_COMMAND_CLAIM_DIR);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const fullPath = path.join(GROUP_COMMAND_CLAIM_DIR, entry);
      let claimAgeMs = 0;
      try {
        const claim = readGroupCommandClaim(fullPath);
        const claimedAt = Number(claim?.claimedAt || claim?.updatedAt || 0);
        if (claimedAt > 0) {
          claimAgeMs = Math.max(0, now - claimedAt);
        } else {
          const stats = fs.statSync(fullPath);
          claimAgeMs = Math.max(0, now - Number(stats?.mtimeMs || 0));
        }
      } catch {
        claimAgeMs = GROUP_COMMAND_CLAIM_TTL_MS + 1;
      }

      if (claimAgeMs > GROUP_COMMAND_CLAIM_TTL_MS) {
        try {
          fs.rmSync(fullPath, { force: true });
        } catch {}
      }
    }
  } catch {}
}

function normalizeGroupUpdateClaimParticipant(value = "") {
  const normalized = String(normalizeJidUser(value) || "")
    .trim()
    .toLowerCase();
  if (normalized) return normalized;
  return String(value || "").trim().toLowerCase();
}

function buildGroupUpdateClaimKey(update = {}) {
  const groupId = String(update?.id || "").trim().toLowerCase();
  const action = String(update?.action || "").trim().toLowerCase();
  const participants = Array.isArray(update?.participants) ? update.participants : [];
  const participantKeys = Array.from(
    new Set(
      participants
        .map((item) => normalizeGroupUpdateClaimParticipant(item))
        .filter(Boolean)
    )
  ).sort();

  if (!groupId || !action || !participantKeys.length) {
    return "";
  }

  return `group_update|${groupId}|${action}|${participantKeys.join(",")}`;
}

function getGroupUpdateClaimFilePath(claimKey = "") {
  const normalizedKey = String(claimKey || "").trim();
  if (!normalizedKey) return "";
  const digest = crypto.createHash("sha1").update(normalizedKey).digest("hex");
  return path.join(GROUP_UPDATE_CLAIM_DIR, `${digest}.json`);
}

function readGroupUpdateClaim(filePath = "") {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }

    const parsed = safeReadJson(fs.readFileSync(filePath, "utf-8"), null);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

let lastGroupUpdateClaimCleanupAt = 0;

function cleanupGroupUpdateClaimFiles(now = Date.now()) {
  if (!GROUP_UPDATE_CLAIM_ENABLED) return;
  if (now - lastGroupUpdateClaimCleanupAt < GROUP_UPDATE_CLAIM_CLEANUP_INTERVAL_MS) {
    return;
  }

  lastGroupUpdateClaimCleanupAt = now;

  try {
    const entries = fs.readdirSync(GROUP_UPDATE_CLAIM_DIR);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const fullPath = path.join(GROUP_UPDATE_CLAIM_DIR, entry);
      let claimAgeMs = 0;
      try {
        const claim = readGroupUpdateClaim(fullPath);
        const claimedAt = Number(claim?.claimedAt || claim?.updatedAt || 0);
        if (claimedAt > 0) {
          claimAgeMs = Math.max(0, now - claimedAt);
        } else {
          const stats = fs.statSync(fullPath);
          claimAgeMs = Math.max(0, now - Number(stats?.mtimeMs || 0));
        }
      } catch {
        claimAgeMs = GROUP_UPDATE_CLAIM_TTL_MS + 1;
      }

      if (claimAgeMs > GROUP_UPDATE_CLAIM_TTL_MS) {
        try {
          fs.rmSync(fullPath, { force: true });
        } catch {}
      }
    }
  } catch {}
}

function cleanupLocalGroupUpdateClaimCache(botState, now = Date.now()) {
  if (!(botState?.groupUpdateClaimCache instanceof Map)) {
    botState.groupUpdateClaimCache = new Map();
    return;
  }

  for (const [key, claimedAt] of botState.groupUpdateClaimCache) {
    if (!claimedAt || now - Number(claimedAt) > GROUP_UPDATE_CLAIM_TTL_MS) {
      botState.groupUpdateClaimCache.delete(key);
    }
  }
}

async function reserveGroupUpdateProcessing(botState, update = {}) {
  if (!GROUP_UPDATE_CLAIM_ENABLED) {
    return { allowed: true, reason: "disabled" };
  }

  const claimKey = buildGroupUpdateClaimKey(update);
  if (!claimKey) {
    return { allowed: true, reason: "missing_claim_key" };
  }

  const now = Date.now();
  cleanupGroupUpdateClaimFiles(now);
  cleanupLocalGroupUpdateClaimCache(botState, now);

  const localClaimedAt = Number(botState?.groupUpdateClaimCache?.get?.(claimKey) || 0);
  if (localClaimedAt && now - localClaimedAt <= GROUP_UPDATE_CLAIM_TTL_MS) {
    return { allowed: false, reason: "local_duplicate" };
  }

  const claimFilePath = getGroupUpdateClaimFilePath(claimKey);
  if (!claimFilePath) {
    return { allowed: true, reason: "missing_claim_path" };
  }

  const botId = String(botState?.config?.id || "main").trim().toLowerCase();
  const delayMs = getGroupCommandDelayMs(botId);
  if (delayMs > 0) {
    await delay(delayMs);
  }

  const payload = {
    claimedAt: Date.now(),
    claimKey,
    botId,
    processPid: process.pid,
    update: {
      id: String(update?.id || "").trim(),
      action: String(update?.action || "").trim().toLowerCase(),
      participants: Array.isArray(update?.participants)
        ? update.participants.map((item) => String(item || "").trim()).filter(Boolean)
        : [],
    },
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    let fileHandle = null;
    try {
      fileHandle = fs.openSync(claimFilePath, "wx");
      fs.writeFileSync(fileHandle, JSON.stringify(payload, null, 2), "utf-8");
      botState?.groupUpdateClaimCache?.set?.(claimKey, Number(payload.claimedAt || Date.now()));
      return {
        allowed: true,
        reason: "claimed",
        delayMs,
      };
    } catch (error) {
      const code = String(error?.code || "").trim().toUpperCase();
      if (code !== "EEXIST") {
        const fallbackNow = Date.now();
        const localSeenAt = Number(botState?.groupUpdateClaimCache?.get?.(claimKey) || 0);
        if (localSeenAt && fallbackNow - localSeenAt <= GROUP_UPDATE_CLAIM_TTL_MS) {
          return { allowed: false, reason: "local_duplicate_on_error" };
        }
        botState?.groupUpdateClaimCache?.set?.(claimKey, fallbackNow);
        console.error("[group-update-claim] No pude reservar update:", error?.message || error);
        return {
          allowed: true,
          reason: "error_fail_open",
          delayMs,
        };
      }

      const existingClaim = readGroupUpdateClaim(claimFilePath);
      const existingClaimedAt = Number(
        existingClaim?.claimedAt || existingClaim?.updatedAt || 0
      );

      if (
        !existingClaimedAt ||
        Date.now() - existingClaimedAt > GROUP_UPDATE_CLAIM_TTL_MS
      ) {
        try {
          fs.rmSync(claimFilePath, { force: true });
          continue;
        } catch {}
      }

      botState?.groupUpdateClaimCache?.set?.(
        claimKey,
        existingClaimedAt || Date.now()
      );
      return {
        allowed: false,
        reason: "claimed_by_other_or_duplicate",
      };
    } finally {
      if (fileHandle !== null) {
        try {
          fs.closeSync(fileHandle);
        } catch {}
      }
    }
  }

  return {
    allowed: true,
    reason: "retry_exhausted_fail_open",
    delayMs,
  };
}

function resolveBotDisplayName(botId = "") {
  const normalized = String(botId || "")
    .trim()
    .toLowerCase();
  if (!normalized) return "";
  if (normalized === "main") {
    return String(settings?.botName || "Bot principal").trim() || "Bot principal";
  }

  const config = getBotConfigById(normalized);
  if (config) {
    return (
      String(config.displayName || config.label || normalized).trim() || normalized
    );
  }

  return normalized;
}

function doesGroupUpdateIncludeSelf(sock, update = {}) {
  const self = normalizeJidUser(sock?.user?.id);
  if (!self) return false;

  const participants = Array.isArray(update?.participants) ? update.participants : [];
  for (const value of participants) {
    if (normalizeJidUser(value) === self) {
      return true;
    }
  }

  return false;
}

async function sendGroupResponderNotice(sock, groupId, text) {
  if (!sock || !groupId || !text) return false;

  try {
    await sock.sendMessage(groupId, {
      text,
      ...global.channelInfo,
    });
    return true;
  } catch {
    return false;
  }
}

async function maybeAnnounceGroupEntry(botState, sock, groupId, action = "") {
  if (!GROUP_RESPONDER_NOTICE_ENABLED) return;
  if (!groupId || !groupId.endsWith("@g.us")) return;
  if (botState?.autoJoinManagedGroups instanceof Set && botState.autoJoinManagedGroups.has(groupId)) {
    return;
  }

  if (!(botState?.groupJoinNoticeCache instanceof Map)) {
    botState.groupJoinNoticeCache = new Map();
  }

  const now = Date.now();
  const lastSentAt = Number(botState.groupJoinNoticeCache.get(groupId) || 0);
  if (lastSentAt && now - lastSentAt < GROUP_RESPONDER_ENTRY_NOTICE_COOLDOWN_MS) {
    return;
  }

  const botId = String(botState?.config?.id || "main")
    .trim()
    .toLowerCase();
  const botName = resolveBotDisplayName(botId) || String(botState?.config?.displayName || "Bot");
  const mainSummary = summarizeBotConfig(buildMainBotConfig(settings));
  const mainLikelyAvailable = Boolean(
    mainSummary?.connected || mainSummary?.registered || mainSummary?.connectionState === "open"
  );

  let text = "";
  if (botId === "main") {
    text =
      `✅ *${botName}* conectado en este grupo.\n` +
      `Si hay subbots aqui, quedaran en silencio para evitar spam.`;
  } else {
    text =
      `🤖 *${botName}* conectado.\n` +
      `Modo anti-spam activo: solo respondera un bot por mensaje.\n` +
      (mainLikelyAvailable
        ? `Si el bot principal responde, este subbot se silencia automaticamente.`
        : `Si el bot principal no esta disponible, este subbot responde como respaldo.`);
  }

  const sent = await sendGroupResponderNotice(sock, groupId, text);
  if (sent) {
    botState.groupJoinNoticeCache.set(groupId, now);
  }
}

async function maybeAnnounceResponderTransition(
  botState,
  sock,
  raw,
  reservation = {}
) {
  if (!GROUP_RESPONDER_NOTICE_ENABLED) return;

  const groupId = String(raw?.key?.remoteJid || "").trim();
  if (!groupId.endsWith("@g.us")) return;

  if (!(botState?.groupResponderState instanceof Map)) {
    botState.groupResponderState = new Map();
  }

  const now = Date.now();
  const botId = String(botState?.config?.id || "main")
    .trim()
    .toLowerCase();
  const previous = botState.groupResponderState.get(groupId) || {
    mode: "",
    winnerBotId: "",
    updatedAt: 0,
    lastNoticeAt: 0,
  };

  let nextMode = previous.mode;
  let winnerBotId = previous.winnerBotId;

  if (reservation.allowed) {
    nextMode = "active";
    winnerBotId = botId;
  } else if (reservation.reason === "claimed_by_other") {
    nextMode = "standby";
    winnerBotId = String(reservation.winnerBotId || "").trim().toLowerCase();
  } else {
    return;
  }

  const changed = nextMode !== previous.mode || winnerBotId !== previous.winnerBotId;
  if (!changed) return;

  botState.groupResponderState.set(groupId, {
    ...previous,
    mode: nextMode,
    winnerBotId,
    updatedAt: now,
  });

  if (now - Number(previous.lastNoticeAt || 0) < GROUP_RESPONDER_NOTICE_COOLDOWN_MS) {
    return;
  }

  let text = "";
  const botName = resolveBotDisplayName(botId) || String(botState?.config?.displayName || "Bot");

  if (nextMode === "standby" && botId !== "main") {
    const winnerName =
      winnerBotId === "main"
        ? resolveBotDisplayName("main")
        : resolveBotDisplayName(winnerBotId) || "otro bot";
    text =
      `⚠️ Hay varios bots activos en este grupo.\n` +
      `🔇 *${botName}* se silenciara para evitar spam.\n` +
      `✅ Bot activo ahora: *${winnerName}*.`;
  } else if (
    nextMode === "active" &&
    botId !== "main" &&
    previous.mode === "standby"
  ) {
    if (previous.winnerBotId === "main") {
      text =
        `⚠️ El bot principal no responde en este momento.\n` +
        `✅ *${botName}* se activo como respaldo.\n` +
        `Cuando regrese el principal, este subbot volvera a silencio automatico.`;
    } else {
      text =
        `✅ *${botName}* quedo activo en este grupo.\n` +
        `Los demas subbots quedan en silencio para evitar spam.`;
    }
  } else if (nextMode === "active" && botId === "main" && previous.mode === "standby") {
    text =
      `✅ Bot principal activo de nuevo en este grupo.\n` +
      `Los subbots quedan en silencio para evitar spam.`;
  }

  if (!text) return;

  const sent = await sendGroupResponderNotice(sock, groupId, text);
  if (!sent) return;

  botState.groupResponderState.set(groupId, {
    ...botState.groupResponderState.get(groupId),
    lastNoticeAt: now,
  });
}

async function reserveGroupCommandExecution(botState, raw, commandData = {}) {
  if (!GROUP_COMMAND_CLAIM_ENABLED) {
    return { allowed: true, reason: "disabled" };
  }

  const chatId = String(raw?.key?.remoteJid || "").trim();
  if (!chatId.endsWith("@g.us")) {
    return { allowed: true, reason: "not_group" };
  }

  const claimKey = buildGroupCommandClaimKey(raw, commandData) || getMessageDedupKey(raw);
  const claimFilePath = getGroupCommandClaimFilePath(claimKey);
  if (!claimFilePath) {
    return { allowed: true, reason: "missing_claim_key" };
  }

  const now = Date.now();
  cleanupGroupCommandClaimFiles(now);

  const botId = String(botState?.config?.id || "main").trim().toLowerCase();
  const slot = getBotSlot(botId);
  const priority = getBotGroupCommandPriority(botId);
  const delayMs = getGroupCommandDelayMs(botId);

  if (delayMs > 0) {
    await delay(delayMs);
  }

  const payload = {
    claimedAt: Date.now(),
    claimKey,
    chatId,
    messageId: String(raw?.key?.id || "").trim(),
    messageTimestampMs: parseMessageTimestampToMs(raw?.messageTimestamp),
    sender: normalizeGroupCommandSender(raw),
    command: String(commandData?.commandName || "").trim().toLowerCase(),
    botId,
    slot,
    priority,
    processPid: process.pid,
  };

  const semanticKey = buildGroupCommandSemanticKey(raw, commandData);
  const semanticClaimFilePath = getGroupCommandClaimFilePath(semanticKey);
  if (semanticClaimFilePath) {
    const semanticResult = reserveGroupClaimFile(
      semanticClaimFilePath,
      {
        ...payload,
        claimType: "semantic",
        claimKey: semanticKey,
      },
      GROUP_COMMAND_SEMANTIC_DEDUP_TTL_MS,
      {
        failOpen: false,
        logLabel: "group-claim-semantic",
      }
    );
    if (!semanticResult.allowed) {
      return {
        allowed: false,
        reason: "semantic_duplicate",
        winnerBotId: semanticResult.winnerBotId || "",
        delayMs,
      };
    }
  }

  const messageResult = reserveGroupClaimFile(
    claimFilePath,
    payload,
    GROUP_COMMAND_CLAIM_TTL_MS,
    {
      failOpen: true,
      logLabel: "group-claim",
    }
  );

  if (!messageResult.allowed) {
    const winnerBotId = String(messageResult?.winnerBotId || "").trim().toLowerCase();
    return {
      allowed: winnerBotId === botId,
      reason: winnerBotId && winnerBotId !== botId ? "claimed_by_other" : "already_claimed",
      winnerBotId,
      delayMs,
    };
  }

  return {
    allowed: true,
    reason: "claimed",
    delayMs,
  };
}

function shouldProcessUpsertMessage(raw = {}, type = "") {
  if (!raw?.message) {
    return false;
  }

  const normalizedType = String(type || "").trim().toLowerCase();

  if (!normalizedType || normalizedType === "notify" || normalizedType === "replace") {
    return true;
  }

  if (raw?.key?.fromMe) {
    return true;
  }

  if (normalizedType !== "append" && normalizedType !== "history") {
    return false;
  }

  const messageTimestampMs = parseMessageTimestampToMs(raw?.messageTimestamp);
  if (!messageTimestampMs) {
    return false;
  }

  const ageMs = Date.now() - messageTimestampMs;
  return ageMs >= -90_000 && ageMs <= APPEND_UPSERT_RECENT_WINDOW_MS;
}

function getStoreContactName(botState, ...ids) {
  const contacts = botState?.store?.contacts;
  if (!contacts || typeof contacts !== "object") return "";
  if (!(botState?.contactNameCache instanceof Map)) {
    botState.contactNameCache = new Map();
  }

  const now = Date.now();
  const cacheKeys = [];

  for (const value of ids) {
    const raw = String(value || "").trim();
    if (!raw) continue;

    const normalized = normalizeJidUser(raw);
    cacheKeys.push(raw.toLowerCase());
    if (normalized) {
      cacheKeys.push(normalized.toLowerCase());
      cacheKeys.push(`${normalized}@s.whatsapp.net`.toLowerCase());
      cacheKeys.push(`${normalized}@lid`.toLowerCase());
    }
  }

  for (const key of cacheKeys) {
    const cached = botState.contactNameCache.get(key);
    if (!cached) continue;
    const cachedAt = Number(cached.cachedAt || 0);
    const cachedName = String(cached.name || "").trim();

    if (!cachedName || !cachedAt || now - cachedAt > CONTACT_NAME_CACHE_TTL_MS) {
      botState.contactNameCache.delete(key);
      continue;
    }

    botState.contactNameCache.delete(key);
    botState.contactNameCache.set(key, cached);
    return cachedName;
  }

  for (const value of ids) {
    const raw = String(value || "").trim();
    if (!raw) continue;

    const normalized = normalizeJidUser(raw);
    const candidates = [raw];

    if (normalized) {
      candidates.push(`${normalized}@s.whatsapp.net`, `${normalized}@lid`);
    }

    for (const candidate of candidates) {
      const entry = contacts?.[candidate];
      const name = String(
        entry?.notify || entry?.name || entry?.verifiedName || entry?.verifiedBizName || ""
      ).trim();

      if (name) {
        const item = {
          name,
          cachedAt: now,
        };

        for (const key of cacheKeys) {
          botState.contactNameCache.set(key, item);
        }

        while (botState.contactNameCache.size > CONTACT_NAME_CACHE_MAX_ENTRIES) {
          const oldestKey = botState.contactNameCache.keys().next().value;
          if (!oldestKey) break;
          botState.contactNameCache.delete(oldestKey);
        }

        return name;
      }
    }
  }

  return "";
}

async function getVersionSafe() {
  try {
    const data = await fetchLatestBaileysVersion();
    return data?.version;
  } catch {
    return undefined;
  }
}

function buildOwnerIds(currentSettings) {
  const ownerIds = new Set();

  const add = (value) => {
    const normalized = normalizeJidUser(value);
    if (normalized) ownerIds.add(normalized);
  };

  add(currentSettings?.ownerNumber);

  for (const value of currentSettings?.ownerNumbers || []) {
    add(value);
  }

  for (const value of currentSettings?.ownerLids || []) {
    add(value);
  }

  return ownerIds;
}

function getConfiguredPrefixes(currentSettings) {
  if (Array.isArray(currentSettings?.prefix)) {
    return currentSettings.prefix
      .map((prefix) => String(prefix || "").trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
  }

  const prefix = String(currentSettings?.prefix || ".").trim();
  return prefix ? [prefix] : [];
}

function extractCommandData(text, currentSettings) {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) return null;

  const prefix = getConfiguredPrefixes(currentSettings).find((value) =>
    normalizedText.startsWith(value)
  );

  if (!prefix) return null;

  const body = normalizedText.slice(prefix.length).trim();
  if (!body) return null;

  const args = body.split(/\s+/);
  const commandName = String(args.shift() || "").toLowerCase();

  if (!commandName) return null;

  return {
    prefix,
    body,
    args,
    commandName,
  };
}

function compactJidForLog(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const base = raw.split("@")[0].split(":")[0];
  const digits = base.replace(/[^\d]/g, "");
  return digits || base;
}

function formatPhoneForLog(value = "") {
  const compact = compactJidForLog(value);
  if (!compact) return "desconocido";
  return /^\d+$/.test(compact) ? `+${compact}` : compact;
}

function formatCommandConsoleLog(commandData = {}, message = {}, from = "") {
  const prefix = String(commandData?.prefix || ".").trim() || ".";
  const commandName = String(commandData?.commandName || "").trim().toLowerCase();
  const argsText = Array.isArray(commandData?.args)
    ? String(commandData.args.join(" ") || "").trim()
    : "";
  const shownArgs = argsText.length > 52 ? `${argsText.slice(0, 49)}...` : argsText;
  const commandText = `${prefix}${commandName}${shownArgs ? ` ${shownArgs}` : ""}`;
  const user = formatPhoneForLog(message?.senderPhone || message?.sender);
  const chatId = compactJidForLog(from);
  const scope = String(from || "").endsWith("@g.us")
    ? `grupo:${chatId || "desconocido"}`
    : `privado:${user}`;
  const requestId = String(commandData?.requestId || "").trim();
  return `CMD ${commandText} | user ${user} | ${scope}${requestId ? ` | id ${requestId}` : ""}`;
}

const GLOBAL_COMMAND_ALIAS_MAP = new Map([
  // sistema
  ["ayuda", "menu"],
  ["comandos", "menu"],
  ["panel", "menu"],
  ["saludbot", "healthbot"],
  ["salud", "healthbot"],
  ["estadosalud", "healthbot"],
  ["panelgrupo", "gpanel"],
  ["paneladmin", "gpanel"],
  ["adminpanel", "gpanel"],
  ["botpanel", "controlbot"],
  ["controlbot", "controlbot"],
  ["panelbot", "controlbot"],
  ["antierrorvisible", "antierror"],
  ["errores", "logs"],
  ["respaldo", "backup"],
  ["restaurar", "restore"],
  ["tablero", "dashboard"],
  ["difusion", "broadcast"],
  ["limpiarlogs", "clearlogs"],
  ["manten", "mantenimiento"],
  ["actualizar", "update"],
  ["reiniciar", "restart"],

  // grupo
  ["bienvenida", "welcome"],
  ["despedida", "welcome"],
  ["estadogrupo", "estadogrupo"],
  ["configuraciongrupo", "estadogrupo"],
  ["ascender", "promote"],
  ["degradar", "demote"],
  ["cerrargrupo", "grupo"],
  ["abrirgrupo", "grupo"],
  ["lista blanca", "whitelist"],
  ["listablanca", "whitelist"],

  // descargas y busqueda
  ["descargatiktok", "tiktok"],
  ["descargayoutube", "ytmp4"],
  ["audioyoutube", "ytmp3"],
  ["videoyoutube", "ytmp4"],
  ["buscaryoutube", "ytsearch"],
  ["buscartiktok", "ttsearch"],
  ["perfiltiktok", "tiktokusuario"],
  ["cancion", "play"],
  ["descargarapk", "apk"],
  ["descargarmediafire", "mediafire"],
  ["descargarmega", "mega"],
  ["descargarwindows", "windows"],
  ["descargarmac", "mac"],
  ["descargarspotify", "spotify"],

  // economia
  ["trabajo", "work"],
  ["diario", "daily"],
  ["tienda", "shop"],
  ["comprar", "buy"],
  ["comprarsolicitud", "buyrequests"],
  ["misolicitudes", "solicitudes"],
  ["rankdinero", "topdolares"],
  ["ranksolicitudes", "topsolicitudes"],
  ["enviardinero", "transferir"],
  ["saldo", "dolares"],
  ["cartera", "dolares"],

  // utilidades/ia
  ["traductor", "traducir"],
  ["traduccion", "traducir"],
  ["resumir", "resumen"],
  ["ia", "gpt5"],
  ["chat", "gpt5"],

  // juegos
  ["juego", "juegos"],
  ["menujuego", "juegos"],
  ["piedrapapeltijera", "ppt"],
  ["ruletarusa", "ruleta"],
  ["adivinar", "adivina"],
]);

function applyGlobalCommandAliases() {
  for (const [aliasName, canonicalName] of GLOBAL_COMMAND_ALIAS_MAP.entries()) {
    const alias = String(aliasName || "").trim().toLowerCase();
    const canonical = String(canonicalName || "").trim().toLowerCase();
    if (!alias || !canonical) continue;
    if (comandos.has(alias)) continue;
    const target = comandos.get(canonical);
    if (!target) continue;
    comandos.set(alias, target);
  }
}

function buildMainBotConfig(currentSettings) {
  const mainAuthFolder =
    String(currentSettings?.authFolder || DEFAULT_AUTH_FOLDER).trim() ||
    DEFAULT_AUTH_FOLDER;

  return {
    id: "main",
    slot: 0,
    enabled: true,
    label: "MAIN",
    displayName: String(currentSettings?.botName || "DVYER").trim() || "DVYER",
    authFolder: mainAuthFolder,
    pairingNumber: sanitizePhoneNumber(currentSettings?.pairingNumber) || "",
  };
}

function buildBotConfigs(currentSettings) {
  const mainConfig = buildMainBotConfig(currentSettings);
  const subbotConfigs = buildSubbotSlotConfigs(currentSettings).map((slotConfig) => {
    let authFolder =
      String(slotConfig?.authFolder || getDefaultSubbotAuthFolder(slotConfig.slot)).trim() ||
      getDefaultSubbotAuthFolder(slotConfig.slot);

    if (authFolder === mainConfig.authFolder) {
      authFolder = `${mainConfig.authFolder}-subbot-${slotConfig.slot}`;
    }

    return {
      id: slotConfig.id,
      slot: slotConfig.slot,
      enabled: Boolean(slotConfig.enabled),
      label: String(slotConfig.label || getDefaultSubbotLabel(slotConfig.slot))
        .trim()
        .toUpperCase() || getDefaultSubbotLabel(slotConfig.slot),
      displayName:
        String(slotConfig.name || getDefaultSubbotName(currentSettings, slotConfig.slot)).trim() ||
        getDefaultSubbotName(currentSettings, slotConfig.slot),
      authFolder,
      pairingNumber: sanitizePhoneNumber(slotConfig.pairingNumber) || "",
      requesterNumber: sanitizePhoneNumber(slotConfig.requesterNumber) || "",
      requesterJid: String(slotConfig.requesterJid || "").trim(),
      requestedAt: normalizeTimestamp(slotConfig.requestedAt),
      releasedAt: normalizeTimestamp(slotConfig.releasedAt),
    };
  });

  return [
    mainConfig,
    ...subbotConfigs.filter((config) => config.enabled),
  ];
}

let SUBBOT_SLOT_CONFIGS = buildSubbotSlotConfigs(settings);
let BOT_CONFIGS = buildBotConfigs(settings);
let OWNER_IDS = buildOwnerIds(settings);

function ownsBotInThisProcess(botId) {
  return PROCESS_BOT_ID === "all" || normalizeProcessBotId(botId) === PROCESS_BOT_ID;
}

function getManagedProcessBotConfigs() {
  if (!SPLIT_PROCESS_MODE) {
    return BOT_CONFIGS.slice();
  }

  const targetConfig = getBotConfigById(PROCESS_BOT_ID);
  return targetConfig ? [targetConfig] : [];
}

function getPm2Executable() {
  return process.platform === "win32" ? "pm2.cmd" : "pm2";
}

function getSplitProcessName(botId) {
  const normalized = normalizeProcessBotId(botId);
  if (normalized === "main") {
    return "dvyer-main";
  }

  const slotMatch = normalized.match(/^subbot(\d{1,2})$/);
  if (slotMatch) {
    return `dvyer-subbot-${Number.parseInt(slotMatch[1], 10)}`;
  }

  return `dvyer-${normalized}`;
}

function getSubbotConfigBySlot(slotNumber) {
  return SUBBOT_SLOT_CONFIGS.find((config) => config.slot === Number(slotNumber)) || null;
}

function getSubbotAssignedNumber(config = {}) {
  return (
    sanitizePhoneNumber(config?.waNumber) ||
    sanitizePhoneNumber(config?.configuredNumber) ||
    sanitizePhoneNumber(config?.requesterNumber) ||
    sanitizePhoneNumber(config?.pairingNumber) ||
    ""
  );
}

function findSubbotByAssignedNumber(number, options = {}) {
  const normalizedNumber = sanitizePhoneNumber(number);
  if (!normalizedNumber) return null;

  const excludeSlot = Number(options?.excludeSlot || 0);

  for (const config of SUBBOT_SLOT_CONFIGS || []) {
    if (!config) continue;
    const summary = summarizeBotConfig(config);
    const slot = Number(summary?.slot || config?.slot || 0);
    if (excludeSlot > 0 && slot === excludeSlot) continue;
    if (getSubbotAssignedNumber(summary) !== normalizedNumber) continue;

    return {
      slot,
      botId: String(summary?.id || config?.id || ""),
      displayName: String(summary?.displayName || config?.displayName || "Subbot"),
    };
  }

  return null;
}

function pickDefaultSubbotConfig(options = {}) {
  const preferredNumber =
    sanitizePhoneNumber(options?.number) ||
    sanitizePhoneNumber(options?.requesterNumber) ||
    "";

  const summaries = SUBBOT_SLOT_CONFIGS
    .map((config) => summarizeBotConfig(config))
    .sort((a, b) => a.slot - b.slot);

  if (preferredNumber) {
    const sameRequester = summaries.find(
      (bot) => getSubbotAssignedNumber(bot) === preferredNumber
    );
    if (sameRequester) {
      return getSubbotConfigBySlot(sameRequester.slot);
    }
  }

  const preferred =
    summaries.find(
      (bot) =>
        bot.enabled &&
        !bot.registered &&
        !bot.connected &&
        !bot.pairingPending &&
        !getSubbotAssignedNumber(bot)
    ) ||
    summaries.find(
      (bot) =>
        !bot.enabled &&
        !bot.registered &&
        !bot.connected &&
        !bot.pairingPending
    ) ||
    summaries.find(
      (bot) =>
        !bot.registered &&
        !bot.connected &&
        !bot.pairingPending &&
        !bot.hasConfiguredNumber &&
        !getSubbotAssignedNumber(bot)
    ) ||
    null;

  return preferred ? getSubbotConfigBySlot(preferred.slot) : null;
}

function getSubbotConfigById(botId) {
  const normalized = String(botId || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "subbot") {
    return pickDefaultSubbotConfig();
  }

  const asSlot = Number.parseInt(normalized, 10);
  if (
    Number.isInteger(asSlot) &&
    asSlot >= 1 &&
    asSlot <= getConfiguredSubbotSlotsCount(settings)
  ) {
    return getSubbotConfigBySlot(asSlot);
  }

  return (
    SUBBOT_SLOT_CONFIGS.find((config) => config.id === normalized) ||
    SUBBOT_SLOT_CONFIGS.find((config) => config.label.toLowerCase() === normalized) ||
    null
  );
}

function getBotConfigById(botId) {
  const normalized = String(botId || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "main") return buildMainBotConfig(settings);
  return getSubbotConfigById(normalized);
}

function resolveSubbotTargetConfig(botId, options = {}) {
  const normalized = String(botId || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized !== "subbot") {
    return getBotConfigById(normalized);
  }

  return pickDefaultSubbotConfig({
    number: options?.number,
    requesterNumber: options?.requesterNumber,
  });
}

// ================= ESTADO =================

const HAS_INTERACTIVE_CONSOLE = Boolean(process.stdin?.isTTY && process.stdout?.isTTY);
let readlineClosed = !HAS_INTERACTIVE_CONSOLE;
const rl = HAS_INTERACTIVE_CONSOLE
  ? readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
  : null;

if (rl) {
  rl.on("close", () => {
    readlineClosed = true;
  });
}

function canPromptInConsole() {
  return Boolean(HAS_INTERACTIVE_CONSOLE && rl && !readlineClosed);
}

const preguntar = (q) =>
  new Promise((resolve, reject) => {
    if (!canPromptInConsole()) {
      resolve("");
      return;
    }

    try {
      rl.question(q, resolve);
    } catch (error) {
      reject(error);
    }
  });
let promptBusy = false;

async function preguntarSeguro(question) {
  if (!canPromptInConsole()) {
    return "";
  }

  while (promptBusy) {
    await delay(200);
  }

  promptBusy = true;

  try {
    return await preguntar(question);
  } catch (error) {
    if (error?.code === "ERR_USE_AFTER_CLOSE") {
      readlineClosed = true;
      return "";
    }
    throw error;
  } finally {
    promptBusy = false;
  }
}

const comandos = new Map();
const commandModules = new Set();
const messageHookModules = [];
const groupUpdateHookModules = [];
const messageDeleteHookModules = [];
const botStates = new Map();

let totalMensajes = 0;
let totalComandos = 0;

const mensajesPorTipo = {
  Grupo: 0,
  Privado: 0,
  Desconocido: 0,
};

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
  } catch {
    return fallback;
  }
}

function replaceObjectContents(target, source) {
  for (const key of Object.keys(target || {})) {
    delete target[key];
  }

  Object.assign(target, source || {});
}

function getBotRuntimeStateFile(botId) {
  return path.join(BOT_RUNTIME_STATE_DIR, `${normalizeProcessBotId(botId)}.json`);
}

function readPersistedBotRuntimeState(botId) {
  try {
    const state = safeReadJson(getBotRuntimeStateFile(botId), null);
    if (!state || typeof state !== "object") return null;
    const updatedAt = Number(state.updatedAt || 0);
    if (!updatedAt || Date.now() - updatedAt > BOT_RUNTIME_STATE_TTL_MS) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function clearPersistedBotRuntimeState(botId) {
  const botState = botStates.get(botId);

  if (botState) {
    clearPersistedBotRuntimeStateWriteTimer(botState);
    botState.persistedStateWritePending = false;
  }

  try {
    fs.rmSync(getBotRuntimeStateFile(botId), { force: true });
  } catch {}
}

function clearPersistedBotRuntimeStateWriteTimer(botState) {
  if (!botState?.persistedStateWriteTimer) return;

  try {
    clearTimeout(botState.persistedStateWriteTimer);
  } catch {}

  botState.persistedStateWriteTimer = null;
}

function writePersistedBotRuntimeStateNow(botState) {
  if (!botState?.config?.id || !ownsBotInThisProcess(botState.config.id)) return;

  botState.persistedStateWritePending = false;

  try {
    const summary = summarizeBotState(botState);
    writeAtomicJsonFile(getBotRuntimeStateFile(botState.config.id), {
      ...summary,
      processBotId: PROCESS_BOT_ID,
      processPid: process.pid,
      splitProcessMode: SPLIT_PROCESS_MODE,
      updatedAt: Date.now(),
    });
  } catch {}
}

function writePersistedBotRuntimeState(botState, options = {}) {
  if (!botState?.config?.id || !ownsBotInThisProcess(botState.config.id)) return;

  const delayMs = Math.max(
    0,
    Number(options?.delayMs ?? BOT_RUNTIME_STATE_WRITE_DEBOUNCE_MS) || 0
  );

  if (options?.immediate === true || delayMs === 0) {
    clearPersistedBotRuntimeStateWriteTimer(botState);
    writePersistedBotRuntimeStateNow(botState);
    return;
  }

  botState.persistedStateWritePending = true;

  if (botState.persistedStateWriteTimer) return;

  botState.persistedStateWriteTimer = setTimeout(() => {
    botState.persistedStateWriteTimer = null;
    writePersistedBotRuntimeStateNow(botState);
  }, delayMs);

  botState.persistedStateWriteTimer.unref?.();
}

function flushManagedBotRuntimeStates() {
  for (const config of getManagedProcessBotConfigs()) {
    const botState = ensureBotState(config);
    botState.config = {
      ...botState.config,
      ...config,
    };
    writePersistedBotRuntimeState(botState, { immediate: true });
  }
}

function normalizeUsageStats(data = {}) {
  const source = isPlainObject(data) ? data : {};

  return {
    trackedSince:
      String(source.trackedSince || "").trim() ||
      new Date().toISOString(),
    totalMessages: Number(source.totalMessages || 0),
    totalCommands: Number(source.totalCommands || 0),
    commandUsage: isPlainObject(source.commandUsage) ? source.commandUsage : {},
    chatUsage: isPlainObject(source.chatUsage) ? source.chatUsage : {},
    userUsage: isPlainObject(source.userUsage) ? source.userUsage : {},
    botUsage: isPlainObject(source.botUsage) ? source.botUsage : {},
  };
}

const usageStats = normalizeUsageStats(safeReadJson(USAGE_STATS_FILE, {}));
let usageStatsSaveTimer = null;
let managedBotSyncInterval = null;
let autoCleanInterval = null;
let botHealthCheckInterval = null;
let liveConsoleTelemetryInterval = null;
let dashboardServer = null;
let structuredLogStream = null;
let runtimeRequestCounter = 0;
const runtimeMetrics = {
  startedAt: Date.now(),
  logs: {
    written: 0,
    dropped: 0,
  },
  http: {
    healthHits: 0,
    metricsHits: 0,
  },
  commands: {
    started: 0,
    success: 0,
    error: 0,
    timeout: 0,
    active: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    byName: {},
  },
};
let secondaryBotStartInProgress = false;
const WEB_BRIDGE_TOKEN = String(process.env.WEB_BRIDGE_TOKEN || "").trim();

function parseBooleanEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;

  const normalized = String(raw).trim().toLowerCase();
  return ["1", "true", "yes", "on", "si"].includes(normalized);
}

function parseNumberEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeHostValue(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "");
}

function isLoopbackHost(host = "") {
  const normalized = normalizeHostValue(host);
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  );
}

const ALLOW_LOOPBACK_BRIDGE_WITHOUT_TOKEN = parseBooleanEnv(
  "WEB_BRIDGE_ALLOW_LOOPBACK",
  false
);
const LOG_COMMAND_LOADS = parseBooleanEnv("LOG_COMMAND_LOADS", false);
const LOG_COMMAND_EXECUTIONS = parseBooleanEnv("LOG_COMMAND_EXECUTIONS", true);
const STRUCTURED_LOG_ENABLED = parseBooleanEnv("STRUCTURED_LOG_ENABLED", true);
const CONSOLE_BOOT_ANIMATION = parseBooleanEnv("CONSOLE_BOOT_ANIMATION", false);
const CONSOLE_BOOT_FRAME_DELAY_MS = Math.max(
  90,
  parseNumberEnv("CONSOLE_BOOT_FRAME_DELAY_MS", 180) || 180
);
const CONSOLE_METRIC_HTTP_TIMEOUT_MS = Math.max(
  600,
  parseNumberEnv("CONSOLE_METRIC_HTTP_TIMEOUT_MS", 1400) || 1400
);
const CONSOLE_NET_REFERENCE_MBPS = Math.max(
  5,
  parseNumberEnv("CONSOLE_NET_REFERENCE_MBPS", 120) || 120
);
const CONSOLE_METRIC_PING_URL = String(
  process.env.CONSOLE_METRIC_PING_URL || buildDvyerUrl("/health")
).trim();
const CONSOLE_LIVE_TELEMETRY_ENABLED = parseBooleanEnv(
  "CONSOLE_LIVE_TELEMETRY",
  false
);
const CONSOLE_LIVE_TELEMETRY_INTERVAL_MS = Math.max(
  15_000,
  parseNumberEnv("CONSOLE_LIVE_TELEMETRY_INTERVAL_MS", 60_000) || 60_000
);
const CONSOLE_LIVE_TELEMETRY_FORCE_LOG_MS = Math.max(
  60_000,
  parseNumberEnv("CONSOLE_LIVE_TELEMETRY_FORCE_LOG_MS", 5 * 60_000) || 5 * 60_000
);
const CONSOLE_LIVE_TELEMETRY_CPU_DELTA = Math.max(
  1,
  parseNumberEnv("CONSOLE_LIVE_TELEMETRY_CPU_DELTA", 5) || 5
);
const CONSOLE_LIVE_TELEMETRY_RAM_DELTA = Math.max(
  1,
  parseNumberEnv("CONSOLE_LIVE_TELEMETRY_RAM_DELTA", 5) || 5
);
const CONSOLE_LIVE_TELEMETRY_NET_DELTA = Math.max(
  1,
  parseNumberEnv("CONSOLE_LIVE_TELEMETRY_NET_DELTA", 12) || 12
);
const CONSOLE_LIVE_TELEMETRY_LAT_DELTA = Math.max(
  1,
  parseNumberEnv("CONSOLE_LIVE_TELEMETRY_LAT_DELTA", 40) || 40
);
const DASHBOARD_AUTO_ENABLED = parseBooleanEnv("DASHBOARD_ENABLED", false);
const DASHBOARD_AUTO_PORT = Math.max(
  1,
  Math.min(65535, parseNumberEnv("DASHBOARD_PORT", 8787) || 8787)
);
const DASHBOARD_AUTO_HOST =
  String(process.env.DASHBOARD_HOST || "0.0.0.0").trim() || "0.0.0.0";
let dashboardState = {
  enabled: DASHBOARD_AUTO_ENABLED,
  port: DASHBOARD_AUTO_PORT,
  host: DASHBOARD_AUTO_HOST,
};
const BOT_RUNTIME_STATE_WRITE_DEBOUNCE_MS = Math.max(
  150,
  parseNumberEnv("BOT_RUNTIME_STATE_WRITE_DEBOUNCE_MS", 1200) || 1200
);
const MANAGED_STOP_GRACE_MS = Math.max(
  4_000,
  parseNumberEnv("MANAGED_STOP_GRACE_MS", 18_000) || 18_000
);
const MANAGED_STOP_LOG_THROTTLE_MS = Math.max(
  2_000,
  parseNumberEnv("MANAGED_STOP_LOG_THROTTLE_MS", 12_000) || 12_000
);
const RAW_SUBBOT_RESERVATION_TIMEOUT_MS = parseNumberEnv(
  "SUBBOT_RESERVATION_TIMEOUT_MS",
  0
);
const SUBBOT_RESERVATION_TIMEOUT_MS =
  RAW_SUBBOT_RESERVATION_TIMEOUT_MS <= 0
    ? 0
    : Math.max(30_000, RAW_SUBBOT_RESERVATION_TIMEOUT_MS);
const GROUP_METADATA_CACHE_TTL_MS = Math.max(
  60_000,
  parseNumberEnv("GROUP_METADATA_CACHE_TTL_MS", 5 * 60 * 1000) || 5 * 60 * 1000
);
const GROUP_METADATA_CACHE_MAX_ENTRIES = Math.max(
  50,
  parseNumberEnv("GROUP_METADATA_CACHE_MAX_ENTRIES", 250) || 250
);
const GROUP_COMMAND_CLAIM_ENABLED = parseBooleanEnv("GROUP_COMMAND_CLAIM_ENABLED", true);
const GROUP_COMMAND_CLAIM_TTL_MS = Math.max(
  20_000,
  parseNumberEnv("GROUP_COMMAND_CLAIM_TTL_MS", 3 * 60 * 1000) || 3 * 60 * 1000
);
const GROUP_COMMAND_CLAIM_CLEANUP_INTERVAL_MS = Math.max(
  20_000,
  parseNumberEnv("GROUP_COMMAND_CLAIM_CLEANUP_INTERVAL_MS", 90_000) || 90_000
);
const GROUP_COMMAND_SUBBOT_BASE_DELAY_MS = Math.max(
  40,
  parseNumberEnv("GROUP_COMMAND_SUBBOT_BASE_DELAY_MS", 180) || 180
);
const GROUP_COMMAND_SUBBOT_STEP_DELAY_MS = Math.max(
  15,
  parseNumberEnv("GROUP_COMMAND_SUBBOT_STEP_DELAY_MS", 70) || 70
);
const GROUP_COMMAND_SUBBOT_MAX_DELAY_MS = Math.max(
  60,
  parseNumberEnv("GROUP_COMMAND_SUBBOT_MAX_DELAY_MS", 850) || 850
);
const GROUP_COMMAND_SEMANTIC_DEDUP_TTL_MS = Math.max(
  15_000,
  parseNumberEnv("GROUP_COMMAND_SEMANTIC_DEDUP_TTL_MS", 90_000) || 90_000
);
const COMMAND_REPLAY_CACHE_TTL_MS = Math.max(
  30_000,
  parseNumberEnv("COMMAND_REPLAY_CACHE_TTL_MS", 2 * 60 * 1000) || 2 * 60 * 1000
);
const LINKED_IDENTITY_LOG_THROTTLE_MS = Math.max(
  30_000,
  parseNumberEnv("LINKED_IDENTITY_LOG_THROTTLE_MS", 120_000) || 120_000
);
const GROUP_UPDATE_CLAIM_ENABLED = parseBooleanEnv("GROUP_UPDATE_CLAIM_ENABLED", true);
const GROUP_UPDATE_CLAIM_TTL_MS = Math.max(
  15_000,
  parseNumberEnv("GROUP_UPDATE_CLAIM_TTL_MS", 120_000) || 120_000
);
const GROUP_UPDATE_CLAIM_CLEANUP_INTERVAL_MS = Math.max(
  20_000,
  parseNumberEnv("GROUP_UPDATE_CLAIM_CLEANUP_INTERVAL_MS", 90_000) || 90_000
);
const GROUP_RESPONDER_NOTICE_ENABLED = parseBooleanEnv("GROUP_RESPONDER_NOTICE_ENABLED", true);
const GROUP_RESPONDER_NOTICE_COOLDOWN_MS = Math.max(
  60_000,
  parseNumberEnv("GROUP_RESPONDER_NOTICE_COOLDOWN_MS", 10 * 60 * 1000) || 10 * 60 * 1000
);
const GROUP_RESPONDER_ENTRY_NOTICE_COOLDOWN_MS = Math.max(
  2 * 60 * 1000,
  parseNumberEnv("GROUP_RESPONDER_ENTRY_NOTICE_COOLDOWN_MS", 6 * 60 * 60 * 1000) ||
    6 * 60 * 60 * 1000
);

function scheduleUsageStatsSave() {
  if (usageStatsSaveTimer) return;

  usageStatsSaveTimer = setTimeout(() => {
    usageStatsSaveTimer = null;

    try {
      writeAtomicJsonFile(USAGE_STATS_FILE, usageStats);
    } catch {}
  }, 2000);

  usageStatsSaveTimer.unref?.();
}

function incrementUsageCounter(container, key, updates = {}) {
  if (!key) return;

  const current = isPlainObject(container[key]) ? container[key] : {};
  const next = { ...current };

  for (const [field, incrementBy] of Object.entries(updates)) {
    next[field] = Number(next[field] || 0) + Number(incrementBy || 0);
  }

  container[key] = next;
}

function trackMessageUsage(botState, message) {
  const senderId = normalizeJidUser(message?.sender || "");
  const chatId = String(message?.from || "").trim();
  const botId = String(botState?.config?.id || "main");

  usageStats.totalMessages += 1;
  incrementUsageCounter(usageStats.chatUsage, chatId, {
    messages: 1,
    commands: 0,
  });
  incrementUsageCounter(usageStats.userUsage, senderId, {
    messages: 1,
    commands: 0,
  });
  incrementUsageCounter(usageStats.botUsage, botId, {
    messages: 1,
    commands: 0,
  });
  recordWeeklyMessage({
    userId: senderId,
    chatId,
  });
  scheduleUsageStatsSave();
}

function trackCommandUsage(botState, message, commandName) {
  const senderId = normalizeJidUser(message?.sender || "");
  const chatId = String(message?.from || "").trim();
  const botId = String(botState?.config?.id || "main");
  const normalizedCommand = String(commandName || "").trim().toLowerCase();

  usageStats.totalCommands += 1;
  usageStats.commandUsage[normalizedCommand] =
    Number(usageStats.commandUsage[normalizedCommand] || 0) + 1;
  incrementUsageCounter(usageStats.chatUsage, chatId, { commands: 1 });
  incrementUsageCounter(usageStats.userUsage, senderId, { commands: 1 });
  incrementUsageCounter(usageStats.botUsage, botId, { commands: 1 });
  recordWeeklyCommand({
    userId: senderId,
    chatId,
    commandName: normalizedCommand,
  });
  scheduleUsageStatsSave();
}

function sortUsageMap(container = {}, field, limit = 5) {
  return Object.entries(container)
    .map(([id, value]) => ({
      id,
      value: Number(value?.[field] || 0),
      meta: value,
    }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function getUsageStatsSnapshot(limit = 5) {
  return {
    trackedSince: usageStats.trackedSince,
    totalMessages: Number(usageStats.totalMessages || 0),
    totalCommands: Number(usageStats.totalCommands || 0),
    messagesByType: {
      ...mensajesPorTipo,
    },
    topCommands: Object.entries(usageStats.commandUsage || {})
      .map(([command, count]) => ({
        command,
        count: Number(count || 0),
      }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, limit),
    topChatsByMessages: sortUsageMap(usageStats.chatUsage, "messages", limit),
    topChatsByCommands: sortUsageMap(usageStats.chatUsage, "commands", limit),
    topUsersByMessages: sortUsageMap(usageStats.userUsage, "messages", limit),
    topUsersByCommands: sortUsageMap(usageStats.userUsage, "commands", limit),
    bots: sortUsageMap(usageStats.botUsage, "commands", limit),
  };
}

// ================= CONSOLA =================

global.consoleBuffer = [];
global.MAX_CONSOLE_LINES = 120;

function pushConsole(level, args) {
  const line =
    `[${new Date().toLocaleString()}] [${level}] ` +
    args
      .map((value) => {
        try {
          if (value instanceof Error) return value.stack;
          if (typeof value === "string") return value;
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })
      .join(" ");

  global.consoleBuffer.push(line);

  if (global.consoleBuffer.length > global.MAX_CONSOLE_LINES) {
    global.consoleBuffer.shift();
  }
}

function shouldIgnoreError(value) {
  const txt = String(value || "");
  const lower = txt.toLowerCase();
  return (
    txt.includes("Bad MAC") ||
    txt.includes("SessionCipher") ||
    txt.includes("Failed to decrypt message with any known session") ||
    txt.includes("No session record") ||
    txt.includes("Closing open session in favor of incoming prekey bundle") ||
    lower.includes("messagecountererror") ||
    lower.includes("key used already or never filled")
  );
}

function normalizeRuntimeErrorText(value) {
  if (value instanceof Error) {
    return String(
      `${value.message || ""} ${value.stack || ""} ${value.name || ""}`
    )
      .trim()
      .toLowerCase();
  }

  if (typeof value === "object" && value) {
    try {
      return JSON.stringify(value).toLowerCase();
    } catch {}
  }

  return String(value || "").trim().toLowerCase();
}

function isTransientRuntimeError(value) {
  const txt = normalizeRuntimeErrorText(value);
  if (!txt) return false;

  const transientTokens = [
    "timeout",
    "timed out",
    "etimedout",
    "econnreset",
    "socket hang up",
    "eai_again",
    "enotfound",
    "network error",
    "connection closed",
    "stream error",
    "service unavailable",
    "temporarily unavailable",
    "websocket is not open",
    "device sent no auth",
    "not-authorized",
    "conflict",
    "messagecountererror",
    "key used already or never filled",
    "precondition required",
  ];

  return transientTokens.some((token) => txt.includes(token));
}

const log = console.log;
const warn = console.warn;
const error = console.error;

console.log = (...args) => {
  pushConsole("LOG", args);
  log(chalk.cyan("[LOG]"), ...args);
};

console.warn = (...args) => {
  pushConsole("WARN", args);
  warn(chalk.yellow("[WARN]"), ...args);
};

console.error = (...args) => {
  if (shouldIgnoreError(args[0])) return;
  pushConsole("ERROR", args);
  error(chalk.red("[ERROR]"), ...args);
};

// ================= ANTI CRASH =================

const fatalRuntimeErrors = [];

function recordFatalRuntimeError(kind, payload) {
  if (isTransientRuntimeError(payload)) {
    console.warn(
      `[FATAL_GUARD] ${kind} transitorio detectado. No reinicio global.`,
      payload
    );
    return;
  }

  const now = Date.now();
  fatalRuntimeErrors.push(now);

  while (
    fatalRuntimeErrors.length &&
    now - Number(fatalRuntimeErrors[0] || 0) > FATAL_ERROR_WINDOW_MS
  ) {
    fatalRuntimeErrors.shift();
  }

  if (fatalRuntimeErrors.length < FATAL_ERROR_THRESHOLD) {
    return;
  }

  fatalRuntimeErrors.length = 0;
  console.error(
    `[FATAL_GUARD] Demasiados ${kind} en poco tiempo. Reiniciando proceso...`,
    payload
  );
  scheduleProcessRestart(2000);
}

process.on("unhandledRejection", (reason) => {
  if (shouldIgnoreError(reason)) return;
  console.error(reason);
  recordFatalRuntimeError("unhandledRejection", reason);
});

process.on("uncaughtException", (err) => {
  if (shouldIgnoreError(err?.message || err)) return;
  console.error(err);
  recordFatalRuntimeError("uncaughtException", err);
});

// ================= HELPERS BOT =================

function getBotTag(value) {
  const config = value?.config || value;
  const label = String(config?.label || "BOT").trim() || "BOT";
  return `[${label}]`;
}

function getBotSlotNumber(value) {
  const config = value?.config || value;
  const slot = Number(config?.slot || 0);
  return Number.isInteger(slot) && slot >= 1 ? slot : 0;
}

function formatLogTime(timestamp = Date.now()) {
  const date = new Date(Number(timestamp || Date.now()));
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function wrapConsoleText(value = "", maxWidth = 72) {
  const source = String(value || "").trim();
  if (!source) {
    return ["-"];
  }

  const lines = [];
  let remaining = source;

  while (remaining.length > maxWidth) {
    let cutAt = remaining.lastIndexOf(" ", maxWidth);
    if (cutAt < Math.floor(maxWidth * 0.55)) {
      cutAt = maxWidth;
    }

    lines.push(remaining.slice(0, cutAt).trim());
    remaining = remaining.slice(cutAt).trim();
  }

  if (remaining) {
    lines.push(remaining);
  }

  return lines.length ? lines : ["-"];
}

function nextRuntimeRequestId(prefix = "req") {
  runtimeRequestCounter = (Number(runtimeRequestCounter || 0) + 1) % 1_000_000;
  const ts = Date.now().toString(36);
  const seq = String(runtimeRequestCounter).padStart(4, "0");
  return `${prefix}-${ts}-${seq}`;
}

function ensureStructuredLogStream() {
  if (!STRUCTURED_LOG_ENABLED) return null;
  if (structuredLogStream) return structuredLogStream;
  try {
    fs.mkdirSync(RUNTIME_LOG_DIR, { recursive: true });
    structuredLogStream = fs.createWriteStream(STRUCTURED_LOG_FILE, {
      flags: "a",
      encoding: "utf8",
    });
    structuredLogStream.on("error", () => {
      runtimeMetrics.logs.dropped += 1;
      structuredLogStream = null;
    });
  } catch {
    structuredLogStream = null;
  }
  return structuredLogStream;
}

function appendStructuredLog(entry = {}) {
  const stream = ensureStructuredLogStream();
  if (!stream) return;
  try {
    const line = `${JSON.stringify(entry)}\n`;
    stream.write(line);
    runtimeMetrics.logs.written += 1;
  } catch {
    runtimeMetrics.logs.dropped += 1;
  }
}

function getCommandMetricEntry(commandName = "") {
  const key = String(commandName || "unknown").trim().toLowerCase() || "unknown";
  const container = runtimeMetrics.commands.byName;
  if (!container[key]) {
    container[key] = {
      started: 0,
      success: 0,
      error: 0,
      timeout: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
    };
  }
  return container[key];
}

function recordCommandMetricStart(commandName = "") {
  runtimeMetrics.commands.started += 1;
  runtimeMetrics.commands.active += 1;
  const entry = getCommandMetricEntry(commandName);
  entry.started += 1;
}

function recordCommandMetricFinish(commandName = "", status = "success", durationMs = 0) {
  const normalizedStatus = String(status || "success").trim().toLowerCase();
  const safeDuration = Math.max(0, Number(durationMs || 0));

  runtimeMetrics.commands.active = Math.max(0, Number(runtimeMetrics.commands.active || 0) - 1);
  runtimeMetrics.commands.totalDurationMs += safeDuration;
  runtimeMetrics.commands.maxDurationMs = Math.max(
    Number(runtimeMetrics.commands.maxDurationMs || 0),
    safeDuration
  );

  if (normalizedStatus === "timeout") {
    runtimeMetrics.commands.timeout += 1;
  } else if (normalizedStatus === "error") {
    runtimeMetrics.commands.error += 1;
  } else {
    runtimeMetrics.commands.success += 1;
  }

  const entry = getCommandMetricEntry(commandName);
  entry.totalDurationMs += safeDuration;
  entry.maxDurationMs = Math.max(Number(entry.maxDurationMs || 0), safeDuration);
  if (normalizedStatus === "timeout") {
    entry.timeout += 1;
  } else if (normalizedStatus === "error") {
    entry.error += 1;
  } else {
    entry.success += 1;
  }
}

function logBotEvent(value, level = "info", message = "", metadata = {}) {
  const config = value?.config || value || {};
  const tag = String(config?.label || "BOT")
    .trim()
    .toUpperCase()
    .slice(0, 12);
  const normalizedLevel = String(level || "info").trim().toLowerCase();
  const messageText = String(message || "").trim();
  const requestId = String(metadata?.requestId || "").trim();
  const extraText = requestId ? ` [${requestId}]` : "";
  const timeText = chalk.magentaBright(`[${formatLogTime()}]`);
  const tagText = chalk.cyanBright(`[${tag}]`);

  appendStructuredLog({
    ts: new Date().toISOString(),
    level: normalizedLevel,
    bot: tag,
    message: messageText,
    requestId: requestId || undefined,
    meta: isPlainObject(metadata) ? metadata : undefined,
  });

  if (normalizedLevel === "error") {
    console.log(`${timeText} ${tagText} ${chalk.redBright("[ERROR]")} ${chalk.redBright(`${messageText}${extraText}`)}`);
    return;
  }

  if (normalizedLevel === "warn") {
    console.log(`${timeText} ${tagText} ${chalk.yellowBright("[WARN ]")} ${chalk.yellowBright(`${messageText}${extraText}`)}`);
    return;
  }

  if (normalizedLevel === "success") {
    console.log(`${timeText} ${tagText} ${chalk.greenBright("[ OK  ]")} ${chalk.greenBright(`${messageText}${extraText}`)}`);
    return;
  }

  console.log(`${timeText} ${tagText} ${chalk.blueBright("[INFO ]")} ${chalk.cyanBright(`${messageText}${extraText}`)}`);
}

function createStoreForBot(botId) {
  if (typeof makeInMemoryStore !== "function") return null;

  const store = makeInMemoryStore({ logger });
  const storeFile = path.join(TMP_DIR, `baileys_store_${botId}.json`);

  try {
    if (store?.readFromFile && fs.existsSync(storeFile)) {
      store.readFromFile(storeFile);
    }
  } catch {}

  if (store?.writeToFile) {
    const timer = setInterval(() => {
      try {
        store.writeToFile(storeFile);
      } catch {}
    }, 10000);

    timer.unref?.();
    store.__writeTimer = timer;
  }

  return store;
}

function formatTimeoutSeconds(ms) {
  const seconds = Math.max(1, Math.ceil(Number(ms || 0) / 1000));
  return `${seconds}s`;
}

function buildTaskTimeoutError(label, timeoutMs) {
  const error = new Error(
    `${label} supero el tiempo limite (${formatTimeoutSeconds(timeoutMs)}).`
  );
  error.code = "TASK_TIMEOUT";
  error.timeoutMs = Number(timeoutMs || 0);
  return error;
}

function isTaskTimeoutError(error) {
  return String(error?.code || "").trim().toUpperCase() === "TASK_TIMEOUT";
}

function createTaskAbortController() {
  try {
    return typeof AbortController === "function" ? new AbortController() : null;
  } catch {
    return null;
  }
}

function runTaskWithTimeout(label, timeoutMs, task, options = {}) {
  const effectiveTimeout = Number(timeoutMs || 0);
  const abortController = options?.abortController || null;

  if (!Number.isFinite(effectiveTimeout) || effectiveTimeout <= 0) {
    return Promise.resolve().then(task);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      const timeoutError = buildTaskTimeoutError(label, effectiveTimeout);

      if (abortController && typeof abortController.abort === "function") {
        try {
          abortController.abort(timeoutError);
        } catch {
          try {
            abortController.abort();
          } catch {}
        }
      }

      reject(timeoutError);
    }, effectiveTimeout);

    timer.unref?.();

    Promise.resolve()
      .then(task)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) {
          console.error(`${label} termino con error despues del timeout:`, error);
          return;
        }

        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

function markBotSocketActivity(botState, eventLabel = "") {
  if (!botState) return;
  botState.lastSocketEventAt = Date.now();
  if (eventLabel) {
    botState.lastSocketEvent = String(eventLabel || "").trim().slice(0, 120);
  }
}

function markBotSendSuccess(botState) {
  if (!botState) return;
  botState.lastSendSuccessAt = Date.now();
  botState.lastSendErrorAt = 0;
  botState.lastSendError = "";
}

function markBotSendError(botState, error) {
  if (!botState) return;
  botState.lastSendErrorAt = Date.now();
  botState.lastSendError = String(
    error?.message || error || "error desconocido"
  ).slice(0, 220);
}

function setActiveCommandAbortController(botState, abortController) {
  if (!botState) return;
  botState.activeCommandAbortController = abortController || null;
}

function abortActiveCommand(botState, reason = "cancelled") {
  const abortController = botState?.activeCommandAbortController;
  if (!abortController || typeof abortController.abort !== "function") {
    return false;
  }

  try {
    if (!abortController.signal?.aborted) {
      abortController.abort(new Error(String(reason || "cancelled")));
    }
  } catch {
    try {
      abortController.abort();
    } catch {}
  }

  return true;
}

function clearActiveCommandState(botState) {
  if (!botState) return;
  botState.activeCommandName = "";
  botState.activeCommandStartedAt = 0;
  botState.activeCommandTimeoutMs = 0;
  botState.activeCommandAbortController = null;
}

function startCommandTracking(botState, commandName, timeoutMs) {
  if (!botState) return;

  const startedAt = Date.now();
  const normalizedCommand = String(commandName || "").trim();

  botState.lastCommandName = normalizedCommand;
  botState.lastCommandStartedAt = startedAt;
  botState.activeCommandName = normalizedCommand;
  botState.activeCommandStartedAt = startedAt;
  botState.activeCommandTimeoutMs = Number(timeoutMs || 0);
}

function finishCommandTracking(botState, commandName, status = "ok") {
  if (!botState) return;

  const finishedAt = Date.now();
  const startedAt = Number(
    botState.activeCommandStartedAt || botState.lastCommandStartedAt || 0
  );

  botState.lastCommandName =
    String(commandName || botState.lastCommandName || "").trim();
  botState.lastCommandFinishedAt = finishedAt;
  botState.lastCommandStatus = String(status || "ok").trim() || "ok";
  botState.lastCommandDurationMs = startedAt
    ? Math.max(0, finishedAt - startedAt)
    : 0;

  if (status === "timeout") {
    botState.lastCommandTimedOutAt = finishedAt;
  }

  clearActiveCommandState(botState);
}

function resolveCommandTimeout(cmd) {
  const explicitTimeout = Number(cmd?.timeoutMs || 0);
  if (Number.isFinite(explicitTimeout) && explicitTimeout > 0) {
    return explicitTimeout;
  }

  return isDownloadCommand(cmd)
    ? DOWNLOAD_COMMAND_TIMEOUT_MS
    : COMMAND_TIMEOUT_MS;
}

function wrapSocketSendMessage(botState, sock) {
  if (!sock || sock.__dvyerWrappedSendMessage) {
    return sock;
  }

  const originalSendMessage =
    typeof sock.sendMessage === "function" ? sock.sendMessage.bind(sock) : null;

  if (!originalSendMessage) {
    return sock;
  }

  sock.sendMessage = async (...args) => {
    markBotSocketActivity(botState, "sendMessage");

    try {
      const result = await originalSendMessage(...args);
      markBotSendSuccess(botState);
      return result;
    } catch (error) {
      markBotSendError(botState, error);
      throw error;
    }
  };

  sock.__dvyerWrappedSendMessage = true;
  return sock;
}

function hasPairingSocketProgress(botState, sock) {
  if (!botState || !sock || botState.sock !== sock) {
    return false;
  }

  const connectionState = String(botState.connectionState || "")
    .trim()
    .toLowerCase();
  const lastEvent = String(botState.lastSocketEvent || "")
    .trim()
    .toLowerCase();

  if (connectionState === "connecting" || connectionState === "open") {
    return true;
  }

  return (
    lastEvent === "connection.qr" ||
    lastEvent === "connection.connecting" ||
    lastEvent === "connection.open"
  );
}

async function waitForPairingSocketProgress(
  botState,
  sock,
  timeoutMs = PAIRING_SOCKET_WAIT_MS
) {
  const timeoutAt = Date.now() + Math.max(1000, Number(timeoutMs || 0));

  while (Date.now() < timeoutAt) {
    if (!botState || botState.sock !== sock) {
      return false;
    }

    if (hasPairingSocketProgress(botState, sock)) {
      return true;
    }

    await delay(250);
  }

  return hasPairingSocketProgress(botState, sock);
}

async function sendCommandTimeoutNotice(context, error) {
  if (!context?.sock || !context?.from) return;

  try {
    const timeoutMs = Number(error?.timeoutMs || 0);
    const commandName = String(
      context.commandName || context.cmd?.name || "comando"
    ).trim();

    await context.sock.sendMessage(
      context.from,
      {
        text:
          `El comando *${commandName || "comando"}* tardo demasiado y fue detenido.\n` +
          `Tiempo limite: *${formatTimeoutSeconds(timeoutMs)}*\n` +
          `Puedes intentarlo otra vez en unos segundos.`,
        ...global.channelInfo,
      },
      getQuoteOptions(context.msg)
    );
  } catch (notifyError) {
    console.error("No pude avisar el timeout del comando:", notifyError);
  }
}

function getSafeCommandErrorText(error) {
  const raw = String(error?.message || error || "").trim();
  const lower = raw.toLowerCase();

  if (
    lower.includes("internal ") ||
    lower.includes("http 4") ||
    lower.includes("http 5") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("econnreset") ||
    lower.includes("eai_again") ||
    lower.includes("socket hang up")
  ) {
    return "Error temporal del proveedor. Intenta de nuevo en unos segundos.";
  }

  if (lower.includes("not a group") || lower.includes("solo funciona en grupos")) {
    return "Este comando necesita un chat de grupo para funcionar.";
  }

  if (!raw) {
    return "Ocurrio un error inesperado al ejecutar el comando.";
  }

  return raw.slice(0, 160);
}

function getOwnerAlertTargets() {
  const targets = [];

  for (const ownerId of OWNER_IDS || []) {
    const ownerJid = String(ownerId || "").trim();
    if (!ownerJid) continue;

    if (ownerJid.endsWith("@s.whatsapp.net")) {
      targets.push(ownerJid);
      continue;
    }

    if (ownerJid.endsWith("@lid")) {
      targets.push(ownerJid);
      continue;
    }
  }

  return Array.from(new Set(targets));
}

async function sendVisibleCommandErrorNotice(botState, context, error) {
  if (!context?.sock || !context?.from) return;
  if (isTaskTimeoutError(error)) return;

  const visibility = getErrorVisibilityState();
  if (!visibility.enabled) return;

  const commandName = String(
    context?.commandName || context?.cmd?.name || "comando"
  ).trim();
  const userText = getSafeCommandErrorText(error);

  try {
    await context.sock.sendMessage(
      context.from,
      {
        text:
          `⚠️ Ocurrio un error en *${commandName || "comando"}*.\n` +
          `${userText}`,
        ...global.channelInfo,
      },
      getQuoteOptions(context.msg)
    );
  } catch {}

  if (!visibility.ownerDetails || context.esOwner) {
    return;
  }

  const targets = getOwnerAlertTargets().slice(0, 3);
  if (!targets.length) return;

  const detailText =
    `🧩 *ERROR BOT (${String(botState?.config?.label || "MAIN")})*\n\n` +
    `Comando: *${commandName || "desconocido"}*\n` +
    `Chat: *${String(context.from || "-").slice(0, 120)}*\n` +
    `Sender: *${String(context.sender || "-").slice(0, 120)}*\n` +
    `Detalle: ${String(error?.message || error || "sin detalle").slice(0, 900)}`;

  for (const target of targets) {
    try {
      await context.sock.sendMessage(target, {
        text: detailText,
        ...global.channelInfo,
      });
    } catch {}
  }
}

function ensureBotState(config) {
  const existing = botStates.get(config.id);
  if (existing) {
    existing.config = {
      ...existing.config,
      ...config,
    };
    return existing;
  }

  const state = {
    config,
    sock: null,
    authState: null,
    connecting: false,
    connectedAt: 0,
    lastDisconnectAt: 0,
    pairingRequested: false,
    pairingResetTimer: null,
    pairingCommandHintShown: false,
    lastPairingCode: "",
    lastPairingNumber: "",
    lastPairingAt: 0,
    replacementBlocked: false,
    replacementBlockedAt: 0,
    replacementBlockedUntil: 0,
    reconnectAttempts: 0,
    lastReconnectScheduledAt: 0,
    lastReconnectDelayMs: 0,
    lastReconnectReason: "",
    lastProfileSignature: "",
    lastProfileAppliedAt: 0,
    profileApplyTimer: null,
    reconnectTimer: null,
    lastConnectingLogAt: 0,
    lastUpsertLogAt: 0,
    suppressedUpsertCount: 0,
    bootStartedAt: 0,
    connectionState: "",
    lastDisconnectCode: 0,
    lastSocketEventAt: 0,
    lastSocketEvent: "",
    lastMessageUpsertAt: 0,
    lastIncomingMessageAt: 0,
    lastSendSuccessAt: 0,
    lastSendErrorAt: 0,
    lastSendError: "",
    lastPairingRequestAt: 0,
    lastPairingRequestNumber: "",
    lastPairingErrorAt: 0,
    lastPairingError: "",
    lastCommandName: "",
    lastCommandStartedAt: 0,
    lastCommandFinishedAt: 0,
    lastCommandDurationMs: 0,
    lastCommandStatus: "",
    lastCommandTimedOutAt: 0,
    activeCommandName: "",
    activeCommandStartedAt: 0,
    activeCommandTimeoutMs: 0,
    activeCommandAbortController: null,
    groupCache: new Map(),
    contactNameCache: new Map(),
    recentMessageIds: new Map(),
    store: createStoreForBot(config.id),
    activeDownloadJobs: new Map(),
    downloadQueueCounter: 0,
    groupResponderState: new Map(),
    groupJoinNoticeCache: new Map(),
    groupUpdateClaimCache: new Map(),
    commandReplayCache: new Map(),
    linkedIdentityLeaderLogAt: 0,
    persistedStateWriteTimer: null,
    persistedStateWritePending: false,
    socketRecoveryTimer: null,
    managedStopDeferredAt: 0,
    lastManagedStopDecisionReason: "",
    lastManagedStopDecisionAt: 0,
  };

  botStates.set(config.id, state);
  return state;
}

function clearReplacementBlock(botState) {
  if (!botState) return;
  botState.replacementBlocked = false;
  botState.replacementBlockedAt = 0;
  botState.replacementBlockedUntil = 0;
}

function clearProfileApplyTimer(botState) {
  if (!botState?.profileApplyTimer) return;

  try {
    clearTimeout(botState.profileApplyTimer);
  } catch {}

  botState.profileApplyTimer = null;
}

function markReplacementBlocked(botState) {
  if (!botState) return;
  botState.replacementBlocked = true;
  botState.replacementBlockedAt = Date.now();
  botState.replacementBlockedUntil = botState.replacementBlockedAt + SESSION_REPLACED_BLOCK_MS;
}

function isReplacementBlocked(botState) {
  if (!botState?.replacementBlocked) {
    return false;
  }

  const blockedUntil = Number(botState?.replacementBlockedUntil || 0);
  if (!blockedUntil || Date.now() < blockedUntil) {
    return true;
  }

  clearReplacementBlock(botState);
  return false;
}

function readRawPersistedBotRuntimeState(botId) {
  try {
    const state = safeReadJson(getBotRuntimeStateFile(botId), null);
    return state && typeof state === "object" ? state : null;
  } catch {
    return null;
  }
}

function isPersistedReplacementBlocked(botId) {
  const persisted = readRawPersistedBotRuntimeState(botId);
  if (!persisted?.replacementBlocked) {
    return false;
  }

  const blockedUntil = Number(persisted?.replacementBlockedUntil || 0);
  return Boolean(blockedUntil && Date.now() < blockedUntil);
}

function applyReconnectJitter(baseDelayMs = 0) {
  const base = Math.max(1000, Number(baseDelayMs || 0));
  const spread = Math.max(0, Math.floor(base * RECONNECT_JITTER_RATIO));

  if (spread <= 0) {
    return base;
  }

  const offset = Math.floor(Math.random() * (spread * 2 + 1)) - spread;
  return Math.max(1000, base + offset);
}

function getSubbotReconnectOffsetMs(botState) {
  if (String(botState?.config?.id || "").trim().toLowerCase() === "main") {
    return 0;
  }

  const slot = getBotSlotNumber(botState);
  if (!slot) {
    return Math.floor(SUBBOT_RECONNECT_STAGGER_MS / 2);
  }

  return Math.min(
    SUBBOT_RECONNECT_STAGGER_MAX_MS,
    Math.max(0, slot - 1) * SUBBOT_RECONNECT_STAGGER_MS
  );
}

function getReconnectDelay(botState, options = false) {
  const loggedOut =
    typeof options === "boolean" ? options : Boolean(options?.loggedOut);
  const closeCode =
    typeof options === "object" && options !== null
      ? Number(options.closeCode || 0)
      : 0;
  const subbotOffset = getSubbotReconnectOffsetMs(botState);

  if (loggedOut) {
    botState.reconnectAttempts = 0;
    const loggedOutDelay = Math.max(4000, RECONNECT_CODE0_MIN_DELAY_MS) + subbotOffset;
    return applyReconnectJitter(loggedOutDelay);
  }

  const attempts = Math.max(1, Math.min(8, Number(botState?.reconnectAttempts || 0) + 1));
  botState.reconnectAttempts = attempts;

  let baseDelayMs = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * 2 ** (attempts - 1)
  );

  if (closeCode === 0) {
    baseDelayMs = Math.max(baseDelayMs, RECONNECT_CODE0_MIN_DELAY_MS);
  }

  baseDelayMs += subbotOffset;
  return applyReconnectJitter(Math.min(RECONNECT_MAX_DELAY_MS, baseDelayMs));
}

function logMessageUpsertEvent(botState, type, count) {
  const now = Date.now();
  const normalizedCount = Math.max(0, Number(count || 0));
  const typeLabel = String(type || "unknown").trim().toLowerCase() || "unknown";
  const elapsed = now - Number(botState?.lastUpsertLogAt || 0);
  botState.suppressedUpsertCount = Number(botState?.suppressedUpsertCount || 0) + normalizedCount;
  botState.lastUpsertType = typeLabel;

  if (elapsed < MESSAGE_UPSERT_LOG_THROTTLE_MS) {
    return;
  }

  const totalInWindow = Number(botState?.suppressedUpsertCount || 0);
  botState.suppressedUpsertCount = 0;
  botState.lastUpsertLogAt = now;

  if (totalInWindow < MESSAGE_UPSERT_SUMMARY_MIN_COUNT) {
    return;
  }

  const seconds = Math.max(1, Math.round(elapsed / 1000));
  logBotEvent(
    botState,
    "info",
    `Actividad mensajes: +${totalInWindow} eventos (${botState.lastUpsertType}) en ${seconds}s`
  );
}

function getDisconnectReasonText(lastDisconnect = null) {
  const candidates = [
    lastDisconnect?.error?.output?.payload?.message,
    lastDisconnect?.error?.output?.payload?.error?.message,
    typeof lastDisconnect?.error?.output?.payload?.error === "string"
      ? lastDisconnect?.error?.output?.payload?.error
      : "",
    lastDisconnect?.error?.message,
    typeof lastDisconnect?.error?.toString === "function"
      ? lastDisconnect.error.toString()
      : "",
  ];

  for (const value of candidates) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }

  return "";
}

function getDisconnectStatusCode(lastDisconnect = null) {
  const candidates = [
    lastDisconnect?.error?.output?.statusCode,
    lastDisconnect?.error?.data?.statusCode,
    lastDisconnect?.error?.output?.payload?.statusCode,
    lastDisconnect?.error?.statusCode,
    lastDisconnect?.statusCode,
  ];

  for (const value of candidates) {
    const code = Number(value);
    if (Number.isFinite(code) && code > 0) {
      return code;
    }
  }

  const reasonText = getDisconnectReasonText(lastDisconnect);
  if (!reasonText) {
    return 0;
  }

  if (/logged\s*out/i.test(reasonText)) {
    return Number(DisconnectReason.loggedOut || 401) || 401;
  }

  if (/connection\s*replaced|replaced\s*by\s*new/i.test(reasonText)) {
    return Number(DisconnectReason.connectionReplaced || 440) || 440;
  }

  const explicitCode = reasonText.match(/\b(4\d{2}|5\d{2})\b/);
  if (explicitCode?.[1]) {
    return Number(explicitCode[1]) || 0;
  }

  return 0;
}

function refreshBotConfigCache() {
  ensureSubbotSettings(settings);
  ensureSystemSettings(settings);
  SUBBOT_SLOT_CONFIGS = buildSubbotSlotConfigs(settings);
  BOT_CONFIGS = buildBotConfigs(settings);
  OWNER_IDS = buildOwnerIds(settings);
  refreshChannelInfo();

  const knownConfigs = [
    buildMainBotConfig(settings),
    ...SUBBOT_SLOT_CONFIGS,
  ];

  for (const config of knownConfigs) {
    ensureBotState(config);
  }

  return {
    subbots: SUBBOT_SLOT_CONFIGS,
    bots: BOT_CONFIGS,
  };
}

function saveSubbotSlotConfig(slotNumber, updates = {}) {
  const slot = Number(slotNumber);
  if (
    !Number.isInteger(slot) ||
    slot < 1 ||
    slot > getConfiguredSubbotSlotsCount(settings)
  ) {
    return null;
  }

  ensureSubbotSettings(settings);

  const currentConfig = getSubbotConfigBySlot(slot) || normalizeSubbotSlotConfig({}, slot, settings);
  const nextConfig = normalizeSubbotSlotConfig(
    {
      ...currentConfig,
      ...updates,
    },
    slot,
    settings,
    settings.subbot
  );

  settings.subbots[slot - 1] = {
    slot: nextConfig.slot,
    enabled: nextConfig.enabled,
    label: nextConfig.label,
    name: nextConfig.name,
    authFolder: nextConfig.authFolder,
    pairingNumber: nextConfig.pairingNumber,
    requesterNumber: nextConfig.requesterNumber,
    requesterJid: nextConfig.requesterJid,
    requestedAt: nextConfig.requestedAt,
    releasedAt: nextConfig.releasedAt,
  };

  saveSettingsFile();
  refreshBotConfigCache();

  return getSubbotConfigBySlot(slot);
}

function cachedGroupMetadata(botState, jid) {
  if (!(botState?.groupCache instanceof Map)) {
    return undefined;
  }

  const entry = botState.groupCache.get(jid);
  if (!entry) return undefined;

  if (
    entry &&
    typeof entry === "object" &&
    Object.prototype.hasOwnProperty.call(entry, "metadata")
  ) {
    const cachedAt = Number(entry.cachedAt || 0);

    if (cachedAt > 0 && Date.now() - cachedAt > GROUP_METADATA_CACHE_TTL_MS) {
      botState.groupCache.delete(jid);
      return undefined;
    }

    return entry.metadata || undefined;
  }

  return entry || undefined;
}

function pruneGroupMetadataCache(botState) {
  if (!(botState?.groupCache instanceof Map) || !botState.groupCache.size) {
    return;
  }

  const now = Date.now();

  for (const [jid, entry] of botState.groupCache) {
    if (!entry) {
      botState.groupCache.delete(jid);
      continue;
    }

    if (
      entry &&
      typeof entry === "object" &&
      Object.prototype.hasOwnProperty.call(entry, "metadata")
    ) {
      const cachedAt = Number(entry.cachedAt || 0);

      if (cachedAt > 0 && now - cachedAt > GROUP_METADATA_CACHE_TTL_MS) {
        botState.groupCache.delete(jid);
      }
    }
  }

  while (botState.groupCache.size > GROUP_METADATA_CACHE_MAX_ENTRIES) {
    const oldestKey = botState.groupCache.keys().next().value;
    if (!oldestKey) break;
    botState.groupCache.delete(oldestKey);
  }
}

function cacheGroupMetadata(botState, jid, metadata) {
  if (!jid || !metadata) return metadata;

  if (!(botState?.groupCache instanceof Map)) {
    botState.groupCache = new Map();
  }

  if (botState.groupCache.has(jid)) {
    botState.groupCache.delete(jid);
  }

  botState.groupCache.set(jid, {
    metadata,
    cachedAt: Date.now(),
  });
  pruneGroupMetadataCache(botState);
  return metadata;
}

function getQuoteOptions(message) {
  return message?.key ? { quoted: message } : undefined;
}

function isBotRegistered(botState) {
  return Boolean(botState?.authState?.creds?.registered);
}

function clearReconnectTimer(botState) {
  if (!botState?.reconnectTimer) return;
  clearTimeout(botState.reconnectTimer);
  botState.reconnectTimer = null;
}

function clearSocketRecoveryTimer(botState) {
  if (!botState?.socketRecoveryTimer) return;
  clearTimeout(botState.socketRecoveryTimer);
  botState.socketRecoveryTimer = null;
}

function removeAuthFolder(authFolder) {
  if (!String(authFolder || "").trim()) return;

  try {
    fs.rmSync(authFolder, { recursive: true, force: true });
  } catch {}
}

function releaseSubbotSlot(botState, options = {}) {
  if (!botState || botState?.config?.id === "main") {
    return false;
  }

  const slot = Number(botState?.config?.slot || 0);
  if (
    !Number.isInteger(slot) ||
    slot < 1 ||
    slot > getConfiguredSubbotSlotsCount(settings)
  ) {
    return false;
  }

  const releaseAt = Date.now();
  const currentConfig = getSubbotConfigBySlot(slot) || botState.config;

  clearReconnectTimer(botState);
  clearPairingResetTimer(botState);
  clearProfileApplyTimer(botState);
  abortActiveDownloadJobs(botState, "subbot_slot_released");

  if (options?.closeSocket !== false) {
    try {
      botState.sock?.end?.();
    } catch {}
  }

  if (options?.resetAuthFolder !== false) {
    removeAuthFolder(currentConfig?.authFolder || botState?.config?.authFolder);
  }

  const releasedConfig =
    saveSubbotSlotConfig(slot, {
      enabled: false,
      pairingNumber: "",
      requesterNumber: "",
      requesterJid: "",
      requestedAt: 0,
      releasedAt: releaseAt,
    }) || currentConfig;

  botState.sock = null;
  botState.authState = null;
  botState.connecting = false;
  botState.connectedAt = 0;
  botState.lastDisconnectAt = releaseAt;
  botState.lastDisconnectCode = 0;
  botState.pairingRequested = false;
  botState.pairingCommandHintShown = false;
  botState.lastPairingCode = "";
  botState.lastPairingNumber = "";
  botState.lastPairingAt = 0;
  botState.lastPairingRequestAt = 0;
  botState.lastPairingRequestNumber = "";
  botState.lastPairingErrorAt = 0;
  botState.lastPairingError = "";
  botState.connectionState = "released";
  botState.bootStartedAt = 0;
  clearActiveCommandState(botState);
  botState.config = {
    ...botState.config,
    ...releasedConfig,
    enabled: false,
    pairingNumber: "",
    requesterNumber: "",
    requesterJid: "",
    requestedAt: 0,
    releasedAt: releaseAt,
  };
  botState.groupCache?.clear?.();
  botState.contactNameCache?.clear?.();
  botState.recentMessageIds?.clear?.();
  botState.activeDownloadJobs?.clear?.();

  console.log(
    `${getBotTag(botState)} Slot liberado (${options?.reason || "sin motivo"})`
  );
  writePersistedBotRuntimeState(botState);

  if (SPLIT_PROCESS_MODE && botState?.config?.id !== "main") {
    void deleteSplitBotProcess(botState.config.id).catch(() => {});
  }

  return true;
}

function saveMainBotPairingNumber(nextNumber = "") {
  const normalized = sanitizePhoneNumber(nextNumber);

  if (normalized === sanitizePhoneNumber(settings?.pairingNumber || "")) {
    return buildMainBotConfig(settings);
  }

  settings.pairingNumber = normalized;
  saveSettingsFile();
  refreshBotConfigCache();

  return buildMainBotConfig(settings);
}

function resetMainBotSession(botState, options = {}) {
  if (!botState || botState?.config?.id !== "main") {
    return false;
  }

  const resetAt = Date.now();
  const requestedNumber =
    sanitizePhoneNumber(options?.number) ||
    sanitizePhoneNumber(botState?.config?.pairingNumber) ||
    sanitizePhoneNumber(settings?.pairingNumber) ||
    "";

  clearReconnectTimer(botState);
  clearPairingResetTimer(botState);
  clearProfileApplyTimer(botState);
  abortActiveDownloadJobs(botState, "main_session_reset");

  try {
    botState.sock?.end?.();
  } catch {}

  removeAuthFolder(botState?.config?.authFolder || buildMainBotConfig(settings)?.authFolder);

  if (requestedNumber) {
    saveMainBotPairingNumber(requestedNumber);
  }

  clearReplacementBlock(botState);
  botState.sock = null;
  botState.authState = null;
  botState.connecting = false;
  botState.connectedAt = 0;
  botState.lastDisconnectAt = resetAt;
  botState.lastDisconnectCode = 0;
  botState.pairingRequested = false;
  botState.pairingCommandHintShown = false;
  botState.lastPairingCode = "";
  botState.lastPairingNumber = "";
  botState.lastPairingAt = 0;
  botState.lastPairingRequestAt = 0;
  botState.lastPairingRequestNumber = "";
  botState.lastPairingErrorAt = 0;
  botState.lastPairingError = "";
  botState.reconnectAttempts = 0;
  botState.lastProfileSignature = "";
  botState.connectionState = "reset";
  botState.bootStartedAt = 0;
  clearActiveCommandState(botState);
  botState.groupCache?.clear?.();
  botState.contactNameCache?.clear?.();
  botState.recentMessageIds?.clear?.();
  botState.activeDownloadJobs?.clear?.();
  botState.config = {
    ...botState.config,
    ...buildMainBotConfig(settings),
    pairingNumber: requestedNumber || sanitizePhoneNumber(settings?.pairingNumber) || "",
  };

  writePersistedBotRuntimeState(botState);
  return true;
}

function createBaseContext(botState, sock, message, extra = {}) {
  return {
    sock,
    m: message,
    msg: message,
    from: message.from,
    chat: message.from,
    sender: message.sender,
    isGroup: message.isGroup,
    esGrupo: message.isGroup,
    text: message.text,
    body: message.body,
    quoted: message.quoted,
    settings,
    comandos,
    botId: botState.config.id,
    botLabel: botState.config.label,
    botName: botState.config.displayName,
    ...extra,
  };
}

async function getMessageExecutionInfo(botState, sock, message) {
  const senderId = normalizeJidUser(message.sender);
  const esOwner = OWNER_IDS.has(senderId);
  const info = {
    esOwner,
    isOwner: esOwner,
    esAdmin: false,
    isAdmin: false,
    esBotAdmin: false,
    isBotAdmin: false,
    groupMetadata: null,
  };

  if (!message.isGroup) {
    return info;
  }

  let metadata = cachedGroupMetadata(botState, message.from);
  let usedCachedMetadata = Boolean(metadata);

  if (!metadata) {
    try {
      metadata = await sock.groupMetadata(message.from);
      cacheGroupMetadata(botState, message.from, metadata);
    } catch {}
  }

  if (!metadata) {
    return info;
  }

  const participant =
    findCompatGroupParticipant(metadata, [
      message.sender,
      message.senderLid,
      message.senderPhone,
    ]) ||
    null;
  const botParticipant =
    findCompatGroupParticipant(metadata, [
      sock?.user?.id,
      normalizeJidUser(sock?.user?.id),
    ]) ||
    null;
  const needsFreshMetadata =
    usedCachedMetadata &&
    (!participant ||
      !botParticipant ||
      (!Boolean(participant?.admin) &&
        !isCompatGroupMetadataOwner(metadata, [
          message.sender,
          message.senderLid,
          message.senderPhone,
        ])));

  if (needsFreshMetadata) {
    try {
      const freshMetadata = await sock.groupMetadata(message.from);
      cacheGroupMetadata(botState, message.from, freshMetadata);
      metadata = freshMetadata;
    } catch {}
  }

  const resolvedParticipant =
    findCompatGroupParticipant(metadata, [
      message.sender,
      message.senderLid,
      message.senderPhone,
    ]) ||
    participant ||
    null;
  const resolvedBotParticipant =
    findCompatGroupParticipant(metadata, [
      sock?.user?.id,
      normalizeJidUser(sock?.user?.id),
    ]) ||
    botParticipant ||
    null;
  const esAdmin =
    Boolean(resolvedParticipant?.admin) ||
    isCompatGroupMetadataOwner(metadata, [
      message.sender,
      message.senderLid,
      message.senderPhone,
    ]);
  const esBotAdmin =
    Boolean(resolvedBotParticipant?.admin) ||
    isCompatGroupMetadataOwner(metadata, [sock?.user?.id]);

  return {
    ...info,
    esAdmin,
    isAdmin: esAdmin,
    esBotAdmin,
    isBotAdmin: esBotAdmin,
    groupMetadata: metadata,
  };
}

async function runMessageHooks(botState, context) {
  for (const cmd of messageHookModules) {
    try {
      const blocked = await runTaskWithTimeout(
        `${getBotTag(botState)} hook onMessage ${cmd?.name || "anonimo"}`,
        HOOK_TIMEOUT_MS,
        () => cmd.onMessage(context)
      );
      if (blocked) return true;
    } catch (err) {
      console.error(`${getBotTag(botState)} Error onMessage:`, err);
    }
  }

  return false;
}

async function runGroupUpdateHooks(botState, sock, update) {
  for (const cmd of groupUpdateHookModules) {
    try {
      await runTaskWithTimeout(
        `${getBotTag(botState)} hook onGroupUpdate ${cmd?.name || "anonimo"}`,
        HOOK_TIMEOUT_MS,
        () =>
          cmd.onGroupUpdate({
            sock,
            update,
            settings,
            comandos,
            botId: botState.config.id,
            botLabel: botState.config.label,
            botName: botState.config.displayName,
          })
      );
    } catch (err) {
      console.error(`${getBotTag(botState)} Error onGroupUpdate:`, err);
    }
  }
}

async function runMessageDeleteHooks(botState, sock, payload) {
  for (const cmd of messageDeleteHookModules) {
    try {
      await runTaskWithTimeout(
        `${getBotTag(botState)} hook onMessageDelete ${cmd?.name || "anonimo"}`,
        HOOK_TIMEOUT_MS,
        () =>
          cmd.onMessageDelete({
            sock,
            settings,
            comandos,
            botId: botState.config.id,
            botLabel: botState.config.label,
            botName: botState.config.displayName,
            ...payload,
          })
      );
    } catch (err) {
      console.error(`${getBotTag(botState)} Error onMessageDelete:`, err);
    }
  }
}

async function canRunCommand(cmd, context) {
  const quoted = getQuoteOptions(context.msg);

  if (cmd?.ownerOnly && !context.esOwner) {
    await context.sock.sendMessage(
      context.from,
      {
        text: "Solo el owner puede usar este comando.",
        ...global.channelInfo,
      },
      quoted
    );
    return false;
  }

  if (cmd?.groupOnly && !context.esGrupo) {
    await context.sock.sendMessage(
      context.from,
      {
        text: "Este comando solo funciona en grupos.",
        ...global.channelInfo,
      },
      quoted
    );
    return false;
  }

  if (cmd?.adminOnly && !context.esOwner && !context.esAdmin) {
    await context.sock.sendMessage(
      context.from,
      {
        text: "Solo los administradores o el owner pueden usar este comando.",
        ...global.channelInfo,
      },
      quoted
    );
    return false;
  }

  if (cmd?.botAdminOnly && context.esGrupo && !context.esBotAdmin) {
    await context.sock.sendMessage(
      context.from,
      {
        text: "Necesito ser administrador para usar este comando.",
        ...global.channelInfo,
      },
      quoted
    );
    return false;
  }

  const disabledState = isCommandTemporarilyBlocked(context.commandName || cmd?.name || "");
  if (disabledState.blocked && !context.esOwner) {
    let text =
      "Ese comando fue pausado automaticamente por errores repetidos.\n" +
      `Tiempo restante: ${Math.ceil(disabledState.remainingMs / 1000)}s`;

    if (disabledState.lastError) {
      text += `\nUltimo error: ${disabledState.lastError}`;
    }

    await context.sock.sendMessage(
      context.from,
      {
        text,
        ...global.channelInfo,
      },
      quoted
    );
    return false;
  }

  return true;
}

function getMaintenanceState() {
  const mode = normalizeMaintenanceMode(settings?.system?.maintenanceMode);
  const message = String(settings?.system?.maintenanceMessage || "").trim();

  return {
    enabled: mode !== "off",
    mode,
    message,
    label:
      mode === "owner_only"
        ? "SOLO OWNER"
        : mode === "downloads_off"
          ? "DESCARGAS EN PAUSA"
          : "APAGADO",
    ownerOnly: mode === "owner_only",
    downloadsBlocked: mode === "downloads_off",
  };
}

function setMaintenanceState(mode, message = "") {
  ensureSystemSettings(settings);
  settings.system.maintenanceMode = normalizeMaintenanceMode(mode);
  settings.system.maintenanceMessage = String(message || "").trim().slice(0, 240);
  saveSettingsFile();
  refreshBotConfigCache();
  return getMaintenanceState();
}

function getErrorVisibilityState() {
  const mode = normalizeErrorVisibilityMode(settings?.system?.errorVisibilityMode);
  return {
    mode,
    enabled: mode !== "off",
    ownerDetails: mode === "owner",
    label: mode === "owner" ? "VISIBLE + OWNER" : mode === "user" ? "VISIBLE" : "OFF",
  };
}

function setErrorVisibilityMode(mode = "off") {
  ensureSystemSettings(settings);
  settings.system.errorVisibilityMode = normalizeErrorVisibilityMode(mode);
  saveSettingsFile();
  refreshBotConfigCache();
  return getErrorVisibilityState();
}

function isDownloadCommand(cmd) {
  const category = String(cmd?.category || "").trim().toLowerCase();
  return category === "descarga" || category === "descargas" || category === "busqueda";
}

function ensureBotDownloadQueue(botState) {
  if (!botState) return;
  if (!(botState.activeDownloadJobs instanceof Map)) {
    botState.activeDownloadJobs = new Map();
  }
  if (!Number.isFinite(Number(botState.downloadQueueCounter))) {
    botState.downloadQueueCounter = 0;
  }
}

function abortActiveDownloadJobs(botState, reason = "cancelled") {
  if (!botState?.activeDownloadJobs?.size) {
    return 0;
  }

  const abortError = new Error(String(reason || "cancelled"));
  let abortedCount = 0;

  for (const job of botState.activeDownloadJobs.values()) {
    const abortController = job?.abortController;
    if (!abortController || typeof abortController.abort !== "function") {
      continue;
    }

    try {
      if (!abortController.signal?.aborted) {
        abortController.abort(abortError);
      }
      abortedCount += 1;
    } catch {}
  }

  return abortedCount;
}

function getBotDownloadQueueState(botState) {
  ensureBotDownloadQueue(botState);

  const activeJobs = Array.from(botState?.activeDownloadJobs?.values?.() || []);
  const currentCommandList = activeJobs
    .map((job) => String(job?.commandName || "").trim())
    .filter(Boolean);
  const currentCommand =
    currentCommandList.length > 3
      ? `${currentCommandList.slice(0, 3).join(", ")} +${currentCommandList.length - 3}`
      : currentCommandList.join(", ");
  const oldestJob = activeJobs.reduce((oldest, job) => {
    if (!oldest) return job;
    return Number(job?.startedAt || 0) < Number(oldest?.startedAt || 0) ? job : oldest;
  }, null);

  return {
    active: activeJobs.length > 0,
    activeCount: activeJobs.length,
    pending: 0,
    currentCommand,
    runningForMs:
      oldestJob?.startedAt
        ? Math.max(0, Date.now() - Number(oldestJob.startedAt))
        : 0,
  };
}

function enqueueDownloadCommand(botState, cmd, commandContext) {
  ensureBotDownloadQueue(botState);

  const jobId = Number(botState.downloadQueueCounter || 0) + 1;
  botState.downloadQueueCounter = jobId;
  const timeoutMs = resolveCommandTimeout(cmd);
  const abortController = createTaskAbortController();
  const commandExecutionContext = {
    ...commandContext,
    abortSignal: abortController?.signal || null,
  };

  let resolveJob;
  let rejectJob;
  const promise = new Promise((resolve, reject) => {
    resolveJob = resolve;
    rejectJob = reject;
  });

  const activeJob = {
    id: jobId,
    commandName: commandContext?.commandName || cmd?.name || "descarga",
    startedAt: Date.now(),
    timeoutMs,
    abortController,
  };
  botState.activeDownloadJobs.set(jobId, activeJob);

  Promise.resolve()
    .then(() =>
      runTaskWithTimeout(
        `${getBotTag(botState)} comando ${activeJob.commandName}`,
        timeoutMs,
        () => cmd.run(commandExecutionContext),
        { abortController }
      )
    )
    .then((result) => {
      resolveJob(result);
    })
    .catch((error) => {
      rejectJob(error);
    })
    .finally(() => {
      botState.activeDownloadJobs.delete(jobId);
    });

  return {
    promise,
    position: 1,
    activeCount: botState.activeDownloadJobs.size,
  };
}

async function isBlockedByMaintenance(cmd, context) {
  if (context.esOwner) return false;

  const maintenance = getMaintenanceState();
  if (!maintenance.enabled) return false;

  let text = "";

  if (maintenance.ownerOnly) {
    text = "El bot esta en mantenimiento. Solo el owner puede usar comandos ahora.";
  } else if (maintenance.downloadsBlocked && isDownloadCommand(cmd)) {
    text = "Las descargas estan en mantenimiento temporal. Intenta otra vez mas tarde.";
  }

  if (!text) return false;

  if (maintenance.message) {
    text += `\n\n${maintenance.message}`;
  }

  await context.sock.sendMessage(
    context.from,
    {
      text,
      ...global.channelInfo,
    },
    getQuoteOptions(context.msg)
  );

  return true;
}

function quoteForShell(value) {
  return `"${String(value || "").replace(/"/g, '\\"')}"`;
}

function quoteForSh(value) {
  return `'${String(value || "").replace(/'/g, `'\"'\"'`)}'`;
}

function normalizeRemoteIp(value = "") {
  const raw = String(value || "").trim();

  if (!raw) {
    return "";
  }

  if (raw.startsWith("::ffff:")) {
    return raw.slice(7);
  }

  return raw;
}

function getRequestIp(req) {
  const forwarded = String(req?.headers?.["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();

  return normalizeRemoteIp(
    forwarded ||
      req?.socket?.remoteAddress ||
      req?.connection?.remoteAddress ||
      ""
  );
}

function isIpAllowed(req) {
  if (!INTERNAL_ALLOWED_IPS.size) {
    return true;
  }

  return INTERNAL_ALLOWED_IPS.has(getRequestIp(req));
}

function resolveRequestUrl(req) {
  return new URL(String(req?.url || "/"), "http://127.0.0.1");
}

function getRequestTokenFromHeaders(req, headerNames = []) {
  for (const headerName of headerNames) {
    const headerValue = req?.headers?.[headerName];

    if (typeof headerValue === "string" && headerValue.trim()) {
      return headerValue.trim();
    }
  }

  const authorization = String(req?.headers?.authorization || "").trim();

  if (authorization.startsWith("Bearer ")) {
    return authorization.slice(7).trim();
  }

  return "";
}

function isTokenAuthorized(req, expectedToken, headerNames = []) {
  if (!expectedToken) {
    return true;
  }

  const url = resolveRequestUrl(req);
  const candidate =
    getRequestTokenFromHeaders(req, headerNames) ||
    String(url.searchParams.get("token") || "").trim();

  return candidate === expectedToken;
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function readJsonBody(req, options = {}) {
  const maxBytes = Math.max(
    1024,
    Math.min(256 * 1024, Number(options.maxBytes || 64 * 1024) || 64 * 1024)
  );

  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;

      if (Buffer.byteLength(raw, "utf8") > maxBytes) {
        const error = new Error("El cuerpo excede el limite permitido.");
        error.statusCode = 413;
        req.destroy(error);
      }
    });

    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        const error = new Error("JSON invalido.");
        error.statusCode = 400;
        reject(error);
      }
    });

    req.on("error", (error) => {
      if (!error.statusCode) {
        error.statusCode = 400;
      }

      reject(error);
    });
  });
}

function resolvePanelCallbackConfig(payload = {}) {
  const bodyCallbackUrl = String(payload?.panelPairingUrl || "").trim();
  const bodyCallbackToken = String(payload?.panelBotToken || "").trim();

  return {
    callbackUrl: PANEL_CALLBACK_URL || bodyCallbackUrl,
    callbackToken: PANEL_CALLBACK_TOKEN || bodyCallbackToken,
  };
}

function mapRuntimePairingResultToPanelPayload(requestToken, result = {}) {
  if (result?.ok) {
    return {
      requestToken,
      pairingCode: result.code,
      pairingStatus: "code_ready",
      pairingMessage:
        result.cached === true
          ? `Codigo recuperado desde cache para ${result.displayName || "el subbot"}.`
          : `Codigo generado por ${result.displayName || "el bot principal"}.`,
      pairingExpiresAt: result.expiresInMs
        ? new Date(Date.now() + Number(result.expiresInMs)).toISOString()
        : null,
    };
  }

  const failedStatuses = new Set([
    "missing_bot",
    "main_not_ready",
    "already_linked",
    "number_already_linked",
    "missing_number",
    "slot_busy",
    "no_capacity",
    "error",
  ]);
  const pairingStatus = failedStatuses.has(String(result?.status || "").trim())
    ? "failed"
    : "processing";

  return {
    requestToken,
    pairingStatus,
    pairingMessage:
      result?.message ||
      "La solicitud fue aceptada por el bot y sigue en proceso.",
  };
}

async function sendPanelPairingUpdate(callbackUrl, callbackToken, payload) {
  if (!callbackUrl || !callbackToken || !payload?.requestToken) {
    return {
      ok: false,
      status: "missing_callback_config",
    };
  }

  const response = await fetch(callbackUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bot-token": callbackToken,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `El panel respondio ${response.status} al callback del pairing. ${errorText}`.trim()
    );
  }

  return {
    ok: true,
    status: "sent",
  };
}

async function processInternalSubbotRequest(payload = {}) {
  const requestToken = String(payload?.requestToken || "").trim();
  const phoneNumber = normalizePairingPhoneNumber(payload?.phoneNumber);

  if (!requestToken || !phoneNumber) {
    return {
      ok: false,
      status: "invalid_request",
      message: "Faltan requestToken o phoneNumber.",
    };
  }

  let result = await global.botRuntime.requestBotPairingCode("subbot", {
    number: phoneNumber,
    requesterNumber: phoneNumber,
    requesterJid: `panel:${requestToken}`,
    useCache: payload?.useCache !== false,
  });

  const pendingStatuses = new Set(["pending", "pending_remote", "unavailable"]);
  const timeoutAt =
    Date.now() + Math.max(PANEL_SUBBOT_CALLBACK_POLL_MS, PANEL_SUBBOT_CALLBACK_WAIT_MS);

  while (
    pendingStatuses.has(String(result?.status || "").trim()) &&
    Date.now() < timeoutAt
  ) {
    await delay(PANEL_SUBBOT_CALLBACK_POLL_MS);
    result = await global.botRuntime.requestBotPairingCode("subbot", {
      number: phoneNumber,
      requesterNumber: phoneNumber,
      requesterJid: `panel:${requestToken}`,
      useCache: true,
    });
  }

  const { callbackUrl, callbackToken } = resolvePanelCallbackConfig(payload);
  const panelPayload = mapRuntimePairingResultToPanelPayload(requestToken, result);

  if (callbackUrl && callbackToken) {
    try {
      await sendPanelPairingUpdate(callbackUrl, callbackToken, panelPayload);
    } catch (error) {
      console.error("[internal-webhook] No pude enviar el callback al panel:", error?.message || error);
    }
  }

  return {
    ok: true,
    accepted: true,
    result,
    panelPayload,
  };
}

function getRestartMode() {
  if (isPm2Environment(process.env)) {
    return {
      kind: "pm2",
      label: "PM2/VPS",
      needsBootstrap: false,
      allowsInternalRestart: true,
    };
  }

  if (isManagedHostingEnvironment(process.env)) {
    return {
      kind: "managed",
      label: "Hosting administrado",
      needsBootstrap: false,
      allowsInternalRestart: false,
    };
  }

  return {
    kind: "self",
    label: "Node directo / VPS",
    needsBootstrap: true,
    allowsInternalRestart: true,
  };
}

function buildRestartBootstrap(delayMs = PROCESS_RESTART_DELAY_MS) {
  const args = process.argv.slice(1);

  if (process.platform === "win32") {
    const waitSeconds = Math.max(1, Math.ceil(delayMs / 1000));
    const command = [
      `timeout /t ${waitSeconds} >nul`,
      `${quoteForShell(process.execPath)} ${args.map(quoteForShell).join(" ")}`,
    ].join(" && ");

    return {
      command: "cmd.exe",
      args: ["/c", command],
    };
  }

  const waitSeconds = Math.max(1, Math.ceil(delayMs / 1000));
  const command = [
    `sleep ${waitSeconds}`,
    `${quoteForSh(process.execPath)} ${args.map(quoteForSh).join(" ")}`,
  ].join("; ");

  return {
    command: "sh",
    args: ["-c", command],
  };
}

function scheduleProcessRestart(delayMs = PROCESS_RESTART_DELAY_MS) {
  const restartMode = getRestartMode();
  if (restartMode.allowsInternalRestart === false) {
    return {
      ...restartMode,
      scheduled: false,
    };
  }

  if (restartMode.needsBootstrap) {
    const bootstrap = buildRestartBootstrap(delayMs);
    const child = spawn(bootstrap.command, bootstrap.args, {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  setTimeout(() => {
    process.kill(process.pid, "SIGINT");
  }, restartMode.needsBootstrap ? 1200 : delayMs).unref?.();

  return {
    ...restartMode,
    scheduled: true,
  };
}

function scheduleReconnect(botState, ms = RECONNECT_BASE_DELAY_MS, reason = "auto") {
  if (botState?.config?.id !== "main" && botState?.config?.enabled === false) {
    return;
  }

  if (isReplacementBlocked(botState)) {
    return;
  }

  const startDecision = evaluateManagedProcessStartDecision(botState?.config, { botState });
  if (!startDecision.start) {
    return;
  }

  clearReconnectTimer(botState);
  clearSocketRecoveryTimer(botState);
  botState.connectionState = "reconnecting";
  markBotSocketActivity(botState, "reconnecting");
  const reconnectDelayMs = Math.max(800, Number(ms || RECONNECT_BASE_DELAY_MS));
  botState.lastReconnectScheduledAt = Date.now();
  botState.lastReconnectDelayMs = reconnectDelayMs;
  botState.lastReconnectReason = String(reason || "auto")
    .trim()
    .slice(0, 80);
  const reconnectAttempt = Math.max(1, Number(botState?.reconnectAttempts || 1));

  logBotEvent(
    botState,
    "warn",
    `Reconexion en ${Math.ceil(reconnectDelayMs / 1000)}s ` +
      `(intento ${reconnectAttempt}, motivo: ${botState.lastReconnectReason || "auto"})`
  );

  botState.reconnectTimer = setTimeout(() => {
    botState.reconnectTimer = null;
    Promise.resolve(iniciarInstanciaBot(botState.config)).catch((error) => {
      logBotEvent(
        botState,
        "error",
        `Error en reconexion programada: ${String(error?.message || error)}`
      );

      if (shouldManagedProcessStartBot(botState.config) && !isReplacementBlocked(botState)) {
        scheduleReconnect(
          botState,
          getReconnectDelay(botState, false),
          "error_reconexion_programada"
        );
      }
    });
  }, reconnectDelayMs);
  botState.reconnectTimer.unref?.();
}

function scheduleSocketRecoveryCheck(
  botState,
  sock,
  reason = "socket_closed",
  delayMs = 1500
) {
  if (!botState || !sock) {
    return;
  }

  clearSocketRecoveryTimer(botState);
  botState.socketRecoveryTimer = setTimeout(() => {
    botState.socketRecoveryTimer = null;

    if (!botState.sock || botState.sock !== sock) {
      return;
    }

    if (botState.reconnectTimer || botState.connecting || isReplacementBlocked(botState)) {
      return;
    }

    if (!shouldManagedProcessStartBot(botState.config)) {
      return;
    }

    recycleBotInstance(botState, reason);
    scheduleReconnect(
      botState,
      getReconnectDelay(botState, false),
      `socket_recovery:${String(reason || "socket_closed").slice(0, 40)}`
    );
  }, Math.max(500, Number(delayMs || 1500)));
  botState.socketRecoveryTimer.unref?.();
}

function attachSocketLifecycleWatchers(botState, sock) {
  if (!sock || sock.__dvyerRecoveryWatchersAttached) {
    return;
  }

  sock.__dvyerRecoveryWatchersAttached = true;
  const rawSocket = sock.ws;

  if (!rawSocket || typeof rawSocket.on !== "function") {
    return;
  }

  rawSocket.on("close", (code) => {
    const normalizedCode = Number(code || 0);
    markBotSocketActivity(botState, `ws.close:${normalizedCode || "unknown"}`);
    scheduleSocketRecoveryCheck(
      botState,
      sock,
      `ws_close:${normalizedCode || "unknown"}`,
      1800
    );
  });

  rawSocket.on("error", (error) => {
    markBotSocketActivity(botState, "ws.error");
    logBotEvent(botState, "warn", `WebSocket error: ${String(error?.message || error)}`);

    const readyState = Number(sock.ws?.readyState);
    if (botState?.connectedAt || (Number.isFinite(readyState) && readyState >= 2)) {
      scheduleSocketRecoveryCheck(botState, sock, "ws_error", 1200);
    }
  });
}

function maskDashboardNumber(value = "") {
  const digits = sanitizePhoneNumber(value);
  if (!digits) return "";

  if (digits.length <= 4) {
    return digits;
  }

  const visiblePrefix = digits.slice(0, Math.min(3, digits.length - 4));
  const visibleSuffix = digits.slice(-4);
  const hiddenCount = Math.max(
    2,
    digits.length - visiblePrefix.length - visibleSuffix.length
  );

  return `${visiblePrefix}${"*".repeat(hiddenCount)}${visibleSuffix}`;
}

function sanitizeDashboardBotSummary(bot = {}) {
  return {
    ...bot,
    authFolder: "",
    requesterJid: "",
    configuredNumber: maskDashboardNumber(bot?.configuredNumber),
    requesterNumber: maskDashboardNumber(bot?.requesterNumber),
    lastPairingRequestNumber: maskDashboardNumber(bot?.lastPairingRequestNumber),
    cachedPairingCode: "",
    cachedPairingNumber: "",
    cachedPairingExpiresInMs: 0,
  };
}

function getDashboardSnapshot(options = {}) {
  const includeSensitive = options?.includeSensitive === true;
  const bots = global.botRuntime?.listBots?.({ includeMain: true }) || [];

  return {
    pid: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
    processMode: PROCESS_MODE_LABEL,
    commandsLoaded: comandos.size,
    totalMessages: totalMensajes,
    totalCommands: totalComandos,
    memory: process.memoryUsage(),
    bots: includeSensitive ? bots : bots.map((bot) => sanitizeDashboardBotSummary(bot)),
    usage: getUsageStatsSnapshot(10),
    weekly: getWeeklySnapshot(10),
    resilience: getResilienceSnapshot(),
    autoclean: getAutoCleanState(),
    runtimeMetrics,
    providers: getProviderGuardSnapshot(),
    dashboard: {
      ...dashboardState,
      active: Boolean(dashboardServer),
    },
  };
}

function summarizeBotConnections() {
  const bots = global.botRuntime?.listBots?.({ includeMain: true }) || [];
  const total = bots.length;
  const connected = bots.filter((bot) => Boolean(bot?.connected)).length;
  const disconnected = Math.max(0, total - connected);
  return { total, connected, disconnected };
}

function getHealthSnapshot() {
  const memory = process.memoryUsage();
  const connections = summarizeBotConnections();
  const uptimeSeconds = Math.floor(process.uptime());
  const providers = getProviderGuardSnapshot();
  const openProviders = providers.filter((item) => item.status === "open").map((item) => item.name);
  const now = Date.now();

  const ok = connections.connected > 0 && openProviders.length === 0;
  return {
    ok,
    status: ok ? "ok" : "degraded",
    timestamp: new Date(now).toISOString(),
    process: {
      pid: process.pid,
      mode: PROCESS_MODE_LABEL,
      uptimeSeconds,
    },
    memory: {
      rss: Number(memory.rss || 0),
      heapUsed: Number(memory.heapUsed || 0),
      heapTotal: Number(memory.heapTotal || 0),
      external: Number(memory.external || 0),
    },
    counters: {
      totalMessages: Number(totalMensajes || 0),
      totalCommands: Number(totalComandos || 0),
    },
    runtimeMetrics,
    connections,
    providers,
    alerts: {
      openProviders,
    },
  };
}

function escapePromLabel(value = "") {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function buildPrometheusMetrics() {
  const health = getHealthSnapshot();
  const providers = Array.isArray(health.providers) ? health.providers : [];
  const commandEntries = Object.entries(runtimeMetrics.commands.byName || {});

  const lines = [];
  lines.push("# HELP fsociety_uptime_seconds Process uptime in seconds");
  lines.push("# TYPE fsociety_uptime_seconds gauge");
  lines.push(`fsociety_uptime_seconds ${Math.floor(process.uptime())}`);

  lines.push("# HELP fsociety_messages_total Total messages observed");
  lines.push("# TYPE fsociety_messages_total counter");
  lines.push(`fsociety_messages_total ${Number(totalMensajes || 0)}`);

  lines.push("# HELP fsociety_commands_total Total commands observed");
  lines.push("# TYPE fsociety_commands_total counter");
  lines.push(`fsociety_commands_total ${Number(totalComandos || 0)}`);

  lines.push("# HELP fsociety_command_executions_total Command lifecycle counters");
  lines.push("# TYPE fsociety_command_executions_total counter");
  lines.push(`fsociety_command_executions_total{status="started"} ${Number(runtimeMetrics.commands.started || 0)}`);
  lines.push(`fsociety_command_executions_total{status="success"} ${Number(runtimeMetrics.commands.success || 0)}`);
  lines.push(`fsociety_command_executions_total{status="error"} ${Number(runtimeMetrics.commands.error || 0)}`);
  lines.push(`fsociety_command_executions_total{status="timeout"} ${Number(runtimeMetrics.commands.timeout || 0)}`);

  lines.push("# HELP fsociety_command_active Current active command executions");
  lines.push("# TYPE fsociety_command_active gauge");
  lines.push(`fsociety_command_active ${Number(runtimeMetrics.commands.active || 0)}`);

  lines.push("# HELP fsociety_command_duration_ms_total Accumulated command duration in ms");
  lines.push("# TYPE fsociety_command_duration_ms_total counter");
  lines.push(`fsociety_command_duration_ms_total ${Number(runtimeMetrics.commands.totalDurationMs || 0)}`);

  lines.push("# HELP fsociety_command_duration_ms_max Max command duration in ms");
  lines.push("# TYPE fsociety_command_duration_ms_max gauge");
  lines.push(`fsociety_command_duration_ms_max ${Number(runtimeMetrics.commands.maxDurationMs || 0)}`);

  for (const [commandName, entry] of commandEntries) {
    const command = escapePromLabel(commandName);
    lines.push(`fsociety_command_by_name_total{command="${command}",status="started"} ${Number(entry.started || 0)}`);
    lines.push(`fsociety_command_by_name_total{command="${command}",status="success"} ${Number(entry.success || 0)}`);
    lines.push(`fsociety_command_by_name_total{command="${command}",status="error"} ${Number(entry.error || 0)}`);
    lines.push(`fsociety_command_by_name_total{command="${command}",status="timeout"} ${Number(entry.timeout || 0)}`);
  }

  lines.push("# HELP fsociety_provider_circuit_state Provider circuit breaker state (1=open)");
  lines.push("# TYPE fsociety_provider_circuit_state gauge");
  for (const provider of providers) {
    const name = escapePromLabel(provider.name);
    const isOpen = provider.status === "open" ? 1 : 0;
    lines.push(`fsociety_provider_circuit_state{provider="${name}"} ${isOpen}`);
  }

  lines.push("# HELP fsociety_http_endpoint_hits_total Hits for health/metrics endpoints");
  lines.push("# TYPE fsociety_http_endpoint_hits_total counter");
  lines.push(`fsociety_http_endpoint_hits_total{endpoint="health"} ${Number(runtimeMetrics.http.healthHits || 0)}`);
  lines.push(`fsociety_http_endpoint_hits_total{endpoint="metrics"} ${Number(runtimeMetrics.http.metricsHits || 0)}`);

  return `${lines.join("\n")}\n`;
}

function buildMainPairingSnapshot(result = null) {
  const summary = summarizeBotConfig(buildMainBotConfig(settings));

  let pairingStatus = "idle";
  if (summary.connected) {
    pairingStatus = "linked";
  } else if (summary.cachedPairingCode) {
    pairingStatus = "code_ready";
  } else if (summary.pairingPending || summary.connecting) {
    pairingStatus = "processing";
  } else if (summary.replacementBlocked) {
    pairingStatus = "needs_relink";
  } else if (summary.registered && !summary.connected) {
    pairingStatus = "disconnected";
  }

  if (result?.status === "created" || result?.status === "cached") {
    pairingStatus = "code_ready";
  } else if (result?.status === "already_linked") {
    pairingStatus = "linked";
  } else if (["pending", "pending_remote", "unavailable"].includes(String(result?.status || ""))) {
    pairingStatus = "processing";
  } else if (["error", "missing_number", "missing_bot"].includes(String(result?.status || ""))) {
    pairingStatus = "failed";
  }

  const code = String(result?.code || summary.cachedPairingCode || "").trim();
  const number = sanitizePhoneNumber(result?.number || summary.cachedPairingNumber || summary.configuredNumber || "");
  const expiresInMs = Number(result?.expiresInMs || summary.cachedPairingExpiresInMs || 0);

  return {
    botId: "main",
    pairingStatus,
    message:
      String(result?.message || "").trim() ||
      (pairingStatus === "linked"
        ? `${summary.displayName} ya esta conectado.`
        : pairingStatus === "code_ready"
          ? "Codigo de vinculacion listo."
          : pairingStatus === "needs_relink"
            ? "La sesion principal fue reemplazada o requiere relink."
            : pairingStatus === "disconnected"
              ? "La sesion principal existe pero no esta conectada."
              : "Bot principal disponible para vinculacion."),
    code,
    number,
    expiresInMs,
    expiresAt: expiresInMs > 0 ? new Date(Date.now() + expiresInMs).toISOString() : "",
    connected: Boolean(summary.connected),
    registered: Boolean(summary.registered),
    connecting: Boolean(summary.connecting),
    pairingPending: Boolean(summary.pairingPending),
    replacementBlocked: Boolean(summary.replacementBlocked),
    configuredNumber: summary.configuredNumber || number || "",
    displayName: summary.displayName,
    lastDisconnectAt: Number(summary.lastDisconnectAt || 0),
    connectedAt: Number(summary.connectedAt || 0)
  };
}

function getPrimaryPrefix() {
  if (Array.isArray(settings?.prefix)) {
    return String(settings.prefix[0] || ".").trim() || ".";
  }

  return String(settings?.prefix || ".").trim() || ".";
}

function sendDashboardJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function isLoopbackRequest(req) {
  const remoteAddress = String(req?.socket?.remoteAddress || "")
    .trim()
    .toLowerCase();

  return (
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress.endsWith("127.0.0.1")
  );
}

function isBridgeReady() {
  if (WEB_BRIDGE_TOKEN) {
    return true;
  }

  return (
    ALLOW_LOOPBACK_BRIDGE_WITHOUT_TOKEN &&
    isLoopbackHost(dashboardState.host)
  );
}

function getBridgeUnavailableMessage() {
  if (WEB_BRIDGE_TOKEN) {
    return "";
  }

  if (
    ALLOW_LOOPBACK_BRIDGE_WITHOUT_TOKEN &&
    !isLoopbackHost(dashboardState.host)
  ) {
    return (
      "El bridge sin token solo puede funcionar con DASHBOARD_HOST en " +
      "127.0.0.1, ::1 o localhost."
    );
  }

  return (
    "Configura WEB_BRIDGE_TOKEN para usar el bridge web. " +
    "Si solo lo usaras localmente, habilita WEB_BRIDGE_ALLOW_LOOPBACK=1 " +
    "y deja DASHBOARD_HOST en 127.0.0.1."
  );
}

function isBridgeAuthorized(req) {
  if (!String(req?.url || "").startsWith("/bridge/")) {
    return true;
  }

  if (WEB_BRIDGE_TOKEN) {
    const authHeader = String(req?.headers?.authorization || "").trim();
    const altToken = String(req?.headers?.["x-bridge-token"] || "").trim();

    if (authHeader.startsWith("Bearer ")) {
      return authHeader.slice(7).trim() === WEB_BRIDGE_TOKEN;
    }

    return altToken === WEB_BRIDGE_TOKEN;
  }

  return (
    ALLOW_LOOPBACK_BRIDGE_WITHOUT_TOKEN &&
    isLoopbackHost(dashboardState.host) &&
    isLoopbackRequest(req)
  );
}

function readJsonRequestBody(req, maxBytes = 32768) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;

      if (size > maxBytes) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8").trim();

      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid_json"));
      }
    });

    req.on("error", reject);
  });
}

function buildBridgeStatusPayload() {
  const runtime = global.botRuntime;
  const subbotState = runtime?.getSubbotRequestState?.() || {};

  return {
    ok: true,
    source: "Fsociety bot runtime",
    mainReady: Boolean(runtime?.isMainReady?.()),
    publicRequests: Boolean(subbotState.publicRequests),
    maxSlots: Number(subbotState.maxSlots || 0),
    enabledSlots: Number(subbotState.enabledSlots || subbotState.maxSlots || 0),
    availableSlots: Number(subbotState.availableSlots || 0),
    activeSlots: Number(subbotState.activeSlots || 0),
    processMode: PROCESS_MODE_LABEL,
    commandsLoaded: comandos.size,
  };
}

function buildBridgeChatReply(mensaje = "", usuario = "web-user") {
  const normalized = String(mensaje || "").trim().toLowerCase();
  const runtime = global.botRuntime;
  const subbotState = runtime?.getSubbotRequestState?.() || {};
  const prefix = getPrimaryPrefix();
  const mainReady = runtime?.isMainReady?.() ? "listo" : "pendiente";

  if (!normalized) {
    return "Escribe un mensaje para consultar el estado del bot.";
  }

  if (/(ayuda|help|menu|opciones)/.test(normalized)) {
    return (
      `Hola ${usuario}. Desde esta web puedes consultar estado del bot, revisar capacidad y pedir un subbot.` +
      `\n\nComandos utiles:` +
      `\n- Escribe "estado general"` +
      `\n- Escribe "slots disponibles"` +
      `\n- Usa el formulario de solicitud de subbot con tu numero` +
      `\n- En WhatsApp tambien puedes usar: ${prefix}subbot 51912345678`
    );
  }

  if (/(estado|status|resumen|health)/.test(normalized)) {
    return (
      `Estado del runtime:` +
      `\n- Bot principal: ${mainReady}` +
      `\n- Solicitudes publicas: ${subbotState.publicRequests ? "encendidas" : "apagadas"}` +
      `\n- Slots libres: ${Number(subbotState.availableSlots || 0)}` +
      `\n- Slots activos: ${Number(subbotState.activeSlots || 0)}` +
      `\n- Capacidad total: ${Number(subbotState.maxSlots || 0)}`
    );
  }

  if (/(subbot|slot|slots|capacidad|pairing|codigo)/.test(normalized)) {
    return (
      `Subbots disponibles ahora:` +
      `\n- Public requests: ${subbotState.publicRequests ? "ON" : "OFF"}` +
      `\n- Slots libres: ${Number(subbotState.availableSlots || 0)}` +
      `\n- Slots activos: ${Number(subbotState.activeSlots || 0)}` +
      `\n\nSi quieres un codigo real, usa el formulario web o el comando ${prefix}subbot 51912345678.`
    );
  }

  return (
    `Recibi tu mensaje, ${usuario}. El bridge web esta conectado al runtime del bot.` +
    `\n\nSi quieres pedir un subbot, usa el formulario de la web con tu numero o el comando ${prefix}subbot 51912345678 en WhatsApp.`
  );
}

function resolveBridgeSubbotError(result = {}, maxSlots = 15) {
  if (result?.status === "missing_bot") {
    return `No encontre ese slot. Usa un valor entre 1 y ${maxSlots}.`;
  }

  if (result?.status === "no_capacity") {
    return "No hay slots libres para crear otro subbot ahora mismo.";
  }

  if (result?.status === "slot_busy") {
    return result.message || "Ese slot ya esta ocupado por otro subbot.";
  }

  if (result?.status === "number_already_linked") {
    return (
      result.message ||
      "Ese numero ya esta vinculado en otro subbot. Libera ese slot antes de reutilizarlo."
    );
  }

  if (result?.status === "main_not_ready") {
    return "El bot principal aun no esta listo para generar un codigo.";
  }

  if (result?.status === "pending") {
    return "Ya hay una solicitud de codigo en proceso para ese subbot.";
  }

  if (result?.status === "missing_number") {
    return "Debes enviar un numero con codigo de pais, por ejemplo 51912345678.";
  }

  if (result?.status === "already_linked") {
    return "Ese subbot ya esta vinculado y funcionando.";
  }

  if (result?.status === "public_requests_disabled") {
    return "Las solicitudes publicas de subbots estan apagadas por el owner.";
  }

  return result?.message || "No pude completar la solicitud del subbot.";
}

function resolveBridgeSubbotHttpStatus(status = "") {
  if (status === "main_not_ready") return 503;
  if (status === "public_requests_disabled") return 403;
  if (
    ["no_capacity", "slot_busy", "pending", "already_linked", "number_already_linked"].includes(
      status
    )
  ) {
    return 409;
  }

  return 400;
}

async function handleBridgeRequest(req, res, requestUrl) {
  const pathname = requestUrl.pathname;

  if (!pathname.startsWith("/bridge/")) {
    return false;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization, X-Bridge-Token",
      "access-control-max-age": "600",
    });
    res.end();
    return true;
  }

  if (!isBridgeReady()) {
    sendDashboardJson(res, 503, {
      ok: false,
      error: getBridgeUnavailableMessage(),
    });
    return true;
  }

  if (!isBridgeAuthorized(req)) {
    sendDashboardJson(res, 401, {
      ok: false,
      error: "No autorizado para usar el bridge del bot.",
    });
    return true;
  }

  if (pathname === "/bridge/status" && req.method === "GET") {
    sendDashboardJson(res, 200, buildBridgeStatusPayload());
    return true;
  }

  if (pathname === "/bridge/chat" && req.method === "POST") {
    const body = await readJsonRequestBody(req);
    const mensaje = String(body?.mensaje || "").trim();
    const usuario = String(body?.usuario || "web-user").trim() || "web-user";

    if (!mensaje) {
      sendDashboardJson(res, 400, {
        ok: false,
        error: "El campo mensaje es obligatorio.",
      });
      return true;
    }

    sendDashboardJson(res, 200, {
      ...buildBridgeStatusPayload(),
      respuesta: buildBridgeChatReply(mensaje, usuario),
    });
    return true;
  }

  if (pathname === "/bridge/subbot-request" && req.method === "POST") {
    const body = await readJsonRequestBody(req);
  const numero = normalizePairingPhoneNumber(
    body?.numero || body?.number || body?.requesterNumber
  );
    const usuario = String(body?.usuario || "web-user").trim() || "web-user";
    const slot = Number.parseInt(String(body?.slot || ""), 10);
    const runtime = global.botRuntime;
    const state = runtime?.getSubbotRequestState?.() || {};

    if (!numero) {
      sendDashboardJson(res, 400, {
        ok: false,
        error: "Debes enviar un numero con codigo de pais.",
      });
      return true;
    }

    if (!runtime?.requestBotPairingCode) {
      sendDashboardJson(res, 503, {
        ok: false,
        error: "El runtime de subbots no esta disponible en este proceso.",
      });
      return true;
    }

    const requestedBotId =
      Number.isFinite(slot) && slot >= 1 ? `subbot${slot}` : "subbot";
    const result = await runtime.requestBotPairingCode(requestedBotId, {
      number: numero,
      requesterNumber: numero,
      requesterJid: `web:${usuario}`,
      useCache: true,
    });

    if (!result?.ok) {
      sendDashboardJson(res, resolveBridgeSubbotHttpStatus(result?.status), {
        ok: false,
        error: resolveBridgeSubbotError(result, Number(state?.maxSlots || 15)),
        status: result?.status || "request_failed",
        state: runtime?.getSubbotRequestState?.() || state,
      });
      return true;
    }

    sendDashboardJson(res, 200, {
      ok: true,
      source: "Fsociety bot runtime",
      solicitudId: `subbot-${Date.now()}`,
      respuesta:
        `Solicitud aceptada. Usa el codigo para vincular ${result.displayName || "tu subbot"} en WhatsApp.`,
      codigo: result.code,
      slot: result.slot || (Number.isFinite(slot) ? slot : null),
      numero: result.number || numero,
      expiresInMs: Number(result.expiresInMs || 0),
      displayName: result.displayName || "Subbot",
      cached: Boolean(result.cached),
      state: runtime?.getSubbotRequestState?.() || state,
    });
    return true;
  }

  sendDashboardJson(res, 404, {
    ok: false,
    error: "Ruta del bridge no encontrada.",
  });
  return true;
}

function ensureDashboardServer() {
  if (!dashboardState.enabled || dashboardServer) return;

  dashboardServer = http.createServer((req, res) => {
    (async () => {
      const requestUrl = resolveRequestUrl(req);
      const pathname = requestUrl.pathname;
      const method = String(req?.method || "GET").trim().toUpperCase();

      if (pathname === "/health" && method === "GET") {
        runtimeMetrics.http.healthHits += 1;
        writeJson(res, 200, getHealthSnapshot());
        return;
      }

      if (pathname === "/metrics" && method === "GET") {
        runtimeMetrics.http.metricsHits += 1;
        if (
          DASHBOARD_TOKEN &&
          !isTokenAuthorized(req, DASHBOARD_TOKEN, [
            "x-dashboard-token",
            "x-api-key",
          ])
        ) {
          writeJson(res, 401, {
            message: "Token de dashboard invalido.",
          });
          return;
        }

        res.writeHead(200, {
          "content-type": "text/plain; version=0.0.4; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(buildPrometheusMetrics());
        return;
      }

      if (pathname === "/internal/main/pairing") {
        if (!["GET", "POST"].includes(method)) {
          writeJson(res, 405, {
            message: "Metodo no permitido.",
          });
          return;
        }

        if (!INTERNAL_WEBHOOK_TOKEN) {
          writeJson(res, 503, {
            message: "Configura INTERNAL_WEBHOOK_TOKEN o BOT_WEBHOOK_TOKEN antes de exponer este endpoint.",
          });
          return;
        }

        if (!isIpAllowed(req)) {
          writeJson(res, 403, {
            message: "IP no autorizada para el webhook interno.",
          });
          return;
        }

        if (
          !isTokenAuthorized(req, INTERNAL_WEBHOOK_TOKEN, [
            "x-bot-webhook-token",
            "x-internal-token",
          ])
        ) {
          writeJson(res, 401, {
            message: "Token del webhook interno invalido.",
          });
          return;
        }

        try {
          if (method === "GET") {
            writeJson(res, 200, {
              ok: true,
              ...buildMainPairingSnapshot(),
            });
            return;
          }

          const body = await readJsonBody(req);
          const phoneNumber = normalizePairingPhoneNumber(body?.phoneNumber);
          const forceRelink = body?.forceRelink === true;
          const useCache = body?.useCache !== false;
          const mainState =
            getMainBotState() || ensureBotState(buildMainBotConfig(settings));

          if (phoneNumber) {
            const nextConfig = saveMainBotPairingNumber(phoneNumber);
            mainState.config = {
              ...mainState.config,
              ...nextConfig,
            };
          }

          if (forceRelink) {
            if (Boolean(mainState?.sock?.user?.id)) {
              writeJson(res, 409, {
                ok: false,
                ...buildMainPairingSnapshot({
                  status: "already_linked",
                  message: `${
                    mainState.config?.displayName || "El bot principal"
                  } ya esta conectado.`,
                }),
              });
              return;
            }

            resetMainBotSession(mainState, {
              number:
                phoneNumber ||
                mainState?.config?.pairingNumber ||
                settings?.pairingNumber ||
                "",
            });
          }

          const result = await global.botRuntime.requestBotPairingCode("main", {
            number:
              phoneNumber ||
              mainState?.config?.pairingNumber ||
              settings?.pairingNumber ||
              "",
            useCache,
          });

          writeJson(res, 200, {
            ok: Boolean(result?.ok),
            ...buildMainPairingSnapshot(result),
          });
          return;
        } catch (error) {
          writeJson(res, error?.statusCode || 500, {
            ok: false,
            ...buildMainPairingSnapshot({
              status: "error",
              message:
                error?.message ||
                "No pude generar el codigo del bot principal.",
            }),
          });
          return;
        }
      }

      if (pathname === "/internal/subbot/request") {
        if (method !== "POST") {
          writeJson(res, 405, {
            message: "Metodo no permitido.",
          });
          return;
        }

        if (!INTERNAL_WEBHOOK_TOKEN) {
          writeJson(res, 503, {
            message: "Configura INTERNAL_WEBHOOK_TOKEN o BOT_WEBHOOK_TOKEN antes de exponer este endpoint.",
          });
          return;
        }

        if (!isIpAllowed(req)) {
          writeJson(res, 403, {
            message: "IP no autorizada para el webhook interno.",
          });
          return;
        }

        if (
          !isTokenAuthorized(req, INTERNAL_WEBHOOK_TOKEN, [
            "x-bot-webhook-token",
            "x-internal-token",
          ])
        ) {
          writeJson(res, 401, {
            message: "Token del webhook interno invalido.",
          });
          return;
        }

        try {
          const body = await readJsonBody(req);
          const requestToken = String(body?.requestToken || "").trim();
          const phoneNumber = normalizePairingPhoneNumber(body?.phoneNumber);

          if (!requestToken || !phoneNumber) {
            writeJson(res, 400, {
              message: "Debes enviar requestToken y phoneNumber.",
            });
            return;
          }

          const callbackConfig = resolvePanelCallbackConfig(body);
          const hasAsyncCallback =
            Boolean(callbackConfig.callbackUrl) &&
            Boolean(callbackConfig.callbackToken);

          if (hasAsyncCallback) {
            Promise.resolve()
              .then(() => processInternalSubbotRequest(body))
              .catch((error) => {
                console.error(
                  "[internal-webhook] Error procesando solicitud:",
                  error?.message || error
                );
              });

            writeJson(res, 202, {
              accepted: true,
              requestToken,
              pairingStatus: "processing",
              pairingMessage:
                "Solicitud aceptada por el bot principal. El codigo se enviara al panel cuando este listo.",
            });
            return;
          }

          const outcome = await processInternalSubbotRequest(body);
          writeJson(res, 200, {
            accepted: true,
            requestToken,
            ...outcome.panelPayload,
          });
          return;
        } catch (error) {
          writeJson(res, error?.statusCode || 500, {
            message:
              error?.message || "No pude procesar la solicitud del subbot.",
          });
          return;
        }
      }

      if (await handleBridgeRequest(req, res, requestUrl)) {
        return;
      }

      if (pathname.startsWith("/json")) {
        if (
          !isTokenAuthorized(req, DASHBOARD_TOKEN, [
            "x-dashboard-token",
            "x-api-key",
          ])
        ) {
          writeJson(res, 401, {
            message: "Token de dashboard invalido.",
          });
          return;
        }

        sendDashboardJson(res, 200, getDashboardSnapshot());
        return;
      }

      if (
        !isTokenAuthorized(req, DASHBOARD_TOKEN, [
          "x-dashboard-token",
          "x-api-key",
        ])
      ) {
        writeJson(res, 401, {
          message: "Token de dashboard invalido.",
        });
        return;
      }

      const snapshot = getDashboardSnapshot();
      const html = `
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>DVYER Dashboard</title>
  <style>
    body { font-family: Consolas, monospace; background: #10151f; color: #e8f0ff; margin: 0; padding: 24px; }
    h1 { margin-top: 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
    .card { background: #172232; border: 1px solid #25354c; border-radius: 14px; padding: 16px; }
    pre { white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <h1>DVYER Dashboard</h1>
  <div class="grid">
    <div class="card"><b>PID</b><br>${snapshot.pid}</div>
    <div class="card"><b>Uptime</b><br>${snapshot.uptimeSeconds}s</div>
    <div class="card"><b>Modo</b><br>${snapshot.processMode}</div>
    <div class="card"><b>Comandos</b><br>${snapshot.commandsLoaded}</div>
  </div>
  <div class="card" style="margin-top:16px"><pre>${JSON.stringify(snapshot, null, 2)}</pre></div>
</body>
</html>`;
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      res.end(html);
    })().catch((error) => {
      if (res.headersSent) {
        return;
      }

      if (error?.message === "invalid_json") {
        sendDashboardJson(res, 400, {
          ok: false,
          error: "JSON invalido en la solicitud del bridge.",
        });
        return;
      }

      if (error?.message === "payload_too_large") {
        sendDashboardJson(res, 413, {
          ok: false,
          error: "La solicitud al bridge es demasiado grande.",
        });
        return;
      }

      console.error("Error en dashboard/bridge:", error);
      sendDashboardJson(res, 500, {
        ok: false,
        error: "Error interno en el dashboard del bot.",
      });
    });
  });

  dashboardServer.listen(dashboardState.port, dashboardState.host, () => {
    console.log(`Dashboard web activo en http://${dashboardState.host}:${dashboardState.port}`);
  });
}

function setDashboardConfig(patch = {}) {
  if (Object.prototype.hasOwnProperty.call(patch, "enabled")) {
    dashboardState.enabled = Boolean(patch.enabled);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "port")) {
    const nextPort = Number(patch.port || dashboardState.port);
    if (Number.isFinite(nextPort) && nextPort >= 1 && nextPort <= 65535) {
      dashboardState.port = nextPort;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "host")) {
    dashboardState.host = String(patch.host || dashboardState.host || "0.0.0.0").trim() || "0.0.0.0";
  }

  if (dashboardServer) {
    try {
      dashboardServer.close();
    } catch {}
    dashboardServer = null;
  }

  ensureDashboardServer();
  return {
    ...dashboardState,
    active: Boolean(dashboardServer),
  };
}

// ================= BANNER =================

let packageVersionLabelCache = "";
let networkTrafficSampleCache = null;
let lastMeasuredLatencyMs = 0;
let lastLiveTelemetrySnapshot = null;
let lastLiveTelemetryLogAt = 0;

function getPackageVersionLabel() {
  if (packageVersionLabelCache) {
    return packageVersionLabelCache;
  }

  try {
    const raw = fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8");
    const parsed = JSON.parse(raw);
    const version = String(parsed?.version || "").trim();
    packageVersionLabelCache = version ? `v${version}` : "vdev";
  } catch {
    packageVersionLabelCache = "vdev";
  }

  return packageVersionLabelCache;
}

async function estimateBootLatencyMs() {
  const baselineDelayMs = 20;
  const start = process.hrtime.bigint();
  await delay(baselineDelayMs);
  const elapsedNs = Number(process.hrtime.bigint() - start);
  const elapsedMs = Math.max(1, Math.round(elapsedNs / 1_000_000));
  return Math.max(1, elapsedMs - baselineDelayMs);
}

function readNetworkTrafficSample() {
  try {
    const raw = fs.readFileSync("/proc/net/dev", "utf-8");
    const lines = raw
      .split("\n")
      .slice(2)
      .map((line) => line.trim())
      .filter(Boolean);

    let rxBytes = 0;
    let txBytes = 0;

    for (const line of lines) {
      const parts = line.split(/[:\s]+/).filter(Boolean);
      if (parts.length < 10) continue;

      const iface = String(parts[0] || "").trim();
      if (!iface || iface === "lo") continue;

      const rx = Number(parts[1] || 0);
      const tx = Number(parts[9] || 0);
      if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;

      rxBytes += rx;
      txBytes += tx;
    }

    return {
      atMs: Date.now(),
      rxBytes,
      txBytes,
    };
  } catch {
    return null;
  }
}

function getRealtimeNetworkMetrics() {
  const nowSample = readNetworkTrafficSample();
  if (!nowSample) {
    return {
      percent: 0,
      mbps: 0,
      rxMbps: 0,
      txMbps: 0,
    };
  }

  const prevSample = networkTrafficSampleCache;
  networkTrafficSampleCache = nowSample;

  if (!prevSample || nowSample.atMs <= prevSample.atMs) {
    return {
      percent: 0,
      mbps: 0,
      rxMbps: 0,
      txMbps: 0,
    };
  }

  const elapsedSec = Math.max(0.001, (nowSample.atMs - prevSample.atMs) / 1000);
  const rxBytesDelta = Math.max(0, nowSample.rxBytes - prevSample.rxBytes);
  const txBytesDelta = Math.max(0, nowSample.txBytes - prevSample.txBytes);
  const totalMbps = ((rxBytesDelta + txBytesDelta) * 8) / 1_000_000 / elapsedSec;
  const rxMbps = (rxBytesDelta * 8) / 1_000_000 / elapsedSec;
  const txMbps = (txBytesDelta * 8) / 1_000_000 / elapsedSec;
  const percent = Math.max(
    1,
    Math.min(99, Math.round((totalMbps / CONSOLE_NET_REFERENCE_MBPS) * 100))
  );

  return {
    percent,
    mbps: Math.max(0, Number(totalMbps.toFixed(2))),
    rxMbps: Math.max(0, Number(rxMbps.toFixed(2))),
    txMbps: Math.max(0, Number(txMbps.toFixed(2))),
  };
}

async function measureHttpLatencyMs(url, timeoutMs = CONSOLE_METRIC_HTTP_TIMEOUT_MS) {
  const target = String(url || "").trim();
  if (!target || typeof fetch !== "function") {
    return Math.max(1, Number(lastMeasuredLatencyMs || 0));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(300, Number(timeoutMs || 0)));
  timer.unref?.();

  const started = process.hrtime.bigint();
  try {
    await fetch(target, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    });
    const elapsedMs = Math.max(
      1,
      Math.round(Number(process.hrtime.bigint() - started) / 1_000_000)
    );
    lastMeasuredLatencyMs = elapsedMs;
    return elapsedMs;
  } catch {
    return Math.max(1, Number(lastMeasuredLatencyMs || 0));
  } finally {
    clearTimeout(timer);
  }
}

async function collectLiveTelemetrySnapshot(forceLatency = false) {
  const cpuCount = Math.max(1, Number(os.cpus()?.length || 1));
  const loadAverage = Number(os.loadavg?.()[0] || 0);
  const totalMemBytes = Math.max(1, Number(os.totalmem() || 0));
  const usedMemBytes = Math.max(0, totalMemBytes - Number(os.freemem() || 0));
  const networkMetrics = getRealtimeNetworkMetrics();
  const latencyMs = forceLatency
    ? await measureHttpLatencyMs(CONSOLE_METRIC_PING_URL)
    : Math.max(1, Number(lastMeasuredLatencyMs || 0));

  return {
    cpuPct: Math.max(1, Math.min(99, Math.round((loadAverage / cpuCount) * 100))),
    ramPct: Math.max(1, Math.min(99, Math.round((usedMemBytes / totalMemBytes) * 100))),
    netPct: networkMetrics.percent,
    netMbps: networkMetrics.mbps,
    latencyMs: Math.max(1, Number(latencyMs || 1)),
  };
}

function startLiveConsoleTelemetryTicker() {
  if (!CONSOLE_LIVE_TELEMETRY_ENABLED || liveConsoleTelemetryInterval) {
    return;
  }

  const shouldEmitTelemetryLog = (snapshot) => {
    const now = Date.now();

    if (!lastLiveTelemetrySnapshot) {
      lastLiveTelemetrySnapshot = snapshot;
      lastLiveTelemetryLogAt = now;
      return false;
    }

    const previous = lastLiveTelemetrySnapshot;
    const forceByTime = now - Number(lastLiveTelemetryLogAt || 0) >= CONSOLE_LIVE_TELEMETRY_FORCE_LOG_MS;
    const changedEnough =
      Math.abs(Number(snapshot.cpuPct || 0) - Number(previous.cpuPct || 0)) >= CONSOLE_LIVE_TELEMETRY_CPU_DELTA ||
      Math.abs(Number(snapshot.ramPct || 0) - Number(previous.ramPct || 0)) >= CONSOLE_LIVE_TELEMETRY_RAM_DELTA ||
      Math.abs(Number(snapshot.netPct || 0) - Number(previous.netPct || 0)) >= CONSOLE_LIVE_TELEMETRY_NET_DELTA ||
      Math.abs(Number(snapshot.latencyMs || 0) - Number(previous.latencyMs || 0)) >= CONSOLE_LIVE_TELEMETRY_LAT_DELTA;

    lastLiveTelemetrySnapshot = snapshot;

    if (!changedEnough && !forceByTime) {
      return false;
    }

    lastLiveTelemetryLogAt = now;
    return true;
  };

  let tick = 0;

  const runTick = () => {
    tick += 1;
    const forceLatency = tick % 3 === 1;

    collectLiveTelemetrySnapshot(forceLatency)
      .then((snapshot) => {
        const mainState = getMainBotState() || { config: { label: "MAIN" } };
        if (!mainState?.connectedAt) {
          return;
        }

        if (!shouldEmitTelemetryLog(snapshot)) {
          return;
        }

        // Keep live snapshot in memory without flooding console logs.
        mainState.lastTelemetrySnapshot = snapshot;
      })
      .catch(() => {});
  };

  liveConsoleTelemetryInterval = setInterval(runTick, CONSOLE_LIVE_TELEMETRY_INTERVAL_MS);
  liveConsoleTelemetryInterval.unref?.();
  // Warm up first sample without logging.
  runTick();
}

function buildDashboardProgressBar(percent = 0, width = 20) {
  const normalizedPercent = Math.max(0, Math.min(100, Number(percent || 0)));
  const safeWidth = Math.max(8, Number(width || 20));
  const filled = Math.round((normalizedPercent / 100) * safeWidth);
  const remaining = Math.max(0, safeWidth - filled);
  const soft = Math.round(remaining * 0.4);
  const empty = Math.max(0, remaining - soft);
  return `${"▓".repeat(filled)}${"▒".repeat(soft)}${"░".repeat(empty)}`;
}

function composeDashboardHeader(leftText = "", rightText = "", contentWidth = 80) {
  const right = String(rightText || "");
  const maxLeft = Math.max(1, contentWidth - right.length - 1);
  const leftRaw = String(leftText || "");
  const left = leftRaw.length > maxLeft ? `${leftRaw.slice(0, Math.max(1, maxLeft - 1))}…` : leftRaw;
  const spacer = " ".repeat(Math.max(1, contentWidth - left.length - right.length));
  return `${left}${spacer}${right}`;
}

function buildDashboardFrame(params = {}) {
  const {
    bodyWidth = 98,
    botName = "FSOCIETY BOT",
    onlinePulse = "●",
    ownerName = "OWNER",
    prefixValue = ".",
    commandCount = 0,
    processLabel = "UNICO",
    managedLabels = "MAIN",
    activeConfigLabels = "MAIN",
    sessionLabel = "main",
    versionLabel = "vdev",
    modules = [],
    telemetry = { cpuPct: 0, ramPct: 0, netPct: 0, latencyMs: 0, usedRamGb: 0, totalRamGb: 0 },
    activityLogs = [],
    bootReady = false,
  } = params;

  const contentWidth = Math.max(72, bodyWidth - 2);
  const systemTitle = `${String(botName || "FSOCIETY BOT").trim().toUpperCase()} CONTROL PANEL`;
  const statusLabel = bootReady ? "ONLINE" : "BOOTING";
  const lines = [];
  const row = (text = "") => {
    const clipped = String(text || "").slice(0, contentWidth);
    lines.push(`║${clipped.padEnd(contentWidth, " ")}║`);
  };
  const rawProcess = String(processLabel || "STABLE")
    .replaceAll("_", " ")
    .trim()
    .toUpperCase();
  const compactProcess =
    rawProcess.includes("UNICO") || rawProcess.includes("HOSTING")
      ? "UNICO"
      : rawProcess.includes("SPLIT") || rawProcess.includes("SEPARADO")
        ? "SPLIT"
        : rawProcess || "STABLE";
  const compactEnabled = String(activeConfigLabels || "MAIN").replace(/\s+/g, " ");
  const eventLines = activityLogs.length
    ? activityLogs.slice(-2).map((line) => `➤ ${String(line || "").replace(/^[✓↻]\s*/u, "")}`)
    : ["➤ Core initialized", "➤ Ready for command traffic"];
  const netPct = Math.max(0, Math.min(99, Number(telemetry.netPct || 0)));

  lines.push(`╔${"═".repeat(contentWidth)}╗`);
  row(
    composeDashboardHeader(
      `  ⚡ ${systemTitle}`,
      `${statusLabel} ${onlinePulse}`,
      contentWidth
    )
  );
  row(
    composeDashboardHeader(
      `  Process ${compactProcess} | Session ${sessionLabel}`,
      `Build ${versionLabel}`,
      contentWidth
    )
  );
  lines.push(`╠${"═".repeat(contentWidth)}╣`);
  row(`  Owner   : ${ownerName.toUpperCase()}`);
  row(`  Prefix  : ${prefixValue}`);
  row(`  Commands: ${commandCount} | Config: ${compactEnabled}`);
  lines.push(`╟${"─".repeat(contentWidth)}╢`);
  row(
    `  CPU ${String(telemetry.cpuPct).padStart(2, " ")}% | RAM ${String(telemetry.ramPct).padStart(2, " ")}% | NET ${String(netPct).padStart(2, " ")}% (${Number(telemetry.netMbps || 0).toFixed(2)} Mbps)`
  );
  row(
    `  LAT ${String(telemetry.latencyMs).padStart(3, " ")} ms | MEM ${telemetry.usedRamGb.toFixed(1)}/${telemetry.totalRamGb.toFixed(1)} GB`
  );
  for (const line of eventLines) {
    row(`  ${line}`);
  }
  lines.push(`╟${"─".repeat(contentWidth)}╢`);
  row(bootReady ? "  SISTEMA LISTO PARA COMANDOS." : "  INICIANDO SERVICIOS...");
  lines.push(`╚${"═".repeat(contentWidth)}╝`);

  return lines;
}

function buildMaskLoadingScreen() {
  return [
    "╔════════════════════════════════════════════════════════════════════╗",
    "║                      FSOCIETY PRE-BOOT MASK                       ║",
    "╠════════════════════════════════════════════════════════════════════╣",
    "║                                                                    ║",
    "║             .                                                      ║",
    "║           .d8b.      .d8888.   .d8888.   .d8888.                  ║",
    "║          d8' `8b     88'  YP   88'  YP   88'  YP                  ║",
    "║          88ooo88     `8bo.     `8bo.     `8bo.                    ║",
    "║          88~~~88       `Y8b.     `Y8b.     `Y8b.                  ║",
    "║          88   88     db   8D   db   8D   db   8D                  ║",
    "║          YP   YP     `8888Y'   `8888Y'   `8888Y'                  ║",
    "║                                                                    ║",
    "║               CARGANDO SISTEMA... ESPERA UN MOMENTO               ║",
    "║                                                                    ║",
    "╚════════════════════════════════════════════════════════════════════╝",
  ];
}

function buildMaskPairingScreen() {
  return [
    "╔════════════════════════════════════════════════════════════════════╗",
    "║                         FSOCIETY LINK MASK                         ║",
    "╠════════════════════════════════════════════════════════════════════╣",
    "║                                                                    ║",
    "║             .-'''-.                                                ║",
    "║            /  .-.  \\                                               ║",
    "║           |  /   \\  |                                              ║",
    "║           | |     | |                                              ║",
    "║           |  \\___/  |                                              ║",
    "║            \\       /                                               ║",
    "║             `-...-'                                                ║",
    "║                                                                    ║",
    "║      INGRESE SU NUMERO PARA VINCULARSE AL BOT PRINCIPAL            ║",
    "║      FORMATO SUGERIDO: 51XXXXXXXXX                                 ║",
    "║                                                                    ║",
    "╚════════════════════════════════════════════════════════════════════╝",
  ];
}

async function banner() {
  const managedLabels = getManagedProcessBotConfigs()
    .map((cfg) => cfg.label)
    .filter(Boolean)
    .join(", ") || "NINGUNO";
  const activeConfigLabels = BOT_CONFIGS.map((cfg) => cfg.label).join(", ") || "NINGUNO";
  const botName = String(settings?.botName || "Fsociety bot")
    .trim()
    .toUpperCase();
  const ownerName = String(settings?.ownerName || "Owner").trim();
  const prefixValue = Array.isArray(settings.prefix)
    ? settings.prefix.join(", ")
    : String(settings.prefix || ".");
  const terminalWidth = Number(process.stdout?.columns || 0);
  const bodyWidth = Math.max(76, Math.min(96, terminalWidth > 0 ? terminalWidth - 2 : 92));
  const isInteractiveTerminal = Boolean(process.stdout?.isTTY);
  const animateBoot =
    CONSOLE_BOOT_ANIMATION &&
    isInteractiveTerminal &&
    !isPm2Environment(process.env);
  const bootSteps = animateBoot ? 2 : 1;
  const bootDelayMs = CONSOLE_BOOT_FRAME_DELAY_MS;
  const onlinePulseFrames = ["●", "○", "◇", "◆"];
  const managedConfigs = getManagedProcessBotConfigs();
  const moduleTargets = managedConfigs.slice(0, 2).map((cfg, index) => ({
    name: String(cfg?.label || `BOT${index + 1}`),
    target: index === 0 ? 100 : 98,
  }));
  moduleTargets.push({ name: "IMG ENGINE", target: 76 });
  const bootLogSeed = [
    "✓ Core initialized",
    "↻ Module scan complete",
    "✓ Connections established",
    "↻ Fallback mode enabled",
    "✓ Ready for command traffic",
  ];
  const activityLogs = [];
  const fallbackLatency = await estimateBootLatencyMs();
  networkTrafficSampleCache = readNetworkTrafficSample();
  const initialLatency = await measureHttpLatencyMs(CONSOLE_METRIC_PING_URL);

  if (isInteractiveTerminal) {
    console.clear();
  }
  for (const line of buildMaskLoadingScreen()) {
    console.log(chalk.magentaBright(line));
  }
  await delay(450);

  if (isInteractiveTerminal) {
    console.clear();
  }
  for (const line of buildMaskPairingScreen()) {
    console.log(chalk.cyanBright(line));
  }
  await delay(550);

  for (let step = 1; step <= bootSteps; step += 1) {
    const ratio = step / bootSteps;
    while (activityLogs.length < Math.min(bootLogSeed.length, step)) {
      activityLogs.push(bootLogSeed[activityLogs.length]);
    }

    const modules = moduleTargets.map((module) => ({
      ...module,
      percent:
        step === bootSteps
          ? module.target
          : Math.max(8, Math.round(module.target * ratio)),
    }));

    const cpuCount = Math.max(1, Number(os.cpus()?.length || 1));
    const loadAverage = Number(os.loadavg?.()[0] || 0);
    const totalMemBytes = Math.max(1, Number(os.totalmem() || 0));
    const usedMemBytes = Math.max(0, totalMemBytes - Number(os.freemem() || 0));
    const usedRamGb = usedMemBytes / (1024 ** 3);
    const totalRamGb = totalMemBytes / (1024 ** 3);
    const networkMetrics = getRealtimeNetworkMetrics();
    const liveLatency =
      step === bootSteps
        ? await measureHttpLatencyMs(CONSOLE_METRIC_PING_URL)
        : Number(initialLatency || fallbackLatency || 1);

    const telemetry = {
      cpuPct: Math.max(1, Math.min(99, Math.round((loadAverage / cpuCount) * 100))),
      ramPct: Math.max(1, Math.min(99, Math.round((usedMemBytes / totalMemBytes) * 100))),
      netPct: networkMetrics.percent,
      netMbps: networkMetrics.mbps,
      latencyMs: Math.max(1, Number(liveLatency || fallbackLatency || 1)),
      usedRamGb,
      totalRamGb,
    };

    const frameLines = buildDashboardFrame({
      bodyWidth,
      botName,
      onlinePulse: onlinePulseFrames[(step - 1) % onlinePulseFrames.length],
      ownerName,
      prefixValue,
      commandCount: comandos.size,
      processLabel: String(PROCESS_MODE_LABEL),
      managedLabels,
      activeConfigLabels,
      sessionLabel: SPLIT_PROCESS_MODE
        ? `SPLIT:${String(PROCESS_BOT_ID || "MAIN").toUpperCase()}`
        : "SINGLE:ALL",
      versionLabel: getPackageVersionLabel(),
      modules,
      telemetry,
      activityLogs,
      bootReady: step === bootSteps,
    });

    if (isInteractiveTerminal) {
      console.clear();
    }

    for (const line of frameLines) {
      if (/^[┏┣┗]/.test(line)) {
        console.log(chalk.magentaBright(line));
        continue;
      }

      if (line.includes("ONLINE")) {
        console.log(chalk.cyanBright(line));
        continue;
      }

      console.log(chalk.blueBright(line));
    }

    if (animateBoot && step < bootSteps) {
      await delay(bootDelayMs);
    }
  }
}

// ================= CARGAR COMANDOS =================

function normalizeLoadedCommandMetadata(cmd) {
  if (!cmd || typeof cmd !== "object") {
    return cmd;
  }

  const rawCommandList = [];

  if (cmd.name) {
    rawCommandList.push(cmd.name);
  }

  if (Array.isArray(cmd.command)) {
    rawCommandList.push(...cmd.command);
  } else if (cmd.command) {
    rawCommandList.push(cmd.command);
  }

  if (Array.isArray(cmd.commands)) {
    rawCommandList.push(...cmd.commands);
  } else if (cmd.commands) {
    rawCommandList.push(cmd.commands);
  }

  const normalizedCommands = [...new Set(
    rawCommandList
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean)
  )];

  cmd.command = normalizedCommands;
  cmd.name = String(cmd.name || normalizedCommands[0] || "").trim().toLowerCase();
  cmd.category = String(cmd.category || cmd.categoria || "otros").trim().toLowerCase() || "otros";
  cmd.categoria = cmd.category;
  cmd.description = String(cmd.description || cmd.desc || cmd.help || "").replace(/\s+/g, " ").trim();
  cmd.ownerOnly = cmd.ownerOnly === true;
  cmd.adminOnly = cmd.adminOnly === true || cmd.groupAdminOnly === true;
  cmd.hidden = cmd.hidden === true || cmd.hide === true || cmd.oculto === true;

  return cmd;
}

async function cargarComandos() {
  const base = path.join(__dirname, "commands");
  comandos.clear();
  commandModules.clear();
  messageHookModules.length = 0;
  groupUpdateHookModules.length = 0;
  messageDeleteHookModules.length = 0;

  async function leer(dir) {
    const archivos = fs.readdirSync(dir, { withFileTypes: true });

    for (const archivo of archivos) {
      const ruta = path.join(dir, archivo.name);

      if (archivo.isDirectory()) {
        await leer(ruta);
        continue;
      }

      if (!archivo.name.endsWith(".js")) continue;

      try {
        const fileUrl = pathToFileURL(ruta);
        const mtimeMs = Number(fs.statSync(ruta).mtimeMs || Date.now());
        fileUrl.searchParams.set("v", String(Math.floor(mtimeMs)));
        const mod = await import(fileUrl.href);
        const cmd = normalizeLoadedCommandMetadata(mod.default);

        if (!cmd || typeof cmd.run !== "function") continue;

        try {
          const relativeSource = path.relative(base, ruta).split(path.sep).join("/");
          cmd.__sourceFile = ruta;
          cmd.__pluginKey = relativeSource || ruta;
        } catch {}

        commandModules.add(cmd);
        if (typeof cmd.onMessage === "function") messageHookModules.push(cmd);
        if (typeof cmd.onGroupUpdate === "function") groupUpdateHookModules.push(cmd);
        if (typeof cmd.onMessageDelete === "function") messageDeleteHookModules.push(cmd);

        const nombres = Array.isArray(cmd.command)
          ? cmd.command
          : cmd.command
            ? [cmd.command]
            : cmd.name
              ? [cmd.name]
              : [];

        for (const nombre of nombres) {
          comandos.set(String(nombre).toLowerCase(), cmd);
        }

        if (LOG_COMMAND_LOADS) {
          console.log("Comando cargado:", nombres.join(", "));
        }
      } catch (err) {
        console.error("Error cargando comando:", ruta, err);
      }
    }
  }

  await leer(base);
  applyGlobalCommandAliases();
}

// ================= PAIRING =================

function clearPairingResetTimer(botState) {
  if (!botState?.pairingResetTimer) return;
  clearTimeout(botState.pairingResetTimer);
  botState.pairingResetTimer = null;
}

function resetPairingCache(botState) {
  clearPairingResetTimer(botState);
  botState.pairingRequested = false;
  botState.lastPairingCode = "";
  botState.lastPairingNumber = "";
  botState.lastPairingAt = 0;
  botState.lastPairingRequestAt = 0;
  botState.lastPairingRequestNumber = "";
  writePersistedBotRuntimeState(botState);
}

function cachePairingCode(botState, code, number) {
  clearPairingResetTimer(botState);
  botState.pairingRequested = true;
  botState.lastPairingCode = String(code || "");
  botState.lastPairingNumber = String(number || "");
  botState.lastPairingAt = Date.now();
  botState.lastPairingErrorAt = 0;
  botState.lastPairingError = "";

  botState.pairingResetTimer = setTimeout(() => {
    const shouldRelease =
      botState?.config?.id !== "main" &&
      !isBotRegistered(botState) &&
      !botState?.sock?.user?.id;

    resetPairingCache(botState);

    if (shouldRelease) {
      releaseSubbotSlot(botState, {
        reason: "pairing_expirado",
        closeSocket: true,
        resetAuthFolder: true,
      });
    }
  }, PAIRING_CODE_CACHE_MS);

  botState.pairingResetTimer.unref?.();
  writePersistedBotRuntimeState(botState);
}

function getCachedPairingCode(botState) {
  if (!botState?.lastPairingCode || !botState?.lastPairingAt) {
    return null;
  }

  const age = Date.now() - botState.lastPairingAt;
  if (age >= PAIRING_CODE_CACHE_MS) {
    resetPairingCache(botState);
    return null;
  }

  return {
    code: botState.lastPairingCode,
    number: botState.lastPairingNumber,
    expiresInMs: PAIRING_CODE_CACHE_MS - age,
  };
}

function summarizeBotState(botState) {
  const config = botState?.config || {};
  const cachedPairing = getCachedPairingCode(botState);
  const registered = isBotRegistered(botState);
  const connected = Boolean(botState?.sock?.user?.id);
  const queueState = getBotDownloadQueueState(botState);
  const configuredNumber = sanitizePhoneNumber(config?.pairingNumber);
  const requesterNumber = sanitizePhoneNumber(config?.requesterNumber) || configuredNumber;
  const requestedAt = normalizeTimestamp(config?.requestedAt);
  const connectedForMs =
    connected && botState?.connectedAt ? Math.max(0, Date.now() - botState.connectedAt) : 0;
  const activeCommandStartedAt = Number(botState?.activeCommandStartedAt || 0);
  const rawUserId = String(botState?.sock?.user?.id || "").trim();
  const waNumber = rawUserId
    ? sanitizePhoneNumber(String(rawUserId.split("@")[0] || "").split(":")[0])
    : "";
  const waName = String(
    botState?.sock?.user?.name ||
      botState?.sock?.user?.verifiedName ||
      botState?.sock?.user?.notify ||
      ""
  ).trim();

  return {
    id: String(config.id || ""),
    slot: Number(config.slot || 0),
    label: String(config.label || "BOT"),
    displayName: String(config.displayName || "Bot"),
    authFolder: String(config.authFolder || ""),
    enabled: config.enabled !== false,
    registered,
    connected,
    connecting: Boolean(botState?.connecting),
    hasSocket: Boolean(botState?.sock),
    connectedAt: Number(botState?.connectedAt || 0),
    lastDisconnectAt: Number(botState?.lastDisconnectAt || 0),
    lastDisconnectCode: Number(botState?.lastDisconnectCode || 0),
    configuredNumber,
    requesterNumber,
    requesterJid: String(config?.requesterJid || ""),
    requestedAt,
    releasedAt: normalizeTimestamp(config?.releasedAt),
    waNumber,
    waName,
    connectedForMs,
    hasConfiguredNumber: Boolean(configuredNumber),
    pairingPending: Boolean(botState?.pairingRequested),
    connectionState: String(botState?.connectionState || ""),
    bootStartedAt: Number(botState?.bootStartedAt || 0),
    lastSocketEventAt: Number(botState?.lastSocketEventAt || 0),
    lastSocketEvent: String(botState?.lastSocketEvent || ""),
    lastMessageUpsertAt: Number(botState?.lastMessageUpsertAt || 0),
    lastIncomingMessageAt: Number(botState?.lastIncomingMessageAt || 0),
    lastSendSuccessAt: Number(botState?.lastSendSuccessAt || 0),
    lastSendErrorAt: Number(botState?.lastSendErrorAt || 0),
    lastSendError: String(botState?.lastSendError || ""),
    lastPairingRequestAt: Number(botState?.lastPairingRequestAt || 0),
    lastPairingRequestNumber: String(botState?.lastPairingRequestNumber || ""),
    lastPairingErrorAt: Number(botState?.lastPairingErrorAt || 0),
    lastPairingError: String(botState?.lastPairingError || ""),
    lastCommandName: String(botState?.lastCommandName || ""),
    lastCommandStartedAt: Number(botState?.lastCommandStartedAt || 0),
    lastCommandFinishedAt: Number(botState?.lastCommandFinishedAt || 0),
    lastCommandDurationMs: Number(botState?.lastCommandDurationMs || 0),
    lastCommandStatus: String(botState?.lastCommandStatus || ""),
    lastCommandTimedOutAt: Number(botState?.lastCommandTimedOutAt || 0),
    activeCommandName: String(botState?.activeCommandName || ""),
    activeCommandStartedAt,
    activeCommandTimeoutMs: Number(botState?.activeCommandTimeoutMs || 0),
    activeCommandRunningForMs: activeCommandStartedAt
      ? Math.max(0, Date.now() - activeCommandStartedAt)
      : 0,
    replacementBlocked: Boolean(botState?.replacementBlocked),
    replacementBlockedAt: Number(botState?.replacementBlockedAt || 0),
    replacementBlockedUntil: Number(botState?.replacementBlockedUntil || 0),
    cachedPairingCode: cachedPairing?.code || "",
    cachedPairingNumber: cachedPairing?.number || "",
    cachedPairingExpiresInMs: cachedPairing?.expiresInMs || 0,
    activeDownloadCount: queueState.activeCount,
    downloadQueuePending: queueState.pending,
    downloadQueueActive: queueState.active,
    currentDownloadCommand: queueState.currentCommand,
    currentDownloadRunningForMs: queueState.runningForMs,
  };
}

function summarizeBotConfig(config) {
  const botState = botStates.get(config.id);
  const shouldUseLocalState =
    botState &&
    (!SPLIT_PROCESS_MODE ||
      ownsBotInThisProcess(config?.id) ||
      botState.sock ||
      botState.connecting ||
      botState.authState ||
      botState.pairingRequested ||
      botState.lastPairingCode ||
      botState.connectedAt ||
      botState.lastDisconnectAt);

  if (shouldUseLocalState) {
    return summarizeBotState(botState);
  }

  const persistedState = readPersistedBotRuntimeState(config?.id);
  if (persistedState) {
    return {
      ...persistedState,
      id: String(config?.id || persistedState.id || ""),
      slot: Number(config?.slot || persistedState.slot || 0),
      label: String(config?.label || persistedState.label || "BOT"),
      displayName: String(config?.displayName || persistedState.displayName || "Bot"),
      authFolder: String(config?.authFolder || persistedState.authFolder || ""),
      enabled: config?.enabled !== false,
      configuredNumber:
        sanitizePhoneNumber(config?.pairingNumber) || persistedState.configuredNumber || "",
      requesterNumber:
        sanitizePhoneNumber(config?.requesterNumber) ||
        persistedState.requesterNumber ||
        sanitizePhoneNumber(config?.pairingNumber) ||
        "",
      requesterJid: String(config?.requesterJid || persistedState.requesterJid || ""),
      requestedAt: normalizeTimestamp(config?.requestedAt || persistedState.requestedAt),
      releasedAt: normalizeTimestamp(config?.releasedAt || persistedState.releasedAt),
      hasConfiguredNumber: Boolean(
        sanitizePhoneNumber(config?.pairingNumber) || persistedState.configuredNumber
      ),
      connectionState: String(persistedState.connectionState || ""),
      bootStartedAt: Number(persistedState.bootStartedAt || 0),
      lastSocketEventAt: Number(persistedState.lastSocketEventAt || 0),
      lastSocketEvent: String(persistedState.lastSocketEvent || ""),
      lastMessageUpsertAt: Number(persistedState.lastMessageUpsertAt || 0),
      lastIncomingMessageAt: Number(persistedState.lastIncomingMessageAt || 0),
      lastSendSuccessAt: Number(persistedState.lastSendSuccessAt || 0),
      lastSendErrorAt: Number(persistedState.lastSendErrorAt || 0),
      lastSendError: String(persistedState.lastSendError || ""),
      lastPairingRequestAt: Number(persistedState.lastPairingRequestAt || 0),
      lastPairingRequestNumber: String(persistedState.lastPairingRequestNumber || ""),
      lastPairingErrorAt: Number(persistedState.lastPairingErrorAt || 0),
      lastPairingError: String(persistedState.lastPairingError || ""),
      lastCommandName: String(persistedState.lastCommandName || ""),
      lastCommandStartedAt: Number(persistedState.lastCommandStartedAt || 0),
      lastCommandFinishedAt: Number(persistedState.lastCommandFinishedAt || 0),
      lastCommandDurationMs: Number(persistedState.lastCommandDurationMs || 0),
      lastCommandStatus: String(persistedState.lastCommandStatus || ""),
      lastCommandTimedOutAt: Number(persistedState.lastCommandTimedOutAt || 0),
      activeCommandName: String(persistedState.activeCommandName || ""),
      activeCommandStartedAt: Number(persistedState.activeCommandStartedAt || 0),
      activeCommandTimeoutMs: Number(persistedState.activeCommandTimeoutMs || 0),
      activeCommandRunningForMs: Number(persistedState.activeCommandRunningForMs || 0),
      lastDisconnectCode: Number(persistedState.lastDisconnectCode || 0),
    };
  }

  const configuredNumber = sanitizePhoneNumber(config?.pairingNumber);
  const requesterNumber = sanitizePhoneNumber(config?.requesterNumber) || configuredNumber;
  const requestedAt = normalizeTimestamp(config?.requestedAt);

  return {
    id: String(config?.id || ""),
    slot: Number(config?.slot || 0),
    label: String(config?.label || "BOT"),
    displayName: String(config?.displayName || "Bot"),
    authFolder: String(config?.authFolder || ""),
    enabled: config?.enabled !== false,
    registered: false,
    connected: false,
    connecting: false,
    hasSocket: false,
    connectedAt: 0,
    lastDisconnectAt: 0,
    lastDisconnectCode: 0,
    configuredNumber,
    requesterNumber,
    requesterJid: String(config?.requesterJid || ""),
    requestedAt,
    releasedAt: normalizeTimestamp(config?.releasedAt),
    connectedForMs: 0,
    hasConfiguredNumber: Boolean(configuredNumber),
    pairingPending: false,
    connectionState: "",
    bootStartedAt: 0,
    lastSocketEventAt: 0,
    lastSocketEvent: "",
    lastMessageUpsertAt: 0,
    lastIncomingMessageAt: 0,
    lastSendSuccessAt: 0,
    lastSendErrorAt: 0,
    lastSendError: "",
    lastPairingRequestAt: 0,
    lastPairingRequestNumber: "",
    lastPairingErrorAt: 0,
    lastPairingError: "",
    lastCommandName: "",
    lastCommandStartedAt: 0,
    lastCommandFinishedAt: 0,
    lastCommandDurationMs: 0,
    lastCommandStatus: "",
    lastCommandTimedOutAt: 0,
    activeCommandName: "",
    activeCommandStartedAt: 0,
    activeCommandTimeoutMs: 0,
    activeCommandRunningForMs: 0,
    cachedPairingCode: "",
    cachedPairingNumber: "",
    cachedPairingExpiresInMs: 0,
    activeDownloadCount: 0,
    downloadQueuePending: 0,
    downloadQueueActive: false,
    currentDownloadCommand: "",
    currentDownloadRunningForMs: 0,
  };
}

function hasPersistedBotSession(config = {}) {
  const authFolder = String(config?.authFolder || "").trim();
  if (!authFolder) return false;

  const credsPath = path.join(authFolder, "creds.json");
  if (!fs.existsSync(credsPath)) return false;

  try {
    const raw = fs.readFileSync(credsPath, "utf-8");
    const parsed = JSON.parse(raw);
    return Boolean(parsed?.registered || parsed?.me?.id);
  } catch {
    return false;
  }
}

function hasPendingSubbotAssignment(config = {}) {
  return Boolean(
    sanitizePhoneNumber(config?.pairingNumber) ||
      sanitizePhoneNumber(config?.requesterNumber) ||
      String(config?.requesterJid || "").trim() ||
      normalizeTimestamp(config?.requestedAt)
  );
}

function shouldKeepSplitSubbotProcess(config = {}) {
  if (!config || config.id === "main" || config.enabled === false) {
    return false;
  }

  return Boolean(hasPersistedBotSession(config) || hasPendingSubbotAssignment(config));
}

function shouldRunSubbotReservationCleanup() {
  return !SPLIT_PROCESS_MODE || PROCESS_BOT_ID === "main";
}

function isSubbotReservationExpired(summary = {}) {
  const requestedAt = normalizeTimestamp(summary?.requestedAt);
  if (!requestedAt) {
    return false;
  }

  if (summary?.connected || summary?.registered || summary?.pairingPending) {
    return false;
  }

  if (!getSubbotAssignedNumber(summary)) {
    return false;
  }

  return Date.now() - requestedAt >= SUBBOT_RESERVATION_TIMEOUT_MS;
}

function runSubbotReservationCleanup() {
  if (!shouldRunSubbotReservationCleanup()) {
    return 0;
  }

  if (SUBBOT_RESERVATION_TIMEOUT_MS <= 0) {
    return 0;
  }

  let releasedCount = 0;

  for (const config of SUBBOT_SLOT_CONFIGS) {
    if (!config || config.enabled === false) {
      continue;
    }

    const summary = summarizeBotConfig(config);
    if (!isSubbotReservationExpired(summary)) {
      continue;
    }

    const botState = botStates.get(config.id) || null;
    if (botState && (!SPLIT_PROCESS_MODE || PROCESS_BOT_ID === "main")) {
      const released = releaseSubbotSlot(botState, {
        reason: "reserva_expirada",
        closeSocket: true,
        resetAuthFolder: true,
      });
      if (released) {
        releasedCount += 1;
      }
      continue;
    }

    const releasedConfig = saveSubbotSlotConfig(config.slot, {
      enabled: false,
      pairingNumber: "",
      requesterNumber: "",
      requesterJid: "",
      requestedAt: 0,
      releasedAt: Date.now(),
    });

    if (releasedConfig) {
      clearPersistedBotRuntimeState(config.id);
      releasedCount += 1;
    }
  }

  if (releasedCount > 0) {
    console.log(
      `[SUBBOT] Libere ${releasedCount} slot(s) por reserva expirada ` +
        `(${Math.floor(SUBBOT_RESERVATION_TIMEOUT_MS / 1000)}s).`
    );
  }

  return releasedCount;
}

async function reconnectManagedSubbot(botId, options = {}) {
  const targetConfig = getSubbotConfigById(botId);
  if (!targetConfig) {
    return {
      ok: false,
      status: "missing_bot",
      message: "No encontre ese subbot.",
    };
  }

  const currentSummary = summarizeBotConfig(targetConfig);
  const hasAnySessionOrAssignment = Boolean(
    currentSummary.connected ||
      currentSummary.registered ||
      currentSummary.pairingPending ||
      currentSummary.connecting ||
      getSubbotAssignedNumber(currentSummary)
  );

  if (!hasAnySessionOrAssignment) {
    return {
      ok: false,
      status: "slot_free",
      message: `El slot ${targetConfig.slot} esta libre y no necesita reconexion.`,
    };
  }

  if (SPLIT_PROCESS_MODE && !ownsBotInThisProcess(targetConfig.id)) {
    if (PROCESS_BOT_ID !== "main" || !isPm2Environment(process.env)) {
      return {
        ok: false,
        status: "remote_process",
        message:
          "Ese subbot corre en otro proceso. Ejecuta la reconexion desde el MAIN o con PM2.",
      };
    }

    const processName = getSplitProcessName(targetConfig.id);
    const restartResult = await runPm2Command(["restart", processName, "--update-env"]);

    if (!restartResult.ok) {
      return {
        ok: false,
        status: "pm2_restart_failed",
        message:
          `No pude reiniciar ${processName}. ` +
          String(restartResult?.stderr || restartResult?.stdout || "Error PM2.").trim(),
      };
    }

    await runPm2Command(["save"]);
    return {
      ok: true,
      status: "restarting_process",
      message: `Reinicie ${processName}. Debe reconectar en unos segundos.`,
      bot: summarizeBotConfig(getSubbotConfigBySlot(targetConfig.slot) || targetConfig),
    };
  }

  const targetState = ensureBotState(targetConfig);
  const startDecision = evaluateManagedProcessStartDecision(targetState.config, {
    botState: targetState,
  });

  if (!startDecision.start) {
    return {
      ok: false,
      status: "not_allowed_now",
      message:
        `No puedo reconectar ahora (motivo: ${startDecision.reason}). ` +
        `Revisa el slot o vuelve a intentar.`,
    };
  }

  recycleBotInstance(targetState, String(options?.reason || "owner_reconnect"));
  scheduleReconnect(
    targetState,
    Math.max(800, Number(options?.delayMs || 1200)),
    String(options?.reason || "owner_reconnect")
  );
  writePersistedBotRuntimeState(targetState);

  return {
    ok: true,
    status: "reconnecting",
    message: `Subbot ${targetConfig.slot} entrando en reconexion.`,
    bot: summarizeBotConfig(getSubbotConfigBySlot(targetConfig.slot) || targetConfig),
  };
}

async function listPm2ProcessNames() {
  const result = await runPm2Command(["jlist"]);
  if (!result.ok) {
    return [];
  }

  try {
    const parsed = JSON.parse(result.stdout || "[]");
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item?.name || "").trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

async function ensureSplitBotProcess(config = {}) {
  if (!SPLIT_PROCESS_MODE || !isPm2Environment(process.env) || !config?.id) {
    return false;
  }

  const processName = getSplitProcessName(config.id);
  const names = await listPm2ProcessNames();
  if (names.includes(processName)) {
    return true;
  }

  const result = await runPm2Command(
    ["start", "index.js", "--name", processName, "--cwd", process.cwd(), "--update-env"],
    {
      BOT_INSTANCE: config.id,
    }
  );

  if (result.ok) {
    await runPm2Command(["save"]);
    console.log(`[PM2] Proceso iniciado: ${processName}`);
    return true;
  }

  console.error(`[PM2] No pude iniciar ${processName}:`, result.stderr || result.stdout);
  return false;
}

async function deleteSplitBotProcess(botId) {
  if (!SPLIT_PROCESS_MODE || !isPm2Environment(process.env) || !botId) {
    return false;
  }

  const processName = getSplitProcessName(botId);
  const names = await listPm2ProcessNames();
  if (!names.includes(processName)) {
    return true;
  }

  const result = await runPm2Command(["delete", processName]);
  if (result.ok) {
    await runPm2Command(["save"]);
    console.log(`[PM2] Proceso eliminado: ${processName}`);
    return true;
  }

  console.error(`[PM2] No pude eliminar ${processName}:`, result.stderr || result.stdout);
  return false;
}

function shouldStartSecondaryBot(config = {}) {
  if (!config || config.id === "main") return false;
  if (config.enabled === false) return false;
  return hasPersistedBotSession(config);
}

function shouldPromptInConsole(botState) {
  return (
    canPromptInConsole() &&
    ownsBotInThisProcess(botState?.config?.id) &&
    botState?.config?.id === "main"
  );
}

function shouldAutoRequestPairingCode(botState) {
  if (!ownsBotInThisProcess(botState?.config?.id)) {
    return false;
  }

  if (botState?.config?.id === "main") {
    return true;
  }

  return Boolean(sanitizePhoneNumber(botState?.config?.pairingNumber));
}

function getMainBotState() {
  return botStates.get("main") || null;
}

function isMainBotLiveReady() {
  const mainBotState = getMainBotState();
  if (!mainBotState) return false;

  return Boolean(
    mainBotState.connectedAt &&
      (mainBotState?.sock?.user?.id || isBotRegistered(mainBotState))
  );
}

function isMainBotReady() {
  const mainBotState = getMainBotState();
  if (mainBotState && Boolean(isBotRegistered(mainBotState) || mainBotState?.sock?.user?.id)) {
    return true;
  }

  const persistedMain = readPersistedBotRuntimeState("main");
  return Boolean(persistedMain?.registered || persistedMain?.connected);
}

function shouldDelaySecondaryStartup(config = {}, botState = null) {
  if (SPLIT_PROCESS_MODE || !config || config.id === "main") {
    return false;
  }

  if (botState?.sock || botState?.connecting || botState?.reconnectTimer) {
    return false;
  }

  if (isMainBotLiveReady()) {
    return false;
  }

  const mainBotState = getMainBotState();
  if (!mainBotState) {
    return false;
  }

  return Boolean(
    mainBotState.connecting ||
      mainBotState.bootStartedAt ||
      mainBotState.reconnectTimer ||
      ["", "booting", "connecting", "reconnecting"].includes(
        String(mainBotState.connectionState || "").trim().toLowerCase()
      )
  );
}

function evaluateManagedProcessStartDecision(config = {}, options = {}) {
  if (!config) {
    return { start: false, reason: "missing_config" };
  }

  const botState = options?.botState || botStates.get(config.id) || null;
  if (isReplacementBlocked(botState)) {
    return { start: false, reason: "replacement_blocked_memory" };
  }

  if (isPersistedReplacementBlocked(config.id)) {
    const connectionState = String(botState?.connectionState || "")
      .trim()
      .toLowerCase();
    const liveSocketState = Boolean(
      botState?.sock ||
        botState?.connecting ||
        botState?.reconnectTimer ||
        botState?.connectedAt
    );

    if (
      liveSocketState &&
      ["open", "connecting", "reconnecting", "booting", "close"].includes(connectionState)
    ) {
      return {
        start: true,
        reason: "persisted_replacement_block_ignored_live_socket",
      };
    }

    return { start: false, reason: "replacement_blocked_persisted" };
  }

  if (config.id === "main") {
    return { start: true, reason: "main_process" };
  }

  if (config.enabled === false) {
    return { start: false, reason: "slot_disabled" };
  }

  if (!SPLIT_PROCESS_MODE) {
    return shouldStartSecondaryBot(config)
      ? { start: true, reason: "secondary_session_ready" }
      : { start: false, reason: "secondary_missing_session" };
  }

  if (hasPersistedBotSession(config)) {
    return { start: true, reason: "persisted_session" };
  }

  if (sanitizePhoneNumber(config?.pairingNumber) && isMainBotReady()) {
    return { start: true, reason: "pairing_number_main_ready" };
  }

  return { start: false, reason: "waiting_session_or_main" };
}

function shouldManagedProcessStartBot(config = {}, options = {}) {
  return evaluateManagedProcessStartDecision(config, options).start;
}

function shouldDeferManagedStop(botState, stopReason = "esperando_sesion") {
  if (!botState || stopReason !== "esperando_sesion") {
    return false;
  }

  const connectionState = String(botState.connectionState || "")
    .trim()
    .toLowerCase();
  if (
    botState.sock &&
    ["open", "connecting", "reconnecting", "booting"].includes(connectionState)
  ) {
    return true;
  }

  if (botState.connecting || botState.reconnectTimer) {
    return true;
  }

  const lastActivityAt = Math.max(
    Number(botState.lastSocketEventAt || 0),
    Number(botState.connectedAt || 0),
    Number(botState.bootStartedAt || 0),
    Number(botState.lastDisconnectAt || 0)
  );

  if (lastActivityAt > 0 && Date.now() - lastActivityAt < MANAGED_STOP_GRACE_MS) {
    return true;
  }

  const lastDisconnectCode = Number(botState.lastDisconnectCode || 0);
  const lastDisconnectAt = Number(botState.lastDisconnectAt || 0);
  if (
    lastDisconnectCode === 0 &&
    lastDisconnectAt > 0 &&
    Date.now() - lastDisconnectAt < MANAGED_STOP_GRACE_MS * 2
  ) {
    return true;
  }

  return false;
}

function logManagedStopDecision(botState, config, decision) {
  if (!botState || !decision || decision.start) {
    return;
  }

  const reason = String(decision.reason || "unknown");
  if (["secondary_missing_session", "waiting_session_or_main"].includes(reason)) {
    return;
  }
  const now = Date.now();

  if (
    botState.lastManagedStopDecisionReason === reason &&
    now - Number(botState.lastManagedStopDecisionAt || 0) < MANAGED_STOP_LOG_THROTTLE_MS
  ) {
    return;
  }

  botState.lastManagedStopDecisionReason = reason;
  botState.lastManagedStopDecisionAt = now;

  logBotEvent(
    botState,
    "warn",
    `Sync: pausa gestionada (${reason})` +
      ` | enabled=${config?.enabled !== false}` +
      ` | state=${String(botState.connectionState || "unknown")}` +
      ` | hasSocket=${Boolean(botState.sock)}`
  );
}

function stopLocalManagedBot(botState, reason = "disabled") {
  if (!botState) return;

  clearReconnectTimer(botState);
  clearSocketRecoveryTimer(botState);
  clearPairingResetTimer(botState);
  clearProfileApplyTimer(botState);
  abortActiveDownloadJobs(botState, `bot_stopped:${reason}`);
  abortActiveCommand(botState, `bot_stopped:${reason}`);

  try {
    botState.sock?.end?.();
  } catch {}

  botState.sock = null;
  botState.authState = null;
  botState.connecting = false;
  botState.lastDisconnectAt = Date.now();
  botState.lastDisconnectCode = 0;
  botState.connectedAt = 0;
  botState.connectionState = `stopped:${String(reason || "disabled").slice(0, 40)}`;
  botState.bootStartedAt = 0;
  botState.managedStopDeferredAt = 0;
  botState.lastManagedStopDecisionReason = "";
  botState.lastManagedStopDecisionAt = 0;
  clearActiveCommandState(botState);
  botState.groupCache?.clear?.();
  botState.contactNameCache?.clear?.();
  botState.recentMessageIds?.clear?.();
  botState.activeDownloadJobs?.clear?.();
  if (reason !== "esperando_sesion") {
    logBotEvent(botState, "warn", `Detenido localmente (${reason})`);
  }
  writePersistedBotRuntimeState(botState);
}

function recycleBotInstance(botState, reason = "recovery") {
  if (!botState) return false;

  clearReconnectTimer(botState);
  clearSocketRecoveryTimer(botState);
  clearPairingResetTimer(botState);
  clearProfileApplyTimer(botState);
  abortActiveDownloadJobs(botState, `bot_recycled:${reason}`);
  abortActiveCommand(botState, `bot_recycled:${reason}`);

  try {
    botState.sock?.end?.();
  } catch {}

  botState.sock = null;
  botState.authState = null;
  botState.connecting = false;
  botState.connectedAt = 0;
  botState.lastDisconnectAt = Date.now();
  botState.lastDisconnectCode = 0;
  botState.connectionState = `recovery:${String(reason || "unknown").slice(0, 48)}`;
  botState.bootStartedAt = 0;
  botState.groupCache?.clear?.();
  botState.contactNameCache?.clear?.();
  botState.recentMessageIds?.clear?.();
  clearActiveCommandState(botState);
  botState.activeDownloadJobs?.clear?.();
  resetPairingCache(botState);
  logBotEvent(botState, "warn", `Reciclado automaticamente (${reason})`);
  writePersistedBotRuntimeState(botState);
  return true;
}

function runBotHealthChecks() {
  const now = Date.now();

  for (const botState of botStates.values()) {
    if (!botState?.config?.id) {
      continue;
    }

    if (isReplacementBlocked(botState)) {
      continue;
    }

    const connectionState = String(botState.connectionState || "")
      .trim()
      .toLowerCase();
    const socketReadyState = Number(botState.sock?.ws?.readyState);
    const lastSocketEventAt = Number(
      botState.lastSocketEventAt || botState.bootStartedAt || 0
    );
    const shouldBeRunning = shouldManagedProcessStartBot(botState.config);
    const staleBoot =
      Boolean(botState.sock) &&
      !botState.connectedAt &&
      ["", "booting", "connecting"].includes(connectionState) &&
      lastSocketEventAt > 0 &&
      now - lastSocketEventAt >= BOT_CONNECTING_STALE_MS;

    if (staleBoot) {
      recycleBotInstance(botState, "conexion_atascada");

      if (shouldBeRunning) {
        scheduleReconnect(
          botState,
          getReconnectDelay(botState, false),
          "health:conexion_atascada"
        );
      }
      continue;
    }

    const websocketBroken =
      Boolean(botState.sock) &&
      !botState.reconnectTimer &&
      Number.isFinite(socketReadyState) &&
      socketReadyState >= 2;

    if (websocketBroken) {
      recycleBotInstance(botState, "socket_ws_cerrado");

      if (shouldBeRunning) {
        scheduleReconnect(
          botState,
          getReconnectDelay(botState, false),
          "health:socket_ws_cerrado"
        );
      }
      continue;
    }

    const pairingStuck =
      Boolean(botState.pairingRequested) &&
      !botState.lastPairingCode &&
      Number(botState.lastPairingRequestAt || 0) > 0 &&
      now - Number(botState.lastPairingRequestAt || 0) >= BOT_PAIRING_STALE_MS;

    if (pairingStuck) {
      recycleBotInstance(botState, "pairing_atascado");

      if (shouldBeRunning) {
        scheduleReconnect(botState, 4000, "health:pairing_atascado");
      }
      continue;
    }

    const degradedSocket =
      Boolean(botState.sock) &&
      !botState.connectedAt &&
      !botState.reconnectTimer &&
      !["", "booting", "connecting", "open"].includes(connectionState) &&
      lastSocketEventAt > 0 &&
      now - lastSocketEventAt >= BOT_DEGRADED_SOCKET_STALE_MS;

    if (degradedSocket) {
      recycleBotInstance(botState, "socket_degradado");

      if (shouldBeRunning) {
        scheduleReconnect(
          botState,
          getReconnectDelay(botState, false),
          "health:socket_degradado"
        );
      }
    }

    writePersistedBotRuntimeState(botState);
  }
}

function syncSettingsFromDisk() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return false;
    const raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    replaceObjectContents(settings, parsed);
    refreshBotConfigCache();
    return true;
  } catch (err) {
    console.error("Error recargando settings:", err);
    return false;
  }
}

async function applyHotRuntimeRefresh(reason = "manual") {
  const result = {
    ok: true,
    reason: String(reason || "manual").slice(0, 60),
    settingsReloaded: false,
    commandsReloaded: false,
    processSync: false,
    errors: [],
  };

  try {
    result.settingsReloaded = Boolean(syncSettingsFromDisk());
  } catch (error) {
    result.ok = false;
    result.errors.push(`settings: ${String(error?.message || error)}`);
  }

  try {
    await cargarComandos();
    result.commandsReloaded = true;
  } catch (error) {
    result.ok = false;
    result.errors.push(`commands: ${String(error?.message || error)}`);
  }

  try {
    await syncManagedProcessBots();
    await syncSplitSubbotProcessPool();
    flushManagedBotRuntimeStates();
    result.processSync = true;
  } catch (error) {
    result.ok = false;
    result.errors.push(`process: ${String(error?.message || error)}`);
  }

  return result;
}

async function syncManagedProcessBots() {
  syncSettingsFromDisk();
  runSubbotReservationCleanup();

  for (const config of getManagedProcessBotConfigs()) {
    try {
      const botState = ensureBotState(config);
      botState.config = {
        ...botState.config,
        ...config,
      };

      const startDecision = evaluateManagedProcessStartDecision(config, { botState });
      if (!startDecision.start) {
        const stopReason = config.enabled === false ? "slot_apagado" : "esperando_sesion";
        const hasLiveRuntime = Boolean(botState.sock || botState.connecting || botState.reconnectTimer);

        logManagedStopDecision(botState, config, startDecision);

        if (hasLiveRuntime) {
          if (shouldDeferManagedStop(botState, stopReason)) {
            if (!Number(botState.managedStopDeferredAt || 0)) {
              botState.managedStopDeferredAt = Date.now();
            }
            if (!botState.sock && !botState.connectedAt) {
              botState.connectionState = "waiting_stop_grace";
            }
            writePersistedBotRuntimeState(botState);
          } else {
            botState.managedStopDeferredAt = 0;
            stopLocalManagedBot(botState, stopReason);
          }
        } else {
          botState.managedStopDeferredAt = 0;
          writePersistedBotRuntimeState(botState);
        }
        continue;
      }

      botState.managedStopDeferredAt = 0;
      botState.lastManagedStopDecisionReason = "";
      botState.lastManagedStopDecisionAt = 0;

      if (shouldDelaySecondaryStartup(config, botState)) {
        botState.connectionState = "waiting_main_boot";
        botState.bootStartedAt = 0;
        writePersistedBotRuntimeState(botState);
        continue;
      }

      if (
        !SPLIT_PROCESS_MODE &&
        config.id !== "main" &&
        secondaryBotStartInProgress &&
        !botState.sock &&
        !botState.connecting
      ) {
        botState.connectionState = "waiting_secondary_queue";
        writePersistedBotRuntimeState(botState);
        continue;
      }

      if (!botState.sock && !botState.connecting && !botState.reconnectTimer) {
        await iniciarInstanciaBot(botState.config);
      }

      if (
        botState.sock &&
        !isBotRegistered(botState) &&
        shouldAutoRequestPairingCode(botState) &&
        !botState.pairingRequested
      ) {
        await requestPairingCodeSafe(botState);
      }

      writePersistedBotRuntimeState(botState);
    } catch (error) {
      console.error(
        `[SYNC ${config?.id || "bot"}] Error sincronizando bot:`,
        error?.message || error
      );
    }
  }
}

async function syncSplitSubbotProcessPool() {
  if (!SPLIT_PROCESS_MODE || PROCESS_BOT_ID !== "main" || !isPm2Environment(process.env)) {
    return;
  }

  for (const config of SUBBOT_SLOT_CONFIGS) {
    if (shouldKeepSplitSubbotProcess(config)) {
      await ensureSplitBotProcess(config);
      continue;
    }

    await deleteSplitBotProcess(config.id);
  }
}

async function ensureBotSocket(botState) {
  if (botState?.sock) return botState.sock;

  if (!botState.connecting) {
    await iniciarInstanciaBot(botState.config);
  }

  const timeoutAt = Date.now() + 8000;

  while (!botState.sock && botState.connecting && Date.now() < timeoutAt) {
    await delay(250);
  }

  return botState.sock;
}

async function requestPairingCode(botState, options = {}) {
  const { number, allowPrompt = false, useCache = true } = options;

  if (!botState) {
    return {
      ok: false,
      status: "missing_bot",
      message: "No encontre la instancia del bot solicitado.",
    };
  }

  if (botState.config?.id !== "main" && !isMainBotReady()) {
    return {
      ok: false,
      status: "main_not_ready",
      message: "Primero vincula y conecta el bot principal desde la consola.",
    };
  }

  if (isBotRegistered(botState)) {
    return {
      ok: false,
      status: "already_linked",
      message: `${botState.config.displayName} ya esta vinculado.`,
    };
  }

  const explicitNumber = normalizePairingPhoneNumber(number);
  const cached = getCachedPairingCode(botState);
  const shouldForceRefresh =
    useCache === false ||
    (explicitNumber &&
      explicitNumber !== normalizePairingPhoneNumber(cached?.number || ""));

  if (cached && !shouldForceRefresh) {
    return {
      ok: true,
      status: "cached",
      cached: true,
      label: botState.config.label,
      displayName: botState.config.displayName,
      slot: Number(botState.config.slot || 0),
      code: cached.code,
      number: cached.number,
      expiresInMs: cached.expiresInMs,
    };
  }

  if (cached && shouldForceRefresh) {
    resetPairingCache(botState);
  }

  let resolvedNumber =
    explicitNumber || normalizePairingPhoneNumber(botState.config?.pairingNumber);

  if (!resolvedNumber && allowPrompt) {
    console.log(`${getBotTag(botState)} Bot no vinculado`);
    resolvedNumber = normalizePairingPhoneNumber(
      await preguntarSeguro(
        `Numero del ${botState.config.label} con codigo de pais, sin + ni espacios: `
      )
    );
  }

  if (!resolvedNumber) {
    const prefix =
      (Array.isArray(settings.prefix) ? settings.prefix[0] : settings.prefix) || ".";
    const slotHint =
      botState?.config?.id === "main"
        ? ""
        : ` ${Number(botState?.config?.slot || 1)}`;

    return {
      ok: false,
      status: "missing_number",
      message:
        `Debes enviar un numero valido con codigo de pais (10 a 15 digitos). ` +
        `Ejemplo: ${prefix}subbot${slotHint} 51912345678`,
    };
  }

  if (botState.pairingRequested && !botState.lastPairingCode) {
    return {
      ok: false,
      status: "pending",
      message: `Ya hay una solicitud de codigo en proceso para ${botState.config.displayName}.`,
    };
  }

  clearReplacementBlock(botState);

  const sock = await ensureBotSocket(botState);
  if (!sock) {
    return {
      ok: false,
      status: "unavailable",
      message: `${botState.config.displayName} aun se esta iniciando. Intenta de nuevo en unos segundos.`,
    };
  }

  botState.config.pairingNumber = resolvedNumber;
  botState.pairingRequested = true;
  botState.pairingCommandHintShown = false;
  botState.lastPairingRequestAt = Date.now();
  botState.lastPairingRequestNumber = resolvedNumber;
  botState.lastPairingErrorAt = 0;
  botState.lastPairingError = "";

  try {
    const socketReady = await waitForPairingSocketProgress(botState, sock);
    if (!socketReady) {
      console.warn(
        `${getBotTag(botState)} El socket no avanzo a tiempo para pairing. Intentare igual.`
      );
      await delay(1500);
    } else {
      await delay(1200);
    }

    const code = await runTaskWithTimeout(
      `${getBotTag(botState)} pairing code`,
      PAIRING_REQUEST_TIMEOUT_MS,
      () => sock.requestPairingCode(resolvedNumber)
    );
    cachePairingCode(botState, code, resolvedNumber);

    return {
      ok: true,
      status: "created",
      cached: false,
      label: botState.config.label,
      displayName: botState.config.displayName,
      slot: Number(botState.config.slot || 0),
      code,
      number: resolvedNumber,
      expiresInMs: PAIRING_CODE_CACHE_MS,
    };
  } catch (err) {
    botState.lastPairingErrorAt = Date.now();
    botState.lastPairingError = String(
      err?.message || err || "No pude obtener el codigo de vinculacion."
    ).slice(0, 220);
    resetPairingCache(botState);
    return {
      ok: false,
      status: "error",
      message: err?.message || "No pude obtener el codigo de vinculacion.",
      error: err,
    };
  }
}

async function startSecondaryBots() {
  if (SPLIT_PROCESS_MODE) {
    return;
  }

  if (secondaryBotStartInProgress || !isMainBotLiveReady()) {
    return;
  }

  secondaryBotStartInProgress = true;

  try {
    let startedCount = 0;

    for (const config of BOT_CONFIGS) {
      if (config.id === "main") continue;
      if (!shouldStartSecondaryBot(config)) continue;

      const botState = ensureBotState(config);
      if (botState.sock || botState.connecting || botState.reconnectTimer) {
        continue;
      }

      if (startedCount > 0) {
        await delay(SECONDARY_BOT_START_DELAY_MS);
      }

      try {
        await iniciarInstanciaBot(config);
        startedCount += 1;
      } catch (error) {
        console.error(
          `[SECONDARY ${config?.id || "bot"}] Error iniciando subbot:`,
          error?.message || error
        );
      }
    }
  } finally {
    secondaryBotStartInProgress = false;
  }
}

async function waitForRemoteBotPairing(targetConfig, timeoutMs = REMOTE_PAIRING_WAIT_MS) {
  const timeoutAt = Date.now() + Math.max(3000, Number(timeoutMs || REMOTE_PAIRING_WAIT_MS));

  while (Date.now() < timeoutAt) {
    syncSettingsFromDisk();
    const currentConfig = getBotConfigById(targetConfig?.id || "");
    const summary = currentConfig ? summarizeBotConfig(currentConfig) : null;

    if (summary?.cachedPairingCode) {
      return {
        ok: true,
        status: "created",
        cached: false,
        label: summary.label,
        displayName: summary.displayName,
        slot: Number(summary.slot || 0),
        code: summary.cachedPairingCode,
        number: summary.cachedPairingNumber || summary.configuredNumber || "",
        expiresInMs: Number(summary.cachedPairingExpiresInMs || PAIRING_CODE_CACHE_MS),
      };
    }

    if (summary?.registered || summary?.connected) {
      return {
        ok: false,
        status: "already_linked",
        message: `${summary.displayName || targetConfig?.displayName || "Ese bot"} ya esta vinculado.`,
      };
    }

    await delay(500);
  }

  return {
    ok: false,
    status: "pending_remote",
    message:
      `${targetConfig?.displayName || "El subbot"} se esta iniciando en otro proceso PM2. ` +
      `Intenta otra vez en unos segundos.`,
  };
}

async function requestPairingCodeSafe(botState) {
  const result = await requestPairingCode(botState, {
    allowPrompt: shouldPromptInConsole(botState),
  });

  if (result.ok) {
    console.log(`\nCODIGO DE VINCULACION ${result.label}:\n`);
    console.log(chalk.greenBright(result.code));
    console.log(chalk.cyan(`Numero objetivo: +${result.number || "sin_numero"}`));
    console.log(
      chalk.yellow(
        "WhatsApp > Dispositivos vinculados > Vincular con numero de telefono"
      )
    );
    console.log(
      chalk.gray(
        "Si WhatsApp lo marca invalido, espera 30-40 minutos y vuelve a intentar solo una vez."
      )
    );
    return;
  }

  if (result.status === "missing_number") {
    if (!botState.pairingCommandHintShown) {
      botState.pairingCommandHintShown = true;
      console.log(`${getBotTag(botState)} ${result.message}`);
    }
    return;
  }

  if (result.status === "pending" || result.status === "already_linked") {
    return;
  }

  console.error(
    `${getBotTag(botState)} Error solicitando pairing code:`,
    result.error || result.message
  );
}

function buildSubbotRequestState() {
  const summaries = SUBBOT_SLOT_CONFIGS.map((config) => summarizeBotConfig(config));

  return {
    publicRequests: settings?.subbot?.publicRequests !== false,
    maxSlots: Number(settings?.subbot?.maxSlots || getConfiguredSubbotSlotsCount(settings)),
    enabledSlots: SUBBOT_SLOT_CONFIGS.filter((config) => config.enabled).length,
    availableSlots: summaries.filter(
      (bot) =>
        !bot.connected &&
        !bot.registered &&
        !bot.pairingPending &&
        !getSubbotAssignedNumber(bot)
    ).length,
    activeSlots: summaries.filter((bot) => bot.connected).length,
  };
}

function normalizeInviteCode(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/chat\.whatsapp\.com\/([0-9A-Za-z]{20,})/i);
  if (match?.[1]) return match[1];
  const normalized = text.replace(/[^0-9A-Za-z]/g, "");
  return normalized.length >= 20 ? normalized : "";
}

function getBotAutoJoinInviteCode(botState) {
  if (settings?.system?.autoJoinGroups?.enabled === false) {
    return "";
  }

  const botId = String(botState?.config?.id || "main")
    .trim()
    .toLowerCase();

  return botId === "main"
    ? normalizeInviteCode(settings?.system?.autoJoinGroups?.mainInvite || "")
    : normalizeInviteCode(settings?.system?.autoJoinGroups?.subbotInvite || "");
}

function buildManagedGroupJoinNotice(botState, isAdmin = false) {
  const botName = resolveBotDisplayName(botState?.config?.id || "main") ||
    String(botState?.config?.displayName || settings?.botName || "Fsociety bot");
  const prefix = getPrimaryPrefix(settings);

  if (isAdmin) {
    return (
      `✅ *${botName}* ya esta activo en este grupo.\n\n` +
      `Tengo administrador aqui, asi que respondere mensajes normalmente.\n` +
      `Si quieres silenciarme en este grupo usa *${prefix}botgrupo off*.`
    );
  }

  return (
    `🤖 *${botName}* ya entro a este grupo.\n\n` +
    `En este grupo no voy a responder mensajes porque no tengo administrador.\n` +
    `Estado actual: *BOT OFF*.\n` +
    `Pide al owner que me de admin para activarme automaticamente.`
  );
}

async function isBotAdminInGroup(sock, groupId) {
  if (!sock || !groupId || !groupId.endsWith("@g.us")) return false;

  try {
    const metadata = await sock.groupMetadata(groupId);
    const selfUser = normalizeJidUser(sock?.user?.id);
    if (!selfUser) return false;

    const participants = Array.isArray(metadata?.participants) ? metadata.participants : [];
    const selfParticipant = participants.find(
      (participant) => normalizeJidUser(participant?.id) === selfUser
    );

    return Boolean(
      selfParticipant?.admin === "admin" || selfParticipant?.admin === "superadmin"
    );
  } catch {
    return false;
  }
}

async function applyManagedGroupPolicy(botState, sock, groupId, options = {}) {
  if (!sock || !groupId || !groupId.endsWith("@g.us")) return false;

  if (!(botState?.autoJoinManagedGroups instanceof Set)) {
    botState.autoJoinManagedGroups = new Set();
  }
  if (!(botState?.managedGroupNoticeCache instanceof Map)) {
    botState.managedGroupNoticeCache = new Map();
  }

  botState.autoJoinManagedGroups.add(groupId);

  const isAdmin = await isBotAdminInGroup(sock, groupId);
  setGroupBotDisabled(groupId, !isAdmin);

  const noticeMode = isAdmin ? "on" : "off";
  const now = Date.now();
  const cacheKey = `${groupId}:${noticeMode}`;
  const lastNoticeAt = Number(botState.managedGroupNoticeCache.get(cacheKey) || 0);
  const forceNotice = options?.forceNotice === true;
  const noticeCooldownMs = Math.max(
    60_000,
    Number(options?.noticeCooldownMs || 10 * 60 * 1000)
  );

  if (!forceNotice && lastNoticeAt && now - lastNoticeAt < noticeCooldownMs) {
    return isAdmin;
  }

  const sent = await sendGroupResponderNotice(
    sock,
    groupId,
    buildManagedGroupJoinNotice(botState, isAdmin)
  );

  if (sent) {
    botState.managedGroupNoticeCache.set(cacheKey, now);
  }

  return isAdmin;
}

async function ensureBotAutoJoinGroup(botState) {
  const sock = botState?.sock || null;
  const inviteCode = getBotAutoJoinInviteCode(botState);
  if (!sock || !inviteCode) return null;

  if (botState.autoJoinInFlight) {
    return botState.autoJoinInFlight;
  }

  botState.autoJoinInFlight = (async () => {
    let targetGroupId = "";
    let joinedNow = false;

    try {
      if (typeof sock.groupGetInviteInfo === "function") {
        const info = await sock.groupGetInviteInfo(inviteCode);
        targetGroupId = String(info?.id || info?.jid || "").trim();
      }
    } catch {}

    try {
      const joinedGroupId = await sock.groupAcceptInvite(inviteCode);
      if (joinedGroupId) {
        targetGroupId = String(joinedGroupId || "").trim();
        joinedNow = true;
      }
    } catch (error) {
      const message = String(error?.message || error || "").toLowerCase();
      const alreadyJoined =
        message.includes("already") ||
        message.includes("is already") ||
        message.includes("already a participant");

      if (!alreadyJoined) {
        logBotEvent(
          botState,
          "warn",
          `Autojoin de grupo no completado: ${String(error?.message || error).slice(0, 180)}`
        );
        return null;
      }
    }

    if (!targetGroupId || !targetGroupId.endsWith("@g.us")) {
      return null;
    }

    await applyManagedGroupPolicy(botState, sock, targetGroupId, {
      forceNotice: joinedNow,
    });

    return {
      groupId: targetGroupId,
      joinedNow,
    };
  })();

  try {
    return await botState.autoJoinInFlight;
  } finally {
    botState.autoJoinInFlight = null;
  }
}

async function joinGroupInviteAllSubbots(inviteCode, options = {}) {
  const code = normalizeInviteCode(inviteCode);
  if (!code) {
    return {
      ok: false,
      status: "missing_invite",
      message: "Falta el enlace/codigo de invitacion.",
      results: [],
    };
  }

  const includeMain = options?.includeMain === true;
  const delayMs = Math.max(150, Number(options?.delayMs || 750));
  const results = [];

  const targetConfigs = includeMain
    ? [buildMainBotConfig(settings), ...SUBBOT_SLOT_CONFIGS.slice()]
    : SUBBOT_SLOT_CONFIGS.slice();

  for (const config of targetConfigs) {
    const botId = String(config?.id || "").trim().toLowerCase();
    if (!botId) continue;

    if (SPLIT_PROCESS_MODE && !ownsBotInThisProcess(botId)) {
      results.push({
        botId,
        slot: Number(config?.slot || 0) || 0,
        label: String(config?.label || botId).toUpperCase(),
        displayName: String(config?.displayName || botId),
        status: "different_process",
        message: "Este bot corre en otro proceso (modo separado).",
        groupJid: "",
      });
      continue;
    }

    const botState = botStates.get(botId) || null;
    const sock = botState?.sock || null;

    if (!sock) {
      results.push({
        botId,
        slot: Number(config?.slot || 0) || 0,
        label: String(config?.label || botId).toUpperCase(),
        displayName: String(config?.displayName || botId),
        status: "no_socket",
        message: "No hay socket activo (no conectado).",
        groupJid: "",
      });
      continue;
    }

    try {
      const groupJid = await sock.groupAcceptInvite(code);
      results.push({
        botId,
        slot: Number(config?.slot || 0) || 0,
        label: String(config?.label || botId).toUpperCase(),
        displayName: String(config?.displayName || botId),
        status: "joined",
        message: "Unido correctamente.",
        groupJid: String(groupJid || ""),
      });
    } catch (error) {
      const msg = String(error?.message || error || "");
      const already =
        msg.toLowerCase().includes("already") ||
        msg.toLowerCase().includes("ya eres") ||
        msg.toLowerCase().includes("ya está") ||
        msg.toLowerCase().includes("ya esta") ||
        msg.toLowerCase().includes("participante");

      results.push({
        botId,
        slot: Number(config?.slot || 0) || 0,
        label: String(config?.label || botId).toUpperCase(),
        displayName: String(config?.displayName || botId),
        status: already ? "already" : "error",
        message: msg || "No pude unir este bot al grupo.",
        groupJid: "",
      });
    }

    if (delayMs) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  const joined = results.filter((r) => r.status === "joined").length;
  const already = results.filter((r) => r.status === "already").length;
  const skipped = results.filter((r) => r.status === "different_process" || r.status === "no_socket").length;
  const failed = results.filter((r) => r.status === "error").length;

  return {
    ok: true,
    status: "ok",
    joined,
    already,
    skipped,
    failed,
    results,
  };
}

function setSubbotMaxSlots(nextValue) {
  const nextSlots = clampSubbotSlots(nextValue);
  const currentSlots = getConfiguredSubbotSlotsCount(settings);

  if (nextSlots === currentSlots) {
    return {
      ok: true,
      changed: false,
      state: buildSubbotRequestState(),
    };
  }

  if (nextSlots < currentSlots) {
    const blockedSlots = SUBBOT_SLOT_CONFIGS
      .map((config) => summarizeBotConfig(config))
      .filter(
        (bot) =>
          bot.slot > nextSlots &&
          (bot.connected ||
            bot.registered ||
            bot.pairingPending ||
            bot.enabled ||
            getSubbotAssignedNumber(bot))
      )
      .map((bot) => bot.slot);

    if (blockedSlots.length) {
      return {
        ok: false,
        status: "slots_busy",
        message: `No puedo reducir slots porque siguen ocupados: ${blockedSlots.join(", ")}.`,
      };
    }
  }

  ensureSubbotSettings(settings);
  settings.subbot.maxSlots = nextSlots;
  ensureSubbotSettings(settings);
  saveSettingsFile();
  refreshBotConfigCache();

  return {
    ok: true,
    changed: true,
    state: buildSubbotRequestState(),
  };
}

global.botRuntime = {
  requestBotPairingCode: async (botId, options = {}) => {
    const requestedBotId = String(botId || "").trim().toLowerCase();
    const bypassPublicRequests = options?.bypassPublicRequests === true;
    const isSubbotRequest = requestedBotId !== "main";

    if (
      isSubbotRequest &&
      settings?.subbot?.publicRequests === false &&
      !bypassPublicRequests
    ) {
      return {
        ok: false,
        status: "public_requests_disabled",
        message: "Las solicitudes publicas de subbots estan apagadas por el owner.",
      };
    }

    let targetConfig =
      requestedBotId === "main"
        ? getBotConfigById("main")
        : resolveSubbotTargetConfig(requestedBotId || "subbot", options);

    if (!targetConfig) {
      return {
        ok: false,
        status: requestedBotId === "subbot" ? "no_capacity" : "missing_bot",
        message:
          requestedBotId === "subbot"
            ? "No hay slots libres para crear otro subbot ahora mismo."
            : "No encontre ese bot para vincular.",
      };
    }

    if (targetConfig.id !== "main") {
      const explicitNumber = sanitizePhoneNumber(options?.number);
      const requesterNumber =
        sanitizePhoneNumber(options?.requesterNumber) || explicitNumber;
      const requesterJid = String(options?.requesterJid || "").trim();
      const persistedConfig = getSubbotConfigBySlot(targetConfig.slot) || targetConfig;
      const persistedSummary = summarizeBotConfig(persistedConfig);
      const assignedNumber = getSubbotAssignedNumber(persistedSummary);
      const nextPairingNumber =
        explicitNumber || requesterNumber || sanitizePhoneNumber(persistedConfig.pairingNumber);
      const nextRequesterNumber = requesterNumber || nextPairingNumber;
      const duplicatedAssignment = nextRequesterNumber
        ? findSubbotByAssignedNumber(nextRequesterNumber, {
            excludeSlot: Number(targetConfig?.slot || persistedConfig?.slot || 0),
          })
        : null;
      const isRequestedSlot = requestedBotId !== "subbot";
      const slotBusy =
        persistedSummary.connected ||
        persistedSummary.registered ||
        persistedSummary.pairingPending;

      if (duplicatedAssignment) {
        return {
          ok: false,
          status: "number_already_linked",
          message:
            `El numero ${nextRequesterNumber} ya esta vinculado ` +
            `en el slot ${duplicatedAssignment.slot}. Libera ese slot antes de usarlo otra vez.`,
        };
      }

      if (
        isRequestedSlot &&
        slotBusy &&
        assignedNumber &&
        nextRequesterNumber &&
        assignedNumber !== nextRequesterNumber
      ) {
        return {
          ok: false,
          status: "slot_busy",
          message: `El slot ${persistedConfig.slot} ya esta ocupado por otro subbot.`,
        };
      }

      if (!nextPairingNumber && slotBusy) {
        return {
          ok: false,
          status: "slot_busy",
          message: `El slot ${persistedConfig.slot} ya esta ocupado por otro subbot.`,
        };
      }

      if (!nextPairingNumber && !assignedNumber && !slotBusy) {
        return {
          ok: false,
          status: "missing_number",
          message: "No pude detectar el numero para este subbot.",
        };
      }

      const nextRequestedAt =
        nextRequesterNumber &&
        (nextRequesterNumber !== sanitizePhoneNumber(persistedConfig.requesterNumber) ||
          requesterJid !== String(persistedConfig.requesterJid || "").trim() ||
          persistedConfig.enabled !== true)
          ? Date.now()
          : normalizeTimestamp(persistedConfig.requestedAt);

      if (
        persistedConfig.enabled !== true ||
        nextPairingNumber !== sanitizePhoneNumber(persistedConfig.pairingNumber) ||
        nextRequesterNumber !== sanitizePhoneNumber(persistedConfig.requesterNumber) ||
        requesterJid !== String(persistedConfig.requesterJid || "").trim() ||
        nextRequestedAt !== normalizeTimestamp(persistedConfig.requestedAt) ||
        normalizeTimestamp(persistedConfig.releasedAt) !== 0
      ) {
        targetConfig =
          saveSubbotSlotConfig(targetConfig.slot, {
            enabled: true,
            pairingNumber: nextPairingNumber,
            requesterNumber: nextRequesterNumber,
            requesterJid,
            requestedAt: nextRequestedAt,
            releasedAt: 0,
          }) || targetConfig;
      }
    }

    const targetState = ensureBotState(targetConfig);

    if (!ownsBotInThisProcess(targetConfig.id) && SPLIT_PROCESS_MODE) {
      await ensureSplitBotProcess(targetConfig);
      return waitForRemoteBotPairing(targetConfig);
    }

    return requestPairingCode(targetState, {
      number: options?.number,
      allowPrompt: false,
      useCache: options?.useCache !== false,
    });
  },
  isMainReady: () => isMainBotReady(),
  restartProcess: (delayMs = PROCESS_RESTART_DELAY_MS) =>
    scheduleProcessRestart(delayMs),
  getRestartMode: () => getRestartMode(),
  applyHotRuntimeRefresh: async (reason = "manual") =>
    applyHotRuntimeRefresh(reason),
  getConsoleLines: (limit = 25) =>
    global.consoleBuffer.slice(-Math.max(1, Math.min(80, Number(limit || 25)))),
  getUsageStats: (limit = 5) =>
    getUsageStatsSnapshot(Math.max(1, Math.min(15, Number(limit || 5)))),
  getWeeklyStats: (limit = 5) =>
    getWeeklySnapshot(Math.max(1, Math.min(15, Number(limit || 5)))),
  getMaintenanceState: () => getMaintenanceState(),
  setMaintenanceState: (mode, message = "") => setMaintenanceState(mode, message),
  getErrorVisibilityState: () => getErrorVisibilityState(),
  setErrorVisibilityMode: (mode = "off") => setErrorVisibilityMode(mode),
  getResilienceState: () => getResilienceSnapshot(),
  setResilienceConfig: (patch = {}) => setResilienceConfig(patch),
  clearResilienceCommand: (commandName) => clearResilienceCommand(commandName),
  getAutoCleanState: () => getAutoCleanState(),
  setAutoCleanConfig: (patch = {}) => setAutoCleanConfig(patch),
  runAutoClean: () => runAutoClean(),
  getDashboardSnapshot: (options = {}) => getDashboardSnapshot(options),
  setDashboardConfig: (patch = {}) => setDashboardConfig(patch),
  listBots: (options = {}) => {
    const includeMain = options?.includeMain === true;
    const onlyConnected = options?.onlyConnected === true;
    const subbots = SUBBOT_SLOT_CONFIGS
      .map((config) => summarizeBotConfig(config))
      .filter((bot) => !onlyConnected || bot.connected);

    if (!includeMain) {
      return subbots;
    }

    const mainBot = summarizeBotConfig(buildMainBotConfig(settings));
    return [mainBot, ...subbots].filter((bot) => !onlyConnected || bot.connected);
  },
  getBotSummary: (botId) => {
    const targetConfig = getBotConfigById(botId);
    return targetConfig ? summarizeBotConfig(targetConfig) : null;
  },
  releaseSubbot: (botId, options = {}) => {
    const targetConfig = getSubbotConfigById(botId);
    if (!targetConfig) {
      return {
        ok: false,
        status: "missing_bot",
        message: "No encontre ese subbot.",
      };
    }

    const targetState = ensureBotState(targetConfig);
    const released = releaseSubbotSlot(targetState, {
      reason: options?.reason || "manual",
      closeSocket: options?.closeSocket !== false,
      resetAuthFolder: options?.resetAuthFolder !== false,
    });

    return released
      ? {
          ok: true,
          status: "released",
          bot: summarizeBotConfig(getSubbotConfigBySlot(targetConfig.slot) || targetConfig),
        }
      : {
          ok: false,
          status: "release_failed",
          message: "No pude liberar el slot solicitado.",
        };
  },
  resetSubbot: (botId) => {
    return global.botRuntime.releaseSubbot(botId, {
      reason: "reset_manual",
      closeSocket: true,
      resetAuthFolder: true,
    });
  },
  reconnectSubbot: async (botId, options = {}) => {
    return reconnectManagedSubbot(botId, options);
  },
  setSubbotMaxSlots: (count) => setSubbotMaxSlots(count),
  getSubbotRequestState: () => buildSubbotRequestState(),
  joinGroupInviteAllSubbots: async (inviteCode, options = {}) =>
    joinGroupInviteAllSubbots(inviteCode, options),
  setSubbotPublicRequests: (enabled) => {
    ensureSubbotSettings(settings);
    settings.subbot.publicRequests = Boolean(enabled);
    saveSettingsFile();
    refreshBotConfigCache();

    return buildSubbotRequestState();
  },
};

// ================= MENSAJES =================

async function handleIncomingMessages(botState, sock, messages) {
  for (const raw of messages || []) {
    let failedCommandName = "";
    let activeCommandContext = null;
    let activeRequestId = "";
    let commandStartedAt = 0;
    let commandMetricsOpened = false;

    try {
      if (!raw?.message) continue;
      if (markAndCheckRecentMessage(botState, raw)) continue;

      const from = raw?.key?.remoteJid || "";
      if (shouldIgnoreJid(from)) continue;

      const m = serializeMessage(raw);
      const executionInfo = await getMessageExecutionInfo(botState, sock, m);
      const baseContext = createBaseContext(botState, sock, m, executionInfo);

      const blockedByHook = await runMessageHooks(botState, baseContext);
      if (blockedByHook) continue;

      const texto = String(m?.text || "").trim();
      if (!texto) continue;
      const commandData = extractCommandData(texto, settings);
      const isFromMe = Boolean(raw?.key?.fromMe);

      // Allow testing commands sent from the bot's own account while
      // ignoring its normal replies to avoid self-triggered loops.
      if (isFromMe && !commandData) continue;

      totalMensajes++;
      trackMessageUsage(botState, m);
      botState.lastIncomingMessageAt = Date.now();
      markBotSocketActivity(botState, "incoming_message");

      const tipo = tipoChat(from);
      mensajesPorTipo[tipo] = (mensajesPorTipo[tipo] || 0) + 1;

      if (!commandData) continue;
      const cmd = comandos.get(commandData.commandName);
      if (!cmd) continue;
      const linkedIdentityDecision = shouldCurrentBotHandleLinkedIdentity(botState);
      if (!linkedIdentityDecision.allowed) {
        const now = Date.now();
        if (
          now - Number(botState?.linkedIdentityLeaderLogAt || 0) >=
          LINKED_IDENTITY_LOG_THROTTLE_MS
        ) {
          botState.linkedIdentityLeaderLogAt = now;
          logBotEvent(
            botState,
            "warn",
            `Ignorado comando duplicado por identidad vinculada. Lider: ${
              linkedIdentityDecision.leaderBotId || "desconocido"
            }`
          );
        }
        continue;
      }
      const leaderDecision = shouldCurrentBotHandleGroupCommand(
        botState,
        executionInfo?.groupMetadata || null
      );
      if (!leaderDecision.allowed) {
        continue;
      }
      if (shouldSkipCommandReplay(botState, raw, commandData)) {
        continue;
      }

      const groupReservation = await reserveGroupCommandExecution(
        botState,
        raw,
        commandData
      );
      await maybeAnnounceResponderTransition(botState, sock, raw, groupReservation);
      if (!groupReservation.allowed) {
        continue;
      }

      const contactName =
        m.pushName ||
        getStoreContactName(
          botState,
          m.sender,
          m.senderPhone,
          raw?.key?.participant,
          raw?.key?.participantPn
        );
      touchEconomyProfile(m.sender, settings, {
        jid: m.senderPhone || m.sender,
        phone: m.senderPhone,
        senderPhone: m.senderPhone,
        senderPn: raw?.key?.senderPn,
        participantPn: raw?.key?.participantPn,
        lid: m.senderLid,
        senderLid: raw?.key?.senderLid,
        participantLid: raw?.key?.participantLid,
        name: contactName,
        pushName: m.pushName,
        chatId: from,
        commandName: commandData.commandName,
        botId: botState.config.id,
      });
      failedCommandName = commandData.commandName;

      const commandContext = {
        ...baseContext,
        args: commandData.args,
        body: commandData.body,
        usedPrefix: commandData.prefix,
        commandName: commandData.commandName,
      };
      activeCommandContext = commandContext;

      const allowed = await canRunCommand(cmd, commandContext);
      if (!allowed) continue;
      const blockedByMaintenance = await isBlockedByMaintenance(cmd, commandContext);
      if (blockedByMaintenance) continue;
      if (isDownloadCommand(cmd)) {
        assertSubbotCommandAllowed(commandContext, commandData.commandName);
      }

      activeRequestId = nextRuntimeRequestId("cmd");
      commandData.requestId = activeRequestId;
      commandContext.requestId = activeRequestId;

      if (LOG_COMMAND_EXECUTIONS) {
        logBotEvent(
          botState,
          "info",
          formatCommandConsoleLog(commandData, m, from),
          {
            requestId: activeRequestId,
            command: commandData.commandName,
            chatId: from,
            sender: m.senderPhone || m.sender || "",
          }
        );
      }

      commandStartedAt = Date.now();
      commandMetricsOpened = true;
      recordCommandMetricStart(commandData.commandName);
      totalComandos++;
      trackCommandUsage(botState, m, commandData.commandName);

      if (isDownloadCommand(cmd)) {
        startCommandTracking(botState, commandData.commandName, resolveCommandTimeout(cmd));
        const runningJob = enqueueDownloadCommand(botState, cmd, commandContext);
        runningJob.promise.then(() => {
          finishCommandTracking(botState, commandData.commandName, "ok");
          if (commandMetricsOpened) {
            recordCommandMetricFinish(
              commandData.commandName,
              "success",
              Math.max(0, Date.now() - commandStartedAt)
            );
            commandMetricsOpened = false;
          }
          recordCommandSuccess(commandData.commandName);
        });
        runningJob.promise.catch(async (err) => {
          const status = isTaskTimeoutError(err) ? "timeout" : "error";
          finishCommandTracking(botState, commandData.commandName, status);
          if (commandMetricsOpened) {
            recordCommandMetricFinish(
              commandData.commandName,
              status === "timeout" ? "timeout" : "error",
              Math.max(0, Date.now() - commandStartedAt)
            );
            commandMetricsOpened = false;
          }
          recordCommandFailure(commandData.commandName, err);
          if (isTaskTimeoutError(err)) {
            await sendCommandTimeoutNotice(commandContext, err);
          }
          await sendVisibleCommandErrorNotice(botState, commandContext, err);
          console.error(`${getBotTag(botState)} Error comando concurrente [${activeRequestId || "n/a"}]:`, err);
        });
        continue;
      }

      const timeoutMs = resolveCommandTimeout(cmd);
      const abortController = createTaskAbortController();
      commandContext.abortSignal = abortController?.signal || null;
      setActiveCommandAbortController(botState, abortController);
      startCommandTracking(botState, commandData.commandName, timeoutMs);
      await runTaskWithTimeout(
        `${getBotTag(botState)} comando ${commandData.commandName}`,
        timeoutMs,
        () => cmd.run(commandContext),
        { abortController }
      );
      finishCommandTracking(botState, commandData.commandName, "ok");
      if (commandMetricsOpened) {
        recordCommandMetricFinish(
          commandData.commandName,
          "success",
          Math.max(0, Date.now() - commandStartedAt)
        );
        commandMetricsOpened = false;
      }
      recordCommandSuccess(commandData.commandName);
    } catch (err) {
      if (failedCommandName) {
        const status = isTaskTimeoutError(err) ? "timeout" : "error";
        finishCommandTracking(
          botState,
          failedCommandName,
          status
        );
        if (commandMetricsOpened) {
          recordCommandMetricFinish(
            failedCommandName,
            status === "timeout" ? "timeout" : "error",
            Math.max(0, Date.now() - commandStartedAt)
          );
          commandMetricsOpened = false;
        }
        recordCommandFailure(failedCommandName, err);
      }
      if (activeCommandContext && isTaskTimeoutError(err)) {
        await sendCommandTimeoutNotice(activeCommandContext, err);
      }
      if (activeCommandContext) {
        await sendVisibleCommandErrorNotice(botState, activeCommandContext, err);
      }
      console.error(`${getBotTag(botState)} Error comando [${activeRequestId || "n/a"}]:`, err);
    }
  }
}

// ================= BOT =================

async function iniciarInstanciaBot(config) {
  const botState = ensureBotState(config);
  if (botState.connecting) return;
  botState.connecting = true;
  botState.bootStartedAt = Date.now();
  botState.connectionState = "booting";
  markBotSocketActivity(botState, "booting");

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(
      config.authFolder
    );
    const version = await getVersionSafe();

    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      browser: FIXED_BROWSER,
      defaultQueryTimeoutMs: undefined,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, logger),
      },
      getMessage: async (key) => {
        try {
          if (!botState.store?.loadMessage) return undefined;
          const msg = await botState.store.loadMessage(key.remoteJid, key.id);
          return msg?.message || undefined;
        } catch {
          return undefined;
        }
      },
      cachedGroupMetadata: async (jid) => cachedGroupMetadata(botState, jid),
    });

    botState.sock = wrapSocketSendMessage(botState, sock);
    botState.authState = authState;
    markBotSocketActivity(botState, "socket_created");
    attachSocketLifecycleWatchers(botState, botState.sock);

    if (botState.store?.bind) {
      botState.store.bind(botState.sock.ev);
    }

    botState.sock.ev.on("creds.update", (...args) => {
      markBotSocketActivity(botState, "creds.update");
      return saveCreds(...args);
    });

    const syncEconomyContact = (entry = {}) => {
      if (!entry?.id) return;
      touchEconomyProfile(entry.id, settings, {
        jid: entry.id,
        name: entry?.notify || entry?.name || entry?.verifiedName || entry?.verifiedBizName,
        verifiedName: entry?.verifiedName || entry?.verifiedBizName || "",
      });
    };

    botState.sock.ev.on("contacts.update", (updates = []) => {
      markBotSocketActivity(botState, "contacts.update");
      for (const update of updates || []) {
        try {
          syncEconomyContact(update);
        } catch {}
      }
    });

    botState.sock.ev.on("contacts.upsert", (updates = []) => {
      markBotSocketActivity(botState, "contacts.upsert");
      for (const update of updates || []) {
        try {
          syncEconomyContact(update);
        } catch {}
      }
    });

    botState.sock.ev.on("chats.phoneNumberShare", (payload = {}) => {
      markBotSocketActivity(botState, "chats.phoneNumberShare");
      try {
        if (!payload?.lid || !payload?.jid) return;
        touchEconomyProfile(payload.lid, settings, {
          jid: payload.jid,
          phone: payload.jid,
          lid: payload.lid,
        });
      } catch {}
    });

    botState.sock.ev.on("groups.update", async (updates) => {
      markBotSocketActivity(botState, "groups.update");
      for (const update of updates || []) {
        try {
          if (!update?.id) continue;
          const meta = await botState.sock.groupMetadata(update.id);
          cacheGroupMetadata(botState, update.id, meta);
        } catch {}
      }
    });

    botState.sock.ev.on("group-participants.update", async (update) => {
      markBotSocketActivity(botState, "group-participants.update");
      const reservation = await reserveGroupUpdateProcessing(botState, update);
      if (!reservation.allowed) {
        return;
      }

      if (update?.id) {
        try {
          const meta = await botState.sock.groupMetadata(update.id);
          cacheGroupMetadata(botState, update.id, meta);
        } catch {}
      }

      const action = String(update?.action || "").trim().toLowerCase();
      const selfJoined =
        doesGroupUpdateIncludeSelf(botState.sock, update) &&
        ["add", "invite", "join", "linked_group_join"].includes(action);
      if (selfJoined && update?.id) {
        const managedGroupUpdate =
          botState?.autoJoinManagedGroups instanceof Set &&
          botState.autoJoinManagedGroups.has(update.id);
        if (managedGroupUpdate) {
          await applyManagedGroupPolicy(botState, botState.sock, update.id, {
            forceNotice: false,
          });
        }
        await maybeAnnounceGroupEntry(botState, botState.sock, update.id, action);
      }

      const selfAdminChanged =
        doesGroupUpdateIncludeSelf(botState.sock, update) &&
        ["promote", "demote"].includes(action) &&
        botState?.autoJoinManagedGroups instanceof Set &&
        botState.autoJoinManagedGroups.has(update?.id);
      if (selfAdminChanged && update?.id) {
        await applyManagedGroupPolicy(botState, botState.sock, update.id, {
          forceNotice: true,
        });
      }

      await runGroupUpdateHooks(botState, botState.sock, update);
    });

    botState.sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      try {
        botState.connectionState = String(connection || botState.connectionState || "")
          .trim()
          .toLowerCase();
        markBotSocketActivity(
          botState,
          qr ? "connection.qr" : `connection.${botState.connectionState || "update"}`
        );

        if (
          qr &&
          shouldAutoRequestPairingCode(botState) &&
          !isBotRegistered(botState) &&
          !botState.pairingRequested
        ) {
          await requestPairingCodeSafe(botState);
        }

        if (connection === "connecting") {
          const now = Date.now();
          if (now - Number(botState.lastConnectingLogAt || 0) >= CONNECTING_LOG_THROTTLE_MS) {
            botState.lastConnectingLogAt = now;
            logBotEvent(botState, "info", "Conectando...");
          }
        }

        if (connection === "open") {
          if (botState.reconnectTimer) {
            clearTimeout(botState.reconnectTimer);
            botState.reconnectTimer = null;
          }

          clearSocketRecoveryTimer(botState);
          clearReplacementBlock(botState);
          botState.reconnectAttempts = 0;
          botState.connectedAt = Date.now();
          botState.lastDisconnectAt = 0;
          botState.lastDisconnectCode = 0;
          botState.connectionState = "open";
          resetPairingCache(botState);
          botState.pairingCommandHintShown = false;
          scheduleProfileApply(botState, botState.sock);
          const connectedBotName = resolveConfiguredBotName(config);
          const connectedNumber = sanitizePhoneNumber(
            botState?.config?.pairingNumber ||
              botState?.config?.requesterNumber ||
              botState?.lastPairingNumber ||
              ""
          );

          if (botState.config?.id === "main") {
            logBotEvent(
              botState,
              "success",
              `Ya conectado bot ${connectedBotName}`
            );
          } else {
            logBotEvent(
              botState,
              "success",
              connectedNumber
                ? `Subbot conectado: ${connectedBotName} | Numero: ${connectedNumber}`
                : `Subbot conectado: ${connectedBotName}`
            );
          }
          writePersistedBotRuntimeState(botState);

          ensureBotAutoJoinGroup(botState).catch((error) => {
            logBotEvent(
              botState,
              "warn",
              `No pude aplicar autoingreso de grupo: ${String(error?.message || error).slice(0, 180)}`
            );
          });

          if (botState.config?.id === "main") {
            startSecondaryBots().catch((error) => {
              console.error("[SECONDARY] Error iniciando subbots:", error?.message || error);
            });
          }
        }

        if (connection === "close") {
          const code = getDisconnectStatusCode(lastDisconnect);
          const reasonText = getDisconnectReasonText(lastDisconnect);

          markBotSocketActivity(botState, `connection.close:${code || "unknown"}`);
          logBotEvent(
            botState,
            "warn",
            `Conexion cerrada: ${code || 0}` +
              (reasonText ? ` (${reasonText.slice(0, 160)})` : "")
          );

          const loggedOut =
            code === 401 || code === DisconnectReason.loggedOut;
          const connectionReplaced =
            code === 440 || code === DisconnectReason.connectionReplaced;
          const restartRequired = code === DisconnectReason.restartRequired;

          if (loggedOut) {
            removeAuthFolder(config.authFolder);
          }

          clearSocketRecoveryTimer(botState);
          botState.sock = null;
          botState.connecting = false;
          botState.connectedAt = 0;
          botState.lastDisconnectAt = Date.now();
          botState.lastDisconnectCode = Number(code || 0);
          botState.connectionState = "close";
          botState.bootStartedAt = 0;
          clearProfileApplyTimer(botState);
          abortActiveDownloadJobs(botState, `connection_closed:${code || "unknown"}`);
          abortActiveCommand(botState, `connection_closed:${code || "unknown"}`);
          resetPairingCache(botState);
          writePersistedBotRuntimeState(botState);

          if (botState.config?.id !== "main" && loggedOut) {
            releaseSubbotSlot(botState, {
              reason: "desconectado",
              closeSocket: false,
              resetAuthFolder: false,
            });
            return;
          }

          if (connectionReplaced) {
            markReplacementBlocked(botState);
            botState.reconnectAttempts = 0;
            clearReconnectTimer(botState);
            writePersistedBotRuntimeState(botState);
            logBotEvent(
              botState,
              "warn",
              `Sesion reemplazada (440). No reconecto en bucle; revisa si ese numero ` +
                `esta abierto en otro VPS, hosting o dispositivo.`
            );
            return;
          }

          if (restartRequired) {
            botState.reconnectAttempts = 0;
            scheduleReconnect(botState, 1200, "restart_required");
            return;
          }

          const reconnectDelay = getReconnectDelay(botState, {
            loggedOut,
            closeCode: code,
          });
          const reconnectReason = loggedOut
            ? "logged_out"
            : `close_code_${Number(code || 0) || "unknown"}`;
          scheduleReconnect(botState, reconnectDelay, reconnectReason);
        }
      } catch (err) {
        resetPairingCache(botState);
        logBotEvent(
          botState,
          "error",
          `Error en connection.update: ${String(err?.message || err)}`
        );
      }
    });

    const boundSock = botState.sock;

    boundSock.ev.on("messages.upsert", async ({ messages, type }) => {
      // Ignore late events from a socket that is no longer the active one.
      if (botState.sock !== boundSock) return;

      botState.lastMessageUpsertAt = Date.now();
      markBotSocketActivity(botState, `messages.upsert:${type || "unknown"}`);

      const normalizedType = String(type || "").trim().toLowerCase();
      const allowedTypes = new Set(["", "notify", "append", "replace", "ephemeral", "history"]);
      if (!allowedTypes.has(normalizedType)) {
        return;
      }

      const filteredMessages = [];
      let hasMessagePayload = false;

      for (const raw of messages || []) {
        if (!raw?.message) continue;
        hasMessagePayload = true;

        if (shouldProcessUpsertMessage(raw, type)) {
          filteredMessages.push(raw);
        }
      }

      if (hasMessagePayload) {
        logMessageUpsertEvent(botState, type, messages?.length || 0);
      }

      if (!filteredMessages.length) return;
      await handleIncomingMessages(botState, boundSock, filteredMessages);
    });

    boundSock.ev.on("messages.delete", async (update) => {
      if (botState.sock !== boundSock) return;
      markBotSocketActivity(botState, "messages.delete");
      const keys = Array.isArray(update?.keys) ? update.keys : [];

      for (const key of keys) {
        try {
          const remoteJid = String(key?.remoteJid || "").trim();
          if (!remoteJid) continue;

          let deletedMessage = null;

          try {
            if (botState.store?.loadMessage && key?.id) {
              const stored = await botState.store.loadMessage(remoteJid, key.id);
              const normalizedMessage = stored?.message || stored;
              if (normalizedMessage) {
                deletedMessage = serializeMessage({
                  key,
                  message: normalizedMessage,
                });
              }
            }
          } catch {}

          await runMessageDeleteHooks(botState, boundSock, {
            update,
            deleteKey: key,
            from: remoteJid,
            deletedMessage,
            isGroup: remoteJid.endsWith("@g.us"),
          });
        } catch (err) {
          console.error(`${getBotTag(botState)} Error procesando message delete:`, err);
        }
      }
    });
  } catch (err) {
    clearSocketRecoveryTimer(botState);
    abortActiveDownloadJobs(botState, "start_error");
    abortActiveCommand(botState, "start_error");
    botState.sock = null;
    botState.connectionState = "start_error";
    botState.connectedAt = 0;
    botState.bootStartedAt = 0;
    botState.lastDisconnectAt = Date.now();
    botState.lastSocketEventAt = Date.now();
    botState.lastSocketEvent = "start_error";
    logBotEvent(config, "error", `Error iniciando bot: ${String(err?.message || err)}`);
    writePersistedBotRuntimeState(botState);

    if (shouldManagedProcessStartBot(botState.config) && !isReplacementBlocked(botState)) {
      scheduleReconnect(
        botState,
        getReconnectDelay(botState, false),
        "start_error"
      );
    }
  } finally {
    botState.connecting = false;
  }
}

async function start() {
  getManagedProcessBotConfigs().forEach((config) => ensureBotState(config));
  cleanupManagedTempRoots({
    maxAgeMs: 45 * 60 * 1000,
  });
  await cargarComandos();
  await banner();
  await syncManagedProcessBots();
  await syncSplitSubbotProcessPool();
  flushManagedBotRuntimeStates();
  ensureDashboardServer();
  runAutoClean();
  startLiveConsoleTelemetryTicker();

  if (!managedBotSyncInterval) {
    managedBotSyncInterval = setInterval(() => {
      (async () => {
        await syncManagedProcessBots();
        await syncSplitSubbotProcessPool();
      })().catch((err) => {
        console.error("Error sincronizando procesos del bot:", err);
      });
    }, SETTINGS_SYNC_INTERVAL_MS);
    managedBotSyncInterval.unref?.();
  }

  if (!autoCleanInterval) {
    autoCleanInterval = setInterval(() => {
      try {
        const state = getAutoCleanState();
        const intervalMs = Math.max(60_000, Number(state.intervalMs || 30 * 60 * 1000));
        const lastRunAt = Number(state.lastRunAt || 0);
        // Permite cambiar config sin reiniciar: chequeamos cada minuto y corremos cuando toque.
        if (state.enabled && Date.now() - lastRunAt >= intervalMs) {
          runAutoClean();
        }
      } catch (err) {
        console.error("Error en autoclean:", err);
      }
    }, 60_000);
    autoCleanInterval.unref?.();
  }

  if (!botHealthCheckInterval) {
    botHealthCheckInterval = setInterval(() => {
      try {
        runBotHealthChecks();
      } catch (err) {
        console.error("Error en bot healthcheck:", err);
      }
    }, BOT_HEALTHCHECK_INTERVAL_MS);
    botHealthCheckInterval.unref?.();
  }
}

start();

process.on("SIGINT", () => {
  try {
    if (usageStatsSaveTimer) {
      clearTimeout(usageStatsSaveTimer);
      usageStatsSaveTimer = null;
    }
    if (managedBotSyncInterval) {
      clearInterval(managedBotSyncInterval);
      managedBotSyncInterval = null;
    }
    if (autoCleanInterval) {
      clearInterval(autoCleanInterval);
      autoCleanInterval = null;
    }
    if (botHealthCheckInterval) {
      clearInterval(botHealthCheckInterval);
      botHealthCheckInterval = null;
    }
    if (liveConsoleTelemetryInterval) {
      clearInterval(liveConsoleTelemetryInterval);
      liveConsoleTelemetryInterval = null;
    }
    cleanupManagedTempRoots({
      maxAgeMs: 2 * 60 * 1000,
    });
    writeAtomicJsonFile(USAGE_STATS_FILE, usageStats);
    if (structuredLogStream) {
      try {
        structuredLogStream.end();
      } catch {}
      structuredLogStream = null;
    }
  } catch {}

  try {
    rl?.close?.();
  } catch {}

  for (const botState of botStates.values()) {
    try {
      clearPersistedBotRuntimeStateWriteTimer(botState);
      botState.persistedStateWritePending = false;
    } catch {}

    try {
      abortActiveDownloadJobs(botState, "process_sigint");
    } catch {}

    try {
      abortActiveCommand(botState, "process_sigint");
    } catch {}

    try {
      if (botState.reconnectTimer) {
        clearTimeout(botState.reconnectTimer);
      }
      if (botState.profileApplyTimer) {
        clearTimeout(botState.profileApplyTimer);
      }
      if (botState.socketRecoveryTimer) {
        clearTimeout(botState.socketRecoveryTimer);
      }
    } catch {}

    try {
      if (botState.store?.__writeTimer) {
        clearInterval(botState.store.__writeTimer);
      }
    } catch {}

    try {
      clearPairingResetTimer(botState);
    } catch {}

    try {
      if (botState.sock?.end) {
        botState.sock.end(undefined);
      }
    } catch {}

    clearPersistedBotRuntimeState(botState?.config?.id);
  }

  console.log("Bot apagado");
  process.exit(0);
});
