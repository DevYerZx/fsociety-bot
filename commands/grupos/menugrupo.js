function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }
  return String(settings?.prefix || ".").trim() || ".";
}

function buildFallbackText(prefix) {
  return (
    `╔════════════════════════════╗\n` +
    `║   FSOCIETY-V1 GROUP MENU   ║\n` +
    `╚════════════════════════════╝\n\n` +
    `Admin:\n` +
    `- ${prefix}panelgrupo\n` +
    `- ${prefix}invocar Mensaje\n` +
    `- ${prefix}modoadmi on|off\n` +
    `- ${prefix}antilink on|off\n` +
    `- ${prefix}antispam on|off\n\n` +
    `Dinamica:\n` +
    `- ${prefix}sorteo crear 10m | Premio\n` +
    `- ${prefix}sorteo unirme\n` +
    `- ${prefix}votacion crear 10m | Pregunta | Opcion 1 | Opcion 2\n` +
    `- ${prefix}votar 1\n\n` +
    `IA Util:\n` +
    `- ${prefix}resumirchat\n` +
    `- ${prefix}explicarcomando ytmp4\n` +
    `- ${prefix}traducirvoz en (respondiendo audio)\n`
  );
}

export default {
  name: "menugrupo",
  command: ["menugrupo", "grupomenu", "menuadmin", "menugp"],
  category: "grupo",
  description: "Panel visual para administracion y dinamicas de grupo",
  groupOnly: true,
  adminOnly: true,

  run: async ({ sock, msg, from, settings }) => {
    const prefix = getPrefix(settings);
    const sections = [
      {
        title: "Administracion",
        rows: [
          {
            header: "PANEL",
            title: "Abrir panel de grupo",
            description: "Configura seguridad y control del bot",
            id: `${prefix}panelgrupo`,
          },
          {
            header: "INVOCAR",
            title: "Invocar a todos",
            description: "Menciona miembros del grupo",
            id: `${prefix}invocar Aviso importante`,
          },
          {
            header: "MODO ADMIN",
            title: "Activar modo admin",
            description: "Solo admin/owner usan comandos",
            id: `${prefix}modoadmi on`,
          },
        ],
      },
      {
        title: "Sorteos",
        rows: [
          {
            header: "CREAR",
            title: "Crear sorteo rapido",
            description: "Ejemplo con cierre automatico",
            id: `${prefix}sorteo crear 10m | Nitro Discord`,
          },
          {
            header: "UNIRME",
            title: "Entrar al sorteo",
            description: "Inscripcion de miembros",
            id: `${prefix}sorteo unirme`,
          },
          {
            header: "ESTADO",
            title: "Ver estado del sorteo",
            description: "Tiempo restante y participantes",
            id: `${prefix}sorteo estado`,
          },
        ],
      },
      {
        title: "Votaciones",
        rows: [
          {
            header: "CREAR",
            title: "Crear votacion",
            description: "Con cierre automatico",
            id: `${prefix}votacion crear 10m | Elegimos hora | 8PM | 9PM`,
          },
          {
            header: "VOTAR",
            title: "Emitir voto",
            description: "Votar por indice",
            id: `${prefix}votar 1`,
          },
          {
            header: "ESTADO",
            title: "Ver resultados en vivo",
            description: "Conteo y porcentaje actual",
            id: `${prefix}votacion estado`,
          },
        ],
      },
      {
        title: "IA Util en grupo",
        rows: [
          {
            header: "CHAT",
            title: "Resumir chat",
            description: "Resumen automatico de mensajes recientes",
            id: `${prefix}resumirchat 40`,
          },
          {
            header: "COMANDO",
            title: "Explicar comando",
            description: "Como usar cualquier comando",
            id: `${prefix}explicarcomando ytmp4`,
          },
          {
            header: "VOZ",
            title: "Traducir voz",
            description: "Responde una nota de voz",
            id: `${prefix}traducirvoz en`,
          },
        ],
      },
    ];

    try {
      return await sock.sendMessage(
        from,
        {
          text:
            `╔════════════════════════════╗\n` +
            `║   FSOCIETY-V1 GROUP MENU   ║\n` +
            `╚════════════════════════════╝\n` +
            `┃ 🛡️ Panel de moderacion y dinamicas.\n` +
            `┃ 📌 Usa la lista para ejecutar rapido.\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━⬣`,
          title: "FSOCIETY-V1",
          subtitle: "Panel de grupo",
          footer: "Elige una accion del grupo",
          interactiveButtons: [
            {
              name: "single_select",
              buttonParamsJson: JSON.stringify({
                title: "Abrir panel de grupo",
                sections,
              }),
            },
          ],
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    } catch {
      return sock.sendMessage(
        from,
        { text: buildFallbackText(prefix), ...global.channelInfo },
        { quoted: msg }
      );
    }
  },
};
