import fs from "fs";
import path from "path";

const VIP_FILE = path.join(process.cwd(), "settings", "vip.json");

function ensureVipFile() {
  const dir = path.dirname(VIP_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(VIP_FILE)) fs.writeFileSync(VIP_FILE, JSON.stringify({ users: {} }, null, 2));
}

function readVip() {
  ensureVipFile();
  try {
    const raw = fs.readFileSync(VIP_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (!data.users || typeof data.users !== "object") data.users = {};
    return data;
  } catch {
    return { users: {} };
  }
}

function saveVip(data) {
  try {
    fs.writeFileSync(VIP_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

function normalizeNumber(x) {
  // "51907376960@s.whatsapp.net" -> "51907376960"
  // "51907376960:18@s.whatsapp.net" -> "51907376960"
  // "+51907376960" -> "51907376960"
  return String(x || "")
    .split("@")[0]
    .split(":")[0]
    .replace(/[^\d]/g, "")
    .trim();
}

function getSenderNumber(msg, from) {
  // En grupo: participant, en privado: remoteJid
  const jid = msg?.key?.participant || msg?.participant || msg?.key?.remoteJid || from;
  return normalizeNumber(jid);
}

function getOwners(settings) {
  const owners = [];
  if (Array.isArray(settings?.ownerNumbers)) owners.push(...settings.ownerNumbers);
  if (typeof settings?.ownerNumber === "string") owners.push(settings.ownerNumber);
  if (Array.isArray(settings?.owners)) owners.push(...settings.owners);
  if (typeof settings?.owner === "string") owners.push(settings.owner);
  // también por si guardaste botNumber como owner (a veces)
  if (typeof settings?.botNumber === "string") owners.push(settings.botNumber);

  return owners.map(normalizeNumber).filter(Boolean);
}

function isOwner({ msg, from, settings }) {
  const sender = getSenderNumber(msg, from);
  const owners = getOwners(settings);
  return owners.includes(sender);
}

/**
 * ✅ Verifica VIP y descuenta 1 uso
 * - Owner: ilimitado (no revisa vencimiento ni usos)
 * - VIP: revisa expiresAt y usesLeft
 */
export function checkVipAndConsume({ msg, from, settings }) {
  // 👑 OWNER = ILIMITADO
  if (isOwner({ msg, from, settings })) {
    return { ok: true, owner: true, unlimited: true };
  }

  const sender = getSenderNumber(msg, from);
  const data = readVip();
  const info = data.users[sender];

  if (!info) return { ok: false, reason: "no_vip" };

  const now = Date.now();

  // ⏳ vencido
  if (typeof info.expiresAt === "number" && now >= info.expiresAt) {
    delete data.users[sender];
    saveVip(data);
    return { ok: false, reason: "expired" };
  }

  // 🎟️ sin usos
  if (typeof info.usesLeft === "number") {
    if (info.usesLeft <= 0) {
      delete data.users[sender];
      saveVip(data);
      return { ok: false, reason: "limit" };
    }

    // consumir 1 uso
    info.usesLeft -= 1;
    data.users[sender] = info;
    saveVip(data);
  }

  return { ok: true, owner: false, usesLeft: info.usesLeft, expiresAt: info.expiresAt };
}

// (Opcional) export por si quieres mostrar tu número detectado
export function debugWhoAmI({ msg, from }) {
  return getSenderNumber(msg, from);
}

