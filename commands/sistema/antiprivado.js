import fs from "fs";
import path from "path";

const DB_DIR = path.join(process.cwd(), "database");
const FILE = path.join(DB_DIR, "antiprivado.json");

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

function safeParse(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
  } catch {
    return fallback;
  }
}

function loadState() {
  try {
    if (!fs.existsSync(FILE)) return { enabled: false };
    const parsed = safeParse(fs.readFileSync(FILE, "utf-8"), {});
    return {
      enabled: Boolean(parsed?.enabled),
    };
  } catch {
    return { enabled: false };
  }
}

function saveState(state) {
  fs.writeFileSync(
    FILE,
    JSON.stringify(
      {
        enabled: Boolean(state?.enabled),
        updatedAt: Date.now(),
      },
      null,
      2
    )
  );
}

function normalizeAction(raw = "") {
  const value = String(raw || "").trim().toLowerCase();

  if (["on", "encender", "activar", "enable", "1", "si"].includes(value)) return "on";
  if (["off", "apagar", "desactivar", "disable", "0", "no"].includes(value)) return "off";
  if (["estado", "status", "info"].includes(value)) return "status";
  return "";
}

function getPrefixes(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
  }

  const single = String(settings?.prefix || ".").trim();
  return single ? [single] : ["."];
}

function getPrimaryPrefix(settings) {
  return getPrefixes(settings)[0] || ".";
}

function normalizeId(value = "") {
  return String(value || "")
    .trim()
    .split("@")[0]
    .split(":")[0]
    .replace(/\s+/g, "");
}

function normalizeDigits(value = "") {
  return normalizeId(value).replace(/[^\d]/g, "");
}

function buildAllowedPrivateIds({ settings, sock }) {
  const allowed = new Set();

  const add = (value) => {
    const normalized = normalizeId(value);
    const digits = normalizeDigits(value);
    if (normalized) allowed.add(normalized);
    if (digits) allowed.add(digits);
  };

  add(settings?.ownerNumber);
  add(settings?.ownerLid);
  add(settings?.botNumber);
  add(sock?.user?.id);

  for (const value of settings?.ownerNumbers || []) {
    add(value);
  }

  for (const value of settings?.ownerLids || []) {
    add(value);
  }

  return allowed;
}

function isAllowedPrivateSender({ msg, sender, senderPhone, senderLid, settings, sock, esOwner }) {
  if (esOwner) return true;
  if (msg?.key?.fromMe) return true;

  const allowedIds = buildAllowedPrivateIds({ settings, sock });
  const candidates = [sender, senderPhone, senderLid, msg?.key?.participant, msg?.key?.remoteJid];

  return candidates.some((value) => {
    const normalized = normalizeId(value);
    const digits = normalizeDigits(value);
    return (normalized && allowedIds.has(normalized)) || (digits && allowedIds.has(digits));
  });
}

const state = loadState();

export default {
  name: "antiprivado",
  command: ["antiprivado", "privateoff", "privadoff"],
  category: "sistema",
  description: "Bloquea respuestas en privado para no-owner.",
  ownerOnly: true,

  run: async ({ sock, msg, from, args = [], settings }) => {
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const prefix = getPrimaryPrefix(settings);
    const action = normalizeAction(args[0]);

    if (!action) {
      return sock.sendMessage(
        from,
        {
          text:
            `🔐 *ANTIPRIVADO*\n\n` +
            `Estado: *${state.enabled ? "ON ✅" : "OFF ❌"}*\n\n` +
            `Uso:\n` +
            `• ${prefix}antiprivado on\n` +
            `• ${prefix}antiprivado off\n` +
            `• ${prefix}antiprivado estado`,
          title: "FSOCIETY BOT",
          subtitle: "Control privado",
          footer: state.enabled ? "Privado bloqueado" : "Privado permitido",
          interactiveButtons: [
            {
              name: "single_select",
              buttonParamsJson: JSON.stringify({
                title: "Configurar antiprivado",
                sections: [
                  {
                    title: "Acciones",
                    rows: [
                      {
                        header: "ON",
                        title: "Activar antiprivado",
                        description: "Bloquea privados para no-owner.",
                        id: `${prefix}antiprivado on`,
                      },
                      {
                        header: "OFF",
                        title: "Desactivar antiprivado",
                        description: "Permite privados para todos.",
                        id: `${prefix}antiprivado off`,
                      },
                      {
                        header: "ESTADO",
                        title: "Ver estado",
                        description: "Muestra estado actual.",
                        id: `${prefix}antiprivado estado`,
                      },
                    ],
                  },
                ],
              }),
            },
          ],
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "status") {
      return sock.sendMessage(
        from,
        {
          text:
            `🔐 *ANTIPRIVADO*\n\n` +
            `Estado actual: *${state.enabled ? "ON ✅" : "OFF ❌"}*`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (action === "on") {
      if (state.enabled) {
        return sock.sendMessage(
          from,
          {
            text: "ℹ️ Antiprivado ya estaba activo.",
            ...global.channelInfo,
          },
          quoted
        );
      }

      state.enabled = true;
      saveState(state);

      return sock.sendMessage(
        from,
        {
          text:
            `✅ *ANTIPRIVADO ACTIVADO*\n\n` +
            `Ahora solo el owner recibira respuestas en privado.`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (state.enabled) {
      state.enabled = false;
      saveState(state);
      return sock.sendMessage(
        from,
        {
          text:
            `✅ *ANTIPRIVADO DESACTIVADO*\n\n` +
            `El bot vuelve a responder privados para todos.`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    return sock.sendMessage(
      from,
      {
        text: "ℹ️ Antiprivado ya estaba desactivado.",
        ...global.channelInfo,
      },
      quoted
    );
  },

  onMessage: async ({ msg, esOwner, isGroup, sender, senderPhone, senderLid, settings, sock }) => {
    if (!state.enabled) return;
    if (isGroup) return;
    if (
      isAllowedPrivateSender({
        msg,
        sender,
        senderPhone,
        senderLid,
        settings,
        sock,
        esOwner,
      })
    ) {
      return;
    }

    // Bloquea en silencio privados de usuarios normales.
    return true;
  },
};
