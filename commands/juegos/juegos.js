import fs from "fs";
import path from "path";
import { getPrefix } from "./_shared.js";

function buildJuegosMessage(caption) {
  const imagePath = path.join(process.cwd(), "imagenes", "juegos.png");

  if (fs.existsSync(imagePath)) {
    return {
      image: fs.readFileSync(imagePath),
      caption,
      ...global.channelInfo,
    };
  }

  return {
    text: caption,
    ...global.channelInfo,
  };
}

export default {
  name: "juegos",
  command: ["juegos", "games", "menujuegos"],
  category: "juegos",
  description: "Muestra el menu de juegos del bot",

  run: async ({ sock, msg, from, settings }) => {
    const prefix = getPrefix(settings);

    return sock.sendMessage(
      from,
      buildJuegosMessage(
        `╔════════════════════════════╗\n` +
        `║   FSOCIETY-V1 GAME ARENA   ║\n` +
        `╚════════════════════════════╝\n\n` +
        `*JUEGOS DISPONIBLES*\n\n` +
          `Disponibles:\n` +
          `- ${prefix}ppt piedra\n` +
          `- ${prefix}adivina\n` +
          `- ${prefix}ahorcado\n` +
          `- ${prefix}mezclapalabra\n` +
        `- ${prefix}mate\n` +
        `- ${prefix}trivia\n` +
        `- ${prefix}verdaderoofalso\n` +
        `- ${prefix}quizanime\n` +
        `- ${prefix}emojiquiz\n` +
        `- ${prefix}banderas\n` +
        `- ${prefix}tictactoe\n` +
        `- ${prefix}ruleta rojo\n\n` +
          `Rankings:\n` +
          `- ${prefix}topjuegos\n` +
          `- ${prefix}topjuegos grupo\n` +
          `- ${prefix}topjuegos trivia\n` +
          `- ${prefix}topjuegos quizanime\n` +
          `- ${prefix}topjuegos verdaderoofalso\n` +
          `- ${prefix}topjuegos grupo trivia\n` +
          `- ${prefix}perfilgame\n\n` +
          `Control:\n` +
          `- ${prefix}salirjuego`
      ),
      { quoted: msg }
    );
  },
};
