// Detectar tipo correctamente
const ext = file.type?.toLowerCase();

if (ext === "mp4") {

  await sock.sendMessage(from, {
    video: { url: file.link },
    mimetype: "video/mp4",
    caption:
      `🎬 *MediaFire Downloader*\n\n` +
      `📄 ${file.filename}\n` +
      `📦 ${file.size}\n\n` +
      `🤖 SonGokuBot`
  });

} else if (ext === "mp3") {

  await sock.sendMessage(from, {
    audio: { url: file.link },
    mimetype: "audio/mpeg",
    ptt: false
  });

} else {

  await sock.sendMessage(from, {
    document: { url: file.link },
    fileName: file.filename,
    mimetype: "application/octet-stream",
    caption:
      `📁 *MediaFire Downloader*\n\n` +
      `📄 ${file.filename}\n` +
      `📦 ${file.size}\n\n` +
      `🤖 SonGokuBot`
  });

}
