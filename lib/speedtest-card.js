import fs from "fs";
import path from "path";

const CARD_WIDTH = 1280;
const CARD_HEIGHT = 720;

let sharpLoader = null;

function cleanText(value = "") {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function escapeXml(value = "") {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatMs(value = 0) {
  return `${Number(value || 0).toFixed(0)} ms`;
}

function formatMbpsValue(value = 0) {
  return `${Number(value || 0).toFixed(2)} Mbps`;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function parseSpeedLabel(label = "") {
  const match = String(label).match(/([\d.]+)\s*Mbps/i);
  const value = Number(match?.[1] || 0);
  return Number.isFinite(value) ? value : 0;
}

function buildGaugeWidth(value, max) {
  return 420 * clamp(max > 0 ? value / max : 0, 0, 1);
}

function buildTheme(quality = "ESTABLE") {
  const key = cleanText(quality).toUpperCase();

  if (key === "EXCELENTE") {
    return {
      accent: "#22c55e",
      accentSoft: "#bbf7d0",
      start: "#04140d",
      end: "#0b2e1e",
      badge: "TOP LINK",
    };
  }

  if (key === "MUY BUENA") {
    return {
      accent: "#38bdf8",
      accentSoft: "#bae6fd",
      start: "#06131f",
      end: "#10304a",
      badge: "FAST LANE",
    };
  }

  if (key === "LIMITADA") {
    return {
      accent: "#fb923c",
      accentSoft: "#fed7aa",
      start: "#1b1207",
      end: "#43250d",
      badge: "LOW SIGNAL",
    };
  }

  return {
    accent: "#facc15",
    accentSoft: "#fde68a",
    start: "#18140a",
    end: "#3a2d10",
    badge: "STABLE NET",
  };
}

async function getSharp() {
  if (!sharpLoader) {
    sharpLoader = import("sharp")
      .then((mod) => mod?.default || mod)
      .catch(() => null);
  }

  return sharpLoader;
}

function resolveBackgroundPath() {
  const baseDir = path.join(process.cwd(), "imagenes");
  const candidates = [
    path.join(baseDir, "menu-sistema.png"),
    path.join(baseDir, "menu.png"),
    path.join(baseDir, "fsociety-bot-profile.png"),
  ];

  return candidates.find((filePath) => fs.existsSync(filePath)) || "";
}

function getBackgroundDataUri() {
  const filePath = resolveBackgroundPath();
  if (!filePath) return "";

  try {
    const ext = path.extname(filePath).toLowerCase();
    const mimeByExt = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
    };
    const mime = mimeByExt[ext] || "image/png";
    const base64 = fs.readFileSync(filePath).toString("base64");
    return `data:${mime};base64,${base64}`;
  } catch {
    return "";
  }
}

export async function createSpeedtestCard({
  result = {},
  modeLabel = "NORMAL",
  statusLabel = "ESTABLE",
  ownerName = "DVYER",
} = {}) {
  const sharp = await getSharp();
  if (!sharp) return null;

  const theme = buildTheme(statusLabel);
  const backgroundData = getBackgroundDataUri();
  const downloadMbps = parseSpeedLabel(result?.download?.speedLabel);
  const uploadMbps = parseSpeedLabel(result?.upload?.speedLabel);
  const pingMs = Number(result?.ping?.averageMs || 0);
  const jitterMs = Number(result?.ping?.jitterMs || 0);
  const bestPingMs = Number(result?.ping?.bestMs || 0);
  const network = result?.network || {};
  const location = cleanText(network.location || network.country || "Ubicacion no detectada");
  const cloudflareNode = cleanText(network.colo || "No detectado");
  const connectionType = cleanText(network.connectionType || "No detectada");
  const downloadHost = cleanText(result?.download?.provider || "No disponible");
  const uploadHost = cleanText(result?.upload?.provider || "No disponible");
  const totalSeconds = Math.max(
    0,
    Math.round((Number(result?.finishedAt || 0) - Number(result?.startedAt || 0)) / 1000)
  );
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  const duration = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;

  const svg = `
  <svg width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1280" y2="720" gradientUnits="userSpaceOnUse">
        <stop stop-color="${theme.start}"/>
        <stop offset="1" stop-color="${theme.end}"/>
      </linearGradient>
      <linearGradient id="accent" x1="170" y1="184" x2="590" y2="184" gradientUnits="userSpaceOnUse">
        <stop stop-color="${theme.accent}"/>
        <stop offset="1" stop-color="#ffffff"/>
      </linearGradient>
      <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1">
        <stop stop-color="rgba(255,255,255,0.18)"/>
        <stop offset="1" stop-color="rgba(255,255,255,0.05)"/>
      </linearGradient>
      <filter id="blur" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="42"/>
      </filter>
    </defs>

    <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="36" fill="url(#bg)"/>
    ${
      backgroundData
        ? `<image href="${backgroundData}" x="0" y="0" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" preserveAspectRatio="xMidYMid slice" opacity="0.12" filter="url(#blur)"/>`
        : ""
    }
    <circle cx="1080" cy="120" r="180" fill="${theme.accent}" opacity="0.14"/>
    <circle cx="200" cy="650" r="220" fill="${theme.accent}" opacity="0.09"/>
    <rect x="36" y="36" width="1208" height="648" rx="32" fill="#060b12" fill-opacity="0.52" stroke="rgba(255,255,255,0.10)"/>

    <rect x="72" y="70" width="188" height="46" rx="23" fill="${theme.accent}"/>
    <text x="166" y="100" text-anchor="middle" fill="#041018" font-size="21" font-family="Arial, sans-serif" font-weight="800">${escapeXml(theme.badge)}</text>

    <text x="72" y="164" fill="#dbeafe" font-size="28" font-family="Arial, sans-serif" font-weight="700">FSOCIETY BOT</text>
    <text x="72" y="225" fill="#ffffff" font-size="56" font-family="Arial, sans-serif" font-weight="800">Internet Speed Report</text>
    <text x="72" y="268" fill="${theme.accentSoft}" font-size="24" font-family="Arial, sans-serif">Modo ${escapeXml(modeLabel)} · Calidad ${escapeXml(statusLabel)} · Duracion ${escapeXml(duration)}</text>

    <rect x="72" y="310" width="544" height="156" rx="28" fill="url(#panel)" stroke="rgba(255,255,255,0.08)"/>
    <text x="106" y="360" fill="#e5f3ff" font-size="23" font-family="Arial, sans-serif" font-weight="700">DOWNLOAD</text>
    <text x="106" y="420" fill="#ffffff" font-size="44" font-family="Arial, sans-serif" font-weight="800">${escapeXml(formatMbpsValue(downloadMbps))}</text>
    <rect x="106" y="438" width="420" height="18" rx="9" fill="rgba(255,255,255,0.10)"/>
    <rect x="106" y="438" width="${buildGaugeWidth(downloadMbps, 300)}" height="18" rx="9" fill="url(#accent)"/>
    <text x="106" y="486" fill="#bcd3e6" font-size="20" font-family="Arial, sans-serif">Host ${escapeXml(downloadHost)}</text>

    <rect x="664" y="310" width="544" height="156" rx="28" fill="url(#panel)" stroke="rgba(255,255,255,0.08)"/>
    <text x="698" y="360" fill="#e5f3ff" font-size="23" font-family="Arial, sans-serif" font-weight="700">UPLOAD</text>
    <text x="698" y="420" fill="#ffffff" font-size="44" font-family="Arial, sans-serif" font-weight="800">${escapeXml(formatMbpsValue(uploadMbps))}</text>
    <rect x="698" y="438" width="420" height="18" rx="9" fill="rgba(255,255,255,0.10)"/>
    <rect x="698" y="438" width="${buildGaugeWidth(uploadMbps, 150)}" height="18" rx="9" fill="url(#accent)"/>
    <text x="698" y="486" fill="#bcd3e6" font-size="20" font-family="Arial, sans-serif">Host ${escapeXml(uploadHost)}</text>

    <rect x="72" y="500" width="352" height="132" rx="28" fill="url(#panel)" stroke="rgba(255,255,255,0.08)"/>
    <text x="104" y="548" fill="#e5f3ff" font-size="22" font-family="Arial, sans-serif" font-weight="700">PING</text>
    <text x="104" y="602" fill="#ffffff" font-size="42" font-family="Arial, sans-serif" font-weight="800">${escapeXml(formatMs(pingMs))}</text>
    <text x="104" y="626" fill="#bcd3e6" font-size="18" font-family="Arial, sans-serif">Best ${escapeXml(formatMs(bestPingMs))}</text>

    <rect x="464" y="500" width="352" height="132" rx="28" fill="url(#panel)" stroke="rgba(255,255,255,0.08)"/>
    <text x="496" y="548" fill="#e5f3ff" font-size="22" font-family="Arial, sans-serif" font-weight="700">JITTER</text>
    <text x="496" y="602" fill="#ffffff" font-size="42" font-family="Arial, sans-serif" font-weight="800">${escapeXml(formatMs(jitterMs))}</text>
    <text x="496" y="626" fill="#bcd3e6" font-size="18" font-family="Arial, sans-serif">Muestras ${escapeXml(String(result?.ping?.samples?.length || 0))}</text>

    <rect x="856" y="500" width="352" height="132" rx="28" fill="url(#panel)" stroke="rgba(255,255,255,0.08)"/>
    <text x="888" y="548" fill="#e5f3ff" font-size="22" font-family="Arial, sans-serif" font-weight="700">NETWORK</text>
    <text x="888" y="584" fill="#ffffff" font-size="24" font-family="Arial, sans-serif" font-weight="700">${escapeXml(location)}</text>
    <text x="888" y="610" fill="#bcd3e6" font-size="18" font-family="Arial, sans-serif">Nodo ${escapeXml(cloudflareNode)} · ${escapeXml(connectionType)}</text>
    <text x="888" y="634" fill="#8fb5d4" font-size="16" font-family="Arial, sans-serif">Sin exponer IP publica ni ISP</text>

    <text x="1016" y="110" text-anchor="end" fill="rgba(255,255,255,0.72)" font-size="20" font-family="Arial, sans-serif">Powered by ${escapeXml(ownerName)}</text>
  </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
