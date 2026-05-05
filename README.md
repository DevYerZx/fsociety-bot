<p align="center">
  <a href="https://whatsapp.com/channel/120363354701957370" target="_blank">
    <img src="https://img.shields.io/badge/Canal%20WhatsApp-25D366?style=for-the-badge&logo=whatsapp&logoColor=white" alt="Canal WhatsApp" />
  </a>
  <a href="https://chat.whatsapp.com/GuLWXlFUdy3BJA9OXcc1Hj" target="_blank">
    <img src="https://img.shields.io/badge/Comunidad-128C7E?style=for-the-badge&logo=whatsapp&logoColor=white" alt="Comunidad" />
  </a>
  <a href="https://chat.whatsapp.com/FsrlWXVdG3RCLYbZ5LazBO" target="_blank">
    <img src="https://img.shields.io/badge/Soporte-1EBEA5?style=for-the-badge&logo=whatsapp&logoColor=white" alt="Soporte" />
  </a>
</p>

<p align="center">
  <img src="assets/profile/fsociety-bot-profile.png" alt="Fsociety-V1" width="140" />
</p>

<h1 align="center">Fsociety-V1</h1>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18%2B-43853D?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js 18+" />
  <img src="https://img.shields.io/badge/Baileys-MultiBot-25D366?style=for-the-badge&logo=whatsapp&logoColor=white" alt="Baileys MultiBot" />
  <img src="https://img.shields.io/badge/PM2-Ready-2B037A?style=for-the-badge&logo=pm2&logoColor=white" alt="PM2 Ready" />
</p>

Bot de WhatsApp multi-instancia con Baileys, preparado para bot principal + subbots con soporte para VPS, Termux y Windows.

## Caracteristicas

- Multi-bot por slots (main + subbots).
- Pairing por codigo.
- Menus por categorias y comandos modulares.
- Descargas, juegos, economia, admin, grupos y utilidades.
- Integracion de canal/newsletter para soporte.
- Persistencia de sesiones y datos.

## Requisitos

- Node.js 18 o superior (recomendado Node 20 LTS)
- npm
- git
- ffmpeg

## Instalacion Rapida (Linux/VPS)

```bash
git clone https://github.com/DevYerZx/fsociety-bot.git
cd fsociety-bot
npm install
npm start
```

## Instalacion en Termux

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

## Instalacion en Windows

1. Instala `Node.js LTS`, `Git` y `FFmpeg` (en PATH).
2. En PowerShell:

```powershell
git clone https://github.com/DevYerZx/fsociety-bot.git
cd fsociety-bot
npm install
npm start
```

## Scripts disponibles

```bash
npm start
npm run check
npm run smoke
npm run pm2:start
npm run pm2:restart
```

## PM2 (recomendado para VPS)

```bash
npm install -g pm2
npm run pm2:start
pm2 save
pm2 logs
```

## Configuracion importante

Archivo: `settings/settings.json`

- `botName`: nombre del bot.
- `ownerNumber` / `ownerNumbers`: dueños.
- `prefix`: prefijos de comandos.
- `subbots`: slots de subbots.
- `system.autoProfileOnConnect`: bio/foto al conectar.
- `newsletter.enabled`: habilita metadatos de canal.
- `newsletter.jid`: JID del canal (`...@newsletter`).
- `newsletter.name`: nombre del canal.
- `newsletter.url`: URL directa para boton de soporte.

Ejemplo:

```json
{
  "newsletter": {
    "enabled": true,
    "jid": "120363354701957370@newsletter",
    "name": "Fsociety-V1",
    "url": "https://whatsapp.com/channel/120363354701957370"
  }
}
```

## Boton directo al canal desde el bot

Comando:

```text
.gruposoficiales
```

Si `newsletter.url` existe, el bot envia boton directo para abrir tu canal de WhatsApp.

## Recomendaciones

- Ejecuta `npm run smoke` despues de actualizar.
- No borres carpetas de sesion: `dvyer-session/` y `dvyer-session-subbot*/`.
- Haz backup de `settings/` y `database/`.
- En VPS usa PM2 para auto-reinicio.

## Troubleshooting

- No responde comandos: `npm run smoke`.
- Error de sintaxis: `npm run check`.
- No abre canal: revisa `settings.newsletter.url`.
- Perdida de vinculacion: valida carpetas de sesion.

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

Este proyecto usa Baileys (no API oficial de WhatsApp Business). Cambios de WhatsApp pueden afectar funciones sin previo aviso.
