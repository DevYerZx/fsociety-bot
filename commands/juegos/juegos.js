import fs from "fs";
import path from "path";
import { stylizeSignature, stylizeWord } from "../../lib/unicode-style.js";
import { getPrefix } from "./_shared.js";

const GAMES_IMAGE = path.join(process.cwd(), "imagenes", "juegos.png");

function getGamesImageBuffer() {
  try {
    return fs.existsSync(GAMES_IMAGE) ? fs.readFileSync(GAMES_IMAGE) : null;
  } catch {
    return null;
  }
}

function buildFallbackText(prefix) {
  return (
    `╔════════════════════════════╗\n` +
    `║ ${stylizeWord("FSOCIETY")} ${stylizeSignature("game hub")} ║\n` +
    `╠════════════════════════════╣\n` +
    `║ 🎮 Minijuegos, ranking y perfil.\n` +
    `║ 🧠 Usa ${prefix}salirjuego si quedas en una partida.\n` +
    `╚════════════════════════════╝\n\n` +
    `Retos rapidos:\n` +
    `- ${prefix}ppt piedra\n` +
    `- ${prefix}adivina\n` +
    `- ${prefix}mate\n` +
    `- ${prefix}ruleta rojo\n\n` +
    `Quiz y cultura:\n` +
    `- ${prefix}trivia\n` +
    `- ${prefix}verdaderoofalso\n` +
    `- ${prefix}quizanime\n` +
    `- ${prefix}emojiquiz\n` +
    `- ${prefix}banderas\n\n` +
    `Palabras y salas:\n` +
    `- ${prefix}ahorcado\n` +
    `- ${prefix}mezclapalabra\n` +
    `- ${prefix}tictactoe @usuario\n` +
    `- ${prefix}personajeanimesoy\n\n` +
    `Ranking y control:\n` +
    `- ${prefix}topjuegos\n` +
    `- ${prefix}topjuegos grupo\n` +
    `- ${prefix}perfilgame\n` +
    `- ${prefix}salirjuego\n\n` +
    `Especial:\n` +
    `- ${prefix}freefiremenu\n` +
    `- ${prefix}evento`
  );
}

function buildLandingText(prefix) {
  return [
    "╔════════════════════════════╗",
    `║ ${stylizeWord("FSOCIETY")} ${stylizeSignature("game arena")} ║`,
    "╠════════════════════════════╣",
    "║ 🎮 Juegos rapidos y competitivos.",
    "║ 🏆 Rankings, perfil y retos por grupo.",
    `║ ⚡ Tip: ${prefix}topjuegos grupo`,
    "╚════════════════════════════╝",
  ].join("\n");
}

function buildSections(prefix) {
  return [
    {
      title: "⚡ Inicio rapido",
      highlight_label: "FAST",
      rows: [
        {
          header: "PPT",
          title: "Piedra, papel o tijera",
          description: "Juega al instante contra el bot",
          id: `${prefix}ppt piedra`,
        },
        {
          header: "MATE",
          title: "Reto matematico",
          description: "Cuenta regresiva y respuesta rapida",
          id: `${prefix}mate`,
        },
        {
          header: "RULETA",
          title: "Ruleta de color",
          description: "Prueba suerte con rojo o negro",
          id: `${prefix}ruleta rojo`,
        },
        {
          header: "SALIR",
          title: "Salir del juego actual",
          description: "Limpia tu sesion si quedaste en curso",
          id: `${prefix}salirjuego`,
        },
      ],
    },
    {
      title: "🧠 Quiz y cultura",
      highlight_label: "QUIZ",
      rows: [
        {
          header: "TRIVIA",
          title: "Trivia general",
          description: "Preguntas de cultura general",
          id: `${prefix}trivia`,
        },
        {
          header: "VOF",
          title: "Verdadero o falso",
          description: "Decide rapido antes que acabe el tiempo",
          id: `${prefix}verdaderoofalso`,
        },
        {
          header: "ANIME",
          title: "Quiz anime",
          description: "Preguntas para otakus del grupo",
          id: `${prefix}quizanime`,
        },
        {
          header: "EMOJI",
          title: "Emoji quiz",
          description: "Adivina la palabra o concepto",
          id: `${prefix}emojiquiz`,
        },
        {
          header: "BANDERAS",
          title: "Adivina la bandera",
          description: "Paises y geografia rapida",
          id: `${prefix}banderas`,
        },
      ],
    },
    {
      title: "🔤 Palabras y logica",
      highlight_label: "WORDS",
      rows: [
        {
          header: "ADIVINA",
          title: "Adivina la palabra",
          description: "Respuesta directa contra reloj",
          id: `${prefix}adivina`,
        },
        {
          header: "AHORCADO",
          title: "Jugar ahorcado",
          description: "Descubre la palabra letra por letra",
          id: `${prefix}ahorcado`,
        },
        {
          header: "MEZCLA",
          title: "Palabra mezclada",
          description: "Ordena letras y gana puntos",
          id: `${prefix}mezclapalabra`,
        },
        {
          header: "PERSONAJE",
          title: "Que personaje anime soy",
          description: "Resultado divertido para el usuario",
          id: `${prefix}personajeanimesoy`,
        },
      ],
    },
    {
      title: "👥 Versus y salas",
      highlight_label: "PVP",
      rows: [
        {
          header: "TICTACTOE",
          title: "Tres en raya",
          description: "Reta a otro usuario del chat",
          id: `${prefix}tictactoe @usuario`,
        },
        {
          header: "FREE FIRE",
          title: "Menu Free Fire",
          description: "Eventos, torneos y panel FF",
          id: `${prefix}freefiremenu`,
        },
        {
          header: "EVENTO",
          title: "Panel de evento",
          description: "Inscripciones y equipos por selector",
          id: `${prefix}evento`,
        },
      ],
    },
    {
      title: "🏆 Ranking y perfil",
      highlight_label: "TOP",
      rows: [
        {
          header: "TOP",
          title: "Top general de juegos",
          description: "Muestra a los mejores del bot",
          id: `${prefix}topjuegos`,
        },
        {
          header: "GRUPO",
          title: "Top del grupo",
          description: "Ranking solo del chat actual",
          id: `${prefix}topjuegos grupo`,
        },
        {
          header: "PERFIL",
          title: "Mi perfil gamer",
          description: "Tus puntos, victorias y estadisticas",
          id: `${prefix}perfilgame`,
        },
      ],
    },
  ];
}

export default {
  name: "juegos",
  command: ["juegos", "games", "menujuegos"],
  category: "juegos",
  description: "Muestra el menu de juegos del bot",

  run: async ({ sock, msg, from, settings }) => {
    const prefix = getPrefix(settings);
    const imageBuffer = getGamesImageBuffer();
    const sections = buildSections(prefix);
    const payload = {
      title: "FSOCIETY BOT",
      subtitle: "Game Hub",
      footer: "Elige un juego o panel",
      interactiveButtons: [
        {
          name: "single_select",
          buttonParamsJson: JSON.stringify({
            title: "Abrir game hub",
            sections,
          }),
        },
      ],
      ...global.channelInfo,
    };

    try {
      if (imageBuffer) {
        payload.image = imageBuffer;
        payload.caption = buildLandingText(prefix);
      } else {
        payload.text = buildLandingText(prefix);
      }

      return await sock.sendMessage(from, payload, { quoted: msg });
    } catch {
      return sock.sendMessage(
        from,
        { text: buildFallbackText(prefix), ...global.channelInfo },
        { quoted: msg }
      );
    }
  },
};
