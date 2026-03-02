import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

import pino from "pino";
import chalk from "chalk";
import readline from "readline";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ================= CONFIG =================
const CARPETA_AUTH = "dvyer-session";
const logger = pino({ level: "silent" });
const settings = JSON.parse(fs.readFileSync("./settings/settings.json", "utf-8"));
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================= ✅ FIX RECONEXIÓN (ANTI 2+ SOCKETS) =================
let sockGlobal = null;        // referencia al socket actual
let conectando = false;       // candado para evitar iniciarBot() duplicado
let inicializado = false;     // para no recargar comandos/barra cada reconexión

// ================= NEWSLETTER CONFIG =================
global.channelInfo = settings.newsletter?.enabled
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

// Carpeta TMP para descargas
const TMP_DIR = path.join(process.cwd(), "tmp");

// Readline
let rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const preguntar = (q) => new Promise((r) => rl.question(q, r));

// Mapa de comandos
const comandos = new Map();

// Contadores para dashboard
let totalMensajes = 0;
let totalComandos = 0;
let mensajesPorTipo = { Grupo: 0, Privado: 0 };
let ultimosMensajes = [];

// ================= CAPTURA TOTAL DE CONSOLA (PARA COMANDO .consola) =================
global.consoleBuffer = [];
global.MAX_CONSOLE_LINES = 120; // guarda hasta 120 líneas

function _formatArg(a) {
  try {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === "string") return a;
    return JSON.stringify(a, null, 0);
  } catch {
    return String(a);
  }
}

function _pushConsoleLine(level, args) {
  const ts = new Date().toLocaleString();
  const line = `[${ts}] [${level}] ` + args.map(_formatArg).join(" ");
  global.consoleBuffer.push(line);
  if (global.consoleBuffer.length > global.MAX_CONSOLE_LINES) {
    global.consoleBuffer.shift();
  }
}

// Guardar originales
const __log = console.log;
const __error = console.error;
const __warn = console.warn;

// Interceptar
console.log = (...args) => {
  _pushConsoleLine("LOG", args);
  __log(...args);
};
console.error = (...args) => {
  _pushConsoleLine("ERROR", args);
  __error(...args);
};
console.warn = (...args) => {
  _pushConsoleLine("WARN", args);
  __warn(...args);
};

// Capturar errores globales
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});

// ================= ✅ NORMALIZAR NÚMEROS (FIX OWNER) =================
function normalizarNumero(jid) {
  return String(jid || "")
    .split("@")[0]
    .split(":")[0]
    .replace(/[^\d]/g, "")
    .trim();
}

// ================= BANNER =================
const bannerPremium = ["★ ★ ★ ★ ★ ★ ★ ★ ★ ★", "★     DVYER BOT    ★", "★ ★ ★ ★ ★ ★ ★ ★ ★ ★"];

function mostrarBanner() {
  console.clear();
  bannerPremium.forEach((line) => console.log(chalk.magentaBright.bold(line)));

  console.log(chalk.gray("──────────────────────────────────────────────"));
  console.log(chalk.cyanBright.bold("📊 Dashboard del Bot"));
  console.log(chalk.gray("──────────────────────────────────────────────"));

  console.log(
    chalk.white("🤖 Bot            : ") + chalk.green(settings.botName) + "\n" +
    chalk.white("👑 Owner          : ") + chalk.green(settings.ownerName) + "\n" +
    chalk.white("⚙️ Prefijo         : ") + chalk.green(obtenerEtiquetaPrefijo()) + "\n" +
    chalk.white("🗂 Comandos        : ") + chalk.yellow(comandos.size) + "\n" +
    chalk.white("💬 Total Mensajes  : ") + chalk.cyan(totalMensajes) + "\n" +
    chalk.white("👥 Mensajes Grupos : ") + chalk.blue(mensajesPorTipo.Grupo) + "\n" +
    chalk.white("🗨️ Mensajes Privados : ") + chalk.green(mensajesPorTipo.Privado) + "\n" +
    chalk.white("📝 Total Comandos Ejecutados : ") + chalk.yellow(totalComandos)
  );

  console.log(chalk.gray("──────────────────────────────────────────────\n"));

  if (ultimosMensajes.length) {
    console.log(chalk.white.bold("📌 Últimos mensajes:"));
    ultimosMensajes.slice(-10).forEach((msg) => console.log(msg));
    console.log(chalk.gray("──────────────────────────────────────────────\n"));
  }
}

// ================= NORMALIZACIÓN DE CONFIG =================
function obtenerPrefijos() {
  const p = settings?.prefix;
  if (settings?.noPrefix === true) return [];
  if (Array.isArray(p)) return p.filter(Boolean);
  if (typeof p === "string") return p ? [p] : [];
  return [];
}

function esModoSinPrefijo() {
  return settings?.noPrefix === true || obtenerPrefijos().length === 0;
}

function obtenerEtiquetaPrefijo() {
  if (esModoSinPrefijo()) return "SIN PREFIJO";
  return obtenerPrefijos().join(" | ");
}

// ================= FUNCIONES =================
function tipoChat(jid) {
  if (jid.endsWith("@g.us")) return "Grupo";
  if (jid.endsWith("@s.whatsapp.net")) return "Privado";
  return "Desconocido";
}

function obtenerTexto(message) {
  if (!message) return null;
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    null
  );
}

// ================= 🔥 CARGA RECURSIVA DE COMANDOS =================
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
        const cmd = (await import(ruta)).default;
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

        console.log(
          chalk.green("✓ Comando cargado: ") +
            chalk.white(nombres.join(", ")) +
            chalk.gray(` (${cmd.category || "sin categoría"})`)
        );
      } catch (e) {
        console.error(chalk.red(`❌ Error cargando ${a.name}: ${e.message}`), e);
      }
    }
  }

  await leer(base);
}

// ================= BARRA DE CARGA =================
async function barraCarga(duracion = 2000, ancho = 20) {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = 100;

    const timer = setInterval(() => {
      const progreso = Math.min((Date.now() - start) / duracion, 1);
      const llenado = Math.floor(progreso * ancho);
      const vacio = ancho - llenado;
      const barra = chalk.green("█".repeat(llenado)) + chalk.gray("▒".repeat(vacio));
      const porcentaje = Math.floor(progreso * 100);

      process.stdout.write(`\rLoading… ${barra} ${porcentaje}%`);
      if (progreso === 1) {
        clearInterval(timer);
        process.stdout.write(`\rLoading… ${chalk.green("█".repeat(ancho))} 100% ✅\n\n`);
        resolve();
      }
    }, interval);
  });
}

// ================= BORRADO AUTOMÁTICO TMP =================
function limpiarTMP() {
  if (!fs.existsSync(TMP_DIR)) {
    try {
      fs.mkdirSync(TMP_DIR, { recursive: true });
    } catch {}
    return;
  }
  try {
    fs.readdirSync(TMP_DIR).forEach((file) => {
      try {
        fs.unlinkSync(path.join(TMP_DIR, file));
      } catch {}
    });
    console.log(chalk.yellowBright(`🧹 Carpeta TMP limpiada`));
  } catch (e) {
    console.error(chalk.red(`❌ Error limpiando TMP: ${e.message}`), e);
  }
}

// ================= UTIL: ENVIAR CONSOLA POR WHATSAPP =================
async function enviarConsola(sock, from, n = 30) {
  const lines = global.consoleBuffer || [];
  if (!lines.length) {
    return sock.sendMessage(from, { text: "✅ Consola vacía (sin logs aún)." });
  }

  const take = Math.min(Math.max(parseInt(n, 10) || 30, 5), 120);
  const slice = lines.slice(-take);

  let text = `🧾 *Consola (últimas ${slice.length} líneas)*\n\n` + slice.join("\n");

  const MAX_CHARS = 6000;
  if (text.length > MAX_CHARS) {
    text = "⚠️ (Recortado por límite)\n\n" + text.slice(text.length - MAX_CHARS);
  }

  await sock.sendMessage(from, { text });
}

// ================= INICIAR BOT =================
async function iniciarBot() {
  // ✅ Candado: evita iniciarBot() duplicado (2+ sockets)
  if (conectando) return;
  conectando = true;

  try {
    // ✅ cerrar socket anterior si existía (evita conexiones duplicadas)
    try { sockGlobal?.end?.(); } catch {}

    limpiarTMP();

    // ✅ solo la primera vez: barra + comandos
    if (!inicializado) {
      await barraCarga();
      await cargarComandos();
      inicializado = true;
    }

    mostrarBanner();

    const { state, saveCreds } = await useMultiFileAuthState(CARPETA_AUTH);
    const { version } = await fetchLatestBaileysVersion();

    sockGlobal = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    });

    const sock = sockGlobal;

    if (!state.creds.registered) {
      console.log(chalk.yellowBright("📲 Bot no vinculado"));

      // Si el rl fue cerrado en un intento anterior, recrearlo
      try {
        if (rl?.closed) {
          rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        }
      } catch {}

      const numero = await preguntar("👉 Ingresa tu número (ej: 519XXXXXXXX): ");
      const codigo = await sock.requestPairingCode(numero.trim());

      console.log(chalk.greenBright("\n🔐 CÓDIGO DE VINCULACIÓN:\n"));
      console.log(chalk.white.bold.underline(codigo));
      console.log(chalk.yellow("WhatsApp > Dispositivos vinculados > Vincular con código\n"));

      // NO cerramos rl aquí para evitar problemas en reinicios
      // rl.close();
    }

    sock.ev.on("creds.update", saveCreds);

    // ✅ FIX: reconexión segura + borrar sesión si 401
    sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
      if (connection === "open") {
        console.log(chalk.bgGreen.black("\n ✅ DVYER BOT CONECTADO ✅ \n"));
        return;
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log(chalk.bgRed.black(` ❌ Conexión cerrada (${code}) ❌ `));

        // ✅ 401 / loggedOut => borrar dvyer-session y volver a vincular
        if (code === 401 || code === DisconnectReason.loggedOut) {
          console.log(chalk.redBright("🔐 Sesión inválida (401). Borrando dvyer-session para volver a vincular..."));
          try {
            fs.rmSync(CARPETA_AUTH, { recursive: true, force: true });
          } catch (e) {
            console.error(chalk.red("❌ No se pudo borrar la sesión:"), e?.message);
          }
        }

        // ✅ reconexión controlada (evita bucle agresivo y sockets dobles)
        setTimeout(() => iniciarBot(), 1500);
      }
    });

    // ================= WELCOME / DESPEDIDA =================
    sock.ev.on("group-participants.update", async (update) => {
      for (const cmd of comandos.values()) {
        if (typeof cmd.onGroupUpdate === "function") {
          try {
            await cmd.onGroupUpdate({ sock, update, settings });
          } catch (e) {
            console.error("❌ Error en onGroupUpdate:", e);
          }
        }
      }
    });

    // ================= MENSAJES =================
    sock.ev.on("messages.upsert", async ({ messages }) => {
      const msg = messages[0];
      if (!msg?.message || msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const texto = obtenerTexto(msg.message);
      if (!texto) return;

      totalMensajes++;
      const tipo = tipoChat(from);
      mensajesPorTipo[tipo]++;

      const idCorto = from.split("@")[0];
      ultimosMensajes.push(
        (tipo === "Grupo" ? chalk.bgBlue.black : chalk.bgGreen.black)(` ${tipo} `) +
          chalk.bgWhite.black(` ${idCorto} `) +
          chalk.bgBlack.white(` ${texto} `)
      );
      if (ultimosMensajes.length > 10) ultimosMensajes.shift();

      mostrarBanner();

      // ================= 🔥 EVENTOS AUTOMÁTICOS =================
      const esGrupo = from.endsWith("@g.us");
      const esPrivado = from.endsWith("@s.whatsapp.net");

      const sender = msg.key.participant || from;

      // ✅ FIX OWNER
      const numeroSender = normalizarNumero(sender);

      const owners = Array.isArray(settings.ownerNumbers)
        ? settings.ownerNumbers
        : typeof settings.ownerNumber === "string"
        ? [settings.ownerNumber]
        : [];

      const ownersNorm = owners.map(normalizarNumero);
      const esOwner = ownersNorm.includes(numeroSender);

      let esAdmin = false;

      if (esGrupo) {
        try {
          const metadata = await sock.groupMetadata(from);
          const participantes = metadata.participants;
          const usuario = participantes.find((p) => p.id === sender);
          esAdmin = usuario?.admin === "admin" || usuario?.admin === "superadmin";
        } catch (e) {
          console.error("❌ Error obteniendo metadata del grupo:", e);
        }
      }

      // ================= COMANDOS INTERNOS: .consola / .logs / .errores =================
      const prefijos = obtenerPrefijos();
      const modoSinPrefijo = esModoSinPrefijo();
      const txt = texto.trim();

      const internalMatch = (() => {
        if (!modoSinPrefijo) {
          for (const p of prefijos) {
            if (txt.startsWith(p)) return { p, body: txt.slice(p.length).trim() };
          }
          return null;
        }
        return { p: null, body: txt };
      })();

      if (internalMatch?.body) {
        const parts = internalMatch.body.split(/\s+/);
        const c = (parts[0] || "").toLowerCase();
        const n = parts[1];

        if (["consola", "logs", "errores"].includes(c)) {
          if (!esOwner) {
            return sock.sendMessage(from, { text: "👑 Solo el owner puede ver la consola." });
          }
          return await enviarConsola(sock, from, n || 30);
        }

        if (["clearconsola", "clearlogs"].includes(c)) {
          if (!esOwner) {
            return sock.sendMessage(from, { text: "👑 Solo el owner puede limpiar la consola." });
          }
          global.consoleBuffer = [];
          return sock.sendMessage(from, { text: "✅ Consola limpiada." });
        }
      }

      // ================= Ejecutar onMessage de comandos =================
      let bloqueado = false;
      for (const cmd of comandos.values()) {
        if (typeof cmd.onMessage === "function") {
          try {
            const r = await cmd.onMessage({
              sock,
              msg,
              from,
              esGrupo,
              esAdmin,
              esOwner,
              settings,
              comandos,
            });
            if (r === true) {
              bloqueado = true;
              break;
            }
          } catch (e) {
            console.error("❌ Error en onMessage:", e);
          }
        }
      }
      if (bloqueado) return;

      // ================= SISTEMA DE COMANDOS =================
      let textoComando = null;

      if (!modoSinPrefijo) {
        for (const p of prefijos) {
          if (txt.startsWith(p)) {
            textoComando = txt.slice(p.length).trim();
            break;
          }
        }
        if (!textoComando) return;
      } else {
        const posible = txt.split(/\s+/)[0]?.toLowerCase();
        if (posible && comandos.has(posible)) textoComando = txt;
        else return;
      }

      const a = textoComando.split(/\s+/);
      const comando = a.shift()?.toLowerCase();
      const cmd = comando ? comandos.get(comando) : null;
      if (!cmd) return;

      // ================= PERMISOS =================
      if (cmd.groupOnly && !esGrupo) {
        return await sock.sendMessage(from, { text: "❌ Este comando solo funciona en grupos." });
      }
      if (cmd.privateOnly && !esPrivado) {
        return await sock.sendMessage(from, { text: "❌ Este comando solo funciona en privado." });
      }
      if (cmd.ownerOnly && !esOwner) {
        return await sock.sendMessage(from, { text: "👑 Solo el owner puede usar este comando." });
      }
      if (cmd.adminOnly && !esAdmin) {
        return await sock.sendMessage(from, { text: "⚠️ Solo los administradores pueden usar este comando." });
      }

      totalComandos++;

      try {
        await cmd.run({
          sock,
          msg,
          from,
          args: a,
          settings,
          comandos,
          esOwner,
          esAdmin,
          esGrupo,
        });
      } catch (e) {
        console.error(`❌ Error ejecutando ${comando}:`, e);
      }
    });
  } finally {
    conectando = false;
  }
}

iniciarBot();

// Cierre limpio
process.on("SIGINT", () => {
  console.log(chalk.bgYellow.black("\n👋 DVYER BOT apagado"));
  process.exit(0);
});
