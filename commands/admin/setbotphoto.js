import fs from "fs";
import path from "path";
import * as baileys from "@dvyer/baileys";
import {
  formatCooldownMs,
  guardProfileMutation,
  isProfileRateOverlimitError,
  noteProfileMutationFailure,
  noteProfileMutationSuccess,
} from "./_shared.js";

const { downloadContentFromMessage } = baileys;
const TMP_DIR = path.join(process.cwd(), "tmp");
const PROFILE_PHOTO_COMMAND_COOLDOWN_MS = 30 * 60 * 1000;

function getQuoted(msg) {
  return msg?.key ? { quoted: msg } : undefined;
}

function unwrapMessage(message = {}) {
  let current = message;

  while (current?.ephemeralMessage?.message) {
    current = current.ephemeralMessage.message;
  }

  while (current?.viewOnceMessage?.message) {
    current = current.viewOnceMessage.message;
  }

  while (current?.viewOnceMessageV2?.message) {
    current = current.viewOnceMessageV2.message;
  }

  while (current?.viewOnceMessageV2Extension?.message) {
    current = current.viewOnceMessageV2Extension.message;
  }

  return current || {};
}

async function streamToBuffer(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

async function resolveImageBuffer(msg, args = []) {
  const directInput = String(args.join(" ") || "").trim();

  if (/^https?:\/\//i.test(directInput)) {
    const response = await fetch(directInput, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });

    if (!response.ok) {
      throw new Error(`No pude descargar la imagen (${response.status}).`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  const quotedMessage = unwrapMessage(msg?.quoted?.message || {});
  const imageMessage = quotedMessage?.imageMessage;
  if (!imageMessage) {
    return null;
  }

  const stream = await downloadContentFromMessage(imageMessage, "image");
  return streamToBuffer(stream);
}

export default {
  name: "setbotphoto",
  command: ["setbotphoto", "botphoto", "setppbot", "setpfpbot"],
  category: "admin",
  description: "Cambia la foto de perfil del bot actual",

  run: async ({ sock, msg, from, args = [], esOwner, botLabel, botId }) => {
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

    try {
      const cooldown = guardProfileMutation(botId, "photo", PROFILE_PHOTO_COMMAND_COOLDOWN_MS);
      if (cooldown.skip) {
        return sock.sendMessage(
          from,
          {
            text:
              "WhatsApp esta protegiendo los cambios de foto de este bot.\n\n" +
              `Espera ${formatCooldownMs(cooldown.remainingMs)} antes de volver a cambiarla.`,
            ...global.channelInfo,
          },
          getQuoted(msg)
        );
      }

      const buffer = await resolveImageBuffer(msg, args);

      if (!buffer?.length) {
        return sock.sendMessage(
          from,
          {
            text:
              "*USO SETBOTPHOTO*\n\n" +
              "Responde a una imagen o manda una URL.\n" +
              "Ejemplos:\n" +
              ".setbotphoto https://ejemplo.com/foto.jpg\n" +
              ".setbotphoto respondiendo a una imagen",
            ...global.channelInfo,
          },
          getQuoted(msg)
        );
      }

      if (!fs.existsSync(TMP_DIR)) {
        fs.mkdirSync(TMP_DIR, { recursive: true });
      }

      const tempFile = path.join(TMP_DIR, `bot-profile-${Date.now()}.jpg`);

      try {
        fs.writeFileSync(tempFile, buffer);
        await sock.updateProfilePicture(sock.user.id, { url: tempFile });
        noteProfileMutationSuccess(botId, "photo");
      } finally {
        try {
          fs.rmSync(tempFile, { force: true });
        } catch {}
      }

      await sock.sendMessage(
        from,
        {
          text: `*${String(botLabel || "BOT").toUpperCase()}*\n\nFoto de perfil actualizada.`,
          ...global.channelInfo,
        },
        getQuoted(msg)
      );
    } catch (error) {
      noteProfileMutationFailure(botId, "photo", error);
      await sock.sendMessage(
        from,
        {
          text: isProfileRateOverlimitError(error)
            ? "WhatsApp puso una pausa temporal para cambiar la foto.\n\nEspera unos minutos y vuelve a intentarlo."
            : "*ERROR CAMBIANDO FOTO*\n\n" +
              `${error?.message || "No pude cambiar la foto del bot."}`,
          ...global.channelInfo,
        },
        getQuoted(msg)
      );
    }
  },
};
