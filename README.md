# Fsociety-V1

Bot de WhatsApp multi-instancia con Baileys, pensado para correr como bot principal y tambien como sistema de subbots.

## Caracteristicas

- Bot principal + subbots por slots.
- Pairing por codigo para bot principal y subbots.
- Comandos por categorias (admin, grupos, descargas, juegos, economia, sistema, etc.).
- Soporte para `PM2` y entorno VPS.
- Persistencia de sesiones y base local.
- Comando `gruposoficiales` con acceso directo a soporte/comunidad.

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

## Scripts disponibles

```bash
npm start        # inicia el bot
npm run check    # validacion sintactica de index.js
npm run smoke    # chequeo rapido de comandos/carga
npm run pm2:start
npm run pm2:restart
```

## Configuracion principal

Archivo: `settings/settings.json`

Campos clave:

- `botName`: nombre mostrado del bot.
- `ownerNumber` / `ownerNumbers`: numeros owner.
- `prefix`: prefijos de comandos.
- `subbots`: configuracion de slots.
- `system.autoProfileOnConnect`: actualiza bio/foto al conectar.
- `newsletter.enabled`: activa metadatos de canal en mensajes.
- `newsletter.jid`: JID del canal (`...@newsletter`).
- `newsletter.name`: nombre visible del canal.
- `newsletter.url`: enlace directo del canal para boton de soporte.

Ejemplo minimo para soporte por canal:

```json
{
  "newsletter": {
    "enabled": true,
    "jid": "120363354701957370@newsletter",
    "name": "Fsociety-V1",
    "url": "https://whatsapp.com/channel/TU_CODIGO_DE_CANAL"
  }
}
```

## Soporte y comunidad

Comando:

```text
.gruposoficiales
```

Este comando muestra enlaces oficiales y, si `newsletter.url` esta configurado, envia tambien un boton directo para abrir el canal de WhatsApp.

## Ejecucion con PM2

```bash
npm install -g pm2
npm run pm2:start
pm2 save
pm2 logs
```

## Rutas importantes para respaldos

- `settings/`
- `database/`
- `dvyer-session/`
- `dvyer-session-subbot*/`

## Troubleshooting rapido

- Si el bot no responde: ejecuta `npm run smoke`.
- Si hay error de sintaxis: ejecuta `npm run check`.
- Si no abre el boton del canal: revisa `settings.newsletter.url`.
- Si perdiste vinculacion: valida carpetas de sesion (`dvyer-session*`).

## Nota

Este proyecto usa Baileys (no API oficial de WhatsApp Business). Cambios de WhatsApp pueden afectar funciones sin previo aviso.

## Dueno y colaboradores

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
