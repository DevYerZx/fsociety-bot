import { createSpeedtestCard } from "../../lib/speedtest-card.js";

const TEST_HOST = "https://speed.cloudflare.com";
const TRACE_HOST = "https://1.1.1.1/cdn-cgi/trace";
const IPWHO_HOST = "https://ipwho.is/";

const PING_SAMPLES = 3;
const DEFAULT_DOWNLOAD_BYTES = 16_000_000;
const DEFAULT_UPLOAD_BYTES = 4_000_000;

const REQUEST_TIMEOUT_MS = 45_000;
const TRACE_TIMEOUT_MS = 8_000;
const NETWORK_TIMEOUT_MS = 10_000;

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
    buildUrl: (bytesWanted) =>
      `${TEST_HOST}/__down?bytes=${bytesWanted}&r=${Date.now()}`,
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

function cleanText(value, fallback = "") {
  const text = String(value ?? "").trim();
  if (!text || text === "null" || text === "undefined") return fallback;
  return text;
}

function pickText(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return "";
}

function average(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, current) => sum + current, 0) / values.length;
}

function stdDev(values = []) {
  if (!values.length) return 0;
  const avg = average(values);
  const variance = average(values.map((v) => (v - avg) ** 2));
  return Math.sqrt(variance);
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function pad2(value) {
  return String(Math.trunc(Math.abs(Number(value) || 0))).padStart(2, "0");
}

function formatMs(value) {
  return `${Number(value || 0).toFixed(0)} ms`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

function formatMbps(bytes, ms) {
  const totalMs = Math.max(1, Number(ms || 0));
  const mbps = ((Number(bytes || 0) * 8) / (totalMs / 1000)) / 1_000_000;
  return `${mbps.toFixed(2)} Mbps`;
}

function parseMbps(label = "") {
  const match = String(label).match(/([\d.]+)\s*Mbps/i);
  if (!match?.[1]) return 0;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : 0;
}

function buildBar(percent, size = 16) {
  const pct = clampNumber(percent, 0, 100);
  const total = Math.max(8, Math.min(30, Number(size || 16)));
  const filled = Math.round((pct / 100) * total);
  return "█".repeat(filled) + "░".repeat(Math.max(0, total - filled));
}

function buildGauge(valueMbps, capMbps, size = 18) {
  const ratio = capMbps > 0 ? clampNumber((valueMbps / capMbps) * 100, 0, 100) : 0;
  return buildBar(ratio, size);
}

function formatAsn(value) {
  const text = cleanText(value);
  if (!text) return "";
  if (/^AS/i.test(text)) return text.toUpperCase();
  if (/^\d+$/.test(text)) return `AS${text}`;
  return text;
}

function joinParts(parts, separator = " • ") {
  return parts.filter(Boolean).join(separator);
}

function maskIp(ip) {
  const text = cleanText(ip);
  if (!text) return "";

  if (text.includes(":")) {
    const groups = text.split(":").filter(Boolean);
    if (groups.length <= 2) return `${groups[0] || ""}:…`;
    return `${groups.slice(0, 3).join(":")}:…`;
  }

  const parts = text.split(".");
  if (parts.length === 4) {
    return `${parts[0]}.***.***.${parts[3]}`;
  }

  return `${text.slice(0, 4)}…`;
}

function getFetch() {
  if (typeof fetch === "function") return fetch.bind(globalThis);
  throw new Error("Este entorno no tiene fetch disponible.");
}

async function react(sock, msg, emoji) {
  try {
    if (!msg?.key) return;
    await sock.sendMessage(msg.key.remoteJid, {
      react: {
        text: emoji,
        key: msg.key,
      },
    });
  } catch {}
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
  if (!limit || limit <= 0) return readResponseBytes(response);

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

function withCacheBust(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("r", String(Date.now()));
  return parsed.toString();
}

async function runTimedFetch(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const doFetch = getFetch();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = process.hrtime.bigint();

  try {
    const headers = {
      ...DEFAULT_HEADERS,
      ...(options.headers || {}),
    };

    const response = await doFetch(url, {
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

async function fetchJson(url, timeoutMs = REQUEST_TIMEOUT_MS, options = {}) {
  const { response } = await runTimedFetch(url, options, timeoutMs);
  const raw = await response.text();
  if (!raw.trim()) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function fetchText(url, timeoutMs = REQUEST_TIMEOUT_MS, options = {}) {
  const { response } = await runTimedFetch(url, options, timeoutMs);
  return response.text();
}

function parseTracePayload(text = "") {
  const payload = {};

  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("=")) continue;

    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key) payload[key] = value;
  }

  return payload;
}

async function fetchCloudflareTrace() {
  try {
    const text = await fetchText(
      withCacheBust(TRACE_HOST),
      TRACE_TIMEOUT_MS,
      { method: "GET", headers: DEFAULT_HEADERS }
    );
    return parseTracePayload(text);
  } catch {
    return null;
  }
}

async function fetchIpWhoProfile() {
  try {
    return await fetchJson(withCacheBust(IPWHO_HOST), NETWORK_TIMEOUT_MS, {
      method: "GET",
      headers: {
        ...DEFAULT_HEADERS,
        accept: "application/json",
      },
    });
  } catch {
    return null;
  }
}

function buildNetworkProfile({ trace = null, ipwho = null } = {}) {
  const countryCode = pickText(trace?.loc, ipwho?.country_code);
  const country = pickText(ipwho?.country, countryCode);
  const city = pickText(ipwho?.city);
  const region = pickText(ipwho?.region);
  const timezone = pickText(ipwho?.timezone?.id);
  const asn = pickText(formatAsn(ipwho?.connection?.asn), formatAsn(trace?.asn));
  const connectionType = pickText(
    ipwho?.connection?.type,
    ipwho?.type,
    trace?.connection
  );
  const colo = pickText(trace?.colo);
  const location = joinParts([city, region, country || countryCode].filter(Boolean), ", ");

  return {
    available: Boolean(location || colo || asn),
    countryCode,
    country,
    city,
    region,
    location,
    timezone,
    asn,
    colo,
    connectionType,
  };
}

async function fetchNetworkIdentity() {
  const [traceResult, ipwhoResult] = await Promise.allSettled([
    fetchCloudflareTrace(),
    fetchIpWhoProfile(),
  ]);

  const trace = traceResult.status === "fulfilled" ? traceResult.value : null;
  const ipwho = ipwhoResult.status === "fulfilled" ? ipwhoResult.value : null;

  return buildNetworkProfile({ trace, ipwho });
}

async function measurePing() {
  const samples = [];
  let useFallback = false;

  for (let index = 0; index < PING_SAMPLES; index += 1) {
    try {
      const url = `${TEST_HOST}/__down?bytes=1&r=${Date.now()}-${index}`;
      const { response, startedAt } = await runTimedFetch(url, {
        method: "GET",
        headers: CF_HEADERS,
      });

      await readResponseBytesLimited(response, 8192);

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
      const url = `${TRACE_HOST}?r=${Date.now()}-${index}`;
      const { response, startedAt } = await runTimedFetch(
        url,
        { method: "GET", headers: DEFAULT_HEADERS },
        TRACE_TIMEOUT_MS
      );

      await readResponseBytesLimited(response, 8192);

      const endedAt = process.hrtime.bigint();
      samples.push(Number(endedAt - startedAt) / 1_000_000);
    }
  }

  return {
    samples,
    averageMs: average(samples),
    bestMs: samples.length ? Math.min(...samples) : 0,
    jitterMs: stdDev(samples),
  };
}

async function measureDownload(bytesToDownload) {
  const bytesWanted = Math.max(
    1_000_000,
    Number(bytesToDownload || DEFAULT_DOWNLOAD_BYTES)
  );
  let lastError = "No pude medir la descarga.";

  for (const provider of DOWNLOAD_FALLBACKS) {
    try {
      const url = provider.buildUrl ? provider.buildUrl(bytesWanted) : provider.url;
      const headers = { ...(provider.headers || {}) };

      if (provider.supportsRange) {
        headers.range = `bytes=0-${bytesWanted - 1}`;
      }

      const { response, startedAt } = await runTimedFetch(url, {
        method: "GET",
        headers,
      });

      const bytes = await readResponseBytesLimited(response, bytesWanted);
      const endedAt = process.hrtime.bigint();
      const elapsedMs = Number(endedAt - startedAt) / 1_000_000;

      return {
        ok: true,
        provider: provider.name,
        bytes,
        elapsedMs,
        speedLabel: formatMbps(bytes, elapsedMs),
      };
    } catch (error) {
      lastError = `${provider.name}: ${error?.message || error}`;
    }
  }

  return {
    ok: false,
    provider: "",
    bytes: 0,
    elapsedMs: 0,
    speedLabel: "0.00 Mbps",
    error: lastError,
  };
}

async function measureUpload(bytesToUpload) {
  const bytesWanted = Math.max(500_000, Number(bytesToUpload || DEFAULT_UPLOAD_BYTES));
  const payloadSize = clampNumber(bytesWanted, 500_000, 4_000_000);
  const payload = Buffer.alloc(payloadSize, 97);
  let lastError = "No pude medir la subida.";

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
        bytes: payload.length,
        elapsedMs,
        speedLabel: formatMbps(payload.length, elapsedMs),
      };
    } catch (error) {
      lastError = `${provider.name}: ${error?.message || error}`;
    }
  }

  return {
    ok: false,
    provider: "",
    bytes: payload.length,
    elapsedMs: 0,
    speedLabel: "0.00 Mbps",
    error: lastError,
  };
}

async function executeSpeedtest(options = {}) {
  const startedAt = Date.now();
  const downloadBytes = Number(options.downloadBytes || DEFAULT_DOWNLOAD_BYTES);
  const uploadBytes = Number(options.uploadBytes || DEFAULT_UPLOAD_BYTES);

  const networkPromise = fetchNetworkIdentity();
  const ping = await measurePing();
  const download = await measureDownload(downloadBytes);
  const upload = await measureUpload(uploadBytes);
  const network = await networkPromise;

  return {
    startedAt,
    finishedAt: Date.now(),
    ping,
    download,
    upload,
    network,
  };
}

function buildOwnerContact(settings = {}) {
  return String(settings.ownerName || "DVYER").trim();
}

function classifyConnection(downloadMbps, uploadMbps, pingMs, jitterMs) {
  const dl = Number(downloadMbps || 0);
  const ul = Number(uploadMbps || 0);
  const ping = Number(pingMs || 0);
  const jitter = Number(jitterMs || 0);

  if (dl >= 100 && ul >= 25 && ping <= 35 && jitter <= 12) {
    return { label: "EXCELENTE", emoji: "🟢" };
  }

  if (dl >= 50 && ul >= 10) {
    return { label: "MUY BUENA", emoji: "🔵" };
  }

  if (dl >= 15 && ul >= 5 && ping <= 120) {
    return { label: "ESTABLE", emoji: "🟡" };
  }

  return { label: "LIMITADA", emoji: "🟠" };
}

function buildResultMessage(result, modeLabel = "NORMAL", contactText = "") {
  const totalTimeMs =
    Math.max(0, Number(result?.finishedAt || 0) - Number(result?.startedAt || 0));

  const dl = parseMbps(result?.download?.speedLabel);
  const ul = parseMbps(result?.upload?.speedLabel);
  const ping = Number(result?.ping?.averageMs || 0);
  const jitter = Number(result?.ping?.jitterMs || 0);
  const bestPing = Number(result?.ping?.bestMs || 0);
  const status = classifyConnection(dl, ul, ping, jitter);
  const latencyNote = ping > 150 || jitter > 100 ? "⚠️ *Nota:* Latencia alta" : null;

  const network = result?.network || {};
  const location = network.location || joinParts([network.city, network.region, network.country], ", ");
  const downloadHost = result?.download?.provider || "No disponible";
  const uploadHost = result?.upload?.provider || "No disponible";

  const lines = [
    "╭━━━〔 ⚡ *SPEEDTEST FSOCIETY* 〕━━━⬣",
    "┃",
    `┃ ${status.emoji} *Calidad:* ${status.label}`,
    `┃ 🧪 *Modo:* ${modeLabel}`,
    `┃ ⏱️ *Duración:* ${formatDuration(totalTimeMs)}`,
    "┃",
    "┣━━〔 VELOCIDAD 〕━━⬣",
    `┃ 📥 *Descarga:* ${result?.download?.speedLabel || "0.00 Mbps"}`,
    `┃ ${buildGauge(dl, 200)} ${dl.toFixed(2)} Mbps`,
    `┃ 📤 *Subida:* ${result?.upload?.speedLabel || "0.00 Mbps"}`,
    `┃ ${buildGauge(ul, 100)} ${ul.toFixed(2)} Mbps`,
    "┃",
    "┣━━〔 LATENCIA 〕━━⬣",
    `┃ 📶 *Ping:* ${formatMs(ping)}`,
    `┃ ⚡ *Mejor ping:* ${formatMs(bestPing)}`,
    `┃ 〰️ *Jitter:* ${formatMs(jitter)}`,
    latencyNote ? `┃ ${latencyNote}` : null,
    "┃",
    "┣━━〔 RED DETECTADA 〕━━⬣",
    `┃ 🛰️ *ASN:* ${network.asn || "No detectado"}`,
    `┃ 📍 *Ubicación:* ${location || "No detectada"}`,
    `┃ 🕒 *Zona horaria:* ${network.timezone || "No detectada"}`,
    `┃ 🌍 *Nodo Cloudflare:* ${network.colo || "No detectado"}`,
    `┃ 🧭 *Tipo de conexión:* ${network.connectionType || "No detectado"}`,
    "┃",
    "┣━━〔 HOST DE PRUEBA 〕━━⬣",
    `┃ 📥 *Host descarga:* ${downloadHost}`,
    `┃ 📤 *Host subida:* ${uploadHost}`,
    `┃ 🌐 *Trace:* Cloudflare / 1.1.1.1`,
    "┃",
    "┣━━〔 SESIÓN 〕━━⬣",
    `┃ 📊 *Muestras:* ${result?.ping?.samples?.length || PING_SAMPLES}`,
    contactText ? `┃ 👤 *Owner:* ${contactText}` : null,
    result?.download?.ok === false
      ? `┃ ⚠️ *Error DL:* ${result.download.error || "desconocido"}`
      : null,
    result?.upload?.ok === false
      ? `┃ ⚠️ *Error UL:* ${result.upload.error || "desconocido"}`
      : null,
    "╰━━━━━━━━━━━━━━━━━━━━━━⬣",
  ]
    .filter(Boolean)
    .join("\n");

  return lines;
}

function buildResultCaption(result, modeLabel = "NORMAL", statusLabel = "ESTABLE") {
  const downloadHost = result?.download?.provider || "No disponible";
  const uploadHost = result?.upload?.provider || "No disponible";
  const network = result?.network || {};
  const location = network.location || network.country || "No detectada";

  return [
    "╭━━━〔 ⚡ *SPEEDTEST VISUAL* 〕━━━⬣",
    `┃ 🧪 Modo: *${modeLabel}*`,
    `┃ 📶 Calidad: *${statusLabel}*`,
    `┃ 📍 Zona: *${location}*`,
    `┃ 📥 Host DL: *${downloadHost}*`,
    `┃ 📤 Host UL: *${uploadHost}*`,
    "┃ 🔒 Sin mostrar IP publica ni ISP",
    "╰━━━━━━━━━━━━━━━━━━━━━━⬣",
  ].join("\n");
}

function buildErrorMessage(error, contactText = "") {
  const message = String(error?.message || error || "Error desconocido");

  return [
    "╭━━━〔 ❌ *SPEEDTEST FALLÓ* 〕━━━⬣",
    "┃",
    `┃ Motivo: ${message}`,
    contactText ? `┃ Owner: ${contactText}` : null,
    "╰━━━━━━━━━━━━━━━━━━━━━━⬣",
  ]
    .filter(Boolean)
    .join("\n");
}

function resolveMode(args = []) {
  const mode = String(args?.[0] || "").trim().toLowerCase();

  if (["full", "pro", "completo"].includes(mode)) {
    return {
      modeLabel: "COMPLETO",
      downloadBytes: 40_000_000,
      uploadBytes: 12_000_000,
    };
  }

  if (["lite", "rapido", "rápido", "fast"].includes(mode)) {
    return {
      modeLabel: "RÁPIDO",
      downloadBytes: 8_000_000,
      uploadBytes: 2_000_000,
    };
  }

  return {
    modeLabel: "NORMAL",
    downloadBytes: DEFAULT_DOWNLOAD_BYTES,
    uploadBytes: DEFAULT_UPLOAD_BYTES,
  };
}

export default {
  command: ["speedtest"],
  categoria: "sistema",
  description: "Mide ping, descarga, subida y proveedor de red del bot",

  run: async ({ sock, msg, from, args = [], settings = {} }) => {
    if (activeSpeedtest) {
      return sock.sendMessage(
        from,
        {
          text: "⏳ Ya hay un speedtest en progreso. Espera a que termine.",
          ...global.channelInfo,
        },
        { quoted: msg }
      );
    }

    const { modeLabel, downloadBytes, uploadBytes } = resolveMode(args);
    const ownerName = buildOwnerContact(settings);

    try {
      await react(sock, msg, "⚡");

      await sock.sendMessage(
        from,
        {
          text: [
            "╭━━━〔 ⚡ *INICIANDO SPEEDTEST* 〕━━━⬣",
            "┃",
            `┃ 🧪 *Modo:* ${modeLabel}`,
            "┃ 🛰️ *Paso 1:* Detectando red y nodo",
            "┃ 📶 *Paso 2:* Midiendo ping",
            "┃ 📥 *Paso 3:* Descargando datos",
            "┃ 📤 *Paso 4:* Subiendo datos",
            `┃ 👤 *Owner:* ${ownerName}`,
            "╰━━━━━━━━━━━━━━━━━━━━━━⬣",
          ].join("\n"),
          ...global.channelInfo,
        },
        { quoted: msg }
      );

      activeSpeedtest = executeSpeedtest({ downloadBytes, uploadBytes });
      const result = await activeSpeedtest;
      const status = classifyConnection(
        parseMbps(result?.download?.speedLabel),
        parseMbps(result?.upload?.speedLabel),
        Number(result?.ping?.averageMs || 0),
        Number(result?.ping?.jitterMs || 0)
      );
      const cardBuffer = await createSpeedtestCard({
        result,
        modeLabel,
        statusLabel: status.label,
        ownerName,
      });

      if (cardBuffer) {
        await sock.sendMessage(
          from,
          {
            image: cardBuffer,
            caption: buildResultCaption(result, modeLabel, status.label),
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      }

      if (!cardBuffer) {
        await sock.sendMessage(
          from,
          {
            text: buildResultMessage(result, modeLabel, ownerName),
            ...global.channelInfo,
          },
          { quoted: msg }
        );
      }

      await react(sock, msg, "✅");
    } catch (error) {
      console.error("SPEEDTEST ERROR:", error);

      await sock.sendMessage(
        from,
        {
          text: buildErrorMessage(error, ownerName),
          ...global.channelInfo,
        },
        { quoted: msg }
      );

      await react(sock, msg, "❌");
    } finally {
      activeSpeedtest = null;
    }
  },
};
