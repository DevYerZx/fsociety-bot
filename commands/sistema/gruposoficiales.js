import fs from "fs";
import path from "path";

const COMMUNITY_MAIN_LINK = "https://chat.whatsapp.com/GuLWXlFUdy3BJA9OXcc1Hj";

function resolveCommunityImagePath() {
  const imageDir = path.join(process.cwd(), "imagenes");
  const candidates = [
    path.join(imageDir, "comunidad.jpg"),
    path.join(imageDir, "comunidad.jpeg"),
    path.join(imageDir, "comunidad.png"),
    path.join(imageDir, "comunidad.webp"),
  ];
  return candidates.find((filePath) => fs.existsSync(filePath)) || "";
}

function getCommunityImageBuffer() {
  const imagePath = resolveCommunityImagePath();
  if (!imagePath) return null;
  try {
    return fs.readFileSync(imagePath);
  } catch {
    return null;
  }
}

export default {
  command: ["gruposoficiales", "grupooficial", "comunidad", "soportebot"],
  category: "sistema",
  description: "Muestra los grupos oficiales del bot.",

  run: async ({ sock, msg, from, settings }) => {
    const newsletter = settings?.newsletter && typeof settings.newsletter === "object"
      ? settings.newsletter
      : {};
    const newsletterJid = String(newsletter.jid || "").trim();
    const inferredChannelUrl = newsletterJid.includes("@newsletter")
      ? `https://whatsapp.com/channel/${newsletterJid.replace("@newsletter", "")}`
      : "";
    const supportChannelUrl = String(newsletter.url || inferredChannelUrl || "").trim();
    const communityImage = getCommunityImageBuffer();

    const lines = [
      "╭━━〔 🌐 *GRUPOS OFICIALES FSOCIETY-V1* 〕━━⬣",
      "┃ *Comunidad (DVYER):*",
      `┃ ${COMMUNITY_MAIN_LINK}`,
      "┃",
      "┃ *Grupo oficial del bot:*",
      "┃ https://chat.whatsapp.com/ItdJRKVJGCsIXZjviN3MZO",
      "┃",
      "┃ *Grupo de soporte del bot:*",
      "┃ https://chat.whatsapp.com/FsrlWXVdG3RCLYbZ5LazBO",
      ...(supportChannelUrl
        ? [
            "┃",
            `┃ *Canal de soporte:*`,
            `┃ ${supportChannelUrl}`,
          ]
        : []),
      "┃",
      "┃ *Si algun enlace falla:*",
      "┃ *UNETE DIRECTO A LA COMUNIDAD desde el boton de abajo.*",
      "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━⬣",
    ];
    const communityText = lines.join("\n");

    if (supportChannelUrl) {
      if (communityImage) {
        await sock.sendMessage(
          from,
          { image: communityImage, caption: communityText, ...global.channelInfo },
          { quoted: msg }
        );

        return sock.sendMessage(
          from,
          {
            text: "⚡ Si no abre algun grupo, entra directo a la comunidad oficial desde aqui:",
            title: "FSOCIETY-V1",
            subtitle: "Soporte y comunidad",
            footer: "Boton directo de comunidad",
            interactiveButtons: [
              {
                name: "cta_url",
                buttonParamsJson: JSON.stringify({
                  display_text: "Unete a la comunidad",
                  url: COMMUNITY_MAIN_LINK,
                  merchant_url: COMMUNITY_MAIN_LINK,
                }),
              },
            ],
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      }

      try {
        return await sock.sendMessage(
          from,
          {
            text: communityText,
            title: "FSOCIETY-V1",
            subtitle: "Soporte y comunidad",
            footer: "Usa el boton para abrir la comunidad directo",
            interactiveButtons: [
              {
                name: "cta_url",
                buttonParamsJson: JSON.stringify({
                  display_text: "Unete a la comunidad",
                  url: COMMUNITY_MAIN_LINK,
                  merchant_url: COMMUNITY_MAIN_LINK,
                }),
              },
            ],
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      } catch {}
    }

    if (communityImage) {
      return sock.sendMessage(
        from,
        { image: communityImage, caption: communityText, ...global.channelInfo },
        { quoted: msg }
      );
    }

    return sock.sendMessage(from, { text: communityText, ...global.channelInfo }, { quoted: msg });
  },
};
