import axios from "axios"

export default {
command: ['yt2'],
run: async ({ m, conn, args }) => {

if (!args[0]) return m.reply("❌ Usa:\nyt2 <link youtube>")

let url = args[0]

const apis = [

async () => {
let { data } = await axios.get(`https://api.vevioz.com/api/button/mp4/${url}`)
return { url: data }
},

async () => {
let { data } = await axios.get(`https://api.douyin.wtf/api/youtube?url=${url}`)
return { url: data.download }
},

async () => {
let { data } = await axios.get(`https://ytdownloader.irepo.space/api/youtube/video?url=${url}`)
return { url: data.download }
},

async () => {
let { data } = await axios.get(`https://api.cobalt.tools/api/json`, {
method: "POST",
data: { url }
})
return { url: data.url }
},

async () => {
let { data } = await axios.get(`https://api.akuari.my.id/downloader/youtube?link=${url}`)
return { url: data.respon.url }
},

async () => {
let { data } = await axios.get(`https://api.lolhuman.xyz/api/ytdownloader?apikey=GataDios&url=${url}`)
return { url: data.result.video }
},

async () => {
let { data } = await axios.get(`https://api.neoxr.eu/api/youtube?url=${url}`)
return { url: data.data.url }
},

async () => {
let { data } = await axios.get(`https://api.zahwazein.xyz/downloader/ytmp4?url=${url}`)
return { url: data.result.url }
},

async () => {
let { data } = await axios.get(`https://api.botcahx.eu.org/api/dowloader/yt?url=${url}`)
return { url: data.result.video }
},

async () => {
let { data } = await axios.get(`https://api.ryzendesu.vip/api/downloader/ytmp4?url=${url}`)
return { url: data.result.url }
},

async () => {
let { data } = await axios.get(`https://api.siputzx.my.id/api/d/ytmp4?url=${url}`)
return { url: data.data.url }
},

async () => {
let { data } = await axios.get(`https://api.fgmods.xyz/api/downloader/ytmp4?url=${url}`)
return { url: data.result.url }
},

async () => {
let { data } = await axios.get(`https://api.agatz.xyz/api/ytmp4?url=${url}`)
return { url: data.data.url }
},

async () => {
let { data } = await axios.get(`https://api.itzpire.com/download/youtube?url=${url}`)
return { url: data.data.url }
},

async () => {
let { data } = await axios.get(`https://api.vreden.my.id/api/ytmp4?url=${url}`)
return { url: data.result.url }
},

async () => {
let { data } = await axios.get(`https://api.nekorinn.my.id/downloader/youtube?url=${url}`)
return { url: data.result.url }
},

async () => {
let { data } = await axios.get(`https://api.dhamzxploit.my.id/api/ytmp4?url=${url}`)
return { url: data.result.url }
},

async () => {
let { data } = await axios.get(`https://api.ryzumi.vip/api/downloader/ytmp4?url=${url}`)
return { url: data.result.url }
},

async () => {
let { data } = await axios.get(`https://api.akuari.my.id/downloader/ytmp4?link=${url}`)
return { url: data.respon.url }
},

async () => {
let { data } = await axios.get(`https://api.xyroinee.xyz/api/youtube?url=${url}`)
return { url: data.result.url }
}

]

let success = null

for (let i = 0; i < apis.length; i++) {
try {
let res = await apis[i]()
if (res?.url) {
success = res.url
console.log("API FUNCIONANDO:", i + 1)
break
}
} catch (e) {
console.log("API FALLÓ:", i + 1)
}
}

if (!success) return m.reply("❌ Ninguna API funcionó")

await conn.sendMessage(m.chat, {
video: { url: success },
caption: "✅ Descargado con API fallback"
}, { quoted: m })

}
}
