import fs from "fs";
import path from "path";
import axios from "axios";
import yts from "yt-search";
import { exec } from "child_process";

const API_URL = "https://nexevo-api.vercel.app/download/y2";
const COOLDOWN_TIME = 15 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cooldowns = new Map();

// Nueva carpeta "ytmp4" para los archivos temporales
const YTMP4_DIR = path.join(process.cwd(), "ytmp4");
if (!fs.existsSync(YTMP4_DIR)) {
  fs.mkdirSync(YTMP4_DIR, { recursive: true });
}

export default {
  command: ["ytmp4"],
  category: "descarga",

  run: async (ctx) => {
    const { sock, from, args } = ctx;
    const msg = ctx.m || ctx.msg || null;

    const userId = from;
    let rawMp4, finalMp4;

    // 🔒 COOLDOWN
    if (cooldowns.has(userId)) {
      const wait = cooldowns.get(userId) - Date.now();
      if (wait > 0) {
        return sock.sendMessage(from, {
          text: `⏳ Espera ${Math.ceil(wait / 1000)}s`,
          ...global.channelInfo
        });
      }
    }
    cooldowns.set(userId, Date.now() + COOLDOWN_TIME);

    try {
      if (!args.length) {
        cooldowns.delete(userId);
        return sock.sendMessage(from, {
          text: "❌ Escribe el nombre o link del video",
          ...global.channelInfo
        });
      }

      const query = args.join(" ");
      let videoUrl;
      let title = "video";

      // Definir las rutas para los archivos en la carpeta "ytmp4"
      rawMp4 = path.join(YTMP4_DIR, "video.mp4");
      finalMp4 = path.join(YTMP4_DIR, "video_final.mp4");

      // 🔍 BUSCAR SI NO ES LINK
      if (!/^https?:\/\//.test(query)) {
        const search = await yts(query);
        if (!search.videos.length) {
          cooldowns.delete(userId);
          return sock.sendMessage(from, {
            text: "❌ No se encontró el video",
            ...global.channelInfo
          });
        }

        videoUrl = search.videos[0].url;
        title = search.videos[0].title
          .replace(/[\\/:*?"<>|]/g, "")
          .slice(0, 60);
      } else {
        videoUrl = query;
      }

      await sock.sendMessage(from, {
        text: `🎬 *VIDEO*\n📹 ${title}\n⏳ Descargando…`,
        ...global.channelInfo
      });

      // 🔥 LLAMADA API
      const api = `${API_URL}?url=${encodeURIComponent(videoUrl)}`;
      const { data } = await axios.get(api, { timeout: 20000 });

      if (!data.status || !data.result?.url)
        throw new Error("API inválida");

      // 🔁 DESCARGA CON REINTENTOS
      let ok = false;

      for (let i = 0; i < 3; i++) {
        try {
          const res = await axios.get(data.result.url, {
            responseType: "stream",
            timeout: 60000,
            headers: { "User-Agent": "Mozilla/5.0" }
          });

          const writer = fs.createWriteStream(rawMp4);
          res.data.pipe(writer);

          await new Promise((resolve, reject) => {
            writer.on("finish", resolve);
            writer.on("error", reject);
          });

          if (fs.statSync(rawMp4).size < 300000)
            throw new Error("Archivo incompleto");

          ok = true;
          break;
        } catch {
          await sleep(1200);
        }
      }

      if (!ok) throw new Error("Fallo descarga");

      // 🎞️ NORMALIZAR CON FFMPEG (IMPORTANTE PARA WHATSAPP)
      await new Promise((resolve, reject) => {
        exec(
          `ffmpeg -y -loglevel error -i "${rawMp4}" -map 0:v -map 0:a? -movflags +faststart -c:v copy -c:a copy "${finalMp4}"`,
          (err) => (err ? reject(err) : resolve())
        );
      });

      // 📤 ENVIAR
      await sock.sendMessage(
        from,
        {
          video: fs.readFileSync(finalMp4),
          mimetype: "video/mp4",
          caption: `🎬 ${title}`,
          ...global.channelInfo
        },
        msg?.key ? { quoted: msg } : undefined
      );

    } catch (err) {
      console.error("YTMP4 ERROR:", err.message);
      cooldowns.delete(userId);

      await sock.sendMessage(from, {
        text: "❌ Error al procesar el video",
        ...global.channelInfo
      });

    } finally {
      // 🧹 LIMPIAR CARPETA YTMP4 DESPUÉS DE ENVIAR
      try {
        if (rawMp4 && fs.existsSync(rawMp4)) fs.unlinkSync(rawMp4);
        if (finalMp4 && fs.existsSync(finalMp4)) fs.unlinkSync(finalMp4);
      } catch (error) {
        console.error("Error al eliminar archivos temporales:", error);
      }
    }
  }
};
