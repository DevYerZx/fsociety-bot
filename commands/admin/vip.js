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
  ensureVipFile();
  fs.writeFileSync(VIP_FILE, JSON.stringify(data, null, 2));
}

function normalizeNumber(x) {
  return String(x || "").replace(/[^\d]/g, "").trim();
}

function getSenderNumber(msg, from) {
  const jid = msg?.key?.participant || from;
  return String(jid || "").split("@")[0];
}

function isOwner(senderNumber, settings) {
  const owners = Array.isArray(settings?.ownerNumbers)
    ? settings.ownerNumbers
    : (typeof settings?.ownerNumber === "string" ? [settings.ownerNumber] : []);
  return owners.map(normalizeNumber).includes(normalizeNumber(senderNumber));
}

// Parse: 7d, 12h, 30m, 20s
function parseDurationToMs(str) {
  const s = String(str || "").trim().toLowerCase();
  const m = s.match(/^(\d+)(s|m|h|d)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}

function fmtMs(ms) {
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function cleanExpired(data) {
  const now = Date.now();
  for (const [num, info] of Object.entries(data.users)) {
    if (!info) {
      delete data.users[num];
      continue;
    }
    if (typeof info.expiresAt === "number" && now >= info.expiresAt) {
      delete data.users[num];
    }
    if (typeof info.usesLeft === "number" && info.usesLeft <= 0) {
      delete data.users[num];
    }
  }
}

export default {
  name: "vip",
  command: ["vip"],
  category: "admin",
  description: "Administra VIP con vencimiento y límite (solo owner)",

  run: async ({ sock, msg, from, args = [], settings }) => {
    try {
      const sender = getSenderNumber(msg, from);
      if (!isOwner(sender, settings)) {
        return sock.sendMessage(from, { text: "👑 Solo el owner puede usar este comando." }, { quoted: msg });
      }

      const sub = String(args[0] || "").toLowerCase();
      const data = readVip();
      cleanExpired(data);
      saveVip(data);

      // Ayuda
      if (!sub) {
        return sock.sendMessage(
          from,
          {
            text:
              `🔒 *Panel VIP*\n\n` +
              `➕ Dar VIP:\n` +
              `• *.vip add 519xxxxxxx 7d 50*\n` +
              `   (duración: 7d/12h/30m/20s, usos: 50)\n\n` +
              `➖ Quitar VIP:\n` +
              `• *.vip del 519xxxxxxx*\n\n` +
              `📋 Ver:\n` +
              `• *.vip list*\n` +
              `• *.vip check 519xxxxxxx*\n`,
          },
          { quoted: msg }
        );
      }

      // Listar
      if (sub === "list") {
        const users = Object.entries(data.users);
        if (!users.length) {
          return sock.sendMessage(from, { text: "📋 VIP actuales: (vacío)" }, { quoted: msg });
        }

        const now = Date.now();
        const lines = users
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([num, info]) => {
            const left = typeof info.usesLeft === "number" ? info.usesLeft : "∞";
            const exp = typeof info.expiresAt === "number" ? fmtMs(info.expiresAt - now) : "∞";
            return `• ${num} — usos: *${left}* — vence en: *${exp}*`;
          });

        return sock.sendMessage(from, { text: `📋 *VIP actuales:*\n\n${lines.join("\n")}` }, { quoted: msg });
      }

      // Check
      if (sub === "check") {
        const num = normalizeNumber(args[1]);
        if (!num) return sock.sendMessage(from, { text: "⚠️ Uso: *.vip check 519xxxxxxx*" }, { quoted: msg });

        const info = data.users[num];
        if (!info) return sock.sendMessage(from, { text: `❌ ${num} no es VIP.` }, { quoted: msg });

        const now = Date.now();
        const left = typeof info.usesLeft === "number" ? info.usesLeft : "∞";
        const exp = typeof info.expiresAt === "number" ? fmtMs(info.expiresAt - now) : "∞";

        return sock.sendMessage(from, { text: `✅ ${num} es VIP\n• usos: *${left}*\n• vence en: *${exp}*` }, { quoted: msg });
      }

      // Add: .vip add <num> <dur> <uses>
      if (sub === "add") {
        const num = normalizeNumber(args[1]);
        const durStr = args[2];
        const usesStr = args[3];

        if (!num || !durStr || !usesStr) {
          return sock.sendMessage(
            from,
            { text: "⚠️ Uso: *.vip add 519xxxxxxx 7d 50*" },
            { quoted: msg }
          );
        }

        const durMs = parseDurationToMs(durStr);
        const uses = parseInt(usesStr, 10);

        if (!durMs || !Number.isFinite(uses) || uses <= 0) {
          return sock.sendMessage(
            from,
            { text: "⚠️ Duración inválida (ej: 7d/12h/30m/20s) o usos inválidos." },
            { quoted: msg }
          );
        }

        data.users[num] = {
          expiresAt: Date.now() + durMs,
          usesLeft: uses,
        };

        saveVip(data);
        return sock.sendMessage(
          from,
          { text: `✅ VIP agregado: *${num}*\n⏳ vence en: *${durStr}*\n🎟️ usos: *${uses}*` },
          { quoted: msg }
        );
      }

      // Del
      if (sub === "del" || sub === "remove" || sub === "rm") {
        const num = normalizeNumber(args[1]);
        if (!num) return sock.sendMessage(from, { text: "⚠️ Uso: *.vip del 519xxxxxxx*" }, { quoted: msg });

        delete data.users[num];
        saveVip(data);

        return sock.sendMessage(from, { text: `🗑️ VIP eliminado: *${num}*` }, { quoted: msg });
      }

      return sock.sendMessage(from, { text: "⚠️ Subcomando inválido. Usa: *.vip*" }, { quoted: msg });
    } catch (e) {
      console.error("[VIP] Error:", e);
      return sock.sendMessage(from, { text: "❌ Error en VIP. Revisa consola." }, { quoted: msg });
    }
  },
};
