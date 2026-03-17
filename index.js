// =========================
// DVYER BOT - INDEX (MULTI BOT)
// =========================

import * as baileys from "@whiskeysockets/baileys";
import pino from "pino";
import chalk from "chalk";
import readline from "readline";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

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
const logger = pino({ level: "silent" });
const FIXED_BROWSER = ["Windows", "Chrome", "114.0.5735.198"];

const settings = JSON.parse(
  fs.readFileSync("./settings/settings.json", "utf-8")
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETTINGS_FILE = path.join(__dirname, "settings", "settings.json");
const DATABASE_DIR = path.join(process.cwd(), "database");
const USAGE_STATS_FILE = path.join(DATABASE_DIR, "usage-stats.json");

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
}

function saveSettingsFile() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

ensureSubbotSettings(settings);
ensureSystemSettings(settings);

// ================= INFO CHANNEL =================

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

// ================= TMP =================

const TMP_DIR = path.join(process.cwd(), "tmp");

try {
  if (!fs.existsSync(DATABASE_DIR)) {
    fs.mkdirSync(DATABASE_DIR, { recursive: true });
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

function sanitizePhoneNumber(value) {
  return String(value || "").replace(/\D/g, "");
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

  return (
    msg?.conversation ||
    msg?.extendedTextMessage?.text ||
    msg?.imageMessage?.caption ||
    msg?.videoMessage?.caption ||
    msg?.documentMessage?.caption ||
    msg?.buttonsResponseMessage?.selectedDisplayText ||
    msg?.buttonsResponseMessage?.selectedButtonId ||
    msg?.templateButtonReplyMessage?.selectedId ||
    msg?.listResponseMessage?.title ||
    msg?.listResponseMessage?.singleSelectReply?.selectedRowId ||
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
    quoted,
  };
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
const OWNER_IDS = buildOwnerIds(settings);

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
    reconnectTimer: null,
    groupCache: new Map(),
    store: createStoreForBot(config.id),
  };

  botStates.set(config.id, state);
  return state;
}

function refreshBotConfigCache() {
  ensureSubbotSettings(settings);
  ensureSystemSettings(settings);
  SUBBOT_SLOT_CONFIGS = buildSubbotSlotConfigs(settings);
  BOT_CONFIGS = buildBotConfigs(settings);

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

async function canRunCommand(cmd, context) {
  const quoted = getQuoteOptions(context.msg);

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
  if (process.env.pm_id || process.env.PM2_HOME) {
    return {
      kind: "pm2",
      label: "PM2/VPS",
      needsBootstrap: false,
    };
  }

  if (
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RENDER ||
    process.env.PTERODACTYL_SERVER_UUID ||
    process.env.SERVER_ID ||
    process.env.KOYEB_SERVICE_NAME ||
    process.env.DYNO
  ) {
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

  clearReconnectTimer(botState);
  botState.reconnectTimer = setTimeout(() => {
    botState.reconnectTimer = null;
    iniciarInstanciaBot(botState.config);
  }, ms);
}

// ================= BANNER =================

function banner() {
  console.clear();

  console.log(
    chalk.magentaBright(`
+------------------------------+
|        DVYER BOT v2          |
+------------------------------+
`)
  );

  console.log(
    chalk.green("Owner :"),
    settings.ownerName,
    chalk.blue("\nPrefijo :"),
    Array.isArray(settings.prefix) ? settings.prefix.join(", ") : settings.prefix,
    chalk.yellow("\nComandos cargados :"),
    comandos.size,
    chalk.magenta("\nBots activos :"),
    BOT_CONFIGS.map((cfg) => cfg.label).join(", ")
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
    cachedPairingCode: cachedPairing?.code || "",
    cachedPairingNumber: cachedPairing?.number || "",
    cachedPairingExpiresInMs: cachedPairing?.expiresInMs || 0,
  };
}

function summarizeBotConfig(config) {
  const botState = botStates.get(config.id);
  if (botState) {
    return summarizeBotState(botState);
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

function shouldStartSecondaryBot(config = {}) {
  if (!config || config.id === "main") return false;
  if (config.enabled === false) return false;
  return hasPersistedBotSession(config);
}

function shouldPromptInConsole(botState) {
  return botState?.config?.id === "main";
}

function shouldAutoRequestPairingCode(botState) {
  return botState?.config?.id === "main";
}

function getMainBotState() {
  return botStates.get("main") || null;
}

function isMainBotReady() {
  const mainBotState = getMainBotState();
  if (!mainBotState) return false;
  return Boolean(isBotRegistered(mainBotState) || mainBotState?.sock?.user?.id);
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
  for (const config of BOT_CONFIGS) {
    if (config.id === "main") continue;
    if (!shouldStartSecondaryBot(config)) continue;
    await iniciarInstanciaBot(config);
  }
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
  getMaintenanceState: () => getMaintenanceState(),
  setMaintenanceState: (mode, message = "") => setMaintenanceState(mode, message),
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
    try {
      if (!raw?.message) continue;
      if (raw?.key?.fromMe) continue;

      const from = raw?.key?.remoteJid || "";
      if (shouldIgnoreJid(from)) continue;

      const m = serializeMessage(raw);
      const texto = String(m?.text || "").trim();
      if (!texto) continue;

      totalMensajes++;
      trackMessageUsage(botState, m);

      const tipo = tipoChat(from);
      mensajesPorTipo[tipo] = (mensajesPorTipo[tipo] || 0) + 1;

      const executionInfo = await getMessageExecutionInfo(botState, sock, m);
      const baseContext = createBaseContext(botState, sock, m, executionInfo);

      const blockedByHook = await runMessageHooks(botState, baseContext);
      if (blockedByHook) continue;

      const commandData = extractCommandData(texto, settings);
      if (!commandData) continue;

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

      await cmd.run(commandContext);
    } catch (err) {
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

          botState.connectedAt = Date.now();
          botState.lastDisconnectAt = 0;
          resetPairingCache(botState);
          botState.pairingCommandHintShown = false;
          console.log(
            chalk.green(`${getBotTag(botState)} ${config.displayName} conectado`)
          );

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
          resetPairingCache(botState);

          if (botState.config?.id !== "main" && loggedOut) {
            releaseSubbotSlot(botState, {
              reason: "desconectado",
              closeSocket: false,
              resetAuthFolder: false,
            });
            return;
          }

          if (connectionReplaced) {
            console.log(
              chalk.yellow(
                `${getBotTag(botState)} Sesion reemplazada (440). ` +
                `No voy a reconectar en bucle. Revisa si ese numero esta abierto ` +
                `en otro VPS, hosting o dispositivo vinculado.`
              )
            );
            return;
          }

          scheduleReconnect(botState, loggedOut ? 4000 : 2500);
        }
      } catch (err) {
        resetPairingCache(botState);
        console.error(`${getBotTag(botState)} Error en connection.update:`, err);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      await handleIncomingMessages(botState, sock, messages);
    });
  } catch (err) {
    console.error(`${getBotTag(config)} Error iniciando bot:`, err);
  } finally {
    botState.connecting = false;
  }
}

async function start() {
  BOT_CONFIGS.forEach((config) => ensureBotState(config));
  await cargarComandos();
  banner();

  const mainConfig = BOT_CONFIGS.find((config) => config.id === "main");
  if (mainConfig) {
    await iniciarInstanciaBot(mainConfig);
  }

  if (isMainBotReady()) {
    await startSecondaryBots();
  }
}

start();

process.on("SIGINT", () => {
  try {
    if (usageStatsSaveTimer) {
      clearTimeout(usageStatsSaveTimer);
      usageStatsSaveTimer = null;
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
  }

  console.log("Bot apagado");
  process.exit(0);
});
