
<p align="center">
  <a href="https://chat.whatsapp.com/GuLWXlFUdy3BJA9OXcc1Hj" target="_blank">
    <img src="https://img.shields.io/badge/Entrar%20a%20la%20Comunidad-25D366?style=for-the-badge&logo=whatsapp&logoColor=white" alt="Entrar a la Comunidad" />
  </a>
  <a href="https://chat.whatsapp.com/KlZkjuAparjBga0ZJdhuHM?mode=gi_t" target="_blank">
    <img src="https://img.shields.io/badge/Quiero%20Ser%20Bot%20Gratis-128C7E?style=for-the-badge&logo=whatsapp&logoColor=white" alt="Quiero Ser Bot Gratis" />
  </a>
  <a href="https://chat.whatsapp.com/HARewZpP3KSDTFMLLiDQnl?mode=gi_t" target="_blank">
    <img src="https://img.shields.io/badge/Unirme%20al%20Grupo-1EBEA5?style=for-the-badge&logo=whatsapp&logoColor=white" alt="Unirme al Grupo" />
  </a>
</p>




<p align="center">
  <img src="assets/profile/fsociety-bot-profile.png" alt="FSociety Bot" width="150" />
</p>

<h1 align="center">FSociety Bot</h1>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18%2B-43853D?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js 18+" />
  <img src="https://img.shields.io/badge/Baileys-MultiBot-25D366?style=for-the-badge&logo=whatsapp&logoColor=white" alt="Baileys MultiBot" />
  <img src="https://img.shields.io/badge/PM2-Ready-2B037A?style=for-the-badge&logo=pm2&logoColor=white" alt="PM2 Ready" />
</p>

<p align="center">
Bot de WhatsApp multi-instancia hecho con Baileys, pensado para correr como bot principal y tambien como sistema de subbots. Incluye comandos de administracion, descargas, juegos, economia, utilidades de grupo, herramientas de sistema y paneles de control para VPS y hosting.
</p>

## Tabla De Contenido

- [Resumen](#resumen)
- [Funciones Principales](#funciones-principales)
- [Requisitos](#requisitos)
- [Instalacion Rapida](#instalacion-rapida)
- [Instalacion En Termux](#instalacion-en-termux)
- [Instalacion En PC O VPS Linux](#instalacion-en-pc-o-vps-linux)
- [Instalacion En Windows](#instalacion-en-windows)
- [Ejecucion Con PM2](#ejecucion-con-pm2)
- [Uso En Hosting](#uso-en-hosting)
- [Configuracion Inicial](#configuracion-inicial)
- [Webhook Interno Seguro](#webhook-interno-seguro)
- [Primer Vinculado](#primer-vinculado)
- [Subbots](#subbots)
- [Scripts Disponibles](#scripts-disponibles)
- [Estructura Del Proyecto](#estructura-del-proyecto)
- [Recomendaciones](#recomendaciones)

## Resumen

FSociety Bot esta preparado para:

- correr como bot principal
- generar pairing code del bot principal por consola
- manejar subbots por slots
- trabajar en VPS con PM2 o en hosting administrado
- guardar sesiones por carpeta para no perder la vinculacion
- usar categorias de comandos separadas por modulo

## Funciones Principales

| Area | Incluye |
| --- | --- |
| Administracion | `eval`, `exec`, `join`, `leave`, `getfile`, `vip`, `setvar` |
| Grupos | `antilink`, `antispam`, `antiflood`, `antifake`, `welcome`, `modoadmi` |
| Descargas | YouTube MP3/MP4, TikTok, Spotify, Instagram, Facebook, MediaFire, Mega |
| Juegos | trivia, ahorcado, piedra papel tijera, tictactoe, adivina, emoji quiz |
| Economia | coins, banco, daily, transferencias, shop, solicitudes |
| Sistema | status, botinfo, backup, restore, update, dashboard, autosetup |
| Subbots | slots, pairing publico, panel de estado, liberacion y reset |

## Requisitos

Antes de iniciar, ten instalado lo siguiente:

- Node.js 18 o superior
- npm
- git
- ffmpeg
- PM2 opcional, recomendado para VPS

Tambien es importante conservar estas rutas si usas hosting o reinicios automaticos:

- `settings/`
- `database/`
- `dvyer-session/`
- `dvyer-session-subbot*/`

## Instalacion Rapida

```bash
git clone https://github.com/DevYerZx/fsociety-bot.git
cd fsociety-bot
npm install
npm start
```

## <img src="https://cdn.simpleicons.org/android/3DDC84" alt="Termux" width="18" /> Instalacion En Termux

Usa Termux actualizado desde **F-Droid** o **GitHub Releases**. Las builds viejas de Play Store ya no son recomendadas por el proyecto Termux.

### 1. Actualiza paquetes

```bash
pkg update -y
pkg upgrade -y
```

### 2. Instala dependencias

```bash
pkg install -y git nodejs-lts npm ffmpeg
termux-setup-storage
```

Notas:

- `nodejs-lts` y `npm` dejan el entorno mas estable para este bot.
- No uses `pkg install nodejs` en este repo, porque Termux te quita `nodejs-lts` y puede romper la instalacion.
- Este repo ya no depende de `sharp`, para evitar fallas de instalacion en Termux.

### 3. Clona el repositorio

```bash
git clone https://github.com/DevYerZx/fsociety-bot.git
cd fsociety-bot
```

### 4. Instala paquetes de Node

```bash
npm install
```

Si ves un error aislado de red con dependencias de GitHub, reintenta:

```bash
npm install --fetch-retries=5
```

### 5. Inicia el bot

```bash
npm start
```

Si Termux te da problemas de memoria durante `npm install`, prueba:

```bash
npm cache clean --force
```

Si `pkg` falla al instalar paquetes, cambia el mirror y vuelve a actualizar:

```bash
termux-change-repo
pkg update -y
pkg upgrade -y
```

Si ya instalaste `nodejs` y te removio `nodejs-lts`, recupera asi:

```bash
pkg uninstall -y nodejs
pkg install -y nodejs-lts npm
```

Si `npm install` falla con `git dep preparation failed`:

```bash
rm -rf node_modules package-lock.json
npm cache clean --force
npm install --legacy-peer-deps
```

## <img src="https://cdn.simpleicons.org/linux/FCC624" alt="Linux" width="18" /> Instalacion En PC O VPS Linux

### Ubuntu o Debian

```bash
sudo apt update
sudo apt install -y git ffmpeg curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### Clonar e instalar

```bash
git clone https://github.com/DevYerZx/fsociety-bot.git
cd fsociety-bot
npm install
```

### Ejecutar

```bash
npm start
```

## Instalacion En Windows

### 1. Instala

- Node.js LTS
- Git
- FFmpeg con la variable `PATH` configurada

### 2. Clona el proyecto

Abre PowerShell dentro de la carpeta donde quieras guardar el bot y ejecuta:

```powershell
git clone https://github.com/DevYerZx/fsociety-bot.git
cd fsociety-bot
npm install
npm start
```

## <img src="https://cdn.simpleicons.org/pm2/2B037A" alt="PM2" width="18" /> Ejecucion Con PM2

Ideal para VPS o servidores donde quieras que el bot se reinicie solo.

### Instalar PM2

```bash
npm install -g pm2
```

### Iniciar con el ecosystem del proyecto

```bash
npm run pm2:start
```

### Reiniciar

```bash
npm run pm2:restart
```

### Ver logs

```bash
pm2 logs
```

### Guardar proceso para arranque automatico

```bash
pm2 save
pm2 startup
```

El archivo `ecosystem.config.cjs` ya esta preparado para levantar `main` y los subbots activos cuando corresponda.

## Uso En Hosting

<p>
  <img src="https://cdn.simpleicons.org/railway" alt="Railway" width="18" />
  <img src="https://cdn.simpleicons.org/render" alt="Render" width="18" />
  <img src="https://cdn.simpleicons.org/pterodactyl" alt="Pterodactyl" width="18" />
  <img src="https://cdn.simpleicons.org/koyeb" alt="Koyeb" width="18" />
</p>

Este proyecto detecta varios entornos administrados como:

- Railway
- Render
- Pterodactyl
- Koyeb
- Heroku

### Configuracion recomendada

| Campo | Valor sugerido |
| --- | --- |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Node Version | 18 o superior |
| Disco persistente | obligatorio |

### Importante en hosting

- Debes mantener almacenamiento persistente para no perder sesiones.
- Si tu hosting borra archivos al reiniciar, tendras que volver a vincular el bot.
- `ffmpeg` debe estar disponible en el sistema si usaras comandos multimedia.
- Para VPS con varios procesos, PM2 es la opcion mas estable.

## Configuracion Inicial

La configuracion principal esta en:

- `settings/settings.json`

Campos que normalmente vas a editar:

| Campo | Uso |
| --- | --- |
| `botName` | nombre visible del bot |
| `ownerName` | nombre del owner |
| `ownerNumbers` | numeros autorizados |
| `ownerLids` | LIDs del owner si usas ese formato |
| `prefix` | prefijos permitidos |
| `botNumber` | numero principal del bot |
| `pairingNumber` | numero para pairing automatico del bot principal |
| `subbot.publicRequests` | activa o desactiva pedidos publicos |
| `subbot.maxSlots` | cantidad de slots disponibles |
| `newsletter` | datos del canal o newsletter |

Ejemplo rapido:

```json
{
  "botName": "Fsociety bot",
  "ownerName": "DVYER",
  "prefix": [".", "/", "!", "#"],
  "ownerNumbers": ["51999999999"],
  "botNumber": "51999999999",
  "pairingNumber": ""
}
```

## Webhook Interno Seguro

Si quieres conectar este bot a un panel web para pedir subbots desde una pagina, este repo ya puede recibir solicitudes internas sin exponer datos sensibles del VPS.

### Variables recomendadas

Usa el archivo `.env.example` como base:

```bash
cp .env.example .env
```

Variables:

| Variable | Uso |
| --- | --- |
| `INTERNAL_WEBHOOK_TOKEN` | token obligatorio para `POST /internal/subbot/request` |
| `INTERNAL_WEBHOOK_ALLOWED_IPS` | lista opcional de IPs permitidas para el webhook |
| `PANEL_BASE_URL` | URL base del panel, por ejemplo `https://panel.midominio.com` |
| `PANEL_CALLBACK_URL` | opcional, si quieres fijar la ruta exacta del callback |
| `PANEL_CALLBACK_TOKEN` | token que el bot usara para responder al panel |
| `DASHBOARD_TOKEN` | protege `/json` si decides publicarlo |

### Endpoint interno

Ruta:

`POST /internal/subbot/request`

Header:

`x-bot-webhook-token: <INTERNAL_WEBHOOK_TOKEN>`

Payload minimo:

```json
{
  "requestToken": "abc123",
  "phoneNumber": "51999111222",
  "subbotName": "subbot-demo",
  "ownerName": "dvyer"
}
```

### Seguridad

- no expone la IP, la ruta SSH ni las llaves del VPS
- no devuelve secretos al cliente publico
- puede limitarse por token e IP
- el callback del panel puede quedar fijo por `.env`
- `/json` y el HTML del dashboard pueden protegerse con `DASHBOARD_TOKEN`

### Flujo

1. El panel llama al webhook interno del bot.
2. El bot genera el pairing code usando su runtime real.
3. Cuando el codigo esta listo, el bot envia `POST /api/bot/pairing` al panel.
4. La web publica muestra el codigo sin hablar directo con WhatsApp.

## <img src="https://cdn.simpleicons.org/whatsapp/25D366" alt="WhatsApp" width="18" /> Primer Vinculado

En el primer arranque, el bot principal puede pedirte el numero por consola para generar el pairing code.

### Flujo recomendado

1. Ejecuta `npm start`
2. Escribe el numero del bot con codigo de pais y sin `+`
3. Espera el codigo de vinculacion
4. En WhatsApp entra a `Dispositivos vinculados`
5. Usa la opcion `Vincular con numero de telefono`
6. Ingresa el codigo mostrado en consola

Cuando el bot quede vinculado, la sesion se guardara en `dvyer-session/`.

## Subbots

El proyecto soporta multiples subbots por slots.

### Lo importante

- el bot principal debe estar vinculado primero
- los subbots usan carpetas `dvyer-session-subbot*`
- la capacidad se controla desde `settings/settings.json`
- tambien puedes administrar slots desde comandos del bot

Comandos relacionados:

- `.subbot`
- `.subbots`
- `.subboton`
- `.subbotoff`

## Scripts Disponibles

| Script | Uso |
| --- | --- |
| `npm start` | inicia el bot |
| `npm run check` | revisa sintaxis del archivo principal |
| `npm run smoke` | importa comandos y detecta aliases duplicados |
| `npm run pm2:start` | inicia con PM2 |
| `npm run pm2:restart` | reinicia con PM2 |
| `bash start.sh` | inicio directo por script |

## Estructura Del Proyecto

```text
.
|-- index.js
|-- package.json
|-- ecosystem.config.cjs
|-- start.sh
|-- commands/
|   |-- admin/
|   |-- descargas/
|   |-- economia/
|   |-- grupos/
|   |-- ia/
|   |-- juegos/
|   |-- media/
|   |-- menu/
|   |-- sistema/
|   `-- subbots/
|-- lib/
|-- settings/
|-- database/
`-- assets/
```

## Recomendaciones
