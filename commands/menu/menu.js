import fs from "fs";
import path from "path";

// ⏱️ uptime bonito
function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const CAT_ICON = {
  menu: "📜",
  music: "🎵",
  descarga: "📥",
  grupos: "👥",
  admin: "🛡️",
  juegos: "🎮",
  tools: "🧰",
  fun: "😄",
  default: "✨",
};

function norm(s) {
  return String(s || "").trim().toLowerCase();
}
function icon(cat) {
  return CAT_ICON[cat] || CAT_ICON.default;
}

// límites típicos de WhatsApp (mejor truncar para evitar errores)
function cut(str, max) {
  const s = String(str || "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function buildCategories(comandos) {
  const categorias = new Map(); // cat -> Set(cmd)
  for (const cmd of new Set(comandos.values())) {
    if (!cmd?.category || !cmd?.command) continue;

    const cat = norm(cmd.category) || "otros";
    const names = Array.isArray(cmd.command) ? cmd.command : [cmd.command];

    if (!categorias.has(cat)) categorias.set(cat, new Set());
    const set = categorias.get(cat);

    for (const n of names) {
      const name = norm(n);
      if (!name) continue;
      set.add(name);
    }
  }
  return categorias;
}

function buildTextMenu({ botName, prefix, uptime, categorias }) {
  const cats = [...categorias.keys()].sort();
  let totalCmds = 0;
  for (const set of categorias.values()) totalCmds += set.size;

  let out =
    `╭══════════════════════╮\n` +
    `│ ✦ *${botName}* ✦\n` +
    `╰══════════════════════╯\n\n` +
    `▸ _prefijo_ : *${prefix}*\n` +
    `▸ _estado_  : *online*\n` +
    `▸ _uptime_  : *${uptime}*\n` +
    `▸ _categorías_ : *${cats.length}*\n` +
    `▸ _comandos_   : *${totalCmds}*\n\n` +
    `┌──────────────────────┐\n` +
    `│ ✧ *MENÚ DE COMANDOS* ✧\n` +
    `└──────────────────────┘\n`;

  const MAX_PER_CAT = 6;
  for (const c of cats) {
    const cmds = [...categorias.get(c)].sort();
    out += `\n╭─ ${icon(c)} *${c.toUpperCase()}* _(${cmds.length})_\n│`;
    cmds.slice(0, MAX_PER_CAT).forEach(x => (out += `\n│  • \`${prefix}${x}\``));
    if (cmds.length > MAX_PER_CAT) out += `\n│  • … y *${cmds.length - MAX_PER_CAT}* más`;
    out += `\n╰──────────────────────`;
  }

  out += `\n\n💡 Usa: *${prefix}menu <categoría>*  o  *${prefix}menu* (interactivo)\n`;
  return out;
}

async function sendList(sock, from, payload, msg) {
  // Baileys acepta este formato directo
  // { text, footer, title, buttonText, sections }
  return sock.sendMessage(from, payload, msg ? { quoted: msg } : undefined);
}

export default {
  command: ["menu"],
  category: "menu",
  description: "Menú interactivo premium (listas y secciones)",

  run: async ({ sock, msg, from, settings, comandos, args = [] }) => {
    try {
      if (!sock || !from) return;
      if (!comandos) {
        return sock.sendMessage(from, { text: "❌ error interno" }, { quoted: msg });
      }

      const botName = settings?.botName || "DVYER BOT";
      const prefix = settings?.prefix || ".";
      const uptime = formatUptime(process.uptime());

      const categorias = buildCategories(comandos);
      const catsSorted = [...categorias.keys()].sort();

      // ✅ Si piden menu texto completo
      const firstArg = norm(args[0]);
      if (firstArg === "texto" || firstArg === "text" || firstArg === "all") {
        const menuTxt = buildTextMenu({ botName, prefix, uptime, categorias });
        return sock.sendMessage(from, { text: menuTxt }, { quoted: msg });
      }

      // ✅ Si piden una categoría => lista de comandos interactiva
      if (firstArg) {
        const cat = firstArg;

        if (!categorias.has(cat)) {
          return sock.sendMessage(
            from,
            {
              text:
                `⚠️ Categoría no encontrada: *${cat}*\n\n` +
                `Ejemplo: *${prefix}menu music*\n` +
                `O usa *${prefix}menu* para ver categorías.`,
            },
            { quoted: msg }
          );
        }

        const cmds = [...categorias.get(cat)].sort();

        // Construir filas (cada fila ejecuta el comando)
        const rows = cmds.slice(0, 40).map((c) => ({
          title: cut(`${prefix}${c}`, 24),
          description: cut(`Ejecutar comando ${prefix}${c}`, 72),
          rowId: `${prefix}${c}`, // al tocar, envía este texto al chat
        }));

        // Agregar opciones extra
        rows.push({
          title: cut("⬅️ Volver categorías", 24),
          description: cut("Regresar al menú principal", 72),
          rowId: `${prefix}menu`,
        });
        rows.push({
          title: cut("📄 Menú texto", 24),
          description: cut("Ver menú completo en texto", 72),
          rowId: `${prefix}menu texto`,
        });

        const payload = {
          text: `📂 *Categoría:* ${icon(cat)} *${cat.toUpperCase()}*\n⏱ Uptime: ${uptime}`,
          footer: `${botName} • ${prefix}menu`,
          title: `${botName} — Comandos`,
          buttonText: "Ver comandos",
          sections: [
            {
              title: `Comandos (${cmds.length})`,
              rows,
            },
          ],
        };

        // Intentar enviar lista; si falla => fallback texto
        try {
          await sendList(sock, from, payload, msg);
          return;
        } catch (e) {
          const fallback =
            `📂 *${cat.toUpperCase()}* (${cmds.length})\n\n` +
            cmds.map((x) => `• ${prefix}${x}`).join("\n") +
            `\n\n💡 Volver: ${prefix}menu`;
          return sock.sendMessage(from, { text: fallback }, { quoted: msg });
        }
      }

      // ✅ Menú principal (categorías) interactivo
      // Construimos secciones con categorías (máx 10-15 secciones suele ser seguro)
      // Si tienes MUCHAS categorías, lo agrupamos en 2 secciones.
      const rows = catsSorted.map((c) => {
        const total = categorias.get(c)?.size || 0;
        return {
          title: cut(`${icon(c)} ${c.toUpperCase()}`, 24),
          description: cut(`Ver ${total} comandos`, 72),
          rowId: `${prefix}menu ${c}`, // al tocar, manda ".menu music" por ejemplo
        };
      });

      // Añadir accesos rápidos
      rows.push({
        title: cut("📄 Menú texto", 24),
        description: cut("Ver menú completo en texto", 72),
        rowId: `${prefix}menu texto`,
      });

      const payload = {
        text:
          `👋 *${botName}*\n` +
          `⏱ Uptime: *${uptime}*\n\n` +
          `Toca una categoría 👇`,
        footer: `Prefijo: ${prefix}`,
        title: `${botName} — Menú`,
        buttonText: "Abrir categorías",
        sections: [
          {
            title: "Categorías",
            rows: rows.slice(0, 45), // límite seguro
          },
        ],
      };

      // Intentar enviar lista; si falla => fallback texto
      try {
        await sendList(sock, from, payload, msg);
      } catch (e) {
        const menuTxt = buildTextMenu({ botName, prefix, uptime, categorias });
        await sock.sendMessage(from, { text: menuTxt }, { quoted: msg });
      }
    } catch (err) {
      console.error("MENU ERROR:", err);
      await sock.sendMessage(from, { text: "❌ error al mostrar el menú" }, { quoted: msg });
    }
  },
};

