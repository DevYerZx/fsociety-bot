import path from "path";
import { writeJsonAtomic } from "../../lib/json-store.js";
import {
  formatCooldownMs,
  guardProfileMutation,
  isProfileRateOverlimitError,
  noteProfileMutationFailure,
  noteProfileMutationSuccess,
} from "./_shared.js";

const SETTINGS_FILE = path.join(process.cwd(), "settings", "settings.json");
const PROFILE_NAME_COMMAND_COOLDOWN_MS = 15 * 60 * 1000;

function getQuoted(msg) {
  return msg?.key ? { quoted: msg } : undefined;
}

function getSubbotSlot(botId = "") {
  const match = String(botId || "")
    .trim()
    .toLowerCase()
    .match(/^subbot(\d{1,2})$/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function saveSettings(settings) {
  writeJsonAtomic(SETTINGS_FILE, settings);
}

export default {
  name: "setbotname",
  command: ["setbotname", "botname", "setnamebot", "setnombrebot"],
  category: "admin",
  description: "Cambia el nombre del bot actual",

  run: async ({ sock, msg, from, args = [], esOwner, settings, botId, botLabel }) => {
    if (!esOwner) {
      return sock.sendMessage(
        from,
        {
          text: "Solo el owner puede usar este comando.",
          ...global.channelInfo,
        },
        getQuoted(msg)
      );
    }

    const nextName = String(args.join(" ") || "").trim().replace(/\s+/g, " ").slice(0, 60);
    if (!nextName) {
      return sock.sendMessage(
        from,
        {
          text:
            "*USO SETBOTNAME*\n\n" +
            "Ejemplo:\n" +
            ".setbotname DVYER Ultra",
          ...global.channelInfo,
        },
        getQuoted(msg)
      );
    }

    try {
      const currentName =
        String(
          String(botId || "").toLowerCase() === "main"
            ? settings?.botName || ""
            : settings?.subbots?.[Math.max(0, getSubbotSlot(botId) - 1)]?.name || ""
        )
          .trim()
          .slice(0, 60);

      if (currentName && currentName === nextName) {
        return sock.sendMessage(
          from,
          {
            text: "El nombre ya esta configurado asi. No hice cambios para evitar limite de WhatsApp.",
            ...global.channelInfo,
          },
          getQuoted(msg)
        );
      }

      const cooldown = guardProfileMutation(botId, "name", PROFILE_NAME_COMMAND_COOLDOWN_MS);
      if (cooldown.skip) {
        return sock.sendMessage(
          from,
          {
            text:
              "WhatsApp esta protegiendo los cambios de nombre de este bot.\n\n" +
              `Espera ${formatCooldownMs(cooldown.remainingMs)} antes de volver a cambiarlo.`,
            ...global.channelInfo,
          },
          getQuoted(msg)
        );
      }

      await sock.updateProfileName(nextName);
      noteProfileMutationSuccess(botId, "name");

      if (String(botId || "").toLowerCase() === "main") {
        settings.botName = nextName;
      } else {
        const slot = getSubbotSlot(botId);
        if (slot >= 1 && Array.isArray(settings.subbots) && settings.subbots[slot - 1]) {
          settings.subbots[slot - 1].name = nextName;
        }
      }

      saveSettings(settings);

      await sock.sendMessage(
        from,
        {
          text:
            `*${String(botLabel || "BOT").toUpperCase()} RENOMBRADO*\n\n` +
            `Nuevo nombre: *${nextName}*`,
          ...global.channelInfo,
        },
        getQuoted(msg)
      );
    } catch (error) {
      noteProfileMutationFailure(botId, "name", error);
      await sock.sendMessage(
        from,
        {
          text: isProfileRateOverlimitError(error)
            ? "WhatsApp puso una pausa temporal para cambiar el nombre.\n\nEspera unos minutos y vuelve a intentarlo."
            : "*ERROR CAMBIANDO NOMBRE*\n\n" +
              `${error?.message || "No pude cambiar el nombre del bot."}`,
          ...global.channelInfo,
        },
        getQuoted(msg)
      );
    }
  },
};
