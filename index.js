
// =========================
// DVYER BOT - INDEX (STABLE)
// =========================

import * as baileys from "@whiskeysockets/baileys";
import pino from "pino";
import chalk from "chalk";
import readline from "readline";
import fs from "fs";
import path from "path";
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
  Browsers,
} = baileys;

// ================= CONFIG =================

const CARPETA_AUTH = "dvyer-session";
const logger = pino({ level: "silent" });

const settings = JSON.parse(
  fs.readFileSync("./settings/settings.json", "utf-8")
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// ================= TMP DIR =================

const TMP_DIR = path.join(process.cwd(), "tmp");
const STORE_FILE = path.join(TMP_DIR, "baileys_store.json");

try {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
} catch {}

process.env.TMPDIR = TMP_DIR;
process.env.TMP = TMP_DIR;
process.env.TEMP = TMP_DIR;

// ================= VARIABLES =================

let sockGlobal = null;
let conectando = false;
let pairingSolicitado = false;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const preguntar = (q) => new Promise((r) => rl.question(q, r));

const comandos = new Map();
const groupCache = new Map();

let totalMensajes = 0;
let totalComandos = 0;

const mensajesPorTipo = {
  Grupo: 0,
  Privado: 0,
  Desconocido: 0,
};

// ================= STORE =================

const store =
  typeof makeInMemoryStore === "function"
    ? makeInMemoryStore({ logger })
    : null;

try {
  if (store?.readFromFile && fs.existsSync(STORE_FILE)) {
    store.readFromFile(STORE_FILE);
  }
} catch {}

if (store?.writeToFile) {
  setInterval(() => {
    try {
      store.writeToFile(STORE_FILE);
    } catch {}
  }, 10000).unref();
}

// ================= CONSOLA =================

global.consoleBuffer = [];
global.MAX_CONSOLE_LINES = 120;

function pushConsole(level, args) {
  const line =
    `[${new Date().toLocaleString()}] [${level}] ` +
    args
      .map((a) => {
        try {
          if (a instanceof Error) return a.stack;
          if (typeof a === "string") return a;
          return JSON.stringify(a);
        } catch {
          return String(a);
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
const error = console.error;
const warn = console.warn;

console.log = (...a) => {
  pushConsole("LOG", a);
  log(chalk.cyan("[LOG]"), ...a);
};

console.warn = (...a) => {
  pushConsole("WARN", a);
  warn(chalk.yellow("[WARN]"), ...a);
};

console.error = (...a) => {
  if (shouldIgnoreError(a[0])) return;
  pushConsole("ERROR", a);
  error(chalk.red("[ERROR]"), ...a);
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

// ================= UTIL =================

function tipoChat(jid = "") {
  if (jid.endsWith("@g.us")) return "Grupo";
  if (jid.endsWith("@s.whatsapp.net")) return "Privado";
  return "Desconocido";
}

function obtenerTexto(message) {
  if (!message) return "";

  const msg =
    message?.ephemeralMessage?.message ||
    message?.viewOnceMessage?.message ||
    message?.viewOnceMessageV2?.message ||
    message;

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

function getQuoted(msg) {
  const contextInfo =
    msg?.message?.extendedTextMessage?.contextInfo ||
    msg?.message?.imageMessage?.contextInfo ||
    msg?.message?.videoMessage?.contextInfo ||
    msg?.message?.documentMessage?.contextInfo ||
    {};

  if (!contextInfo?.quotedMessage) return null;

  return {
    key: {
      remoteJid: msg.key.remoteJid,
      fromMe: false,
      id: contextInfo.stanzaId || "",
      participant: contextInfo.participant || msg.key.participant || msg.key.remoteJid,
    },
    message: contextInfo.quotedMessage,
  };
}

function serializarMensaje(msg) {
  const text = obtenerTexto(msg.message);
  const quotedRaw = getQuoted(msg);

  return {
    ...msg,
    text,
    body: text,
    quoted: quotedRaw
      ? {
          ...quotedRaw,
          text: obtenerTexto(quotedRaw.message),
          body: obtenerTexto(quotedRaw.message),
        }
      : null,
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

async function cachedGroupMetadata(jid) {
  return groupCache.get(jid) || undefined;
}

// ================= BANNER =================

function banner() {
  console.clear();

  console.log(
    chalk.magentaBright(`
╔══════════════════════════════╗
║        DVYER BOT v2          ║
╚══════════════════════════════╝
`)
  );

  console.log(
    chalk.green("Owner :"),
    settings.ownerName,
    chalk.blue("\nPrefijo :"),
    settings.prefix,
    chalk.yellow("\nComandos cargados :"),
    comandos.size
  );

  console.log(chalk.gray("──────────────────────────────"));
}

// ================= CARGAR COMANDOS =================

async function cargarComandos() {
  const base = path.join(__dirname, "commands");

  async function leer(dir) {
    const archivos = fs.readdirSync(dir, { withFileTypes: true });

    for (const a of archivos) {
      const ruta = path.join(dir, a.name);

      if (a.isDirectory()) {
        await leer(ruta);
        continue;
      }

      if (!a.name.endsWith(".js")) continue;

      try {
        const mod = await import(pathToFileURL(ruta).href);
        const cmd = mod.default;

        if (!cmd || typeof cmd.run !== "function") continue;

        const nombres = [];

        if (cmd.name) nombres.push(cmd.name);

        if (cmd.command) {
          if (Array.isArray(cmd.command)) nombres.push(...cmd.command);
          else nombres.push(cmd.command);
        }

        for (const n of nombres) {
          comandos.set(String(n).toLowerCase(), cmd);
        }

        console.log("✓ Comando cargado:", nombres.join(", "));
      } catch (e) {
        console.error("Error cargando comando", e);
      }
    }
  }

  await leer(base);
}

// ================= BOT =================

async function iniciarBot() {
  if (conectando) return;
  conectando = true;

  try {
    banner();

    const { state, saveCreds } = await useMultiFileAuthState(CARPETA_AUTH);
    const version = await getVersionSafe();

    pairingSolicitado = false;

    sockGlobal = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      browser: Browsers?.ubuntu ? Browsers.ubuntu("DVYER BOT") : undefined,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      getMessage: async (key) => {
        try {
          if (!store?.loadMessage) return undefined;
          const msg = await store.loadMessage(key.remoteJid, key.id);
          return msg?.message || undefined;
        } catch {
          return undefined;
        }
      },
      cachedGroupMetadata,
    });

    const sock = sockGlobal;

    if (store?.bind) {
      store.bind(sock.ev);
    }

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("groups.update", async (updates) => {
      for (const update of updates || []) {
        try {
          if (!update?.id) continue;
          const meta = await sock.groupMetadata(update.id);
          groupCache.set(update.id, meta);
        } catch {}
      }
    });

    sock.ev.on("group-participants.update", async (update) => {
      try {
        if (!update?.id) return;
        const meta = await sock.groupMetadata(update.id);
        groupCache.set(update.id, meta);
      } catch {}
    });

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      try {
        if (qr && !sock.authState.creds.registered && !pairingSolicitado) {
          pairingSolicitado = true;

          console.log("📲 Bot no vinculado");
          let numero = await preguntar("Numero con codigo de pais: ");
          numero = String(numero || "").replace(/\D/g, "");

          if (!numero) {
            console.log("Numero invalido");
            pairingSolicitado = false;
            return;
          }

          const codigo = await sock.requestPairingCode(numero);

          console.log("\nCODIGO DE VINCULACION:\n");
          console.log(chalk.greenBright(codigo));
          console.log(
            chalk.yellow(
              "Abre WhatsApp > Dispositivos vinculados > Vincular con numero de telefono"
            )
          );
        }

        if (connection === "open") {
          console.log(chalk.green("✅ DVYER BOT CONECTADO"));
        }

        if (connection === "close") {
          const code = lastDisconnect?.error?.output?.statusCode;

          console.log("Conexion cerrada:", code);

          if (code === 401 || code === DisconnectReason.loggedOut) {
            try {
              fs.rmSync(CARPETA_AUTH, { recursive: true, force: true });
            } catch {}
          }

          setTimeout(() => {
            iniciarBot();
          }, 2000);
        }
      } catch (e) {
        pairingSolicitado = false;
        console.error("Error en connection.update:", e);
      }
    });

    // ================= MENSAJES =================

    sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const raw of messages || []) {
        try {
          if (!raw?.message || raw.key.fromMe) continue;

          const from = raw.key.remoteJid || "";
          if (!from || from === "status@broadcast") continue;

          const msg = serializarMensaje(raw);
          const texto = msg.text;

          if (!texto) continue;

          totalMensajes++;

          const tipo = tipoChat(from);
          mensajesPorTipo[tipo] = (mensajesPorTipo[tipo] || 0) + 1;

          const txt = texto.trim();
          const prefijo = settings.prefix || ".";

          if (!txt.startsWith(prefijo)) continue;

          const body = txt.slice(prefijo.length).trim();
          if (!body) continue;

          const args = body.split(/\s+/);
          const comando = args.shift()?.toLowerCase();

          const cmd = comandos.get(comando);
          if (!cmd) continue;

          totalComandos++;

          await cmd.run({
            sock,
            m: msg,
            msg,
            from,
            args,
            text: msg.text,
            body: msg.body,
            quoted: msg.quoted,
            settings,
            comandos,
          });
        } catch (e) {
          console.error("Error comando:", e);
        }
      }
    });
  } catch (e) {
    console.error(e);
  } finally {
    conectando = false;
  }
}

async function start() {
  await cargarComandos();
  await iniciarBot();
}

start();

process.on("SIGINT", () => {
  try {
    rl.close();
  } catch {}

  console.log("Bot apagado");
  process.exit();
});
