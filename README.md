<p align="center">
  <a href="https://www.whatsapp.com/channel/0029VatMd2cGk1FmWw8au11u" target="_blank">
    <img src="https://img.shields.io/badge/Canal%20Oficial%20WhatsApp-25D366?style=for-the-badge&logo=whatsapp&logoColor=white" alt="Canal Oficial" />
  </a>
  <a href="https://chat.whatsapp.com/GuLWXlFUdy3BJA9OXcc1Hj" target="_blank">
    <img src="https://img.shields.io/badge/Comunidad-128C7E?style=for-the-badge&logo=whatsapp&logoColor=white" alt="Comunidad" />
  </a>
  <a href="https://chat.whatsapp.com/FsrlWXVdG3RCLYbZ5LazBO" target="_blank">
    <img src="https://img.shields.io/badge/Soporte-1EBEA5?style=for-the-badge&logo=whatsapp&logoColor=white" alt="Soporte" />
  </a>
</p>

<p align="center">
  <img src="assets/profile/fsociety-bot-profile.png" alt="Fsociety-V1" width="150" />
</p>

<h1 align="center">Fsociety-V1</h1>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18%2B-43853D?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Baileys-MultiBot-25D366?style=for-the-badge&logo=whatsapp&logoColor=white" alt="Baileys" />
  <img src="https://img.shields.io/badge/PM2-Ready-2B037A?style=for-the-badge&logo=pm2&logoColor=white" alt="PM2" />
  <img src="https://img.shields.io/badge/Status-Activo-success?style=for-the-badge" alt="Status" />
</p>

<p align="center">
Bot de WhatsApp multi-instancia con soporte para <b>bot principal + subbots</b>, util para VPS, Termux y Windows.
</p>

## Tabla de contenido

- [Caracteristicas](#caracteristicas)
- [Requisitos](#requisitos)
- [Instalacion rapida](#instalacion-rapida-linuxvps)
- [Instalacion en Termux](#instalacion-en-termux-android)
- [Instalacion en Linux (Ubuntu/Debian)](#instalacion-en-linux-ubuntudebian)
- [Instalacion en Windows](#instalacion-en-windows)
- [Ejecucion con PM2](#ejecucion-con-pm2-vps-recomendado)
- [Configuracion principal](#configuracion-principal)
- [Canal directo desde el bot](#canal-directo-desde-el-bot)
- [Scripts disponibles](#scripts-disponibles)
- [Recomendaciones](#recomendaciones)
- [Troubleshooting](#troubleshooting)

## Caracteristicas

- Multi-bot por slots (`main` + subbots).
- Pairing por codigo para vincular rapido.
- Modulos de comandos: admin, grupos, juegos, descargas, economia, sistema.
- Integracion de canal/newsletter para soporte.
- Persistencia de sesiones para no perder vinculacion.
- Compatible con PM2 para produccion.

## Requisitos

- `Node.js` 18 o superior (ideal: Node 20 LTS)
- `npm`
- `git`
- `ffmpeg`

## Instalacion rapida (Linux/VPS)

```bash
git clone https://github.com/DevYerZx/fsociety-bot.git
cd fsociety-bot
npm install
npm start
```

## Instalacion en Termux (Android)

<p>
  <img src="https://cdn.simpleicons.org/android/3DDC84" alt="Android" width="16" />
  <b>Recomendado:</b> Termux de F-Droid.
</p>

```bash
pkg update -y
pkg upgrade -y
pkg install -y git nodejs-lts npm ffmpeg
termux-setup-storage

git clone https://github.com/DevYerZx/fsociety-bot.git
cd fsociety-bot
npm install
npm start
```

Si falla `npm install` por red:

```bash
npm install --fetch-retries=5
```

## Instalacion en Linux (Ubuntu/Debian)

<p>
  <img src="https://cdn.simpleicons.org/linux/FCC624" alt="Linux" width="16" />
  <b>Servidor o VPS</b>
</p>

```bash
sudo apt update
sudo apt install -y git ffmpeg curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

git clone https://github.com/DevYerZx/fsociety-bot.git
cd fsociety-bot
npm install
npm start
```

## Instalacion en Windows

<p>
  <img src="https://cdn.simpleicons.org/windows/0078D6" alt="Windows" width="16" />
  <b>PowerShell</b>
</p>

1. Instala `Node.js LTS`, `Git`, `FFmpeg` (agregado al `PATH`).
2. Ejecuta:

```powershell
git clone https://github.com/DevYerZx/fsociety-bot.git
cd fsociety-bot
npm install
npm start
```

## Ejecucion con PM2 (VPS recomendado)

<p>
  <img src="https://cdn.simpleicons.org/pm2/2B037A" alt="PM2" width="16" />
  <b>Produccion estable</b>
</p>

```bash
npm install -g pm2
npm run pm2:start
pm2 save
pm2 logs
```

## Configuracion principal

Archivo: `settings/settings.json`

- `botName`: nombre del bot.
- `ownerNumber` / `ownerNumbers`: dueños.
- `prefix`: prefijos de comandos.
- `subbots`: slots y estado de subbots.
- `newsletter.enabled`: activa funciones de canal.
- `newsletter.jid`: JID del canal.
- `newsletter.name`: nombre del canal.
- `newsletter.url`: URL directa del canal (boton de soporte).

Ejemplo:

```json
{
  "newsletter": {
    "enabled": true,
    "jid": "120363354701957370@newsletter",
    "name": "Fsociety-V1",
    "url": "https://www.whatsapp.com/channel/0029VatMd2cGk1FmWw8au11u"
  }
}
```

## Canal directo desde el bot

Usa este comando:

```text
.gruposoficiales
```

Si `newsletter.url` esta configurado, el bot envia boton directo para abrir el canal.

## Scripts disponibles

```bash
npm start
npm run check
npm run smoke
npm run pm2:start
npm run pm2:restart
```

## Recomendaciones

- Ejecuta `npm run smoke` despues de cada cambio grande.
- No elimines `dvyer-session/` ni `dvyer-session-subbot*/`.
- Haz backup de `settings/` y `database/`.
- Usa PM2 en VPS para reinicio automatico.
- Mantente en Node LTS para evitar incompatibilidades.

## Troubleshooting

- Bot no responde: `npm run smoke`.
- Error de sintaxis: `npm run check`.
- Canal no abre: revisa `settings.newsletter.url`.
- Sesion perdida: valida carpetas de sesion.

## Dueno y colaborador

<p align="center">
  <a href="https://github.com/DevYerZx" target="_blank">
    <img src="https://github.com/DevYerZx.png" width="96" height="96" alt="DevYerZx" />
  </a>
  <a href="https://github.com/crxsmods" target="_blank">
    <img src="https://github.com/crxsmods.png" width="96" height="96" alt="crxsmods" />
  </a>
</p>

<p align="center">
  <b>Dueno:</b> <a href="https://github.com/DevYerZx">DevYerZx</a><br/>
  <b>Colaborador:</b> <a href="https://github.com/crxsmods">crxsmods</a>
</p>

## Nota

Este proyecto usa Baileys (no API oficial de WhatsApp Business). Algunos cambios de WhatsApp pueden afectar funciones sin previo aviso.
