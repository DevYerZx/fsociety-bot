import fs from "fs";
import path from "path";
import { clampNumber, createScheduledJsonStore, formatBytes } from "./json-store.js";

const FILE = path.join(process.cwd(), "database", "autoclean.json");
const TMP_DIR = path.join(process.cwd(), "tmp");
const BACKUP_DIR = path.join(process.cwd(), "backups");

const DEFAULT_TMP_LIMIT_BYTES = 1024 * 1024 * 1024; // 1GB
const PROTECT_RECENT_FILES_MS = 2 * 60 * 1000; // evita borrar descargas en curso

const store = createScheduledJsonStore(FILE, () => ({
  enabled: true,
  intervalMs: 30 * 60 * 1000,
  maxFileAgeMs: 6 * 60 * 60 * 1000,
  maxTmpTotalBytes: DEFAULT_TMP_LIMIT_BYTES,
  lastRunAt: 0,
  lastSummary: {
    removedFiles: 0,
    freedBytes: 0,
  },
}));

function collectFiles(dirPath, results = []) {
  if (!fs.existsSync(dirPath)) return results;

  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
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
  try {
    if (!fs.existsSync(rootDir)) return 0;
    let removed = 0;

    const walk = (dirPath) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        walk(path.join(dirPath, entry.name));
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
  } catch {
    return 0;
  }
}

function planTmpDeletions(files, { now, maxAgeMs, maxTotalBytes }) {
  const protectedUntil = now - PROTECT_RECENT_FILES_MS;
  const eligible = files.filter((f) => f.mtimeMs > 0 && f.mtimeMs <= protectedUntil);

  const old = eligible.filter((f) => now - f.mtimeMs >= maxAgeMs);
  const byOldest = [...eligible].sort((a, b) => a.mtimeMs - b.mtimeMs);

  const totalBytes = files.reduce((acc, f) => acc + Number(f.size || 0), 0);
  let currentBytes = totalBytes;
  const overLimit = Number.isFinite(maxTotalBytes) && maxTotalBytes > 0 ? currentBytes > maxTotalBytes : false;

  const toDelete = new Map();
  for (const f of old) toDelete.set(f.path, f);

  if (overLimit) {
    for (const f of byOldest) {
      if (currentBytes <= maxTotalBytes) break;
      if (toDelete.has(f.path)) {
        currentBytes -= Number(f.size || 0);
        continue;
      }
      toDelete.set(f.path, f);
      currentBytes -= Number(f.size || 0);
    }
  }

  return {
    totalBytes,
    planned: Array.from(toDelete.values()),
    overLimit,
  };
}

export function runAutoClean() {
  const now = Date.now();
  const maxAgeMs = Number(store.state.maxFileAgeMs || 0);
  const maxTmpTotalBytes = Number(store.state.maxTmpTotalBytes || 0);

  const tmpFiles = collectFiles(TMP_DIR);
  const tmpPlan = planTmpDeletions(tmpFiles, {
    now,
    maxAgeMs,
    maxTotalBytes: maxTmpTotalBytes,
  });

  const backupFiles = collectFiles(BACKUP_DIR).filter((f) => now - f.mtimeMs >= maxAgeMs * 2);
  const targets = [...tmpPlan.planned, ...backupFiles];

  let removedFiles = 0;
  let freedBytes = 0;
  let removedDirs = 0;

  for (const target of targets) {
    try {
      fs.unlinkSync(target.path);
      removedFiles += 1;
      freedBytes += Number(target.size || 0);
    } catch {}
  }

  removedDirs += removeEmptyDirs(TMP_DIR);
  removedDirs += removeEmptyDirs(BACKUP_DIR);

  store.state.lastRunAt = now;
  store.state.lastSummary = {
    removedFiles,
    freedBytes,
    removedDirs,
    tmpTotalBytes: tmpPlan.totalBytes,
    tmpLimitBytes: maxTmpTotalBytes,
    tmpOverLimit: tmpPlan.overLimit,
  };
  store.scheduleSave();

  return {
    removedFiles,
    freedBytes,
    freedLabel: formatBytes(freedBytes),
    removedDirs,
    tmpTotalBytes: tmpPlan.totalBytes,
    tmpLimitBytes: maxTmpTotalBytes,
    lastRunAt: now,
  };
}

export function getAutoCleanState() {
  return {
    enabled: store.state.enabled !== false,
    intervalMs: Number(store.state.intervalMs || 0),
    maxFileAgeMs: Number(store.state.maxFileAgeMs || 0),
    maxTmpTotalBytes: Number(store.state.maxTmpTotalBytes || 0),
    lastRunAt: Number(store.state.lastRunAt || 0),
    lastSummary: {
      removedFiles: Number(store.state.lastSummary?.removedFiles || 0),
      freedBytes: Number(store.state.lastSummary?.freedBytes || 0),
      freedLabel: formatBytes(store.state.lastSummary?.freedBytes || 0),
      removedDirs: Number(store.state.lastSummary?.removedDirs || 0),
      tmpTotalBytes: Number(store.state.lastSummary?.tmpTotalBytes || 0),
      tmpTotalLabel: formatBytes(store.state.lastSummary?.tmpTotalBytes || 0),
      tmpLimitBytes: Number(store.state.lastSummary?.tmpLimitBytes || 0),
      tmpLimitLabel: formatBytes(store.state.lastSummary?.tmpLimitBytes || 0),
      tmpOverLimit: Boolean(store.state.lastSummary?.tmpOverLimit),
    },
  };
}

export function setAutoCleanConfig(patch = {}) {
  if (Object.prototype.hasOwnProperty.call(patch, "enabled")) {
    store.state.enabled = Boolean(patch.enabled);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "intervalMs")) {
    store.state.intervalMs = clampNumber(
      patch.intervalMs,
      5 * 60 * 1000,
      24 * 60 * 60 * 1000,
      30 * 60 * 1000
    );
  }
  if (Object.prototype.hasOwnProperty.call(patch, "maxFileAgeMs")) {
    store.state.maxFileAgeMs = clampNumber(
      patch.maxFileAgeMs,
      10 * 60 * 1000,
      7 * 24 * 60 * 60 * 1000,
      6 * 60 * 60 * 1000
    );
  }
  if (Object.prototype.hasOwnProperty.call(patch, "maxTmpTotalBytes")) {
    store.state.maxTmpTotalBytes = clampNumber(
      patch.maxTmpTotalBytes,
      100 * 1024 * 1024,
      50 * 1024 * 1024 * 1024,
      DEFAULT_TMP_LIMIT_BYTES
    );
  }

  store.scheduleSave();
  return getAutoCleanState();
}
