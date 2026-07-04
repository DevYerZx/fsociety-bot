import fs from "fs";
import path from "path";
import { stylizeSignature, stylizeWord } from "../../lib/unicode-style.js";

const GROUP_MENU_IMAGE = path.join(process.cwd(), "imagenes", "menu-grupo.png");

function getPrefix(settings) {
  if (Array.isArray(settings?.prefix)) {
    return settings.prefix.find((value) => String(value || "").trim()) || ".";
  }
  return String(settings?.prefix || ".").trim() || ".";
}

function buildFallbackText(prefix) {
  return (
    `╔════════════════════════════╗\n` +
    `║ ${stylizeWord("FSOCIETY-V1")} ${stylizeSignature("group menu")} ║\n` +
    `╚════════════════════════════╝\n\n` +
    `Admin:\n` +
    `- ${prefix}panelgrupo\n` +
    `- ${prefix}invocar Mensaje\n` +
    `- ${prefix}modoadmi on|off\n` +
    `- ${prefix}antilink on|off\n` +
    `- ${prefix}antispam on|off\n` +
    `- ${prefix}antiimagen on|off\n` +
    `- ${prefix}antisticker on|off\n` +
    `- ${prefix}antivideo on|off\n\n` +
      `- ${prefix}antiaudio on|off\n` +
      `- ${prefix}antidocumento on|off\n` +
      `- ${prefix}antiraid on|off\n` +
      `- ${prefix}sanciones\n` +
      `- ${prefix}horariogrupo\n` +
      `- ${prefix}horariogrupo pais peru\n` +
      `- ${prefix}horariogrupo pais argentina\n` +
      `- ${prefix}horariogrupo dias\n\n` +
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

function getGroupMenuImageBuffer() {
  try {
    return fs.existsSync(GROUP_MENU_IMAGE) ? fs.readFileSync(GROUP_MENU_IMAGE) : null;
  } catch {
    return null;
  }
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
        title: "Panel principal",
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
            header: "ESTADO",
            title: "Ver estado del grupo",
            description: "Resumen de protecciones y automatizaciones",
            id: `${prefix}estadogrupo`,
          },
        ],
      },
      {
        title: "Proteccion",
        rows: [
          {
            header: "ANTILINK",
            title: "Configurar AntiLink",
            description: "Borra enlaces y aplica sanciones",
            id: `${prefix}antilink`,
          },
          {
            header: "ANTISPAM",
            title: "Configurar AntiSpam",
            description: "Reduce flood y mensajes repetidos",
            id: `${prefix}antispam`,
          },
          {
            header: "MODO ADMIN",
            title: "Configurar Modo Admin",
            description: "Solo admin y owner usan comandos",
            id: `${prefix}modoadmi`,
          },
        ],
      },
      {
        title: "Horarios y control",
        rows: [
          {
            header: "HORARIO",
            title: "Abrir horario del grupo",
            description: "Cierre y apertura automatica del grupo",
            id: `${prefix}horariogrupo`,
          },
          {
            header: "PERU",
            title: "Horario base Peru",
            description: "Configurar con hora principal de Peru",
            id: `${prefix}horariogrupo pais peru`,
          },
          {
            header: "SEMANA",
            title: "Ver horario semanal",
            description: "Resumen por dias y paises",
            id: `${prefix}horariogrupo dias`,
          },
        ],
      },
      {
        title: "Dinamicas",
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
        title: "Escudos multimedia",
        rows: [
          {
            header: "IMAGENES",
            title: "Configurar AntiImagen",
            description: "Bloquea imagenes de miembros normales",
            id: `${prefix}antiimagen`,
          },
          {
            header: "STICKERS",
            title: "Configurar AntiSticker",
            description: "Bloquea stickers de miembros normales",
            id: `${prefix}antisticker`,
          },
          {
            header: "VIDEOS",
            title: "Configurar AntiVideo",
            description: "Bloquea videos de miembros normales",
            id: `${prefix}antivideo`,
          },
          {
            header: "AUDIOS",
            title: "Configurar AntiAudio",
            description: "Bloquea audios de miembros normales",
            id: `${prefix}antiaudio`,
          },
          {
            header: "DOCUMENTOS",
            title: "Configurar AntiDocumento",
            description: "Bloquea archivos de miembros normales",
            id: `${prefix}antidocumento`,
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
        title: "IA util en grupo",
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
      {
        title: "Accesos rapidos",
        rows: [
          {
            header: "REGLAS",
            title: "Ver reglas del grupo",
            description: "Abre el mensaje de reglas actual",
            id: `${prefix}reglas`,
          },
          {
            header: "ADMINS",
            title: "Ver administradores",
            description: "Muestra staff del grupo",
            id: `${prefix}administradores`,
          },
          {
            header: "TAGALL",
            title: "Invocar a todos",
            description: "Mencion general para avisos",
            id: `${prefix}invocar Aviso importante`,
          },
        ],
      },
    ];

    const imageBuffer = getGroupMenuImageBuffer();
    const payload = {
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
    };

    const landingText =
      `╔════════════════════════════╗\n` +
      `║ ${stylizeWord("FSOCIETY-V1")} ${stylizeSignature("group hub")} ║\n` +
      `╠════════════════════════════╣\n` +
      `║ 🛡️ Seguridad, horarios y control.\n` +
      `║ 🎛️ Usa el selector para abrir cada ajuste.\n` +
      `║ ⚡ Acceso rapido a panel, estado y horarios.\n` +
      `╚════════════════════════════╝`;

    try {
      if (imageBuffer) {
        payload.image = imageBuffer;
        payload.caption = landingText;
      } else {
        payload.text = landingText;
      }

      return await sock.sendMessage(
        from,
        payload,
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
