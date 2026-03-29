// =========================
// FSOCIETY BOT - INDEX (MULTI BOT)
//OWNDER DVYER 
// =========================

import * as baileys from "@whiskeysockets/baileys";
import pino from "pino";
import chalk from "chalk";
import dotenv from "dotenv";
import readline from "readline";
import fs from "fs";
import path from "path";
import http from "http";
import { spawn } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
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
import { applyStoredRuntimeVars } from "./lib/runtime-vars.js";
import { writeJsonAtomic as writeAtomicJsonFile } from "./lib/json-store.js";
import { touchEconomyProfile } from "./commands/economia/_shared.js";

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
const BOT_RUNTIME_STATE_TTL_MS = 20_000;
const REMOTE_PAIRING_WAIT_MS = 18_000;
const PANEL_SUBBOT_CALLBACK_WAIT_MS = 90_000;
const PANEL_SUBBOT_CALLBACK_POLL_MS = 4_000;
const SESSION_REPLACED_BLOCK_MS = 15 * 60 * 1000;
const PROFILE_APPLY_DELAY_MS = 15 * 1000;
const COMMAND_TIMEOUT_MS = 3 * 60 * 1000;
const DOWNLOAD_COMMAND_TIMEOUT_MS = 12 * 60 * 1000;
const HOOK_TIMEOUT_MS = 20 * 1000;
const PAIRING_SOCKET_WAIT_MS = 15 * 1000;
const PAIRING_REQUEST_TIMEOUT_MS = 25 * 1000;
const BOT_HEALTHCHECK_INTERVAL_MS = 30 * 1000;
const BOT_CONNECTING_STALE_MS = 2 * 60 * 1000;
const BOT_PAIRING_STALE_MS = 2 * 60 * 1000;
const BOT_DEGRADED_SOCKET_STALE_MS = 90 * 1000;
const FATAL_ERROR_WINDOW_MS = 2 * 60 * 1000;
const FATAL_ERROR_THRESHOLD = 3;
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

  if (typeof sock.updateProfileName === "function" && desiredName) {
    try {
      await sock.updateProfileName(desiredName);
    } catch (error) {
      if (String(error?.message || error).includes("App state key not present")) {
        hadAppStateError = true;
      }
      console.log(`${getBotTag(botState)} No pude actualizar el nombre del perfil: ${error?.message || error}`);
    }
  }

  if (typeof sock.updateProfileStatus === "function" && desiredBio) {
    try {
      await sock.updateProfileStatus(desiredBio);
    } catch (error) {
      if (String(error?.message || error).includes("App state key not present")) {
        hadAppStateError = true;
      }
      console.log(`${getBotTag(botState)} No pude actualizar la bio del perfil: ${error?.message || error}`);
    }
  }

  if (typeof sock.updateProfilePicture === "function" && desiredPhoto) {
    let photoSource = null;

    try {
      photoSource = await resolveBotProfilePhotoSource(botState?.config);
      if (photoSource?.path) {
        await sock.updateProfilePicture(sock.user.id, { url: photoSource.path });
      }
    } catch (error) {
      if (String(error?.message || error).includes("App state key not present")) {
        hadAppStateError = true;
      }
      console.log(`${getBotTag(botState)} No pude actualizar la foto del perfil: ${error?.message || error}`);
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
  const jid = String(value || "").trim();
  if (!jid) return "";
  const [user] = jid.split("@");
  return user.split(":")[0];
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
  const sender =
    raw?.key?.participant ||
    contextInfo?.participant ||
    raw?.key?.remoteJid ||
    "";

  let quoted = null;

  if (contextInfo?.quotedMessage) {
    const quotedText = obtenerTexto(contextInfo.quotedMessage);
    quoted = {
      key: {
        remoteJid: from,
        fromMe: false,
        id: contextInfo?.stanzaId || "",
        participant: contextInfo?.participant || sender,
      },
      message: contextInfo.quotedMessage,
      text: quotedText,
      body: quotedText,
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
    senderPhone: String(raw?.key?.participantPn || raw?.key?.senderPn || "").trim(),
    senderLid: String(raw?.key?.participantLid || raw?.key?.senderLid || "").trim(),
    quoted,
  };
}

function getStoreContactName(botState, ...ids) {
  const contacts = botState?.store?.contacts;
  if (!contacts || typeof contacts !== "object") return "";

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
    sanitizePhoneNumber(config?.requesterNumber) ||
    sanitizePhoneNumber(config?.pairingNumber) ||
    ""
  );
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

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const preguntar = (q) => new Promise((r) => rl.question(q, r));
let promptBusy = false;

async function preguntarSeguro(question) {
  while (promptBusy) {
    await delay(200);
  }

  promptBusy = true;

  try {
    return await preguntar(question);
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
let dashboardServer = null;
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
const GROUP_METADATA_CACHE_TTL_MS = Math.max(
  60_000,
  parseNumberEnv("GROUP_METADATA_CACHE_TTL_MS", 5 * 60 * 1000) || 5 * 60 * 1000
);
const GROUP_METADATA_CACHE_MAX_ENTRIES = Math.max(
  50,
  parseNumberEnv("GROUP_METADATA_CACHE_MAX_ENTRIES", 250) || 250
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
  return (
    txt.includes("Bad MAC") ||
    txt.includes("SessionCipher") ||
    txt.includes("Failed to decrypt message with any known session") ||
    txt.includes("No session record") ||
    txt.includes("Closing open session in favor of incoming prekey bundle")
  );
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
    lastProfileSignature: "",
    lastProfileAppliedAt: 0,
    profileApplyTimer: null,
    reconnectTimer: null,
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
    store: createStoreForBot(config.id),
    activeDownloadJobs: new Map(),
    downloadQueueCounter: 0,
    persistedStateWriteTimer: null,
    persistedStateWritePending: false,
    socketRecoveryTimer: null,
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

function getReconnectDelay(botState, loggedOut = false) {
  if (loggedOut) {
    botState.reconnectAttempts = 0;
    return 4000;
  }

  const attempts = Math.max(1, Math.min(8, Number(botState?.reconnectAttempts || 0) + 1));
  botState.reconnectAttempts = attempts;
  return Math.min(30_000, 2500 * 2 ** (attempts - 1));
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

  if (!metadata) {
    try {
      metadata = await sock.groupMetadata(message.from);
      cacheGroupMetadata(botState, message.from, metadata);
    } catch {}
  }

  if (!metadata) {
    return info;
  }

  const participants = Array.isArray(metadata.participants)
    ? metadata.participants
    : [];
  const normalizedBotUserId = normalizeJidUser(sock?.user?.id);
  let participant = null;
  let botParticipant = null;

  for (const value of participants) {
    const normalizedParticipantId = normalizeJidUser(value?.id);

    if (!participant && normalizedParticipantId === senderId) {
      participant = value;
    }

    if (!botParticipant && normalizedParticipantId === normalizedBotUserId) {
      botParticipant = value;
    }

    if (participant && botParticipant) {
      break;
    }
  }

  const esAdmin = Boolean(participant?.admin);
  const esBotAdmin = Boolean(botParticipant?.admin);

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
  const phoneNumber = sanitizePhoneNumber(payload?.phoneNumber);

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

function scheduleReconnect(botState, ms = 2500) {
  if (botState?.config?.id !== "main" && botState?.config?.enabled === false) {
    return;
  }

  if (isReplacementBlocked(botState)) {
    return;
  }

  clearReconnectTimer(botState);
  clearSocketRecoveryTimer(botState);
  botState.connectionState = "reconnecting";
  markBotSocketActivity(botState, "reconnecting");
  botState.reconnectTimer = setTimeout(() => {
    botState.reconnectTimer = null;
    iniciarInstanciaBot(botState.config);
  }, ms);
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
    scheduleReconnect(botState, getReconnectDelay(botState, false));
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
    console.warn(`${getBotTag(botState)} WebSocket error:`, error?.message || error);

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
    dashboard: {
      ...dashboardState,
      active: Boolean(dashboardServer),
    },
  };
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
  if (["no_capacity", "slot_busy", "pending", "already_linked"].includes(status)) {
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
    const numero = sanitizePhoneNumber(body?.numero || body?.number || body?.requesterNumber);
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
          const phoneNumber = sanitizePhoneNumber(body?.phoneNumber);
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
          const phoneNumber = sanitizePhoneNumber(body?.phoneNumber);

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

function banner() {
  console.clear();
  const managedLabels = getManagedProcessBotConfigs()
    .map((cfg) => cfg.label)
    .filter(Boolean)
    .join(", ") || "NINGUNO";
  const activeConfigLabels = BOT_CONFIGS.map((cfg) => cfg.label).join(", ") || "NINGUNO";

  console.log(
    chalk.magentaBright(`
+--------------------------------------+
|        ${String(settings?.botName || "Fsociety bot").toUpperCase().padEnd(28, " ")}|
+--------------------------------------+
`)
  );

  console.log(
    chalk.green("Owner :"),
    settings.ownerName,
    chalk.blue("\nPrefijo :"),
    Array.isArray(settings.prefix) ? settings.prefix.join(", ") : settings.prefix,
    chalk.yellow("\nComandos cargados :"),
    comandos.size,
    chalk.magenta("\nModo proceso :"),
    PROCESS_MODE_LABEL,
    chalk.cyan("\nEste proceso maneja :"),
    managedLabels,
    chalk.magenta("\nBots habilitados :"),
    activeConfigLabels
  );

  console.log(chalk.gray("------------------------------"));
}

// ================= CARGAR COMANDOS =================

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
        const mod = await import(pathToFileURL(ruta).href);
        const cmd = mod.default;

        if (!cmd || typeof cmd.run !== "function") continue;

        commandModules.add(cmd);
        if (typeof cmd.onMessage === "function") messageHookModules.push(cmd);
        if (typeof cmd.onGroupUpdate === "function") groupUpdateHookModules.push(cmd);
        if (typeof cmd.onMessageDelete === "function") messageDeleteHookModules.push(cmd);

        const nombres = [];

        if (cmd.name) nombres.push(cmd.name);

        if (cmd.command) {
          if (Array.isArray(cmd.command)) nombres.push(...cmd.command);
          else nombres.push(cmd.command);
        }

        for (const nombre of nombres) {
          comandos.set(String(nombre).toLowerCase(), cmd);
        }

        console.log("Comando cargado:", nombres.join(", "));
      } catch (err) {
        console.error("Error cargando comando:", ruta, err);
      }
    }
  }

  await leer(base);
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
  return ownsBotInThisProcess(botState?.config?.id) && botState?.config?.id === "main";
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

function isMainBotReady() {
  const mainBotState = getMainBotState();
  if (mainBotState && Boolean(isBotRegistered(mainBotState) || mainBotState?.sock?.user?.id)) {
    return true;
  }

  const persistedMain = readPersistedBotRuntimeState("main");
  return Boolean(persistedMain?.registered || persistedMain?.connected);
}

function shouldManagedProcessStartBot(config = {}) {
  if (!config) return false;

  const botState = botStates.get(config.id);
  if (isReplacementBlocked(botState)) {
    return false;
  }

  if (isPersistedReplacementBlocked(config.id)) {
    return false;
  }

  if (config.id === "main") {
    return true;
  }

  if (config.enabled === false) {
    return false;
  }

  if (!SPLIT_PROCESS_MODE) {
    return shouldStartSecondaryBot(config);
  }

  return Boolean(
    hasPersistedBotSession(config) ||
      (sanitizePhoneNumber(config?.pairingNumber) && isMainBotReady())
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
  clearActiveCommandState(botState);
  botState.groupCache?.clear?.();
  botState.activeDownloadJobs?.clear?.();
  console.log(`${getBotTag(botState)} Detenido localmente (${reason})`);
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
  clearActiveCommandState(botState);
  botState.activeDownloadJobs?.clear?.();
  resetPairingCache(botState);
  console.log(`${getBotTag(botState)} Reciclado automaticamente (${reason})`);
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
        scheduleReconnect(botState, getReconnectDelay(botState, false));
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
        scheduleReconnect(botState, getReconnectDelay(botState, false));
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
        scheduleReconnect(botState, 4000);
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
        scheduleReconnect(botState, getReconnectDelay(botState, false));
      }
    }
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

async function syncManagedProcessBots() {
  syncSettingsFromDisk();

  for (const config of getManagedProcessBotConfigs()) {
    const botState = ensureBotState(config);
    botState.config = {
      ...botState.config,
      ...config,
    };

    if (!shouldManagedProcessStartBot(config)) {
      if (botState.sock || botState.connecting || botState.reconnectTimer) {
        stopLocalManagedBot(botState, config.enabled === false ? "slot_apagado" : "esperando_sesion");
      } else {
        writePersistedBotRuntimeState(botState);
      }
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

  const explicitNumber = sanitizePhoneNumber(number);
  const cached = getCachedPairingCode(botState);
  const shouldForceRefresh =
    useCache === false ||
    (explicitNumber &&
      explicitNumber !== sanitizePhoneNumber(cached?.number || ""));

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
    explicitNumber || sanitizePhoneNumber(botState.config?.pairingNumber);

  if (!resolvedNumber && allowPrompt) {
    console.log(`${getBotTag(botState)} Bot no vinculado`);
    resolvedNumber = sanitizePhoneNumber(
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
        `Primero vincula el bot principal por consola y luego usa ` +
        `${prefix}subbot${slotHint} 519xxxxxxxxx para pedir el codigo.`,
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

  for (const config of BOT_CONFIGS) {
    if (config.id === "main") continue;
    if (!shouldStartSecondaryBot(config)) continue;
    await iniciarInstanciaBot(config);
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
      const isRequestedSlot = requestedBotId !== "subbot";
      const slotBusy =
        persistedSummary.connected ||
        persistedSummary.registered ||
        persistedSummary.pairingPending;

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
  getConsoleLines: (limit = 25) =>
    global.consoleBuffer.slice(-Math.max(1, Math.min(80, Number(limit || 25)))),
  getUsageStats: (limit = 5) =>
    getUsageStatsSnapshot(Math.max(1, Math.min(15, Number(limit || 5)))),
  getWeeklyStats: (limit = 5) =>
    getWeeklySnapshot(Math.max(1, Math.min(15, Number(limit || 5)))),
  getMaintenanceState: () => getMaintenanceState(),
  setMaintenanceState: (mode, message = "") => setMaintenanceState(mode, message),
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
  setSubbotMaxSlots: (count) => setSubbotMaxSlots(count),
  getSubbotRequestState: () => buildSubbotRequestState(),
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

    try {
      if (!raw?.message) continue;

      const from = raw?.key?.remoteJid || "";
      if (shouldIgnoreJid(from)) continue;

      const m = serializeMessage(raw);
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

      const executionInfo = await getMessageExecutionInfo(botState, sock, m);
      const baseContext = createBaseContext(botState, sock, m, executionInfo);

      const blockedByHook = await runMessageHooks(botState, baseContext);
      if (blockedByHook) continue;

      if (!commandData) continue;
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

      const cmd = comandos.get(commandData.commandName);
      if (!cmd) continue;

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

      totalComandos++;
      trackCommandUsage(botState, m, commandData.commandName);

      if (isDownloadCommand(cmd)) {
        const runningJob = enqueueDownloadCommand(botState, cmd, commandContext);
        runningJob.promise.then(() => {
          recordCommandSuccess(commandData.commandName);
        });
        runningJob.promise.catch(async (err) => {
          recordCommandFailure(commandData.commandName, err);
          if (isTaskTimeoutError(err)) {
            await sendCommandTimeoutNotice(commandContext, err);
          }
          console.error(`${getBotTag(botState)} Error comando concurrente:`, err);
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
      recordCommandSuccess(commandData.commandName);
    } catch (err) {
      if (failedCommandName) {
        finishCommandTracking(
          botState,
          failedCommandName,
          isTaskTimeoutError(err) ? "timeout" : "error"
        );
        recordCommandFailure(failedCommandName, err);
      }
      if (activeCommandContext && isTaskTimeoutError(err)) {
        await sendCommandTimeoutNotice(activeCommandContext, err);
      }
      console.error(`${getBotTag(botState)} Error comando:`, err);
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
      if (update?.id) {
        try {
          const meta = await botState.sock.groupMetadata(update.id);
          cacheGroupMetadata(botState, update.id, meta);
        } catch {}
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
          console.log(`${getBotTag(botState)} Conectando...`);
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
          console.log(
            chalk.green(
              `${getBotTag(botState)} Ya conectado bot ${resolveConfiguredBotName(config)}`
            )
          );
          writePersistedBotRuntimeState(botState);

          if (botState.config?.id === "main") {
            await startSecondaryBots();
          }
        }

        if (connection === "close") {
          const code =
            lastDisconnect?.error?.output?.statusCode ||
            lastDisconnect?.error?.data?.statusCode ||
            0;

          markBotSocketActivity(botState, `connection.close:${code || "unknown"}`);
          console.log(`${getBotTag(botState)} Conexion cerrada:`, code);

          const loggedOut =
            code === 401 || code === DisconnectReason.loggedOut;
          const connectionReplaced =
            code === 440 || code === DisconnectReason.connectionReplaced;

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
            console.log(
              chalk.yellow(
                `${getBotTag(botState)} Sesion reemplazada (440). ` +
                `No voy a reconectar en bucle. Revisa si ese numero esta abierto ` +
                `en otro VPS, hosting o dispositivo vinculado.`
              )
            );
            return;
          }

          scheduleReconnect(botState, getReconnectDelay(botState, loggedOut));
        }
      } catch (err) {
        resetPairingCache(botState);
        console.error(`${getBotTag(botState)} Error en connection.update:`, err);
      }
    });

    botState.sock.ev.on("messages.upsert", async ({ messages, type }) => {
      botState.lastMessageUpsertAt = Date.now();
      markBotSocketActivity(botState, `messages.upsert:${type || "unknown"}`);

      if (type && type !== "notify" && type !== "append") {
        return;
      }

      const filteredMessages = [];
      let hasMessagePayload = false;

      for (const raw of messages || []) {
        if (!raw?.message) continue;
        hasMessagePayload = true;

        if (type === "notify" || raw?.key?.fromMe) {
          filteredMessages.push(raw);
        }
      }

      if (hasMessagePayload) {
        console.log(
          `${getBotTag(botState)} messages.upsert type=${type || "unknown"} count=${
            messages?.length || 0
          }`
        );
      }

      if (!filteredMessages.length) return;
      await handleIncomingMessages(botState, botState.sock, filteredMessages);
    });

    botState.sock.ev.on("messages.delete", async (update) => {
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

          await runMessageDeleteHooks(botState, botState.sock, {
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
    console.error(`${getBotTag(config)} Error iniciando bot:`, err);
    writePersistedBotRuntimeState(botState);

    if (shouldManagedProcessStartBot(botState.config) && !isReplacementBlocked(botState)) {
      scheduleReconnect(botState, getReconnectDelay(botState, false));
    }
  } finally {
    botState.connecting = false;
  }
}

async function start() {
  getManagedProcessBotConfigs().forEach((config) => ensureBotState(config));
  await cargarComandos();
  banner();
  await syncManagedProcessBots();
  await syncSplitSubbotProcessPool();
  flushManagedBotRuntimeStates();
  ensureDashboardServer();
  runAutoClean();

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
        if (state.enabled) {
          runAutoClean();
        }
      } catch (err) {
        console.error("Error en autoclean:", err);
      }
    }, Math.max(60_000, Number(getAutoCleanState().intervalMs || 30 * 60 * 1000)));
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
    writeAtomicJsonFile(USAGE_STATS_FILE, usageStats);
  } catch {}

  try {
    rl.close();
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
