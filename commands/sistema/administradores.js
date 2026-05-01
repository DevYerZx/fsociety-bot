function normalizeNumber(value = "") {
  return String(value || "").replace(/[^\d]/g, "").trim();
}

function unique(items = []) {
  return Array.from(new Set(items.filter(Boolean)));
}

export default {
  command: ["administradores", "admins", "staff", "equipo"],
  category: "sistema",
  description: "Muestra owner y administradores del bot.",

  run: async ({ sock, msg, from, settings }) => {
    const ownerName = String(settings?.ownerName || "DVYER").trim();
    const ownerNumber = normalizeNumber(settings?.ownerNumber || "");
    const ownerNumbers = Array.isArray(settings?.ownerNumbers)
      ? settings.ownerNumbers.map((item) => normalizeNumber(item))
      : [];

    const allOwners = unique([ownerNumber, ...ownerNumbers]);
    const ownerMain = allOwners[0] || "";
    const admins = allOwners.slice(1);

    const lines = [
      "╭━━〔 👑 *ADMINISTRADORES FSOCIETY* 〕━━⬣",
      `┃ *Dueño:* ${ownerName}`,
      ownerMain ? `┃ *Contacto owner:* wa.me/${ownerMain}` : "┃ *Contacto owner:* no configurado",
      "┃",
      "┃ *Lista de administradores:*",
      ...(admins.length
        ? admins.map((num) => `┃ • wa.me/${num}`)
        : ["┃ • No hay administradores extra configurados."]),
      "┃",
      "┃ *Soporte directo:* Escribe en Yer Nova Orosco PM",
      "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━⬣",
    ];

    return sock.sendMessage(
      from,
      { text: lines.join("\n"), ...global.channelInfo },
      { quoted: msg }
    );
  },
};
