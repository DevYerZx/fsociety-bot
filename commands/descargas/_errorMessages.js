function parseRawError(error, fallback = "No se pudo completar la solicitud.") {
  let text = String(error?.message || error || fallback).trim();

  try {
    const parsed = JSON.parse(text);
    text = String(parsed?.detail || parsed?.message || text).trim();
  } catch {}

  return text || fallback;
}

export function sanitizeProviderMessage(error, options = {}) {
  const kind = String(options?.kind || "descarga").trim().toLowerCase();
  const fallback = String(options?.fallback || "No se pudo completar la solicitud.").trim();
  const raw = parseRawError(error, fallback);
  const normalized = raw.toLowerCase();

  const busyLabel =
    kind === "video"
      ? "El servidor de video esta ocupado en este momento. Intenta otra vez en unos minutos."
      : kind === "audio"
      ? "El servidor de audio esta ocupado en este momento. Intenta otra vez en unos minutos."
      : kind === "search"
      ? "El buscador esta ocupado en este momento. Intenta otra vez en unos minutos."
      : "El servidor esta ocupado en este momento. Intenta otra vez en unos minutos.";

  if (
    normalized.includes("rate-overlimit") ||
    normalized.includes("rate overlimit") ||
    normalized.includes("too many requests") ||
    normalized.includes("http 429") ||
    normalized === "429"
  ) {
    return busyLabel;
  }

  if (
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("econnaborted")
  ) {
    if (kind === "search") {
      return "La busqueda tardo demasiado. Intenta otra vez en unos segundos.";
    }
    return "El servidor tardo demasiado en responder. Intenta otra vez.";
  }

  if (
    normalized.includes("socket hang up") ||
    normalized.includes("econnreset") ||
    normalized.includes("service unavailable") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("aggregateerror")
  ) {
    return "El servidor esta temporalmente inestable. Intenta otra vez.";
  }

  if (normalized.includes("403") || normalized.includes("forbidden")) {
    return "El proveedor bloqueo temporalmente la solicitud. Intenta otra vez.";
  }

  if (normalized.includes("404") || normalized.includes("not found")) {
    if (kind === "search") {
      return "No se encontraron resultados para esa busqueda.";
    }
    return "No se encontro el archivo o enlace solicitado.";
  }

  if (
    normalized.includes("http 500") ||
    normalized.includes("http 502") ||
    normalized.includes("http 503") ||
    normalized.includes("http 504")
  ) {
    return "El proveedor fallo temporalmente. Intenta otra vez en unos minutos.";
  }

  return raw;
}
