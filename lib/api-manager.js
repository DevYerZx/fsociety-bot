import path from "path";
import { createScheduledJsonStore } from "./json-store.js";

const FILE = path.join(process.cwd(), "database", "api-providers.json");

// ⚠️ Tu key por defecto. Si quieres cambiarla, cambia aquí o desde tu JSON.
const DEFAULT_DVYER_API_KEY = "dvyer493380590234";

function buildDefaultState() {
  return {
    providers: {
      dvyer: {
        enabled: true,
        baseUrl: "https://dv-yer-api.online",
        apiKey: DEFAULT_DVYER_API_KEY,
      },
      ai: {
        enabled: true,
        gpt5Url: "https://api.soymaycol.icu/api/ai/gpt5",
      },
      mediafire: {
        enabled: true,
        url: "https://api-adonix.ultraplus.click/download/mediafire",
        apiKey: "8b8d2496-ee1f-4d28-a0b8-c8b68b4d02d8",
      },
      tikwm: {
        enabled: true,
        searchUrl: "https://www.tikwm.com/api/feed/search",
      },
      bing: {
        enabled: true,
        imageSearchUrl: "https://www.bing.com/images/search",
      },
    },
  };
}

const store = createScheduledJsonStore(FILE, buildDefaultState);

function ensureProvider(name) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return null;

  if (!store.state.providers) {
    store.state.providers = {};
  }

  if (!store.state.providers[key]) {
    store.state.providers[key] = {
      enabled: true,
    };
    store.scheduleSave?.();
  }

  return store.state.providers[key];
}

export function listProviders() {
  return Object.entries(store.state.providers || {}).map(([name, config]) => ({
    name,
    ...config,
  }));
}

export function getProvider(name) {
  const key = String(name || "").trim().toLowerCase();
  const provider = ensureProvider(key);
  return provider ? { name: key, ...provider } : null;
}

export function setProviderValue(name, field, value) {
  const key = String(name || "").trim().toLowerCase();
  const provider = ensureProvider(key);
  if (!provider) return null;

  provider[field] = value;
  store.scheduleSave?.();

  return { name: key, ...provider };
}

export function setProviderEnabled(name, enabled) {
  return setProviderValue(name, "enabled", Boolean(enabled));
}

export function getDvyerBaseUrl() {
  const provider = ensureProvider("dvyer");
  return String(provider?.baseUrl || "https://dv-yer-api.online")
    .trim()
    .replace(/\/+$/, "");
}

export function getDvyerApiKey() {
  const provider = ensureProvider("dvyer");
  return String(provider?.apiKey || DEFAULT_DVYER_API_KEY || "").trim();
}

export function withDvyerApiKey(params = {}) {
  const payload = { ...(params || {}) };
  const key = getDvyerApiKey();

  if (key && !payload.apikey) {
    payload.apikey = key;
  }

  return payload;
}

export function withDvyerApiKeyHeader(headers = {}) {
  const payload = { ...(headers || {}) };
  const key = getDvyerApiKey();

  if (key && !payload["x-api-key"]) {
    payload["x-api-key"] = key;
  }

  return payload;
}

export function appendDvyerApiKeyToUrl(url = "") {
  const raw = String(url || "").trim();
  if (!raw) return raw;

  const key = getDvyerApiKey();
  if (!key) return raw;

  try {
    const parsed = new URL(raw);

    if (!parsed.searchParams.get("apikey")) {
      parsed.searchParams.set("apikey", key);
    }

    return parsed.toString();
  } catch {
    return raw;
  }
}

export function buildDvyerUrl(endpoint = "") {
  const base = getDvyerBaseUrl();
  const suffix = String(endpoint || "").trim();

  if (!suffix) return appendDvyerApiKeyToUrl(base);
  if (/^https?:\/\//i.test(suffix)) return appendDvyerApiKeyToUrl(suffix);
  if (suffix.startsWith("/")) return appendDvyerApiKeyToUrl(`${base}${suffix}`);

  return appendDvyerApiKeyToUrl(`${base}/${suffix}`);
}

export function getGpt5Url(prompt = "") {
  const provider = ensureProvider("ai");
  const base = String(provider?.gpt5Url || "").trim();
  if (!base) return "";

  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}prompt=${encodeURIComponent(prompt)}`;
}

export function getMediafireConfig() {
  const provider = ensureProvider("mediafire");

  return {
    enabled: provider?.enabled !== false,
    url: String(provider?.url || "").trim(),
    apiKey: String(provider?.apiKey || "").trim(),
  };
}

export function getApiChecks() {
  return [
    {
      name: "DVYER ytsearch",
      url: `${buildDvyerUrl("/ytsearch")}&q=ozuna&limit=1`,
    },
    {
      name: "DVYER ytmp3",
      url: `${buildDvyerUrl(
        "/ytmp3"
      )}&mode=link&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ`,
    },
    {
      name: "DVYER ytmp4",
      url: buildDvyerUrl("/ytmp4"),
    },
    {
      name: "DVYER tiktok",
      url: buildDvyerUrl("/ttdlmp4"),
    },
    {
      name: "DVYER spotify",
      url: buildDvyerUrl("/spotify"),
    },
    {
      name: "DVYER instagram",
      url: buildDvyerUrl("/instagram"),
    },
    {
      name: "DVYER apksearch",
      url: `${buildDvyerUrl("/apksearch")}&q=whatsapp&limit=1`,
    },
    {
      name: "TikTok Search Fallback",
      url: "https://www.tikwm.com/api/feed/search?keywords=ozuna&count=1&cursor=0&web=1",
    },
    {
      name: "Pinterest Fallback",
      url: "https://www.bing.com/images/search?q=cat",
    },
    {
      name: "IA GPT",
      url: getGpt5Url("hola"),
    },
  ];
}