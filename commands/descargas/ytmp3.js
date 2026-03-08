
import axios from "axios"
import yts from "yt-search"

const API = "https://0f66da8bd81e5d32-201-230-121-168.serveousercontent.com/ytmp3"

const channelInfo = global.channelInfo || {}

function safeFileName(name){
return String(name || "audio")
.replace(/[\\/:*?"<>|]/g,"")
.slice(0,80)
}

export default {

command:["play","ytmp3"],
category:"descarga",

run: async (ctx)=>{

const {sock, from, args} = ctx
const msg = ctx.m || ctx.msg

if(!args.length){
return sock.sendMessage(from,{
text:"❌ Uso: .play canción\nEjemplo:\n.play bad bunny",
...channelInfo
})
}

try{

const query = args.join(" ")

const search = await yts(query)

const video = search.videos[0]

if(!video){
return sock.sendMessage(from,{
text:"❌ No encontré resultados",
...channelInfo
})
}

await sock.sendMessage(from,{
image:{url: video.thumbnail},
caption:`🎵 *${video.title}*\n⏱️ ${video.timestamp}\n\n⬇️ Descargando audio...`,
...channelInfo
},{quoted: msg})

// llamar a tu API
const apiUrl = `${API}?url=${encodeURIComponent(video.url)}`

const {data} = await axios.get(apiUrl,{
timeout:20000
})

if(!data || !data.download){
throw new Error("API sin audio")
}

const audioUrl = data.download

// descargar audio para evitar 403
const audioData = await axios.get(audioUrl,{
responseType:"arraybuffer",
timeout:30000
})

// enviar audio como buffer
await sock.sendMessage(from,{
audio: Buffer.from(audioData.data),
mimetype:"audio/mpeg",
fileName: safeFileName(video.title)+".mp3",
...channelInfo
},{quoted: msg})

}catch(err){

console.log("PLAY ERROR:", err?.response?.data || err.message)

await sock.sendMessage(from,{
text:"❌ Error descargando música",
...channelInfo
})

}

}

}

