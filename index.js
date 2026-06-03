/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║              M I K U - B O T  |  F S O C I E T Y            ║
 * ║                   index.js — Núcleo principal                ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const pino     = require('pino');
const readline = require('readline');
const { Boom } = require('@hapi/boom');
const axios    = require('axios');

// ─── Carga de Baileys ──────────────────────────────────────────────────────────
let makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason;

try {
  ({
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
  } = require('fsociety-Baileys'));
} catch (err) {
  console.error('\n  ❌  No se pudo cargar fsociety-Baileys.');
  console.error(`      ${String(err?.message || err)}`);
  console.error('  ➜  Ejecuta: npm install\n');
  process.exit(1);
}

const { reloadCommands } = require('./utils/reloadCommands');

// ─── Rutas y constantes ────────────────────────────────────────────────────────
const SETTINGS_FILE  = path.join(process.cwd(), 'settings.json');
const SESSION_DIR    = path.join(process.cwd(), 'session', 'miku-bot');
const RUNTIME_DIR    = path.join(process.cwd(), 'runtime');
const CONNECTED_FILE = path.join(RUNTIME_DIR, 'connected.json');

const MAIN_OWNER        = '51907376960';
const EXTRA_OWNER       = '51966440866';
const LINKED_BOT_NUMBER = '51930108242';

const DEFAULT_SETTINGS = {
  prefix:          '.',
  ownerNumber:     [MAIN_OWNER, EXTRA_OWNER],
  botNumber:       LINKED_BOT_NUMBER,
  authFolder:      SESSION_DIR,
  pairingMode:     '',
  phoneNumber:     '',
  apiBaseUrl:      'https://dv-yer-api.online',
  apiKey:          'dvyer911840240197',
  antiPrivate:     false,
  groupOptions:    {},
  antiLinkWarnings:{},
};

// ─── Estado global ─────────────────────────────────────────────────────────────
let settings          = loadSettings();
let booting           = false;
let reconnectTimer    = null;
let reconnectAttempts = 0;
let socketToken       = 0;
let codeRequested     = false;

// ═══════════════════════════════════════════════════════════════════════════════
//  COLORES Y DISEÑO DE CONSOLA
// ═══════════════════════════════════════════════════════════════════════════════

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  italic:  '\x1b[3m',
  under:   '\x1b[4m',
  blink:   '\x1b[5m',
  // Colores de texto
  black:   '\x1b[30m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  // Colores brillantes
  bred:    '\x1b[91m',
  bgreen:  '\x1b[92m',
  byellow: '\x1b[93m',
  bblue:   '\x1b[94m',
  bmagenta:'\x1b[95m',
  bcyan:   '\x1b[96m',
  bwhite:  '\x1b[97m',
  // Fondos
  bgBlack: '\x1b[40m',
  bgRed:   '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgBlue:  '\x1b[44m',
  bgCyan:  '\x1b[46m',
};

/** Colorea texto */
function c(color, text) {
  return `${C[color] || ''}${text}${C.reset}`;
}

/** Combina dos estilos */
function cc(c1, c2, text) {
  return `${C[c1] || ''}${C[c2] || ''}${text}${C.reset}`;
}

/** Línea decorativa */
function line(style = 'single', color = 'cyan') {
  const chars = {
    single:  '─',
    double:  '═',
    star:    '✦',
    dot:     '·',
    wave:    '≈',
    dash:    '- ',
  };
  const ch = chars[style] || chars.single;
  const w  = style === 'star' || style === 'dot' ? 48 : 56;
  console.log(c(color, ch.repeat(Math.floor(w / ch.length))));
}

/** Log con timestamp */
function log(label, msg, color = 'cyan') {
  const now  = new Date();
  const time = now.toLocaleTimeString('es-PE', { hour12: false });
  const tag  = String(label).padEnd(9);
  const ico  = LABEL_ICONS[label] || '•';
  process.stdout.write(
    `${cc('dim','black',`[${time}]`)} ${c(color, `${ico} [${tag}]`)} ${msg}\n`
  );
}

const LABEL_ICONS = {
  SESSION:  '💾', BAILEYS: '⚙️ ', CODE:    '🔑', QR:     '📷',
  CMD:      '💬', AUTH:    '🔒', CLOSE:   '🔴', RECONECT:'🔄',
  CONFIG:   '⚙️ ', FATAL:   '💀', ERR:     '❌', INFO:   'ℹ️ ',
  CONNECT:  '🟢', INPUT:   '📝',
};

// ═══════════════════════════════════════════════════════════════════════════════
//  BANNERS
// ═══════════════════════════════════════════════════════════════════════════════

function printBanner() {
  const owners = getOwnerNumbers().join(', ');
  const bot    = normalizeNumber(settings.botNumber || '-') || '-';
  const prefix = String(settings.prefix || '.');

  console.log('');
  console.log(cc('bold','bmagenta','╔══════════════════════════════════════════════════════╗'));
  console.log(cc('bold','bmagenta','║') + cc('bold','bwhite','  ███╗   ███╗██╗██╗  ██╗██╗   ██╗    ██████╗  ██████╗ ████████╗') + cc('bold','bmagenta','  ║'));
  console.log(cc('bold','bmagenta','║') + cc('bold','bcyan', '  ████╗ ████║██║██║ ██╔╝██║   ██║    ██╔══██╗██╔═══██╗╚══██╔══╝') + cc('bold','bmagenta','  ║'));
  console.log(cc('bold','bmagenta','║') + cc('bold','bcyan', '  ██╔████╔██║██║█████╔╝ ██║   ██║    ██████╔╝██║   ██║   ██║   ') + cc('bold','bmagenta','  ║'));
  console.log(cc('bold','bmagenta','║') + cc('bold','bblue', '  ██║╚██╔╝██║██║██╔═██╗ ██║   ██║    ██╔══██╗██║   ██║   ██║   ') + cc('bold','bmagenta','  ║'));
  console.log(cc('bold','bmagenta','║') + cc('bold','bblue', '  ██║ ╚═╝ ██║██║██║  ██╗╚██████╔╝    ██████╔╝╚██████╔╝   ██║   ') + cc('bold','bmagenta','  ║'));
  console.log(cc('bold','bmagenta','║') + cc('dim', 'white', '  ╚═╝     ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝     ╚═════╝  ╚═════╝    ╚═╝   ') + cc('bold','bmagenta','  ║'));
  console.log(cc('bold','bmagenta','╠══════════════════════════════════════════════════════╣'));
  console.log(cc('bold','bmagenta','║') + cc('bold','bwhite','         ✦  F S O C I E T Y  —  W H A T S A P P  ✦       ') + cc('bold','bmagenta','  ║'));
  console.log(cc('bold','bmagenta','╠══════════════════════════════════════════════════════╣'));
  console.log(cc('bold','bmagenta','║') + c('byellow', `  👑  Owners  » ${owners.slice(0,37).padEnd(37)}`) + cc('bold','bmagenta','  ║'));
  console.log(cc('bold','bmagenta','║') + c('bcyan',   `  🤖  Bot     » ${bot.padEnd(37)}`) + cc('bold','bmagenta','  ║'));
  console.log(cc('bold','bmagenta','║') + c('bgreen',  `  ⌨️   Prefix  » ${prefix.padEnd(37)}`) + cc('bold','bmagenta','  ║'));
  console.log(cc('bold','bmagenta','╚══════════════════════════════════════════════════════╝'));
  console.log('');
}

function printConnected(me) {
  console.log('');
  console.log(cc('bold','bgreen', '╔══════════════════════════════════════════════════════╗'));
  console.log(cc('bold','bgreen', '║') + cc('bold','bwhite','                                                      ') + cc('bold','bgreen','║'));
  console.log(cc('bold','bgreen', '║') + cc('bold','bwhite','    ██████╗ ██╗  ██╗    ██████╗  ██████╗              ') + cc('bold','bgreen','║'));
  console.log(cc('bold','bgreen', '║') + cc('bold','bwhite','   ██╔═══██╗██║ ██╔╝   ██╔═══██╗██╔════╝              ') + cc('bold','bgreen','║'));
  console.log(cc('bold','bgreen', '║') + cc('bold','bwhite','   ██║   ██║█████╔╝    ██║   ██║██║                   ') + cc('bold','bgreen','║'));
  console.log(cc('bold','bgreen', '║') + cc('bold','bwhite','   ██║   ██║██╔═██╗    ██║   ██║██║                   ') + cc('bold','bgreen','║'));
  console.log(cc('bold','bgreen', '║') + cc('bold','bwhite','   ╚██████╔╝██║  ██╗   ╚██████╔╝╚██████╗              ') + cc('bold','bgreen','║'));
  console.log(cc('bold','bgreen', '║') + cc('dim',  'white','    ╚═════╝ ╚═╝  ╚═╝    ╚═════╝  ╚═════╝              ') + cc('bold','bgreen','║'));
  console.log(cc('bold','bgreen', '║') + cc('bold','bwhite','                                                      ') + cc('bold','bgreen','║'));
  console.log(cc('bold','bgreen', '╠══════════════════════════════════════════════════════╣'));
  console.log(cc('bold','bgreen', '║') + cc('bold','byellow',`  🤖  Bot     » ${String(me||'-').padEnd(37)}`) + cc('bold','bgreen','║'));
  console.log(cc('bold','bgreen', '║') + cc('bold','bcyan',  `  👑  Owners  » ${getOwnerNumbers().join(', ').slice(0,37).padEnd(37)}`) + cc('bold','bgreen','║'));
  console.log(cc('bold','bgreen', '║') + cc('bold','bmagenta',`  ⌨️   Prefix  » ${String(settings.prefix||'.').padEnd(37)}`) + cc('bold','bgreen','║'));
  console.log(cc('bold','bgreen', '╚══════════════════════════════════════════════════════╝'));
  console.log('');
}

function printCode(code) {
  const display = String(code || '').trim();
  // Formatear el código en bloques de 4 separados por guiones
  const formatted = display.match(/.{1,4}/g)?.join(' - ') || display;

  console.log('');
  console.log(cc('bold','byellow','╔══════════════════════════════════════════════════════╗'));
  console.log(cc('bold','byellow','║') + cc('bold','bwhite','       ✦  CÓDIGO DE VINCULACIÓN GENERADO  ✦            ') + cc('bold','byellow','║'));
  console.log(cc('bold','byellow','╠══════════════════════════════════════════════════════╣'));
  console.log(cc('bold','byellow','║') + '                                                      ' + cc('bold','byellow','║'));
  console.log(cc('bold','byellow','║') + cc('bold','bgreen',`          🔑  ${formatted.padEnd(40)}`) + cc('bold','byellow','║'));
  console.log(cc('bold','byellow','║') + '                                                      ' + cc('bold','byellow','║'));
  console.log(cc('bold','byellow','╠══════════════════════════════════════════════════════╣'));
  console.log(cc('bold','byellow','║') + cc('bold','bwhite','  📱  PASOS PARA VINCULAR:                            ') + cc('bold','byellow','║'));
  console.log(cc('bold','byellow','║') + c('bcyan','     1.  Abre WhatsApp en tu teléfono                ') + cc('bold','byellow','║'));
  console.log(cc('bold','byellow','║') + c('bcyan','     2.  Ve a Ajustes → Dispositivos vinculados       ') + cc('bold','byellow','║'));
  console.log(cc('bold','byellow','║') + c('bcyan','     3.  Toca "Vincular con número de teléfono"       ') + cc('bold','byellow','║'));
  console.log(cc('bold','byellow','║') + c('bcyan','     4.  Ingresa el código de arriba                  ') + cc('bold','byellow','║'));
  console.log(cc('bold','byellow','║') + c('bmagenta','  ⚡  El código expira en ~60 segundos               ') + cc('bold','byellow','║'));
  console.log(cc('bold','byellow','╚══════════════════════════════════════════════════════╝'));
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UTILIDADES
// ═══════════════════════════════════════════════════════════════════════════════

function normalizeNumber(value = '') {
  if (Array.isArray(value)) return value.map(normalizeNumber).filter(Boolean);
  return String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function getOwnerNumbers() {
  const raw  = settings.ownerNumbers || settings.ownerNumber || DEFAULT_SETTINGS.ownerNumber;
  const list = Array.isArray(raw) ? raw : [raw];
  return [...new Set([MAIN_OWNER, EXTRA_OWNER, ...list].map(normalizeNumber).filter(Boolean))];
}

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
      return { ...DEFAULT_SETTINGS };
    }
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    const merged = { ...DEFAULT_SETTINGS, ...(parsed || {}) };
    if (!Array.isArray(merged.ownerNumber)) merged.ownerNumber = [merged.ownerNumber].filter(Boolean);
    if (!merged.ownerNumber.includes(EXTRA_OWNER)) merged.ownerNumber.push(EXTRA_OWNER);
    if (!merged.ownerNumber.includes(MAIN_OWNER))  merged.ownerNumber.unshift(MAIN_OWNER);
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(patch = {}) {
  settings = { ...DEFAULT_SETTINGS, ...settings, ...(patch || {}) };
  if (!Array.isArray(settings.ownerNumber)) settings.ownerNumber = [settings.ownerNumber].filter(Boolean);
  if (!settings.ownerNumber.includes(MAIN_OWNER))  settings.ownerNumber.unshift(MAIN_OWNER);
  if (!settings.ownerNumber.includes(EXTRA_OWNER)) settings.ownerNumber.push(EXTRA_OWNER);
  settings.ownerNumber = [...new Set(settings.ownerNumber.map(normalizeNumber).filter(Boolean))];
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return settings;
}

function isOwner(jid = '') {
  const sender    = normalizeNumber(jid);
  const botNumber = normalizeNumber(settings.botNumber || '');
  return Boolean(sender && (getOwnerNumbers().includes(sender) || sender === botNumber));
}

function getGroupOptions(chatId = '') {
  const all = settings?.groupOptions && typeof settings.groupOptions === 'object'
    ? settings.groupOptions : {};
  return all[chatId] || {};
}

function normalizeUserJid(jid = '') {
  const user = String(jid || '').split(':')[0];
  if (!user) return '';
  if (user.endsWith('@s.whatsapp.net')) return user;
  return `${user.replace(/@.+$/, '')}@s.whatsapp.net`;
}

function getMessageText(msg = {}) {
  const m = msg.message || {};
  const fromText =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption || '';
  if (fromText) return fromText;

  const selectedId =
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.templateButtonReplyMessage?.selectedId || '';
  if (selectedId) return selectedId;

  const paramsJson = m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (paramsJson) {
    try { const p = JSON.parse(paramsJson); return p?.id || p?.selectedId || ''; } catch {}
  }
  return '';
}

function getPrefixList() {
  const raw = settings.prefix || '.';
  if (Array.isArray(raw)) return raw.map((x) => String(x || '').trim()).filter(Boolean);
  return [String(raw || '.').trim() || '.'];
}

function getUsedPrefix(body = '') {
  return getPrefixList().find((p) => body.startsWith(p)) || '';
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clearAuthFolder() {
  try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
  try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch {}
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectAttempts += 1;
  const waitMs = Math.min(30000, 3000 + reconnectAttempts * 2000);
  log('RECONECT', `Reintentando en ${c('byellow', `${waitMs / 1000}s`)}... ${c('dim', `(intento #${reconnectAttempts})`)}`, 'yellow');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot().catch((e) => log('FATAL', String(e?.message || e), 'red'));
  }, waitMs);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MENÚ DE VINCULACIÓN — SIEMPRE se ejecuta si no hay sesión
// ═══════════════════════════════════════════════════════════════════════════════

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (ans) => { rl.close(); resolve(String(ans || '').trim()); });
  });
}

/**
 * Muestra el menú y espera que el usuario elija.
 * Siempre limpia la configuración anterior antes de preguntar.
 * Retorna { mode: 'qr'|'code', phone: string }
 */
async function choosePairingMode() {
  // Limpiar configuración previa para forzar selección fresca
  saveSettings({ pairingMode: '', phoneNumber: '' });

  console.log('');
  console.log(cc('bold','bmagenta','╔══════════════════════════════════════════════════════╗'));
  console.log(cc('bold','bmagenta','║') + cc('bold','bwhite','         ✦  MIKU-BOT  —  TIPO DE CONEXIÓN  ✦          ') + cc('bold','bmagenta','║'));
  console.log(cc('bold','bmagenta','╠══════════════════════════════════════════════════════╣'));
  console.log(cc('bold','bmagenta','║') + '                                                      ' + cc('bold','bmagenta','║'));
  console.log(cc('bold','bmagenta','║') + cc('bold','bcyan','  ┌─────────────────────────────────────────────────┐  ') + cc('bold','bmagenta','║'));
  console.log(cc('bold','bmagenta','║') + cc('bold','bcyan','  │                                                 │  ') + cc('bold','bmagenta','║'));
  console.log(cc('bold','bmagenta','║') + cc('bold','bcyan','  │') + cc('bold','bgreen','  【 1 】  🔑  Código de vinculación (número)     ') + cc('bold','bcyan','│  ') + cc('bold','bmagenta','║'));
  console.log(cc('bold','bmagenta','║') + cc('bold','bcyan','  │') + cc('dim',  'white','         Ingresa tu número y obtén un código      ') + cc('bold','bcyan','│  ') + cc('bold','bmagenta','║'));
  console.log(cc('bold','bmagenta','║') + cc('bold','bcyan','  │') + cc('dim',  'white','         para vincular desde WhatsApp.            ') + cc('bold','bcyan','│  ') + cc('bold','bmagenta','║'));
  console.log(cc('bold','bmagenta','║') + cc('bold','bcyan','  │                                                 │  ') + cc('bold','bmagenta','║'));
  console.log(cc('bold','bmagenta','║') + cc('bold','bcyan','  │') + cc('bold','byellow','  【 2 】  📷  Código QR (escanear)               ') + cc('bold','bcyan','│  ') + cc('bold','bmagenta','║'));
  console.log(cc('bold','bmagenta','║') + cc('bold','bcyan','  │') + cc('dim',  'white','         Escanea el QR con WhatsApp               ') + cc('bold','bcyan','│  ') + cc('bold','bmagenta','║'));
  console.log(cc('bold','bmagenta','║') + cc('bold','bcyan','  │') + cc('dim',  'white','         desde Dispositivos vinculados.           ') + cc('bold','bcyan','│  ') + cc('bold','bmagenta','║'));
  console.log(cc('bold','bmagenta','║') + cc('bold','bcyan','  │                                                 │  ') + cc('bold','bmagenta','║'));
  console.log(cc('bold','bmagenta','║') + cc('bold','bcyan','  └─────────────────────────────────────────────────┘  ') + cc('bold','bmagenta','║'));
  console.log(cc('bold','bmagenta','║') + '                                                      ' + cc('bold','bmagenta','║'));
  console.log(cc('bold','bmagenta','╚══════════════════════════════════════════════════════╝'));
  console.log('');

  // Leer opción 1 o 2 — reintentar si es inválida
  let choice = '';
  while (choice !== '1' && choice !== '2') {
    choice = await ask(cc('bold','bgreen','  ➜  Elige una opción [1 o 2]: '));
    if (choice !== '1' && choice !== '2') {
      log('INPUT', `Opción "${c('bred', choice)}" inválida. Escribe ${c('bgreen','1')} o ${c('byellow','2')}.`, 'red');
    }
  }

  if (choice === '1') {
    // ── Modo código ─────────────────────────────────────────────────────────
    console.log('');
    console.log(cc('bold','bcyan','╔══════════════════════════════════════════════════════╗'));
    console.log(cc('bold','bcyan','║') + cc('bold','bwhite','       ✦  VINCULACIÓN POR CÓDIGO DE NÚMERO  ✦          ') + cc('bold','bcyan','║'));
    console.log(cc('bold','bcyan','╠══════════════════════════════════════════════════════╣'));
    console.log(cc('bold','bcyan','║') + c('bwhite','  ℹ️   Ingresa tu número CON código de país,              ') + cc('bold','bcyan','║'));
    console.log(cc('bold','bcyan','║') + c('bwhite','       sin el signo "+" al inicio.                        ') + cc('bold','bcyan','║'));
    console.log(cc('bold','bcyan','║') + c('byellow','       Ejemplo: 51912345678  (Perú)                       ') + cc('bold','bcyan','║'));
    console.log(cc('bold','bcyan','║') + c('byellow','                549876543210 (Argentina)                  ') + cc('bold','bcyan','║'));
    console.log(cc('bold','bcyan','╚══════════════════════════════════════════════════════╝'));
    console.log('');

    let clean = '';
    while (!clean || clean.length < 8) {
      const phone = await ask(cc('bold','bgreen','  ➜  Número (con código de país): '));
      clean = normalizeNumber(phone);
      if (!clean || clean.length < 8) {
        log('INPUT', `Número "${c('bred', phone)}" inválido. Intenta de nuevo.`, 'red');
      }
    }

    saveSettings({ pairingMode: 'code', phoneNumber: clean });

    console.log('');
    console.log(cc('bold','bgreen','╔══════════════════════════════════════════════════════╗'));
    console.log(cc('bold','bgreen','║') + cc('bold','bwhite','  ✅  Configuración guardada — modo CÓDIGO             ') + cc('bold','bgreen','║'));
    console.log(cc('bold','bgreen','╠══════════════════════════════════════════════════════╣'));
    console.log(cc('bold','bgreen','║') + c('bcyan',   `  📱  Número  » ${clean.padEnd(37)}`) + cc('bold','bgreen','║'));
    console.log(cc('bold','bgreen','║') + c('byellow', `  🔑  Modo    » Código de vinculación${''.padEnd(20)}`) + cc('bold','bgreen','║'));
    console.log(cc('bold','bgreen','╚══════════════════════════════════════════════════════╝'));
    console.log('');

    return { mode: 'code', phone: clean };

  } else {
    // ── Modo QR ──────────────────────────────────────────────────────────────
    saveSettings({ pairingMode: 'qr', phoneNumber: '' });

    console.log('');
    console.log(cc('bold','byellow','╔══════════════════════════════════════════════════════╗'));
    console.log(cc('bold','byellow','║') + cc('bold','bwhite','         ✦  VINCULACIÓN POR CÓDIGO QR  ✦              ') + cc('bold','byellow','║'));
    console.log(cc('bold','byellow','╠══════════════════════════════════════════════════════╣'));
    console.log(cc('bold','byellow','║') + c('bwhite','  📷  El código QR aparecerá en la consola.           ') + cc('bold','byellow','║'));
    console.log(cc('bold','byellow','║') + c('bcyan', '  1.  Abre WhatsApp → Dispositivos vinculados         ') + cc('bold','byellow','║'));
    console.log(cc('bold','byellow','║') + c('bcyan', '  2.  Toca "Escanear código QR"                       ') + cc('bold','byellow','║'));
    console.log(cc('bold','byellow','║') + c('bcyan', '  3.  Apunta la cámara al QR en consola               ') + cc('bold','byellow','║'));
    console.log(cc('bold','byellow','╚══════════════════════════════════════════════════════╝'));
    console.log('');

    return { mode: 'qr', phone: '' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SOLICITAR CÓDIGO CON REINTENTOS ROBUSTOS
// ═══════════════════════════════════════════════════════════════════════════════

async function requestCodeWithRetry(sock, number) {
  const clean = normalizeNumber(number);

  for (let i = 1; i <= 12; i++) {
    try {
      // Primer intento: sin espera extra (el socket ya está listo).
      // Reintentos: delay creciente para no saturar WA.
      const waitSec = i === 1 ? 0 : Math.min(30, 4 * i);
      if (waitSec > 0) {
        log('CODE', `Intento ${c('byellow', `${i}/12`)} — esperando ${waitSec}s antes de solicitar...`, 'yellow');
        await delay(waitSec * 1000);
      } else {
        log('CODE', `Intento ${c('byellow', `${i}/12`)} — solicitando código ahora...`, 'yellow');
      }

      const code = await sock.requestPairingCode(clean);
      if (code && String(code).trim()) return String(code).trim();
      throw new Error('Código vacío recibido');

    } catch (e) {
      const status    = Number(e?.output?.statusCode || e?.data?.statusCode || 0);
      const msg       = String(e?.message || '').toLowerCase();
      const isRetry   = [0, 408, 428, 429, 500, 503].includes(status) ||
                        msg.includes('timeout') || msg.includes('timed out') ||
                        msg.includes('network')  || msg.includes('vacío');

      log('CODE', `Intento ${i}/12 → ${c('bred', status || 'N/A')} — ${String(e?.message || '').slice(0, 50)}`, 'red');

      if (!isRetry || i === 12) throw e;
      log('CODE', `Reintentando en ${(i + 1) * 2}s...`, 'yellow');
    }
  }
  throw new Error('No se obtuvo código tras 12 intentos.');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  INICIO DEL BOT
// ═══════════════════════════════════════════════════════════════════════════════

async function startBot() {
  if (booting) return;
  booting     = true;
  socketToken += 1;
  const token = socketToken;

  try {
    saveSettings({ ownerNumber: getOwnerNumbers(), authFolder: SESSION_DIR });
    printBanner();
    reloadCommands();

    if (!String(settings.apiBaseUrl || '').trim()) {
      saveSettings({ apiBaseUrl: DEFAULT_SETTINGS.apiBaseUrl, apiKey: DEFAULT_SETTINGS.apiKey });
    }

    fs.mkdirSync(SESSION_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const isRegistered = Boolean(state?.creds?.registered);

    log('SESSION', isRegistered
      ? `Sesión ${c('bgreen','existente')} — saltando vinculación.`
      : `Sin sesión — ${c('byellow','iniciando vinculación')}...`,
      isRegistered ? 'green' : 'yellow'
    );

    // ── SIEMPRE preguntar modo si no hay sesión ──────────────────────────────
    let pairingResult = { mode: 'qr', phone: '' };

    if (!isRegistered) {
      pairingResult = await choosePairingMode();
      codeRequested = false;
    }

    const isCodeMode = !isRegistered && pairingResult.mode === 'code';
    const isQrMode   = !isCodeMode;

    const { version } = await fetchLatestBaileysVersion();
    log('BAILEYS', `Versión ${c('bcyan', version.join('.'))} — Modo: ${c('bold', isCodeMode ? c('bgreen','CÓDIGO') : c('byellow','QR'))}`, 'blue');

    // ── Crear socket ────────────────────────────────────────────────────────
    const sock = makeWASocket({
      version,
      printQRInTerminal: isQrMode && !isRegistered,  // QR solo si el usuario eligió QR
      logger:            pino({ level: 'silent' }),
      auth:              state,
      browser:           ['MIKU-BOT', 'Chrome', '1.0.0'],
      connectTimeoutMs:  60_000,
      keepAliveIntervalMs: 25_000,
      retryRequestDelayMs: 2_000,
    });

    sock.ev.on('creds.update', saveCreds);

    // ── Pedir código AQUÍ — fuera del connection.update, esperando que
    //    el socket alcance el servidor WA antes de hacer la petición ──────────
    if (isCodeMode && !codeRequested) {
      codeRequested = true;

      // Esperar a que Baileys establezca la conexión TCP con WhatsApp.
      // El socket dispara connection.update con connection='connecting'
      // (o simplemente empieza a funcionar) en los primeros segundos.
      // Esperamos un mínimo fijo + un Promise que resuelve al primer
      // connection.update para asegurarnos que el handshake WA está en curso.
      const socketReady = new Promise((resolve) => {
        const off = sock.ev.on('connection.update', (u) => {
          // Cualquier update (qr, connecting, open) indica que el socket
          // ya habló con los servidores de WhatsApp.
          if (u.qr || u.connection) {
            // Baileys no tiene un método "off" limpio en todos los forks;
            // usamos un flag para ignorar la llamada posterior.
            resolve();
          }
        });
        // Timeout de seguridad: si en 12s no llega ningún update, igual continuamos.
        setTimeout(resolve, 12_000);
      });

      log('CODE', `Esperando que el socket alcance servidores WA...`, 'yellow');
      await socketReady;
      // Pausa adicional para que Baileys complete el handshake interno.
      await delay(3000);
      if (token !== socketToken) return;

      log('CODE', `Solicitando código para ${c('bcyan', pairingResult.phone)}...`, 'yellow');
      try {
        const code = await requestCodeWithRetry(sock, pairingResult.phone);
        printCode(code);
      } catch (e) {
        codeRequested = false;
        log('CODE', `Error definitivo: ${c('bred', String(e?.message || e).slice(0, 80))}`, 'red');
        log('CODE', 'Limpiando sesión y reiniciando vinculación...', 'yellow');
        clearAuthFolder();
        saveSettings({ pairingMode: '', phoneNumber: '' });
        await delay(2000);
        scheduleReconnect();
      }
    }

    // ── connection.update ────────────────────────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
      if (token !== socketToken) return;

      const { connection, lastDisconnect, qr } = update;

      // QR disponible
      if (qr && isQrMode && !isRegistered) {
        console.log('');
        line('double', 'cyan');
        log('QR', cc('bold','bcyan','Código QR listo — escanea con WhatsApp'), 'cyan');
        log('QR', c('dim','  Ruta: Ajustes → Dispositivos vinculados → Escanear QR'), 'dim');
        line('double', 'cyan');
      }

      // ── Conectado ────────────────────────────────────────────────────────
      if (connection === 'open') {
        reconnectAttempts = 0;
        const me = normalizeNumber(sock?.user?.id || '');

        if (me) saveSettings({ botNumber: me, pairingMode: '', phoneNumber: '' });

        printConnected(me);

        try {
          fs.mkdirSync(RUNTIME_DIR, { recursive: true });
          fs.writeFileSync(CONNECTED_FILE, JSON.stringify({
            connected: true,
            at:        Date.now(),
            owners:    getOwnerNumbers(),
            botNumber: me,
          }, null, 2));
        } catch {}

        return;
      }

      // ── Desconectado ─────────────────────────────────────────────────────
      if (connection === 'close') {
        const err        = lastDisconnect?.error;
        const statusCode = new Boom(err)?.output?.statusCode || 0;
        const reason     = String(err?.message || 'desconocida').slice(0, 60);

        line('double', 'red');
        log('CLOSE', `Código ${c('bred', statusCode)} — ${c('dim', reason)}`, 'red');

        if (
          statusCode === DisconnectReason.loggedOut ||
          statusCode === 401 ||
          statusCode === 440
        ) {
          log('AUTH', 'Sesión cerrada remotamente. Limpiando y reiniciando...', 'red');
          clearAuthFolder();
          saveSettings({ pairingMode: '', phoneNumber: '' });
          codeRequested = false;
        }

        scheduleReconnect();
      }
    });

    // ── messages.upsert ──────────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (token !== socketToken) return;
      if (type !== 'notify') return;

      const m = messages?.[0];
      if (!m) return;

      const from      = m.key.remoteJid;
      const sender    = m.key.participant || from;
      const body      = getMessageText(m).trim();
      const isGroup   = String(from || '').endsWith('@g.us');
      const groupOpts = isGroup ? getGroupOptions(from) : {};

      let metadata      = null;
      let senderIsAdmin = false;

      if (isGroup && (groupOpts.antilink || groupOpts.modoadmin)) {
        try {
          metadata      = await sock.groupMetadata(from);
          const p       = (metadata?.participants || []).find((x) => x.id === sender);
          senderIsAdmin = Boolean(p?.admin);
        } catch {}
      }

      if (!isGroup && settings.antiPrivate && !isOwner(sender)) return;

      // ── Anti-link ────────────────────────────────────────────────────────
      if (
        isGroup &&
        groupOpts.antilink &&
        /(chat\.whatsapp\.com\/|whatsapp\.com\/channel\/)/i.test(body)
      ) {
        if (!isOwner(sender) && !senderIsAdmin) {
          const userJid    = normalizeUserJid(sender);
          const allWarns   = typeof settings.antiLinkWarnings === 'object' ? settings.antiLinkWarnings : {};
          const groupWarns = typeof allWarns[from] === 'object' ? allWarns[from] : {};
          const next       = Number(groupWarns[userJid] || 0) + 1;

          groupWarns[userJid] = next;
          allWarns[from]      = groupWarns;
          saveSettings({ antiLinkWarnings: allWarns });

          try { await sock.sendMessage(from, { delete: m.key }); } catch {}

          if (next >= 3) {
            delete groupWarns[userJid];
            allWarns[from] = groupWarns;
            saveSettings({ antiLinkWarnings: allWarns });
            await sock.sendMessage(from, {
              text: `🚫 @${normalizeNumber(sender)} alcanzó *3/3 advertencias* y será expulsado.`,
              mentions: [sender],
            }, { quoted: m });
            try { await sock.groupParticipantsUpdate(from, [userJid], 'remove'); } catch {}
          } else {
            await sock.sendMessage(from, {
              text: `⚠️ @${normalizeNumber(sender)} enlace detectado. Advertencia: *${next}/3*`,
              mentions: [sender],
            }, { quoted: m });
          }
          return;
        }
      }

      // ── Procesar comando ─────────────────────────────────────────────────
      const usedPrefix  = getUsedPrefix(body);
      if (!usedPrefix) return;

      const args        = body.slice(usedPrefix.length).trim().split(/\s+/);
      const commandName = String(args.shift() || '').toLowerCase();
      if (!commandName) return;

      const cmd = global.comandos?.get(commandName);
      if (!cmd) return;

      const place         = isGroup ? 'GRUPO' : 'PRIVADO';
      const senderNum     = normalizeNumber(sender) || '???';
      const senderIsOwner = isOwner(sender);

      log('CMD', `${cc('bold','bgreen', usedPrefix + commandName)} ${c('dim', `[${place}]`)} ${c('byellow', senderNum)}`, 'cyan');

      if (cmd.isOwner && !senderIsOwner) {
        await sock.sendMessage(from, { text: '❌ Solo el owner puede usar este comando.' }, { quoted: m });
        return;
      }

      if (cmd.group && !isGroup) {
        await sock.sendMessage(from, { text: '❌ Este comando solo funciona en grupos.' }, { quoted: m });
        return;
      }

      if (cmd.admin) {
        if (!isGroup) {
          await sock.sendMessage(from, { text: '❌ Este comando requiere grupo y admin.' }, { quoted: m });
          return;
        }
        if (!metadata) {
          try {
            metadata      = await sock.groupMetadata(from);
            const p       = (metadata?.participants || []).find((x) => x.id === sender);
            senderIsAdmin = Boolean(p?.admin);
          } catch {}
        }
        if (!senderIsOwner && !senderIsAdmin) {
          await sock.sendMessage(from, { text: '❌ Solo administradores pueden usar este comando.' }, { quoted: m });
          return;
        }
      }

      if (isGroup && groupOpts.modoadmin && !senderIsOwner && !senderIsAdmin) return;

      try {
        await cmd.run(sock, m, args, from, senderIsOwner, {
          commandName,
          settings,
          saveSettings: (patch = {}) => saveSettings(patch),
          prefix:       usedPrefix,
          prefixes:     getPrefixList(),
          axios,
          isOwner,
          ownerNumbers: getOwnerNumbers(),
        });
      } catch (err) {
        log('ERR', `${c('bred', commandName)}: ${String(err?.message || err).slice(0, 100)}`, 'red');
        await sock.sendMessage(from, {
          text: `❌ *Error ejecutando el comando.*\n_Revisa la consola del bot._`,
        }, { quoted: m });
      }
    });

  } catch (err) {
    log('FATAL', c('bred', String(err?.message || err)), 'red');
    scheduleReconnect();
  } finally {
    booting = false;
  }
}

// ─── Inicio ────────────────────────────────────────────────────────────────────
startBot().catch((err) => log('FATAL', c('bred', String(err?.message || err)), 'red'));
