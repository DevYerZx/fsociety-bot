import axios from "axios";

const DEFAULT_IMAGE_TIMEOUT = 15_000;

export function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function clipText(value = "", max = 72) {
  const text = cleanText(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 3))}...`;
}

export function buildDownloadCard(title = "FSOCIETY DOWNLOAD", sections = []) {
  const lines = [`╭━━〔 ${title} 〕━━⬣`];

  for (const section of sections) {
    if (!section) continue;

    if (typeof section === "string") {
      lines.push(`┃ ${section}`);
      continue;
    }

    if (section.spacer) {
      lines.push("┃");
      continue;
    }

    const sectionTitle = cleanText(section.title);
    if (sectionTitle) {
      lines.push(`┣━━〔 ${sectionTitle} 〕━━⬣`);
    }

    for (const row of Array.isArray(section.lines) ? section.lines : []) {
      if (!row) continue;
      lines.push(`┃ ${row}`);
    }
  }

  lines.push("╰━━━━━━━━━━━━━━━━━━⬣");
  return lines.join("\n");
}

export function buildUsageCard({
  title,
  summary = [],
  examples = [],
  footer = "",
}) {
  const sections = [];

  if (summary.length) {
    sections.push({ lines: summary });
  }

  if (examples.length) {
    sections.push({
      title: "USO",
      lines: examples,
    });
  }

  if (footer) {
    sections.push({
      title: "TIP",
      lines: [footer],
    });
  }

  return buildDownloadCard(title, sections);
}

export function buildSelectorCaption({
  title,
  query = "",
  lead = "",
  featuredTitle = "",
  featuredLines = [],
  actionLines = [],
}) {
  const sections = [];

  if (query || lead) {
    sections.push({
      lines: [
        query ? `🔎 *Busqueda:* ${clipText(query, 56)}` : null,
        lead || null,
      ].filter(Boolean),
    });
  }

  if (featuredTitle || featuredLines.length) {
    sections.push({
      title: "DESTACADO",
      lines: [
        featuredTitle ? `⭐ *${clipText(featuredTitle, 58)}*` : null,
        ...featuredLines.filter(Boolean),
      ].filter(Boolean),
    });
  }

  if (actionLines.length) {
    sections.push({
      title: "SELECTOR",
      lines: actionLines.filter(Boolean),
    });
  }

  return buildDownloadCard(title, sections);
}

export function buildSectionFallbackText(caption, sections = []) {
  const text = sections
    .map((section) => {
      const rows = Array.isArray(section?.rows) ? section.rows : [];
      if (!rows.length) return "";

      return [
        `*${section.title || "Resultados"}*`,
        rows.map((row) => `*${row.header}. ${row.title}*\n${row.id}`).join("\n\n"),
      ]
        .filter(Boolean)
        .join("\n");
    })
    .filter(Boolean)
    .join("\n\n");

  return text ? `${caption}\n\n${text}` : caption;
}

export function buildSelectorPayload({
  imageBuffer = null,
  caption,
  title,
  subtitle,
  footer,
  selectorTitle,
  sections,
}) {
  return {
    ...(imageBuffer ? { image: imageBuffer, caption } : { text: caption }),
    media: Boolean(imageBuffer),
    title,
    subtitle,
    footer,
    interactiveButtons: [
      {
        name: "single_select",
        buttonParamsJson: JSON.stringify({
          title: selectorTitle,
          sections,
        }),
      },
    ],
    ...global.channelInfo,
  };
}

export async function downloadFirstValidImageBuffer(urls = [], options = {}) {
  const timeout = Number(options.timeout || DEFAULT_IMAGE_TIMEOUT);
  const minBytes = Number(options.minBytes || 2_000);
  const unique = [...new Set((Array.isArray(urls) ? urls : [urls]).map((item) => cleanText(item)).filter(Boolean))];

  for (const url of unique) {
    try {
      const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout,
        maxRedirects: 4,
        validateStatus: () => true,
      });

      const contentType = cleanText(response?.headers?.["content-type"]).toLowerCase();
      const buffer = Buffer.from(response?.data || []);

      if (
        Number(response?.status || 0) < 400 &&
        contentType.startsWith("image/") &&
        buffer.length >= minBytes
      ) {
        return buffer;
      }
    } catch {}
  }

  return null;
}
