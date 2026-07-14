import fs from "fs";
import path from "path";
import dns from "dns/promises";
import * as baileysModule from "@dvyer/baileys";

const baileys = baileysModule?.default?.fetchLatestBaileysVersion
  ? baileysModule.default
  : baileysModule;

const {
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
} = baileys;

const cwd = process.cwd();
const authFolder = process.env.AUTH_FOLDER || "dvyer-session";
const runtimeStateFile = path.join(cwd, "database", "runtime", "bot-states", "main.json");
const baileysPkgFile = path.join(cwd, "node_modules", "@dvyer", "baileys", "package.json");

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

function status(ok, text) {
  return `${ok ? "OK " : "WARN"} ${text}`;
}

async function getPublicIp() {
  try {
    const response = await fetch("https://api.ipify.org?format=json", {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return "";
    const data = await response.json();
    return String(data?.ip || "");
  } catch {
    return "";
  }
}

async function lookupHost(host) {
  try {
    const result = await dns.lookup(host);
    return result?.address || "";
  } catch {
    return "";
  }
}

function inspectAuthFolder() {
  const fullPath = path.join(cwd, authFolder);
  const exists = fs.existsSync(fullPath);
  const credsFile = path.join(fullPath, "creds.json");
  const creds = readJson(credsFile, null);
  const files = exists ? fs.readdirSync(fullPath).length : 0;

  return {
    path: fullPath,
    exists,
    files,
    hasCreds: Boolean(creds),
    registered: Boolean(creds?.registered),
    me: String(creds?.me?.id || ""),
  };
}

function explainNodeVersion() {
  const major = Number(process.versions.node.split(".")[0] || 0);
  if (major === 20 || major === 22) {
    return status(true, `Node ${process.version}`);
  }
  return status(
    false,
    `Node ${process.version}. Para Baileys recomiendo Node 20 LTS o 22 LTS si el hosting lo permite.`
  );
}

async function main() {
  const pkg = readJson(baileysPkgFile, {});
  const runtime = readJson(runtimeStateFile, null);
  const auth = inspectAuthFolder();
  const latest =
    (typeof fetchLatestWaWebVersion === "function"
      ? await fetchLatestWaWebVersion().catch(() => null)
      : null) ||
    (await fetchLatestBaileysVersion().catch((error) => ({
      error: error?.message || String(error),
    })));
  const publicIp = await getPublicIp();
  const webWhatsapp = await lookupHost("web.whatsapp.com");
  const staticWhatsapp = await lookupHost("static.whatsapp.net");
  const browser = "Windows / Chrome (socket efectivo)";

  console.log("FSOCIETY pairing diagnostic");
  console.log("");
  console.log(explainNodeVersion());
  console.log(status(Boolean(pkg?.version), `@dvyer/baileys ${pkg?.version || "no instalado"}`));
  console.log(
    status(
      Array.isArray(latest?.version),
      `WA version ${Array.isArray(latest?.version) ? latest.version.join(".") : latest?.error || "no disponible"}`
    )
  );
  console.log(status(Boolean(browser), `Browser ${browser}`));
  console.log(status(Boolean(publicIp), `IP publica ${publicIp || "no detectada"}`));
  console.log(status(Boolean(webWhatsapp), `DNS web.whatsapp.com ${webWhatsapp || "fallo"}`));
  console.log(status(Boolean(staticWhatsapp), `DNS static.whatsapp.net ${staticWhatsapp || "fallo"}`));
  console.log("");
  console.log(status(auth.exists, `Auth folder ${auth.path}`));
  console.log(status(auth.files > 0, `Auth files ${auth.files}`));
  console.log(status(auth.hasCreds, `Creds ${auth.hasCreds ? "presentes" : "no presentes"}`));
  console.log(status(auth.registered, `Sesion registrada ${auth.registered ? "si" : "no"}`));
  if (auth.me) console.log(`INFO Cuenta auth ${auth.me}`);
  console.log("");

  if (runtime) {
    const cooldownUntil = Number(runtime.pairingCooldownUntil || 0);
    const cooldownMs = Math.max(0, cooldownUntil - Date.now());
    console.log(`INFO Runtime state ${runtime.connectionState || "sin_estado"}`);
    console.log(`INFO Last disconnect ${Number(runtime.lastDisconnectCode || 0) || "sin_codigo"}`);
    if (cooldownMs > 0) {
      console.log(`WARN Cooldown 405 activo aprox ${Math.ceil(cooldownMs / 60000)} min`);
    }
  } else {
    console.log("INFO Runtime state no encontrado");
  }

  console.log("");
  console.log("Si QR y codigo fallan con 405 inmediato, WhatsApp esta rechazando la IP/sesion antes de vincular.");
  console.log("Prueba una sola vez despues del cooldown con Node 20/22 LTS y otra IP/VPS si vuelve a pasar.");
}

main().catch((error) => {
  console.error("Diagnostico fallo:", error?.message || error);
  process.exitCode = 1;
});
