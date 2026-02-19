import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ⏱️ uptime bonito
function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Prefijo bonito
function getPrefixLabel(settings) {
  if (settings?.noPrefix === true) return "SIN PREFIJO";
  const p = settings?.prefix;
  if (Array.isArray(p)) return p.filter(Boolean).join(" | ") || ".";
  if (typeof p === "string" && p.trim()) return p.trim();
  return ".";
}

export default {
  command: ["menu"],
  category: "menu",
  description: "Menú principal con diseño premium",

  run: async ({ sock, msg, from, settings, comandos }) => {
    try {
      if (!sock || !from) return;

      if (!comandos) {
        return sock.sendMessage(from, { text: "❌ error interno" }, { quoted: msg });
      }

      const botName = settings?.botName || "DVYER BOT";
      const prefixLabel = getPrefixLabel(settings);
      const uptime = formatUptime(process.uptime());

      // 🎥 video menú (VALIDAR BIEN)
      const videoPath = path.join(process.cwd(), "videos", "menu-video.mp4");

      if (!fs.existsSync(videoPath)) {
        return sock.sendMessage(from, { text: "❌ video del menú no encontrado" }, { quoted: msg });
      }

      const stat = fs.statSync(videoPath);
      if (!stat.isFile() || stat.size <= 1024) {
        // si pesa menos de 1KB casi seguro está corrupto/vacío
        return sock.sendMessage(
          from,
          { text: "❌ el video del menú está vacío o corrupto. Vuelve a subirlo." },
          { quoted: msg }
        );
      }

      // 📂 agrupar comandos (sin duplicados)
      const categorias = {};
      for (const cmd of new Set(comandos.values())) {
        if (!cmd?.category || !cmd?.command) continue;

        const cat = String(cmd.category).toLowerCase().trim() || "otros";
        const names = Array.isArray(cmd.command) ? cmd.command : [cmd.command];

        if (!categorias[cat]) categorias[cat] = new Set();
        for (const n of names) {
          if (!n) continue;
          categorias[cat].add(String(n).toLowerCase());
        }
      }

      const cats = Object.keys(categorias).sort();
      const totalCats = cats.length;

      let totalCmds = 0;
      for (const c of cats) totalCmds += categorias[c].size;

      // 🎨 Diseño mejorado (compacto, pro)
      let menu =
`╭══════════════════════╮
│ ✦ *${botName}* ✦
╰══════════════════════╯

▸ _prefijo_     : *${prefixLabel}*
▸ _estado_      : *online*
▸ _uptime_      : *${uptime}*
▸ _categorías_  : *${totalCats}*
▸ _comandos_    : *${totalCmds}*

┌──────────────────────┐
│ ✧ *MENÚ DE COMANDOS* ✧
└──────────────────────┘`;

      // Limitar comandos por categoría (para que no sea infinito)
      const MAX_PER_CAT = 10;

      for (const cat of cats) {
        const list = [...categorias[cat]].sort();
        const total = list.length;
        const shown = list.slice(0, MAX_PER_CAT);

        menu += `
╭─ ❖ *${cat.toUpperCase()}*  _(${total})_
│`;

        shown.forEach((c) => {
          menu += `\n│  • \`${prefixLabel}${c}\``;
        });

        if (total > MAX_PER_CAT) {
          menu += `\n│  • … y *${total - MAX_PER_CAT}* más`;
        }

        menu += `
╰──────────────────────`;
      }

      menu += `

┌──────────────────────┐
│ ✦ _bot premium activo_ ✦
└──────────────────────┘
💡 Tip: Usa *${prefixLabel}play <texto>* para buscar música
_artoria bot vip_`;

      // ✅ ENVIAR VIDEO COMO BUFFER (más compatible con Baileys)
      const videoBuffer = fs.readFileSync(videoPath);
      if (!videoBuffer || !videoBuffer.length) {
        return sock.sendMessage(
          from,
          { text: "❌ no se pudo leer el video del menú (buffer vacío)." },
          { quoted: msg }
        );
      }

      await sock.sendMessage(
        from,
        {
          video: videoBuffer,
          mimetype: "video/mp4",
          gifPlayback: true,
          caption: menu.trim(),
        },
        { quoted: msg }
      );

    } catch (err) {
      console.error("MENU ERROR:", err);
      await sock.sendMessage(from, { text: "❌ error al mostrar el menú" }, { quoted: msg });
    }
  },
};
