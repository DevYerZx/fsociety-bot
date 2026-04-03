import os from "os";

const TEST_HOST = "https://speed.cloudflare.com";
const TRACE_HOST = "https://1.1.1.1/cdn-cgi/trace";
const PING_SAMPLES = 3;
const DEFAULT_DOWNLOAD_BYTES = 16_000_000;
const DEFAULT_UPLOAD_BYTES = 4_000_000;
const REQUEST_TIMEOUT_MS = 45_000;
const TRACE_TIMEOUT_MS = 8_000;

const DEFAULT_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  accept: "*/*",
  "accept-language": "es-419,es;q=0.9,en;q=0.8",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

const CF_HEADERS = {
  ...DEFAULT_HEADERS,
  origin: TEST_HOST,
  referer: `${TEST_HOST}/`,
};

const DOWNLOAD_FALLBACKS = [
  {
    name: "Cloudflare",
    buildUrl: (bytesWanted) => `${TEST_HOST}/__down?bytes=${bytesWanted}&r=${Date.now()}`,
    headers: CF_HEADERS,
  },
  {
    name: "Hetzner",
    url: "https://speed.hetzner.de/100MB.bin",
    headers: DEFAULT_HEADERS,
    supportsRange: true,
  },
  {
    name: "OVH",
    url: "https://proof.ovh.net/files/100Mb.dat",
    headers: DEFAULT_HEADERS,
    supportsRange: true,
  },
  {
    name: "Cachefly",
    url: "https://cachefly.cachefly.net/100mb.test",
    headers: DEFAULT_HEADERS,
    supportsRange: true,
  },
];

const UPLOAD_FALLBACKS = [
  {
    name: "Cloudflare",
    buildUrl: () => `${TEST_HOST}/__up?r=${Date.now()}`,
    headers: CF_HEADERS,
  },
  {
    name: "Postman",
    url: "https://postman-echo.com/post",
    headers: DEFAULT_HEADERS,
  },
  {
    name: "Httpbin",
    url: "https://httpbin.org/post",
    headers: DEFAULT_HEADERS,
  },
];

let activeSpeedtest = null;

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function formatMbps(bytes, ms) {
  const totalMs = Math.max(1, Number(ms || 0));
  const mbps = ((Number(bytes || 0) * 8) / (totalMs / 1000)) / 1_000_000;
  return `${mbps.toFixed(2)} Mbps`;
}

function formatMs(value) {
  return `${Number(value || 0).toFixed(0)} ms`;
}

function average(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, current) => sum + current, 0) / values.length;
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function stdDev(values = []) {
  if (!values.length) return 0;
  const avg = average(values);
  const variance = average(values.map((v) => (v - avg) ** 2));
  return Math.sqrt(variance);
}

function formatPercent(value) {
  const v = clampNumber(value, 0, 100);
  return `${v.toFixed(0)}%`;
}

async function readResponseBytes(response) {
  if (!response?.body?.getReader) {
    const payload = await response.arrayBuffer();
    return payload.byteLength;
  }

  const reader = response.body.getReader();
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value?.byteLength || 0;
  }

  return total;
}

async function readResponseBytesLimited(response, limitBytes) {
  const limit = Number(limitBytes || 0);
  if (!limit || limit <= 0) {
    return await readResponseBytes(response);
  }

  if (!response?.body?.getReader) {
    const payload = await response.arrayBuffer();
    return Math.min(payload.byteLength, limit);
  }

  const reader = response.body.getReader();
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value?.byteLength || 0;
    if (total >= limit) {
      try {
        await reader.cancel();
      } catch {}
      break;
    }
  }

  return total;
}

async function runTimedFetch(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = process.hrtime.bigint();

  try {
    const headers = {
      ...(DEFAULT_HEADERS || {}),
      ...(options?.headers || {}),
    };
    const response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return { response, startedAt };
  } finally {
    clearTimeout(timeout);
  }
}

async function measurePing() {
  const samples = [];
  let useFallback = false;

  for (let index = 0; index < PING_SAMPLES; index += 1) {
    try {
      const query = `${TEST_HOST}/__down?bytes=1&r=${Date.now()}-${index}`;
      const { response, startedAt } = await runTimedFetch(query, { method: "GET", headers: CF_HEADERS });
      await readResponseBytesLimited(response, 8_192);
      const endedAt = process.hrtime.bigint();
      samples.push(Number(endedAt - startedAt) / 1_000_000);
    } catch {
      useFallback = true;
      break;
    }
  }

  if (useFallback) {
    samples.length = 0;
    for (let index = 0; index < PING_SAMPLES; index += 1) {
      const query = `${TRACE_HOST}?r=${Date.now()}-${index}`;
      const { response, startedAt } = await runTimedFetch(
        query,
        { method: "GET", headers: DEFAULT_HEADERS },
        TRACE_TIMEOUT_MS
      );
      await readResponseBytesLimited(response, 8_192);
      const endedAt = process.hrtime.bigint();
      samples.push(Number(endedAt - startedAt) / 1_000_000);
    }
  }

  const jitter = stdDev(samples);
  return {
    samples,
    averageMs: average(samples),
    bestMs: Math.min(...samples),
    jitterMs: jitter,
  };
}

async function measureDownload(bytesToDownload) {
  const bytesWanted = Math.max(1_000_000, Number(bytesToDownload || DEFAULT_DOWNLOAD_BYTES));
  let lastError = "No pude medir descarga.";

  for (const provider of DOWNLOAD_FALLBACKS) {
    try {
      const url = provider.buildUrl ? provider.buildUrl(bytesWanted) : provider.url;
      const headers = { ...(provider.headers || {}) };

      if (provider.supportsRange) {
        headers.range = `bytes=0-${bytesWanted - 1}`;
      }

      const { response, startedAt } = await runTimedFetch(url, { method: "GET", headers });
      const bytes = await readResponseBytesLimited(response, bytesWanted);
      const endedAt = process.hrtime.bigint();
      const elapsedMs = Number(endedAt - startedAt) / 1_000_000;

      return {
        ok: true,
        provider: provider.name,
        sourceUrl: url,
        bytes,
        elapsedMs,
        speedLabel: formatMbps(bytes, elapsedMs),
      };
    } catch (error) {
      lastError = `${provider.name}: ${error?.message || error}`;
      continue;
    }
  }

  return {
    ok: false,
    provider: "",
    sourceUrl: "",
    bytes: 0,
    elapsedMs: 0,
    speedLabel: "0.00 Mbps",
    error: lastError,
  };
}

async function measureUpload(bytesToUpload) {
  const bytesWanted = Math.max(500_000, Number(bytesToUpload || DEFAULT_UPLOAD_BYTES));
  // Evita que algunos endpoints bloqueen cargas grandes.
  const payloadSize = clampNumber(bytesWanted, 500_000, 4_000_000);
  const payload = Buffer.alloc(payloadSize, 97);
  let lastError = "No pude medir subida.";

  for (const provider of UPLOAD_FALLBACKS) {
    try {
      const url = provider.buildUrl ? provider.buildUrl() : provider.url;
      const headers = {
        ...(provider.headers || {}),
        "content-type": "application/octet-stream",
        "content-length": String(payload.length),
      };

      const { response, startedAt } = await runTimedFetch(url, {
        method: "POST",
        headers,
        body: payload,
      });

      await response.text();
      const endedAt = process.hrtime.bigint();
      const elapsedMs = Number(endedAt - startedAt) / 1_000_000;

      return {
        ok: true,
        provider: provider.name,
        sourceUrl: url,
        bytes: payload.length,
        elapsedMs,
        speedLabel: formatMbps(payload.length, elapsedMs),
      };
    } catch (error) {
      lastError = `${provider.name}: ${error?.message || error}`;
      continue;
    }
  }

  return {
    ok: false,
    provider: "",
    sourceUrl: "",
    bytes: payload.length,
    elapsedMs: 0,
    speedLabel: "0.00 Mbps",
    error: lastError,
  };
}

async function fetchTraceInfo() {
  try {
    const { response } = await runTimedFetch(
      TRACE_HOST,
      { method: "GET", headers: { "user-agent": "fsociety-bot-speedtest/1.0" } },
      TRACE_TIMEOUT_MS
    );
    const text = await response.text();
    const info = {};
    for (const line of String(text || "").split("\n")) {
      const [key, value] = line.split("=");
      if (!key || value == null) continue;
      info[String(key).trim()] = String(value).trim();
    }
    return {
      ip: info.ip || "",
      loc: info.loc || "",
      colo: info.colo || "",
      warp: info.warp || "",
    };
  } catch {
    return null;
  }
}

function parseMbps(label = "") {
  const match = String(label || "").match(/([\d.]+)\s*Mbps/i);
  if (!match?.[1]) return 0;
  const v = Number(match[1]);
  return Number.isFinite(v) ? v : 0;
}

function buildBar(valuePct) {
  const pct = clampNumber(valuePct, 0, 100);
  const total = 24;
  const filled = Math.round((pct / 100) * total);
  return "█".repeat(filled) + "░".repeat(Math.max(0, total - filled));
}

function buildSvgReport(result, meta) {
  const dl = parseMbps(result?.download?.speedLabel);
  const ul = parseMbps(result?.upload?.speedLabel);
  const ping = Number(result?.ping?.averageMs || 0);
  const jitter = Number(result?.ping?.jitterMs || 0);

  // Normalizadores visuales: no es un "tope" real, solo para el gráfico.
  const dlPct = clampNumber((dl / 300) * 100, 0, 100);
  const ulPct = clampNumber((ul / 150) * 100, 0, 100);
  const pingPct = clampNumber(((300 - Math.min(300, ping)) / 300) * 100, 0, 100);
  const jitterPct = clampNumber(((100 - Math.min(100, jitter)) / 100) * 100, 0, 100);

  const title = "FSOCIETY SPEEDTEST";
  const dlSource = result?.download?.provider ? `DL: ${result.download.provider}` : "DL: ?";
  const ulSource = result?.upload?.provider ? `UL: ${result.upload.provider}` : "UL: ?";
  const subtitle = `Fuente: ${dlSource} | ${ulSource}`;
  const ipLine = meta?.ip ? `IP: ${meta.ip}  COLO: ${meta.colo || "?"}  LOC: ${meta.loc || "?"}` : "";
  const hostLine = `Host: ${os.hostname()}  OS: ${os.platform()} ${os.release()}`;
  const timeLine = `Hora: ${new Date(result?.finishedAt || Date.now()).toLocaleString("es-PE")}`;

  const dlBar = buildBar(dlPct);
  const ulBar = buildBar(ulPct);
  const pingBar = buildBar(pingPct);
  const jitBar = buildBar(jitterPct);

  const bg1 = "#070A12";
  const bg2 = "#0B1A2B";
  const neon = "#00F5D4";
  const neon2 = "#3A86FF";
  const warn = "#FFD166";
  const text = "#EAF2FF";
  const muted = "#93A4C7";

  const width = 980;
  const height = 560;

  // SVG simple para poder renderizar sin depender de fonts externos.
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${bg1}"/>
      <stop offset="1" stop-color="${bg2}"/>
    </linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="6" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <rect x="0" y="0" width="${width}" height="${height}" rx="22" fill="url(#bg)"/>
  <rect x="18" y="18" width="${width - 36}" height="${height - 36}" rx="18" fill="none" stroke="${neon2}" stroke-opacity="0.35"/>

  <text x="48" y="72" fill="${text}" font-size="34" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700">${title}</text>
  <text x="48" y="104" fill="${muted}" font-size="16" font-family="DejaVu Sans, Arial, sans-serif">${subtitle}</text>

  <g filter="url(#glow)">
    <circle cx="${width - 72}" cy="64" r="10" fill="${neon}"/>
  </g>
  <text x="${width - 140}" y="70" fill="${text}" font-size="16" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700">ONLINE</text>

  <g>
    <text x="48" y="146" fill="${muted}" font-size="14" font-family="DejaVu Sans, Arial, sans-serif">${hostLine}</text>
    <text x="48" y="168" fill="${muted}" font-size="14" font-family="DejaVu Sans, Arial, sans-serif">${timeLine}</text>
    ${ipLine ? `<text x="48" y="190" fill="${muted}" font-size="14" font-family="DejaVu Sans, Arial, sans-serif">${ipLine}</text>` : ""}
  </g>

  <g transform="translate(48, 226)">
    <rect x="0" y="0" width="${width - 96}" height="270" rx="16" fill="#0A1220" stroke="${neon}" stroke-opacity="0.18"/>

    <text x="24" y="48" fill="${text}" font-size="18" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700">Métricas</text>

    <text x="24" y="92" fill="${muted}" font-size="14" font-family="DejaVu Sans, Arial, sans-serif">Descarga</text>
    <text x="220" y="92" fill="${text}" font-size="14" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700">${result?.download?.speedLabel || "0.00 Mbps"}</text>
    <text x="24" y="114" fill="${muted}" font-size="12" font-family="DejaVu Sans, Arial, sans-serif">${dlBar}  ${formatPercent(dlPct)}</text>

    <text x="24" y="152" fill="${muted}" font-size="14" font-family="DejaVu Sans, Arial, sans-serif">Subida</text>
    <text x="220" y="152" fill="${text}" font-size="14" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700">${result?.upload?.speedLabel || "0.00 Mbps"}</text>
    <text x="24" y="174" fill="${muted}" font-size="12" font-family="DejaVu Sans, Arial, sans-serif">${ulBar}  ${formatPercent(ulPct)}</text>

    <text x="24" y="212" fill="${muted}" font-size="14" font-family="DejaVu Sans, Arial, sans-serif">Ping</text>
    <text x="220" y="212" fill="${text}" font-size="14" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700">${formatMs(ping)}</text>
    <text x="24" y="234" fill="${muted}" font-size="12" font-family="DejaVu Sans, Arial, sans-serif">${pingBar}  ${formatPercent(pingPct)}</text>

    <text x="24" y="272" fill="${muted}" font-size="14" font-family="DejaVu Sans, Arial, sans-serif">Jitter</text>
    <text x="220" y="272" fill="${warn}" font-size="14" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700">${formatMs(jitter)}</text>
    <text x="24" y="294" fill="${muted}" font-size="12" font-family="DejaVu Sans, Arial, sans-serif">${jitBar}  ${formatPercent(jitterPct)}</text>
  </g>

  <g>
    <text x="48" y="${height - 48}" fill="${muted}" font-size="12" font-family="DejaVu Sans, Arial, sans-serif">
      Datos: DL ${formatBytes(result?.download?.bytes)} | UL ${formatBytes(result?.upload?.bytes)} | Ping samples ${PING_SAMPLES}
    </text>
  </g>
</svg>`;
}

async function renderReportPng(result) {
  try {
    const mod = await import("@resvg/resvg-js");
    const Resvg = mod?.Resvg || mod?.default?.Resvg || mod?.default;
    if (!Resvg) return null;

    const trace = await fetchTraceInfo();
    const svg = buildSvgReport(result, trace);
    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: 980 },
      background: "rgba(0,0,0,0)",
    });

    const rendered = resvg.render();
    const png = rendered.asPng();
    return Buffer.from(png);
  } catch (error) {
    console.error("SPEEDTEST RENDER ERROR:", error?.message || error);
    return null;
  }
}

async function executeSpeedtest(options = {}) {
  const startedAt = Date.now();
  const downloadBytes = Number(options?.downloadBytes || DEFAULT_DOWNLOAD_BYTES);
  const uploadBytes = Number(options?.uploadBytes || DEFAULT_UPLOAD_BYTES);
  const ping = await measurePing();
  const download = await measureDownload(downloadBytes);
  const upload = await measureUpload(uploadBytes);

  return {
    startedAt,
    finishedAt: Date.now(),
    ping,
    download,
    upload,
  };
}

function buildResultMessage(result) {
  const totalTimeMs = Math.max(0, Number(result?.finishedAt || 0) - Number(result?.startedAt || 0));

  const dlOk = result?.download?.ok !== false;
  const ulOk = result?.upload?.ok !== false;
  const dlProvider = result?.download?.provider ? ` (${result.download.provider})` : "";
  const ulProvider = result?.upload?.provider ? ` (${result.upload.provider})` : "";

  return (
    `*SPEEDTEST BOT*\n\n` +
    `Fuente: *Cloudflare/Alternativo*\n` +
    `Ping promedio: *${formatMs(result?.ping?.averageMs)}*\n` +
    `Ping mejor: *${formatMs(result?.ping?.bestMs)}*\n` +
    `Jitter: *${formatMs(result?.ping?.jitterMs)}*\n` +
    `Descarga: *${result?.download?.speedLabel || "0.00 Mbps"}*${dlProvider}\n` +
    `Subida: *${result?.upload?.speedLabel || "0.00 Mbps"}*${ulProvider}\n` +
    `Datos descarga: *${formatBytes(result?.download?.bytes)}*${dlOk ? "" : " (fallo)" }\n` +
    `Datos subida: *${formatBytes(result?.upload?.bytes)}*${ulOk ? "" : " (fallo)" }\n` +
    `Tiempo total: *${formatMs(totalTimeMs)}*`
  );
}

function buildErrorMessage(error) {
  const message = String(error?.message || error || "Error desconocido");

  return (
    `No pude completar el speedtest.\n` +
    `Motivo: *${message}*\n\n` +
    `Posibles causas:\n` +
    `- el hosting bloquea pruebas de red\n` +
    `- la salida HTTP esta limitada\n` +
    `- la conexion del servidor esta inestable`
  );
}

export default {
  name: "speedtest",
  command: ["speedtest"],
  category: "sistema",
  description: "Mide ping, descarga y subida del internet del bot",

  run: async ({ sock, msg, from, args = [] }) => {
    if (activeSpeedtest) {
      return sock.sendMessage(
        from,
        {
          text: "Ya hay un speedtest en progreso. Espera a que termine.",
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }

    const mode = String(args?.[0] || "").trim().toLowerCase();
    const isFull = mode === "full" || mode === "pro" || mode === "completo";
    const isLite = mode === "lite" || mode === "rapido" || mode === "fast";
    const downloadBytes = isFull ? 40_000_000 : isLite ? 8_000_000 : DEFAULT_DOWNLOAD_BYTES;
    const uploadBytes = isFull ? 12_000_000 : isLite ? 2_000_000 : DEFAULT_UPLOAD_BYTES;

    await sock.sendMessage(
      from,
      {
        text:
          "*Iniciando speedtest del bot...*\n\n" +
          "Estoy midiendo ping, descarga y subida. Esto puede tardar unos segundos.\n" +
          `Modo: *${isFull ? "COMPLETO" : isLite ? "RAPIDO" : "NORMAL"}*`,
        ...global.channelInfo,
      },
      { quoted: msg }
    );

    activeSpeedtest = executeSpeedtest({ downloadBytes, uploadBytes });

    try {
      const result = await activeSpeedtest;
      const reportPng = await renderReportPng(result);

      if (reportPng) {
        return sock.sendMessage(
          from,
          {
            image: reportPng,
            caption: buildResultMessage(result),
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      }

      return sock.sendMessage(
        from,
        { text: buildResultMessage(result), ...global.channelInfo },
        { quoted: msg }
      );
    } catch (error) {
      console.error("SPEEDTEST ERROR:", error);

      return sock.sendMessage(
        from,
        {
          text: buildErrorMessage(error),
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    } finally {
      activeSpeedtest = null;
    }
  },
};
