import axios from "axios"
import yts from "yt-search"

export default {
name: "prueba",
alias: ["yt","video"],

async run(client, message, args){

if(!args[0]) return message.reply("❌ Escribe algo para buscar")

const search = await yts(args.join(" "))
const video = search.videos[0]

if(!video) return message.reply("❌ No encontrado")

const url = video.url

message.reply("🔎 Buscando descarga...")

const apis = [

`https://cdn.savetube.me/info?url=${url}`,

`https://api.vevioz.com/api/button/mp4/${url}`,

`https://loader.to/ajax/download.php?url=${url}&format=mp4`,

`https://api.cobalt.tools/api/json`,

`https://co.wuk.sh/api/json`,

`https://api-cobalt.islantilla.es/api/json`,

`https://api.yt1s.com/api/ajaxSearch/index?q=${url}&vt=home`,

`https://yt5s.io/api/ajaxSearch`,

`https://keepvid.pro/api`,

`https://y2mate.guru/api/convert`,

`https://snapinsta.app/api`,

`https://ytapi.site/api`,

`https://media-save.net/api`,

`https://videograb.net/api`,

`https://ytdlp.online/api`,

`https://dlpanda.com/api`,

`https://yt-download.org/api`,

`https://tubeapi.com/api`,

`https://mp4downloader.com/api`,

`https://snapvideo.net/api`

]

let download = null

for(const api of apis){

try{

const res = await axios.get(api,{timeout:10000})

if(res.data){

download = res.data.url || res.data.download || res.data.result || res.data.link

if(download) break

}

}catch{}

}

if(!download){
return message.reply("❌ Ninguna API funcionó")
}

await client.sendMessage(message.chat,{
video:{url:download},
caption:`🎬 ${video.title}

⚡ Descargado con sistema multi API`
})

}
}
