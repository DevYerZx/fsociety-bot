function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }
  return String(settings?.prefix || ".").trim() || ".";
}

function buildFallbackText(prefix) {
  return (
    `*MENU FREE FIRE*\n\n` +
    `Torneo:\n` +
    `- ${prefix}ffcrear Torneo Semanal\n` +
    `- ${prefix}ffreglas\n` +
    `- ${prefix}ffformato 4v4 | bo3 | rbo7\n\n` +
    `Clanes:\n` +
    `- ${prefix}ffclan add Clan Alpha\n` +
    `- ${prefix}ffclan del Clan Alpha\n` +
    `- ${prefix}ffclanes\n\n` +
    `Jugadores:\n` +
    `- ${prefix}ffinscribir Clan Alpha | Nick\n` +
    `- ${prefix}ffbaja\n` +
    `- ${prefix}ffinscritos\n` +
    `- ${prefix}ffautoequipos\n\n` +
    `VS:\n` +
    `- ${prefix}ffvs Clan Alpha | Clan Beta | R1\n` +
    `- ${prefix}ffresultado M1 | Clan Alpha | 2-1 | 15-10\n` +
    `- ${prefix}ffpartidos\n` +
    `- ${prefix}fftabla\n` +
    `- ${prefix}ffestado\n\n` +
    `Cierre:\n` +
    `- ${prefix}ffcerrar`
  );
}

export default {
  name: "freefiremenu",
  command: ["freefiremenu", "ffmenu", "menuff", "menufreefire"],
  category: "freefire",
  description: "Menu exclusivo de comandos Free Fire",

  run: async ({ sock, msg, from, settings }) => {
    const prefix = getPrefix(settings);

    const sections = [
      {
        title: "Torneo",
        rows: [
          { header: "Crear", title: "Crear torneo", description: "Nuevo torneo FF", id: `${prefix}ffcrear Torneo Semanal` },
          { header: "Reglas", title: "Ver reglas", description: "Formato actual", id: `${prefix}ffreglas` },
          { header: "Formato", title: "Editar formato", description: "4v4 | bo3 | rbo7", id: `${prefix}ffformato 4v4 | bo3 | rbo7` },
        ],
      },
      {
        title: "Clanes y jugadores",
        rows: [
          { header: "Clan", title: "Agregar clan", description: "Registra clan", id: `${prefix}ffclan add Clan Alpha` },
          { header: "Inscripcion", title: "Inscribirme", description: "Entrar al clan", id: `${prefix}ffinscribir Clan Alpha | Nick` },
          { header: "Inscritos", title: "Ver inscritos", description: "Lista de jugadores", id: `${prefix}ffinscritos` },
          { header: "Autoequipos", title: "Auto-armar", description: "Titulares y suplentes", id: `${prefix}ffautoequipos` },
        ],
      },
      {
        title: "VS y resultados",
        rows: [
          { header: "VS", title: "Programar VS", description: "Crear enfrentamiento", id: `${prefix}ffvs Clan Alpha | Clan Beta | R1` },
          { header: "Resultado", title: "Cargar resultado", description: "M1 | Clan | 2-1 | 15-10", id: `${prefix}ffresultado M1 | Clan Alpha | 2-1 | 15-10` },
          { header: "Tabla", title: "Ver tabla", description: "Puntos y KD", id: `${prefix}fftabla` },
          { header: "Partidos", title: "Ver partidos", description: "Pendientes y jugados", id: `${prefix}ffpartidos` },
          { header: "Estado", title: "Estado torneo", description: "Resumen general", id: `${prefix}ffestado` },
          { header: "Cerrar", title: "Cerrar torneo", description: "Finaliza torneo", id: `${prefix}ffcerrar` },
        ],
      },
    ];

    try {
      return await sock.sendMessage(
        from,
        {
          text: "Comandos Free Fire",
          title: "FSOCIETY BOT",
          subtitle: "Menu Free Fire",
          footer: "Solo Free Fire",
          interactiveButtons: [
            {
              name: "single_select",
              buttonParamsJson: JSON.stringify({
                title: "Abrir menu Free Fire",
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
