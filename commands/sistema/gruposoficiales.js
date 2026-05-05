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
    const supportChannelName = String(newsletter.name || "Canal de soporte").trim();

    const lines = [
      "╭━━〔 🌐 *GRUPOS OFICIALES FSOCIETY-V1* 〕━━⬣",
      "┃ *Comunidad (DVYER):*",
      "┃ https://chat.whatsapp.com/GuLWXlFUdy3BJA9OXcc1Hj",
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
      "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━⬣",
    ];

    if (supportChannelUrl) {
      try {
        return await sock.sendMessage(
          from,
          {
            text: lines.join("\n"),
            title: "FSOCIETY-V1",
            subtitle: "Soporte y comunidad",
            footer: "Usa el boton para abrir el canal directo",
            interactiveButtons: [
              {
                name: "cta_url",
                buttonParamsJson: JSON.stringify({
                  display_text: `Abrir ${supportChannelName}`,
                  url: supportChannelUrl,
                  merchant_url: supportChannelUrl,
                }),
              },
            ],
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      } catch {}
    }

    return sock.sendMessage(from, { text: lines.join("\n"), ...global.channelInfo }, { quoted: msg });
  },
};
