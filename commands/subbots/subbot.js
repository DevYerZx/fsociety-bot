import {
  buildSubbotMediaMessage,
  buildSubbotCard,
  formatDuration,
  getCurrentChatStatus,
  getPrefix,
  getSubbotQuoted,
  hasSubbotRuntime,
  normalizeNumber,
  parseSlotToken,
  parseSubbotRequestArgs,
} from "./_shared.js";

function detectRequesterNumber(msg, sender) {
  const directNumber = normalizeNumber(msg?.senderPhone || msg?.key?.participantPn || "");
  if (directNumber.length >= 8) {
    return directNumber;
  }

  const jidCandidates = [
    msg?.sender,
    sender,
    msg?.key?.participant,
    msg?.key?.remoteJid,
  ];

  for (const candidate of jidCandidates) {
    const raw = String(candidate || "").trim();
    if (!raw || !raw.endsWith("@s.whatsapp.net")) {
      continue;
    }

    const digits = normalizeNumber(raw);
    if (digits.length >= 8) {
      return digits;
    }
  }

  return "";
}

async function sendSubbotRequestMenu({
  sock,
  from,
  quoted,
  prefix,
  parsed,
  subbotAccess,
  chatStatus,
  esOwner,
  requesterNumber,
}) {
  const maxSlots = Number(subbotAccess?.maxSlots || 15);
  const slot = Number(parsed?.slot || 0) || 0;
  const hasAutoNumber = requesterNumber.length >= 8;
  const autoCommand = hasAutoNumber
    ? slot
      ? `${prefix}subbot ${slot} ${requesterNumber}`
      : `${prefix}subbot ${requesterNumber}`
    : "";
  const manualCommand = slot
    ? `${prefix}subbot ${slot} 51912345678`
    : `${prefix}subbot 51912345678`;

  const requestRows = [];

  if (hasAutoNumber) {
    requestRows.push({
      header: "AUTO",
      title: slot ? `Pedir codigo slot ${slot}` : "Pedir codigo ahora",
      description: `Usa tu numero ${requesterNumber}`.slice(0, 72),
      id: autoCommand,
    });
  } else {
    requestRows.push({
      header: "MANUAL",
      title: slot ? `Pedir codigo slot ${slot}` : "Pedir codigo manual",
      description: "Escribe tu numero con codigo de pais".slice(0, 72),
      id: manualCommand,
    });
  }

  requestRows.push({
    header: "PANEL",
    title: "Ver subbots activos",
    description: "Revisar slots libres y conectados".slice(0, 72),
    id: `${prefix}subbots`,
  });

  const sections = [
    {
      title: "Solicitud de codigo",
      rows: requestRows,
    },
  ];

  if (esOwner) {
    const ownerSlot = slot || 1;
    sections.push({
      title: "Gestion owner",
      rows: [
        {
          header: "OWNER",
          title: `Info slot ${ownerSlot}`,
          description: "Ver estado detallado del slot".slice(0, 72),
          id: `${prefix}subbot info ${ownerSlot}`,
        },
        {
          header: "OWNER",
          title: `Reconectar slot ${ownerSlot}`,
          description: "Reconecta sin borrar la sesion".slice(0, 72),
          id: `${prefix}subbot reconectar ${ownerSlot}`,
        },
        {
          header: "OWNER",
          title: `Liberar slot ${ownerSlot}`,
          description: "Apaga y libera ese subbot".slice(0, 72),
          id: `${prefix}subbot liberar ${ownerSlot}`,
        },
        {
          header: "OWNER",
          title: `Reset slot ${ownerSlot}`,
          description: "Resetea sesion del subbot".slice(0, 72),
          id: `${prefix}subbot reset ${ownerSlot}`,
        },
        {
          header: "OWNER",
          title: "Cambiar capacidad",
          description: `Ejemplo: ${prefix}subbot slots ${Math.max(20, maxSlots)}`.slice(0, 72),
          id: `${prefix}subbot slots ${Math.max(20, maxSlots)}`,
        },
      ],
    });
  }

  try {
    await sock.sendMessage(
      from,
      {
          text:
            `Menu rapido de subbot.\n` +
            `Selecciona una opcion para ejecutar el comando.\n` +
            `Tipo normal: dura *3 horas* y luego se libera.\n` +
            `En este chat: ${chatStatus}\n` +
          `Modo publico: *${subbotAccess?.publicRequests ? "ENCENDIDO" : "APAGADO"}*`,
        title: "SUBBOT",
        subtitle: slot ? `Slot seleccionado: ${slot}` : "Seleccion rapida",
        footer: "FSOCIETY BOT",
        interactiveButtons: [
          {
            name: "single_select",
            buttonParamsJson: JSON.stringify({
              title: hasAutoNumber
                ? `Pedir con ${requesterNumber}`
                : "Abrir menu subbot",
              sections,
            }),
          },
        ],
        ...global.channelInfo,
      },
      quoted
    );
    return true;
  } catch (error) {
    console.error("No pude enviar menu interactivo de subbot:", error?.message || error);
    return false;
  }
}

async function sendOwnerSlotMenu({
  sock,
  from,
  quoted,
  prefix,
  slot,
  bot,
  chatStatus,
  publicRequests,
}) {
  const sections = [
    {
      title: `Gestion del slot ${slot}`,
      rows: [
        {
          header: "SLOT",
          title: `Info slot ${slot}`,
          description: "Ver estado completo y datos".slice(0, 72),
          id: `${prefix}subbot info ${slot}`,
        },
        {
          header: "SLOT",
          title: `Reconectar slot ${slot}`,
          description: "Reconecta sin borrar sesion".slice(0, 72),
          id: `${prefix}subbot reconectar ${slot}`,
        },
        {
          header: "SLOT",
          title: `Liberar slot ${slot}`,
          description: "Quitar subbot y liberar espacio".slice(0, 72),
          id: `${prefix}subbot liberar ${slot}`,
        },
        {
          header: "SLOT",
          title: `Reset slot ${slot}`,
          description: "Borrar sesion y reiniciar slot".slice(0, 72),
          id: `${prefix}subbot reset ${slot}`,
        },
      ],
    },
    {
      title: "Control global",
      rows: [
        {
          header: "GLOBAL",
          title: publicRequests ? "Apagar solicitudes" : "Encender solicitudes",
          description: publicRequests
            ? "Nadie podra pedir subbot hasta activarlo."
            : "Permitir que vuelvan a pedir subbot.",
          id: publicRequests ? `${prefix}subbotoff` : `${prefix}subboton`,
        },
        {
          header: "GLOBAL",
          title: "Volver panel owner",
          description: "Ver todos los subbots con datos".slice(0, 72),
          id: `${prefix}subbots owner`,
        },
      ],
    },
  ];

  return sock.sendMessage(
    from,
    {
      text:
        `Panel del slot ${slot}.\n` +
        `Selecciona una accion owner.\n` +
        `En este chat: ${chatStatus}`,
      title: "SUBBOT OWNER",
      subtitle: `Slot ${slot} | ${bot?.displayName || "Subbot"}`,
      footer: "FSOCIETY BOT",
      interactiveButtons: [
        {
          name: "single_select",
          buttonParamsJson: JSON.stringify({
            title: `Opciones slot ${slot}`,
            sections,
          }),
        },
      ],
      ...global.channelInfo,
    },
    quoted
  );
}

export default {
  name: "subbot",
  command: ["subbot", "code", "subbotcode", "codesubbot"],
  category: "subbots",
  description: "Pide el codigo de vinculacion de un subbot",

  run: async ({
    sock,
    msg,
    from,
    sender,
    args = [],
    settings,
    esOwner,
    isGroup,
    botId,
    botLabel,
  }) => {
    const quoted = getSubbotQuoted(msg);
    const prefix = getPrefix(settings);
    const runtime = global.botRuntime;
    const chatStatus = getCurrentChatStatus({ isGroup, botId, botLabel });
    const action = String(args[0] || "").trim().toLowerCase();

    if (!hasSubbotRuntime(runtime)) {
      return sock.sendMessage(
        from,
        {
          text: "No pude acceder al control interno del subbot.",
          ...global.channelInfo,
        },
        quoted
      );
    }

    const subbotAccess = runtime.getSubbotRequestState();

    if (["menu", "panel", "gestionar", "manage"].includes(action)) {
      if (!esOwner) {
        return sock.sendMessage(
          from,
          {
            text: "Solo el owner puede abrir el menu privado de slots.",
            ...global.channelInfo,
          },
          quoted
        );
      }

      const slot = parseSlotToken(args[1], Number(subbotAccess?.maxSlots || 15));
      if (!slot || !runtime?.getBotSummary) {
        return sock.sendMessage(
          from,
          {
            text: `Usa: *${prefix}subbot menu 3*`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      const bot = runtime.getBotSummary(`subbot${slot}`);
      if (!bot) {
        return sock.sendMessage(
          from,
          {
            text: `No encontre el slot ${slot}.`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      try {
        await sendOwnerSlotMenu({
          sock,
          from,
          quoted,
          prefix,
          slot,
          bot,
          chatStatus,
          publicRequests: Boolean(subbotAccess?.publicRequests),
        });
      } catch (error) {
        console.error("No pude enviar menu owner por slot:", error?.message || error);
      }

      return sock.sendMessage(
        from,
        {
          text:
            `*SLOT OWNER ${slot}*\n\n` +
            `${buildSubbotCard(bot, { compact: false, showSensitive: true })}\n\n` +
            `Atajos\n` +
            `- ${prefix}subbot reconectar ${slot}\n` +
            `- ${prefix}subbot liberar ${slot}\n` +
            `- ${prefix}subbot reset ${slot}\n` +
            `- ${prefix}subbotoff / ${prefix}subboton`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (["info", "estado"].includes(action)) {
      if (!esOwner) {
        return sock.sendMessage(
          from,
          {
            text: "Solo el owner puede ver el detalle de un slot de subbot.",
            ...global.channelInfo,
          },
          quoted
        );
      }

      const slot = parseSlotToken(args[1], Number(subbotAccess?.maxSlots || 15));
      if (!slot || !runtime?.getBotSummary) {
        return sock.sendMessage(
          from,
          {
            text: `Usa: *${prefix}subbot info 3*`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      const bot = runtime.getBotSummary(`subbot${slot}`);
      if (!bot) {
        return sock.sendMessage(
          from,
          {
            text: `No encontre el slot ${slot}.`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      return sock.sendMessage(
        from,
        {
          text:
            `*INFO SUBBOT ${slot}*\n\n` +
            `Resumen del slot\n\n` +
            `${buildSubbotCard(bot, { compact: false, showSensitive: true })}\n\n` +
            `Vista actual: ${chatStatus}`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (["liberar", "release", "free"].includes(action)) {
      if (!esOwner) {
        return sock.sendMessage(
          from,
          {
            text: "Solo el owner puede liberar slots de subbot.",
            ...global.channelInfo,
          },
          quoted
        );
      }

      const slot = parseSlotToken(args[1], Number(subbotAccess?.maxSlots || 15));
      if (!slot || !runtime?.releaseSubbot) {
        return sock.sendMessage(
          from,
          {
            text: `Usa: *${prefix}subbot liberar 3 519xxxxxxx*`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      const bot = runtime?.getBotSummary?.(`subbot${slot}`);
      const assignedNumber = normalizeNumber(
        bot?.requesterNumber || bot?.configuredNumber || bot?.cachedPairingNumber || ""
      );
      const providedNumber = normalizeNumber(args[2] || "");

      if (assignedNumber && assignedNumber !== providedNumber) {
        return sock.sendMessage(
          from,
          {
            text:
              `Para liberar el slot ${slot} debes confirmar el numero asignado.\n` +
              `Usa: *${prefix}subbot liberar ${slot} ${assignedNumber}*`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      const result = runtime.releaseSubbot(`subbot${slot}`);
      return sock.sendMessage(
        from,
        {
          text: result?.ok
            ? `Slot ${slot} liberado correctamente.`
            : result?.message || "No pude liberar ese slot.",
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (["reset", "reiniciar"].includes(action)) {
      if (!esOwner) {
        return sock.sendMessage(
          from,
          {
            text: "Solo el owner puede resetear subbots.",
            ...global.channelInfo,
          },
          quoted
        );
      }

      const slot = parseSlotToken(args[1], Number(subbotAccess?.maxSlots || 15));
      if (!slot || !runtime?.resetSubbot) {
        return sock.sendMessage(
          from,
          {
            text: `Usa: *${prefix}subbot reset 3*`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      const result = runtime.resetSubbot(`subbot${slot}`);
      return sock.sendMessage(
        from,
        {
          text: result?.ok
            ? `Slot ${slot} reseteado correctamente.`
            : result?.message || "No pude resetear ese slot.",
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (["reconectar", "reconnect", "rc"].includes(action)) {
      if (!esOwner) {
        return sock.sendMessage(
          from,
          {
            text: "Solo el owner puede reconectar subbots.",
            ...global.channelInfo,
          },
          quoted
        );
      }

      const slot = parseSlotToken(args[1], Number(subbotAccess?.maxSlots || 15));
      if (!slot || !runtime?.reconnectSubbot) {
        return sock.sendMessage(
          from,
          {
            text: `Usa: *${prefix}subbot reconectar 3*`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      const result = await runtime.reconnectSubbot(`subbot${slot}`, {
        reason: "owner_command",
      });

      return sock.sendMessage(
        from,
        {
          text: result?.ok
            ? result?.message || `Reconectando slot ${slot}...`
            : result?.message || "No pude reconectar ese subbot.",
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (["slots", "espacios", "capacidad"].includes(action)) {
      if (!esOwner) {
        return sock.sendMessage(
          from,
          {
            text: "Solo el owner puede cambiar la capacidad de subbots.",
            ...global.channelInfo,
          },
          quoted
        );
      }

      const nextSlots = Number.parseInt(String(args[1] || ""), 10);
      if (!Number.isFinite(nextSlots) || !runtime?.setSubbotMaxSlots) {
        return sock.sendMessage(
          from,
          {
            text: `Usa: *${prefix}subbot slots 20*`,
            ...global.channelInfo,
          },
          quoted
        );
      }

      const result = runtime.setSubbotMaxSlots(nextSlots);
      return sock.sendMessage(
        from,
        {
          text: result?.ok
            ? `Capacidad actualizada a *${result.state.maxSlots}* slots.`
            : result?.message || "No pude actualizar la capacidad de subbots.",
          ...global.channelInfo,
        },
        quoted
      );
    }

    const parsed = parseSubbotRequestArgs(
      args,
      Number(subbotAccess?.maxSlots || 15)
    );

    if (parsed.invalid) {
      return sock.sendMessage(
        from,
        {
          text:
            `Uso correcto:\n` +
            `*${prefix}subbot*\n` +
            `*${prefix}subbot 3*\n` +
            `*${prefix}subbot 519xxxxxxxxx*\n` +
            `*${prefix}subbot 3 519xxxxxxxxx*\n` +
            `*${prefix}subbot menu 3*\n` +
            `*${prefix}subbot info 3*\n` +
            `*${prefix}subbot reconectar 3*\n` +
            `*${prefix}subbot liberar 3*\n` +
            `*${prefix}subbot reset 3*\n` +
            `*${prefix}subbot slots 20*\n` +
            `*${prefix}subbotvip 519xxxxxxxxx* (owner/bot)\n` +
            `*${prefix}subbotoff* / *${prefix}subboton*`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (!parsed.number) {
      const slotHint = parsed.slot ? ` ${parsed.slot}` : "";
      const requesterNumber = detectRequesterNumber(msg, sender);

      const sentInteractiveMenu = await sendSubbotRequestMenu({
        sock,
        from,
        quoted,
        prefix,
        parsed,
        subbotAccess,
        chatStatus,
        esOwner,
        requesterNumber,
      });

      if (sentInteractiveMenu) {
        return;
      }

      return sock.sendMessage(
        from,
        buildSubbotMediaMessage(
          "subbotcodigo.png",
          `*NOTIFICACION SUBBOT*\n\n` +
            `Para pedir tu subbot debes enviar tu numero con codigo de pais.\n` +
            `Ejemplo:\n` +
            `*${prefix}subbot${slotHint} 51xxxxx*\n\n` +
            `Si no eliges slot, el bot usa el primer espacio libre.\n` +
            `Subbot normal: dura *3 horas* desde que conecta y luego se libera.\n` +
            (requesterNumber
              ? `Atajo detectado:\n*${prefix}subbot${slotHint} ${requesterNumber}*\n\n`
              : "") +
            `En este chat: ${chatStatus}`
        ),
        quoted
      );
    }

    if (!subbotAccess.publicRequests && !esOwner) {
      return sock.sendMessage(
        from,
        {
          text:
            `*SUBBOTS APAGADOS POR OWNER*\n\n` +
            `Ahora mismo nadie puede pedir codigo.\n` +
            `En este chat: ${chatStatus}`,
          ...global.channelInfo,
        },
        quoted
      );
    }

    const targetNumber = parsed.number;
    const loadingText =
      parsed.slot
        ? `Generando codigo del subbot ${parsed.slot} para ${targetNumber}...`
        : `Generando codigo para tu subbot ${targetNumber}...`;

    await sock.sendMessage(
      from,
      {
        text:
          `${loadingText}\n` +
          `Modo publico: *${subbotAccess.publicRequests ? "ENCENDIDO" : "APAGADO"}*`,
        ...global.channelInfo,
      },
      quoted
    );

    const result = await runtime.requestBotPairingCode(
      parsed.slot ? `subbot${parsed.slot}` : "subbot",
      {
        number: targetNumber,
        requesterNumber: targetNumber,
        requesterJid: String(sender || ""),
        subbotMode: "normal",
        bypassPublicRequests: Boolean(esOwner),
        useCache: true,
      }
    );

    if (!result?.ok) {
      let text = result?.message || "No pude obtener el codigo del subbot.";

      if (result?.status === "missing_bot") {
        text =
          `No encontre ese slot de subbot.\n` +
          `Usa un numero del 1 al ${subbotAccess.maxSlots}.`;
      } else if (result?.status === "no_capacity") {
        text =
          `No hay slots libres ahora mismo.\n` +
          `Revisa *${prefix}codigosubbots* para ver quien esta conectado.`;
      } else if (result?.status === "slot_busy") {
        text =
          `${result.message}\n` +
          `Prueba con otro slot o revisa *${prefix}codigosubbots*.`;
      } else if (result?.status === "number_already_linked") {
        text =
          `${result.message}\n` +
          `Ese numero solo puede estar vinculado en un subbot a la vez.`;
      } else if (result?.status === "main_not_ready") {
        text = "Primero vincula y conecta el bot principal desde la consola.";
      } else if (result?.status === "already_linked") {
        text =
          `Ese subbot ya esta vinculado y funcionando.\n` +
          `En este chat: ${chatStatus}`;
      } else if (result?.status === "pending") {
        text =
          "Ya hay una solicitud de codigo en proceso para ese subbot. Espera un momento y vuelve a intentar.";
      } else if (result?.status === "missing_number") {
        const slotHint = parsed.slot ? ` ${parsed.slot}` : "";
        text =
          `Debes enviar tu numero con codigo de pais.\n` +
          `Usa: *${prefix}subbot${slotHint} 51912345678*`;
      }

      return sock.sendMessage(
        from,
        {
          text,
          ...global.channelInfo,
        },
        quoted
      );
    }

    const slotLabel = result.slot ? ` ${result.slot}` : "";
    const header = result.cached
      ? `CODIGO ACTUAL DEL SUBBOT${slotLabel}`
      : `CODIGO DE VINCULACION DEL SUBBOT${slotLabel}`;

    return sock.sendMessage(
      from,
      buildSubbotMediaMessage(
        "subbotcodigo.png",
        `*${header}*\n\n` +
          `Bot: *${result.displayName}*\n` +
          `Numero: *${result.number}*\n` +
          `Solicitante: *${targetNumber}*\n` +
          `Tipo: *NORMAL 3H*\n` +
          `Codigo: *${result.code}*\n` +
          `Expira aprox: *${formatDuration(result.expiresInMs)}*\n` +
          `En este chat: ${chatStatus}\n\n` +
          `Abre WhatsApp > Dispositivos vinculados > Vincular con numero de telefono.`
      ),
      quoted
    );
  },
};
