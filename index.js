// =========================
// FSOCIETY BOT - INDEX (MULTI BOT)
//OWNDER DVYER 
// =========================

import * as baileys from "@whiskeysockets/baileys";
import pino from "pino";
import chalk from "chalk";
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
import { touchEconomyProfile } from "./commands/economia/_shared.js";

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
const SESSION_REPLACED_BLOCK_MS = 15 * 60 * 1000;
const PROFILE_APPLY_DELAY_MS = 15 * 1000;
const logger = pino({ level: "silent" });
const FIXED_BROWSER = ["Windows", "Chrome", "114.0.5735.198"];

applyStoredRuntimeVars();

const settings = JSON.parse(
  fs.readFileSync("./settings/settings.json", "utf-8")
);

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
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
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
  try {
    fs.rmSync(getBotRuntimeStateFile(botId), { force: true });
  } catch {}
}

function writePersistedBotRuntimeState(botState) {
  if (!botState?.config?.id || !ownsBotInThisProcess(botState.config.id)) return;

  try {
    const summary = summarizeBotState(botState);
    fs.writeFileSync(
      getBotRuntimeStateFile(botState.config.id),
      JSON.stringify(
        {
          ...summary,
          processBotId: PROCESS_BOT_ID,
          processPid: process.pid,
          splitProcessMode: SPLIT_PROCESS_MODE,
          updatedAt: Date.now(),
        },
        null,
        2
      )
    );
  } catch {}
}

function flushManagedBotRuntimeStates() {
  for (const config of getManagedProcessBotConfigs()) {
    const botState = ensureBotState(config);
    botState.config = {
      ...botState.config,
      ...config,
    };
    writePersistedBotRuntimeState(botState);
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
let dashboardServer = null;
let dashboardState = {
  enabled: false,
  port: 8787,
  host: "0.0.0.0",
};

function scheduleUsageStatsSave() {
  if (usageStatsSaveTimer) return;

  usageStatsSaveTimer = setTimeout(() => {
    usageStatsSaveTimer = null;

    try {
      fs.writeFileSync(USAGE_STATS_FILE, JSON.stringify(usageStats, null, 2));
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

process.on("unhandledRejection", (reason) => {
  if (shouldIgnoreError(reason)) return;
  console.error(reason);
});

process.on("uncaughtException", (err) => {
  if (shouldIgnoreError(err?.message || err)) return;
  console.error(err);
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
    groupCache: new Map(),
    store: createStoreForBot(config.id),
    activeDownloadJobs: new Map(),
    downloadQueueCounter: 0,
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
  return botState.groupCache.get(jid) || undefined;
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
  botState.pairingRequested = false;
  botState.pairingCommandHintShown = false;
  botState.lastPairingCode = "";
  botState.lastPairingNumber = "";
  botState.lastPairingAt = 0;
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

  console.log(
    `${getBotTag(botState)} Slot liberado (${options?.reason || "sin motivo"})`
  );
  writePersistedBotRuntimeState(botState);

  if (SPLIT_PROCESS_MODE && botState?.config?.id !== "main") {
    void deleteSplitBotProcess(botState.config.id).catch(() => {});
  }

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
      botState.groupCache.set(message.from, metadata);
    } catch {}
  }

  if (!metadata) {
    return info;
  }

  const participants = Array.isArray(metadata.participants)
    ? metadata.participants
    : [];

  const participant = participants.find(
    (value) => normalizeJidUser(value?.id) === senderId
  );
  const botParticipant = participants.find(
    (value) => normalizeJidUser(value?.id) === normalizeJidUser(sock?.user?.id)
  );

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
  for (const cmd of commandModules) {
    if (typeof cmd?.onMessage !== "function") continue;

    try {
      const blocked = await cmd.onMessage(context);
      if (blocked) return true;
    } catch (err) {
      console.error(`${getBotTag(botState)} Error onMessage:`, err);
    }
  }

  return false;
}

async function runGroupUpdateHooks(botState, sock, update) {
  for (const cmd of commandModules) {
    if (typeof cmd?.onGroupUpdate !== "function") continue;

    try {
      await cmd.onGroupUpdate({
        sock,
        update,
        settings,
        comandos,
        botId: botState.config.id,
        botLabel: botState.config.label,
        botName: botState.config.displayName,
      });
    } catch (err) {
      console.error(`${getBotTag(botState)} Error onGroupUpdate:`, err);
    }
  }
}

async function runMessageDeleteHooks(botState, sock, payload) {
  for (const cmd of commandModules) {
    if (typeof cmd?.onMessageDelete !== "function") continue;

    try {
      await cmd.onMessageDelete({
        sock,
        settings,
        comandos,
        botId: botState.config.id,
        botLabel: botState.config.label,
        botName: botState.config.displayName,
        ...payload,
      });
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
  };
  botState.activeDownloadJobs.set(jobId, activeJob);

  Promise.resolve()
    .then(() => cmd.run(commandContext))
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

function getRestartMode() {
  if (isPm2Environment(process.env)) {
    return {
      kind: "pm2",
      label: "PM2/VPS",
      needsBootstrap: false,
    };
  }

  if (isManagedHostingEnvironment(process.env)) {
    return {
      kind: "managed",
      label: "Hosting administrado",
      needsBootstrap: false,
    };
  }

  return {
    kind: "self",
    label: "Node directo / VPS",
    needsBootstrap: true,
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

  return restartMode;
}

function scheduleReconnect(botState, ms = 2500) {
  if (botState?.config?.id !== "main" && botState?.config?.enabled === false) {
    return;
  }

  if (isReplacementBlocked(botState)) {
    return;
  }

  clearReconnectTimer(botState);
  botState.reconnectTimer = setTimeout(() => {
    botState.reconnectTimer = null;
    iniciarInstanciaBot(botState.config);
  }, ms);
}

function getDashboardSnapshot() {
  return {
    pid: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
    processMode: PROCESS_MODE_LABEL,
    commandsLoaded: comandos.size,
    totalMessages,
    totalCommands,
    memory: process.memoryUsage(),
    bots: global.botRuntime?.listBots?.({ includeMain: true }) || [],
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

function ensureDashboardServer() {
  if (!dashboardState.enabled || dashboardServer) return;

  dashboardServer = http.createServer((req, res) => {
    const url = String(req?.url || "/");

    if (url.startsWith("/json")) {
      const payload = JSON.stringify(getDashboardSnapshot(), null, 2);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(payload);
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
  writePersistedBotRuntimeState(botState);
}

function cachePairingCode(botState, code, number) {
  clearPairingResetTimer(botState);
  botState.pairingRequested = true;
  botState.lastPairingCode = String(code || "");
  botState.lastPairingNumber = String(number || "");
  botState.lastPairingAt = Date.now();

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
    configuredNumber,
    requesterNumber,
    requesterJid: String(config?.requesterJid || ""),
    requestedAt,
    releasedAt: normalizeTimestamp(config?.releasedAt),
    connectedForMs,
    hasConfiguredNumber: Boolean(configuredNumber),
    pairingPending: Boolean(botState?.pairingRequested),
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
    configuredNumber,
    requesterNumber,
    requesterJid: String(config?.requesterJid || ""),
    requestedAt,
    releasedAt: normalizeTimestamp(config?.releasedAt),
    connectedForMs: 0,
    hasConfiguredNumber: Boolean(configuredNumber),
    pairingPending: false,
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
  clearPairingResetTimer(botState);
  clearProfileApplyTimer(botState);

  try {
    botState.sock?.end?.();
  } catch {}

  botState.sock = null;
  botState.connecting = false;
  botState.lastDisconnectAt = Date.now();
  botState.connectedAt = 0;
  botState.groupCache?.clear?.();
  console.log(`${getBotTag(botState)} Detenido localmente (${reason})`);
  writePersistedBotRuntimeState(botState);
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

    if (!botState.sock && !botState.connecting) {
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

  try {
    console.log(
      `${getBotTag(botState)} Esperando 5 segundos para pedir el pairing code...`
    );
    await delay(5000);

    const code = await sock.requestPairingCode(resolvedNumber);
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
  getDashboardSnapshot: () => getDashboardSnapshot(),
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
        runningJob.promise.catch((err) => {
          recordCommandFailure(commandData.commandName, err);
          console.error(`${getBotTag(botState)} Error comando concurrente:`, err);
        });
        continue;
      }

      await cmd.run(commandContext);
      recordCommandSuccess(commandData.commandName);
    } catch (err) {
      if (failedCommandName) {
        recordCommandFailure(failedCommandName, err);
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

    botState.sock = sock;
    botState.authState = authState;

    if (botState.store?.bind) {
      botState.store.bind(sock.ev);
    }

    sock.ev.on("creds.update", saveCreds);

    const syncEconomyContact = (entry = {}) => {
      if (!entry?.id) return;
      touchEconomyProfile(entry.id, settings, {
        jid: entry.id,
        name: entry?.notify || entry?.name || entry?.verifiedName || entry?.verifiedBizName,
        verifiedName: entry?.verifiedName || entry?.verifiedBizName || "",
      });
    };

    sock.ev.on("contacts.update", (updates = []) => {
      for (const update of updates || []) {
        try {
          syncEconomyContact(update);
        } catch {}
      }
    });

    sock.ev.on("contacts.upsert", (updates = []) => {
      for (const update of updates || []) {
        try {
          syncEconomyContact(update);
        } catch {}
      }
    });

    sock.ev.on("chats.phoneNumberShare", (payload = {}) => {
      try {
        if (!payload?.lid || !payload?.jid) return;
        touchEconomyProfile(payload.lid, settings, {
          jid: payload.jid,
          phone: payload.jid,
          lid: payload.lid,
        });
      } catch {}
    });

    sock.ev.on("groups.update", async (updates) => {
      for (const update of updates || []) {
        try {
          if (!update?.id) continue;
          const meta = await sock.groupMetadata(update.id);
          botState.groupCache.set(update.id, meta);
        } catch {}
      }
    });

    sock.ev.on("group-participants.update", async (update) => {
      if (update?.id) {
        try {
          const meta = await sock.groupMetadata(update.id);
          botState.groupCache.set(update.id, meta);
        } catch {}
      }

      await runGroupUpdateHooks(botState, sock, update);
    });

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      try {
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

          clearReplacementBlock(botState);
          botState.reconnectAttempts = 0;
          botState.connectedAt = Date.now();
          botState.lastDisconnectAt = 0;
          resetPairingCache(botState);
          botState.pairingCommandHintShown = false;
          scheduleProfileApply(botState, sock);
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

          console.log(`${getBotTag(botState)} Conexion cerrada:`, code);

          const loggedOut =
            code === 401 || code === DisconnectReason.loggedOut;
          const connectionReplaced =
            code === 440 || code === DisconnectReason.connectionReplaced;

          if (loggedOut) {
            removeAuthFolder(config.authFolder);
          }

          botState.sock = null;
          botState.lastDisconnectAt = Date.now();
          clearProfileApplyTimer(botState);
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

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type && type !== "notify" && type !== "append") {
        return;
      }

      if ((messages || []).some((raw) => raw?.message)) {
        console.log(
          `${getBotTag(botState)} messages.upsert type=${type || "unknown"} count=${
            messages?.length || 0
          }`
        );
      }

      const filteredMessages = (messages || []).filter((raw) => {
        if (!raw?.message) return false;
        if (type === "notify") return true;
        return Boolean(raw?.key?.fromMe);
      });

      if (!filteredMessages.length) return;
      await handleIncomingMessages(botState, sock, filteredMessages);
    });

    sock.ev.on("messages.delete", async (update) => {
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

          await runMessageDeleteHooks(botState, sock, {
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
    console.error(`${getBotTag(config)} Error iniciando bot:`, err);
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
    fs.writeFileSync(USAGE_STATS_FILE, JSON.stringify(usageStats, null, 2));
  } catch {}

  try {
    rl.close();
  } catch {}

  for (const botState of botStates.values()) {
    try {
      if (botState.reconnectTimer) {
        clearTimeout(botState.reconnectTimer);
      }
      if (botState.profileApplyTimer) {
        clearTimeout(botState.profileApplyTimer);
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
