const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;
let sharpLoader = null;

async function getSharp() {
  if (!sharpLoader) {
    sharpLoader = import("sharp")
      .then((mod) => mod?.default || mod)
      .catch(() => null);
  }

  return sharpLoader;
}

function escapeXml(value = "") {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function wrapText(value = "", maxChars = 34, maxLines = 3) {
  const words = normalizeText(value).split(" ").filter(Boolean);
  if (!words.length) return [];

  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }

    if (current) lines.push(current);
    current = word;

    if (lines.length >= maxLines - 1) break;
  }

  const remainingWords = words.slice(lines.join(" ").split(" ").filter(Boolean).length);
  const tail = normalizeText([current, ...remainingWords].filter(Boolean).join(" "));
  if (tail) {
    lines.push(tail.length > maxChars ? `${tail.slice(0, Math.max(0, maxChars - 3)).trim()}...` : tail);
  }

  return lines.slice(0, maxLines);
}

function buildTheme(action = "add") {
  if (action === "remove") {
    return {
      accent: "#fb7185",
      accentSoft: "#fecdd3",
      start: "#220f16",
      end: "#451a24",
      badge: "HASTA LUEGO",
      title: "Salida del grupo",
    };
  }

  return {
    accent: "#22d3ee",
    accentSoft: "#ccfbf1",
    start: "#071421",
    end: "#12324a",
    badge: "BIENVENIDO",
    title: "Nuevo integrante",
  };
}

async function fetchAsDataUri(url = "") {
  const target = String(url || "").trim();
  if (!target) return "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(target, {
      headers: {
        "user-agent": "fsociety-bot/1.0",
      },
      signal: controller.signal,
    });

    if (!response.ok) return "";
    const type = String(response.headers.get("content-type") || "image/jpeg").trim() || "image/jpeg";
    const arrayBuffer = await response.arrayBuffer();
    return `data:${type};base64,${Buffer.from(arrayBuffer).toString("base64")}`;
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function buildFallbackAvatarLabel(userTag = "") {
  const cleaned = normalizeText(userTag).replace(/^@/, "");
  if (!cleaned) return "FS";
  return cleaned.slice(0, 2).toUpperCase();
}

export async function createWelcomeCard({
  action = "add",
  userTag = "",
  groupName = "",
  totalMembers = 0,
  botName = "",
  mainText = "",
  avatarUrl = "",
  groupImageUrl = "",
}) {
  const theme = buildTheme(action);
  const sharp = await getSharp();
  if (!sharp) return null;

  const avatarData = await fetchAsDataUri(avatarUrl);
  const groupData = await fetchAsDataUri(groupImageUrl);

  const titleLines = wrapText(groupName || "Grupo", 26, 2);
  const bodyLines = wrapText(mainText || "", 42, 3);
  const safeUser = escapeXml(userTag || "@usuario");
  const safeBot = escapeXml(botName || "Bot");
  const safeMembers = escapeXml(String(Math.max(0, Number(totalMembers || 0))));
  const initials = escapeXml(buildFallbackAvatarLabel(userTag));

  const titleSvg = titleLines
    .map(
      (line, index) =>
        `<tspan x="440" dy="${index === 0 ? 0 : 54}">${escapeXml(line)}</tspan>`
    )
    .join("");

  const bodySvg = bodyLines
    .map(
      (line, index) =>
        `<tspan x="440" dy="${index === 0 ? 0 : 34}">${escapeXml(line)}</tspan>`
    )
    .join("");

  const svg = `
  <svg width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" fill="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
        <stop stop-color="${theme.start}"/>
        <stop offset="1" stop-color="${theme.end}"/>
      </linearGradient>
      <linearGradient id="glow" x1="230" y1="90" x2="970" y2="520" gradientUnits="userSpaceOnUse">
        <stop stop-color="${theme.accent}" stop-opacity="0.48"/>
        <stop offset="1" stop-color="#ffffff" stop-opacity="0.08"/>
      </linearGradient>
      <linearGradient id="avatarBg" x1="120" y1="155" x2="360" y2="415" gradientUnits="userSpaceOnUse">
        <stop stop-color="${theme.accent}"/>
        <stop offset="1" stop-color="${theme.end}"/>
      </linearGradient>
      <clipPath id="avatarClip">
        <circle cx="240" cy="285" r="116"/>
      </clipPath>
      <clipPath id="groupClip">
        <rect x="840" y="72" width="276" height="176" rx="32"/>
      </clipPath>
      <filter id="blur" x="-10%" y="-10%" width="120%" height="120%">
        <feGaussianBlur stdDeviation="36"/>
      </filter>
    </defs>

    <rect width="1200" height="630" rx="36" fill="url(#bg)"/>
    ${groupData ? `<image href="${groupData}" x="-40" y="-40" width="1280" height="710" preserveAspectRatio="xMidYMid slice" opacity="0.16" filter="url(#blur)"/>` : ""}
    <circle cx="1040" cy="90" r="160" fill="${theme.accent}" opacity="0.14"/>
    <circle cx="120" cy="560" r="170" fill="${theme.accent}" opacity="0.10"/>
    <rect x="44" y="44" width="1112" height="542" rx="34" fill="url(#glow)" opacity="0.70"/>
    <rect x="58" y="58" width="1084" height="514" rx="30" fill="#071018" fill-opacity="0.52" stroke="rgba(255,255,255,0.10)"/>

    <rect x="84" y="84" width="170" height="44" rx="22" fill="${theme.accent}"/>
    <text x="169" y="113" text-anchor="middle" fill="#04131b" font-size="22" font-family="Arial, sans-serif" font-weight="700">${theme.badge}</text>

    <circle cx="240" cy="285" r="132" fill="rgba(255,255,255,0.08)"/>
    <circle cx="240" cy="285" r="122" fill="url(#avatarBg)" opacity="0.86"/>
    ${
      avatarData
        ? `<image href="${avatarData}" x="124" y="169" width="232" height="232" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)"/>`
        : `<text x="240" y="304" text-anchor="middle" fill="#f8fafc" font-size="72" font-family="Arial, sans-serif" font-weight="700">${initials}</text>`
    }
    <circle cx="240" cy="285" r="116" stroke="${theme.accentSoft}" stroke-opacity="0.85" stroke-width="6"/>

    <text x="440" y="142" fill="#e6f7ff" font-size="28" font-family="Arial, sans-serif" font-weight="600">FSOCIETY BOT</text>
    <text x="440" y="198" fill="#ffffff" font-size="54" font-family="Arial, sans-serif" font-weight="700">${theme.title}</text>
    <text x="440" y="262" fill="#ffffff" font-size="46" font-family="Arial, sans-serif" font-weight="700">${titleSvg}</text>

    <text x="440" y="388" fill="#c7d2fe" font-size="30" font-family="Arial, sans-serif" font-weight="600">Para ${safeUser}</text>
    <text x="440" y="438" fill="#dbeafe" font-size="26" font-family="Arial, sans-serif">${bodySvg}</text>

    <rect x="440" y="490" width="230" height="62" rx="20" fill="rgba(255,255,255,0.08)"/>
    <rect x="692" y="490" width="190" height="62" rx="20" fill="rgba(255,255,255,0.08)"/>
    <text x="462" y="516" fill="${theme.accentSoft}" font-size="18" font-family="Arial, sans-serif" font-weight="700">MIEMBROS</text>
    <text x="462" y="542" fill="#ffffff" font-size="28" font-family="Arial, sans-serif" font-weight="700">${safeMembers}</text>
    <text x="714" y="516" fill="${theme.accentSoft}" font-size="18" font-family="Arial, sans-serif" font-weight="700">BOT</text>
    <text x="714" y="542" fill="#ffffff" font-size="28" font-family="Arial, sans-serif" font-weight="700">${safeBot}</text>

    <rect x="840" y="72" width="276" height="176" rx="32" fill="rgba(255,255,255,0.08)"/>
    ${
      groupData
        ? `<image href="${groupData}" x="840" y="72" width="276" height="176" preserveAspectRatio="xMidYMid slice" clip-path="url(#groupClip)" opacity="0.88"/>`
        : ""
    }
    <rect x="840" y="200" width="276" height="48" rx="0" fill="rgba(7,16,24,0.58)"/>
    <text x="862" y="230" fill="#ffffff" font-size="22" font-family="Arial, sans-serif" font-weight="700">Grupo</text>
    <text x="862" y="256" fill="#dbeafe" font-size="18" font-family="Arial, sans-serif">${escapeXml(
      wrapText(groupName || "Grupo", 22, 1)[0] || "Grupo"
    )}</text>
  </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
