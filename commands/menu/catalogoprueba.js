import baileysHelper from "baileys_helper";

const { sendInteractiveMessage } = baileysHelper;

export default {
  name: "catalogoprueba",
  command: ["catalogoprueba", "catalogotest", "menulista"],
  category: "menu",
  description: "Envia un catalogo interactivo minimo de prueba",

  run: async ({ sock, msg, from, settings }) => {
    const text =
      "MENU PRINCIPAL\n" +
      "[ MENU ]\n" +
      "LABORATORIO DE COMANDOS\n" +
      `Bot: ${settings?.botName || "DVYER"}\n` +
      "Toca el selector para abrir el catalogo de prueba.";

    try {
      await sendInteractiveMessage(sock, from, {
        text,
        interactiveButtons: [
          {
            name: "single_select",
            buttonParamsJson: JSON.stringify({
              title: "Abrir catalogo",
              sections: [
                {
                  title: "Comandos",
                  rows: [
                    {
                      header: "DVYER BOT",
                      title: "Menu completo",
                      description: "Abre el menu principal",
                      id: ".menu",
                    },
                    {
                      header: "DVYER BOT",
                      title: "Ping",
                      description: "Prueba rapida del bot",
                      id: ".ping",
                    },
                    {
                      header: "DVYER BOT",
                      title: "Prueba de catalogo",
                      description: "Confirma que el catalogo responde",
                      id: ".catalogook",
                    },
                  ],
                },
              ],
            }),
          },
        ],
      });
    } catch (error) {
      console.error("CATALOGO PRUEBA ERROR:", error?.formatDetailed?.() || error);

      await sock.sendMessage(
        from,
        {
          text:
            "No pude enviar el catalogo interactivo en este momento.\n" +
            "El bot si recibio el comando, pero WhatsApp/Baileys rechazo ese formato.",
        },
        { quoted: msg }
      );
    }
  },
};
