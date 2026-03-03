import fs from "fs";
import path from "path";
import axios from "axios";
import yts from "yt-search";

const API_BASE = "https://nexevo.onrender.com/download/y2?url=";
const TMP_DIR = path.join(process.cwd(), "tmp");

const MAX_VIDEO_BYTES = 150 * 1024 * 1024;
const MAX_DOC_BYTES = 2 * 1024 * 1024 * 1024;

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function safeFileName(name) {
  return (String(name || "video")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "video");
}

async function searchVideo(query) {
  const res = await yts(query);
  if (!res.videos.length) return null;
  return res.videos[0];
}

async function getDirectUrl(videoUrl) {
  const { data } = await axios.get(
    API_BASE + encodeURIComponent(videoUrl),
    { timeout: 30000 }
  );

  if (!data?.status || !data?.result?.url) {
    console.log("Respuesta API:", data);
    throw new Error("API no devolvió URL válida");
  }

  return {
    url: data.result.url,
    thumbnail: data.result.info?.thumbnail || null,
    title: data.result.info?.title || "video"
  };
}

async function downloadToFile(url, filePath) {
  const response = await axios({
    url,
    method: "GET",
    responseType: "arraybuffer",
    maxRedirects: 5,
    timeout: 60000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "Accept": "*/*",
      "Accept-Language": "es-ES,es;q=0.9",
      "Referer": "https://www.youtube.com/",
      "Connection": "keep-alive"
    }
  });

  const buffer = Buffer.from(response.data);

  // 🔎 Validar tamaño mínimo
  if (buffer.length < 500000) {
    throw new Error("Archivo demasiado pequeño o incompleto");
  }

  // 🔎 Detectar HTML
  const textHeader = buffer.slice(0, 50).toString();
  if (textHeader.includes("<!DOCTYPE") || textHeader.includes("<html")) {
    throw new Error("La API devolvió HTML en vez de video");
  }

  // 🔎 Validar que sea MP4 real
  const header = buffer.slice(0, 20).toString();
  if (!header.includes("ftyp")) {
    throw new Error("El archivo descargado no es un MP4 válido");
  }

  fs.writeFileSync(filePath, buffer);
}

export default {
  command: ["yt2"],
  category: "descarga",

  run: async ({ sock, from, args, m }) => {
    if (!args.length) {
      return sock.sendMessage(from, {
        text: "❌ Uso: .yt2 nombre o link"
      });
    }

    let outFile = null;

    try {
      const query = args.join(" ");
      let videoUrl = query;
      let title = "video";

      if (!query.startsWith("http")) {
        const search = await searchVideo(query);
        if (!search) {
          return sock.sendMessage(from, {
            text: "❌ No se encontró el video."
          });
        }
        videoUrl = search.url;
        title = safeFileName(search.title);
      }

      await sock.sendMessage(from, {
        text: "🔎 Descargando video en 360p..."
      }, { quoted: m });

      const api = await getDirectUrl(videoUrl);
      title = safeFileName(title);

      if (api.thumbnail) {
        await sock.sendMessage(from, {
          image: { url: api.thumbnail },
          caption: `🎬 ${title}\n📺 Calidad: 360p\n⏳ Descargando...`
        }, { quoted: m });
      }

      outFile = path.join(TMP_DIR, `${Date.now()}.mp4`);

      await downloadToFile(api.url, outFile);

      const size = fs.statSync(outFile).size;

      if (size <= MAX_VIDEO_BYTES) {
        await sock.sendMessage(from, {
          video: fs.readFileSync(outFile),
          mimetype: "video/mp4",
          caption: `🎬 ${title}\n📺 360p`
        }, { quoted: m });
      } else if (size <= MAX_DOC_BYTES) {
        await sock.sendMessage(from, {
          document: fs.readFileSync(outFile),
          mimetype: "video/mp4",
          fileName: `${title}.mp4`,
          caption: `📄 ${title}\n📺 360p`
        }, { quoted: m });
      } else {
        throw new Error("El archivo supera el límite permitido.");
      }

    } catch (err) {
      console.error("ERROR yt2:", err.message);
      await sock.sendMessage(from, {
        text: "❌ Error al procesar el video.\n⚠ La API puede estar bloqueando el servidor."
      });
    } finally {
      if (outFile && fs.existsSync(outFile)) {
        fs.unlinkSync(outFile);
      }
    }
  }
};