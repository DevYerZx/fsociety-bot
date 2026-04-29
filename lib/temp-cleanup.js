import fs from "fs";
import os from "os";
import path from "path";

const MANAGED_TEMP_DIR_NAMES = [
  "dvyer-cuevana",
  "dvyer-ytmp3",
  "dvyer-ytmp4",
  "dvyer-mega",
  "dvyer-tiktok",
  "dvyer-instagram",
  "spotify-downloads",
  "dvyer-app-downloads",
  "dvyer-facebook",
  "dvyer-mediafire",
];

const MANAGED_TEMP_FILE_PREFIXES = ["baileys_store_"];
const RECENT_PROTECTION_MS = 2 * 60 * 1000;

function uniquePaths(values = []) {
  return Array.from(
    new Set(
      values
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

export function getManagedTempRoots() {
  const osTmp = os.tmpdir();
  const projectTmp = path.join(process.cwd(), "tmp");

  const roots = [
    projectTmp,
    ...MANAGED_TEMP_DIR_NAMES.map((name) => path.join(osTmp, name)),
  ];

  return uniquePaths(roots);
}

function collectFiles(dirPath, results = []) {
  if (!dirPath || !fs.existsSync(dirPath)) return results;

  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      collectFiles(fullPath, results);
      continue;
    }

    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;
      results.push({
        path: fullPath,
        size: Number(stat.size || 0),
        mtimeMs: Number(stat.mtimeMs || 0),
      });
    } catch {}
  }

  return results;
}

function removeEmptyDirs(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) return 0;

  let removed = 0;
  const walk = (dirPath) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(dirPath, entry.name));
      }
    }

    try {
      const after = fs.readdirSync(dirPath);
      if (after.length === 0 && dirPath !== rootDir) {
        fs.rmdirSync(dirPath);
        removed += 1;
      }
    } catch {}
  };

  walk(rootDir);
  return removed;
}

function shouldDeleteManagedTempFile(file, now, maxAgeMs) {
  const filePath = String(file?.path || "").trim();
  const baseName = path.basename(filePath);
  const ageMs = now - Number(file?.mtimeMs || 0);

  if (!filePath || !Number.isFinite(ageMs) || ageMs < RECENT_PROTECTION_MS) {
    return false;
  }

  if (MANAGED_TEMP_FILE_PREFIXES.some((prefix) => baseName.startsWith(prefix))) {
    return ageMs >= maxAgeMs;
  }

  return ageMs >= maxAgeMs;
}

export function cleanupManagedTempRoots(options = {}) {
  const now = Date.now();
  const maxAgeMs = Math.max(5 * 60 * 1000, Number(options.maxAgeMs || 0) || 6 * 60 * 60 * 1000);
  const roots = uniquePaths(options.roots?.length ? options.roots : getManagedTempRoots());

  let removedFiles = 0;
  let freedBytes = 0;
  let removedDirs = 0;
  let scannedFiles = 0;

  for (const root of roots) {
    const files = collectFiles(root);
    scannedFiles += files.length;

    for (const file of files) {
      if (!shouldDeleteManagedTempFile(file, now, maxAgeMs)) continue;

      try {
        fs.unlinkSync(file.path);
        removedFiles += 1;
        freedBytes += Number(file.size || 0);
      } catch {}
    }

    removedDirs += removeEmptyDirs(root);
  }

  return {
    removedFiles,
    removedDirs,
    freedBytes,
    scannedFiles,
    roots,
    maxAgeMs,
    ranAt: now,
  };
}
