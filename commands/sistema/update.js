import fs from "fs";
import https from "https";
import os from "os";
import path from "path";
import { spawn } from "child_process";

const RESTART_DELAY_MS = 3000;
const DEPENDENCY_MANIFESTS = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
];
const ARCHIVE_SKIPPED_ROOTS = new Set([".git", "node_modules", "tmp", "backups"]);
const ARCHIVE_PROTECTED_PREFIXES = new Set(["database"]);
const PROTECTED_LOCAL_PATHS = new Set(["settings/settings.json"]);
let updateInProgress = false;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeJidUser(value = "") {
  const jid = String(value || "").trim();
  if (!jid) return "";
  const [user] = jid.split("@");
  return user.split(":")[0];
}

function normalizeDigits(value = "") {
  return normalizeJidUser(value).replace(/[^\d]/g, "");
}

function collectOwnerIds(settings = {}) {
  const ownerIds = new Set();

  const add = (value) => {
    const normalized = normalizeJidUser(value);
    const digits = normalizeDigits(value);
    if (normalized) ownerIds.add(normalized);
    if (digits) ownerIds.add(digits);
  };

  add(settings.ownerNumber);
  add(settings.ownerLid);

  for (const value of settings.ownerNumbers || []) {
    add(value);
  }

  for (const value of settings.ownerLids || []) {
    add(value);
  }

  return ownerIds;
}

function collectSenderIds(msg, from) {
  const candidates = [
    msg?.key?.participant,
    msg?.participant,
    msg?.key?.remoteJid,
    from,
  ];

  const senderIds = new Set();

  for (const value of candidates) {
    const normalized = normalizeJidUser(value);
    const digits = normalizeDigits(value);
    if (normalized) senderIds.add(normalized);
    if (digits) senderIds.add(digits);
  }

  return senderIds;
}

function resolveOwnerAccess({ esOwner, settings, msg, from }) {
  const ownerIds = collectOwnerIds(settings);
  const senderIds = collectSenderIds(msg, from);
  const matches = Array.from(senderIds).filter((id) => ownerIds.has(id));

  return {
    isOwner: Boolean(esOwner || matches.length),
    senderIds: Array.from(senderIds),
    ownerIds: Array.from(ownerIds),
    matches,
  };
}

function quoteForShell(value) {
  return `"${String(value || "").replace(/"/g, '\\"')}"`;
}

function quoteForSh(value) {
  return `'${String(value || "").replace(/'/g, `'\"'\"'`)}'`;
}

function getNpmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function readDependencyManifestSnapshot() {
  const snapshot = {};

  for (const filePath of DEPENDENCY_MANIFESTS) {
    const absolutePath = path.join(process.cwd(), filePath.split("/").join(path.sep));
    snapshot[filePath] = fs.existsSync(absolutePath)
      ? fs.readFileSync(absolutePath, "utf-8")
      : null;
  }

  return snapshot;
}

function dependencyManifestsChanged(before = {}, after = {}) {
  return DEPENDENCY_MANIFESTS.some(
    (filePath) => (before[filePath] ?? null) !== (after[filePath] ?? null)
  );
}

function toLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function pickMainLine(result) {
  const lines = [...toLines(result?.stdout), ...toLines(result?.stderr)];
  return lines[0] || "Sin detalle extra.";
}

function buildUpdateMessage(title, lines = [], footer = "") {
  const bodyLines = Array.isArray(lines)
    ? lines.map((line) => String(line || "").trim()).filter(Boolean)
    : [];
  const tail = String(footer || "").trim();

  return [
    `*${String(title || "UPDATE").trim() || "UPDATE"}*`,
    "",
    ...bodyLines,
    ...(tail ? ["", tail] : []),
  ].join("\n");
}

function hasRestartSensitiveChanges(changedFiles = []) {
  return uniquePaths(changedFiles).some((filePath) => {
    const normalized = normalizeGitPath(filePath);
    if (!normalized) return false;

    if (
      /^readme(\.|$)/i.test(path.basename(normalized)) ||
      /\.(md|txt|png|jpg|jpeg|gif|webp|svg)$/i.test(normalized)
    ) {
      return false;
    }

    return true;
  });
}

function updateRequiresRestart(updateResult = null) {
  if (!updateResult?.updated) return false;
  if (updateResult.depsInstalled) return true;
  return hasRestartSensitiveChanges(updateResult.changedFiles || []);
}

function canHotApplyWithoutRestart(updateResult = null) {
  if (!updateResult?.updated) return true;
  if (updateResult?.depsInstalled) return false;

  const changed = uniquePaths(updateResult?.changedFiles || []);
  if (!changed.length) return true;

  return changed.every((filePath) => {
    const normalized = normalizeGitPath(filePath);
    if (!normalized) return true;

    if (
      /^readme(\.|$)/i.test(path.basename(normalized)) ||
      /\.(md|txt|png|jpg|jpeg|gif|webp|svg|ico|map)$/i.test(normalized)
    ) {
      return true;
    }

    if (normalized.startsWith("commands/")) return true;
    if (normalized === "settings/settings.json") return true;

    return false;
  });
}

async function tryApplyHotRuntimeUpdate() {
  const runtime = global?.botRuntime;
  if (!runtime || typeof runtime.applyHotRuntimeRefresh !== "function") {
    return {
      attempted: false,
      ok: false,
      message: "Runtime hot-reload no disponible en este proceso.",
      detail: null,
    };
  }

  try {
    const detail = await runtime.applyHotRuntimeRefresh("update_command");
    return {
      attempted: true,
      ok: Boolean(detail?.ok),
      message: detail?.ok
        ? "Comandos y settings recargados en caliente."
        : "Intente recarga en caliente, pero hubo errores parciales.",
      detail,
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      message: `Fallo recarga en caliente: ${String(error?.message || error)}`,
      detail: null,
    };
  }
}

function normalizeGitPath(value = "") {
  return String(value || "").replace(/\\/g, "/").trim();
}

function decodeGitQuotedPath(value = "") {
  const raw = String(value || "").trim();
  if (!(raw.startsWith('"') && raw.endsWith('"'))) {
    return raw;
  }

  return raw
    .slice(1, -1)
    .replace(/\\([0-7]{1,3})/g, (_, octal) =>
      String.fromCharCode(Number.parseInt(octal, 8))
    )
    .replace(/\\t/g, "\t")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\f/g, "\f")
    .replace(/\\b/g, "\b")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function uniquePaths(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => normalizeGitPath(value))
        .filter(Boolean)
    )
  );
}

function isProtectedLocalPath(filePath = "") {
  return PROTECTED_LOCAL_PATHS.has(normalizeGitPath(filePath));
}

function extractGitStatusPath(line = "") {
  const raw = String(line || "");
  if (raw.length < 4) return "";
  const path = raw.slice(3).trim();
  if (!path) return "";
  if (!path.includes("->")) return normalizeGitPath(decodeGitQuotedPath(path));
  return normalizeGitPath(decodeGitQuotedPath(path.split("->").pop()));
}

function getAuthFolders(settings = {}) {
  const folders = new Set();

  const add = (value) => {
    const normalized = normalizeGitPath(value);
    if (normalized) folders.add(normalized);
  };

  add(settings.authFolder || "dvyer-session");
  add(settings.subbot?.authFolder);

  for (const slot of settings.subbots || []) {
    add(slot?.authFolder);
  }

  return folders;
}

function isIgnorableRuntimePath(filePath, settings = {}) {
  const normalized = normalizeGitPath(filePath);
  if (!normalized) return false;
  if (normalized === "tmp" || normalized.startsWith("tmp/")) return true;
  if (normalized === "node_modules" || normalized.startsWith("node_modules/")) {
    return true;
  }

  for (const folder of getAuthFolders(settings)) {
    if (normalized === folder || normalized.startsWith(`${folder}/`)) {
      return true;
    }
  }

  return false;
}

function getRestartMode() {
  if (process.env.pm_id || process.env.PM2_HOME) {
    return {
      kind: "pm2",
      label: "PM2/VPS",
      needsBootstrap: false,
      allowsInternalRestart: true,
    };
  }

  if (
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RENDER ||
    process.env.PTERODACTYL_SERVER_UUID ||
    process.env.SERVER_ID ||
    process.env.KOYEB_SERVICE_NAME ||
    process.env.DYNO
  ) {
    return {
      kind: "managed",
      label: "Hosting administrado",
      needsBootstrap: false,
      allowsInternalRestart: false,
    };
  }

  return {
    kind: "self",
    label: "Node directo / VPS",
    needsBootstrap: true,
    allowsInternalRestart: true,
  };
}

async function isInsideGitWorkTree() {
  try {
    const result = await runCommand("git", ["rev-parse", "--is-inside-work-tree"]);
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function resolveCurrentBranch(preferredBranch = "") {
  const manualBranch = String(preferredBranch || "").trim();
  if (manualBranch) return manualBranch;

  const envBranch = [
    process.env.UPDATE_BRANCH,
    process.env.BOT_UPDATE_BRANCH,
    process.env.RENDER_GIT_BRANCH,
    process.env.RAILWAY_GIT_BRANCH,
    process.env.GITHUB_REF_NAME,
    process.env.BRANCH,
  ]
    .map((value) => String(value || "").trim())
    .find(Boolean);

  if (envBranch) return envBranch;

  try {
    const result = await runCommand("git", ["branch", "--show-current"]);
    const branch = result.stdout.trim();
    if (branch) return branch;
  } catch {}

  return "main";
}

function readRepositoryUrlFromPackageJson() {
  try {
    const packageJsonPath = path.join(process.cwd(), "package.json");
    if (!fs.existsSync(packageJsonPath)) return "";

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    if (typeof packageJson?.repository === "string") {
      return packageJson.repository.trim();
    }

    if (typeof packageJson?.repository?.url === "string") {
      return packageJson.repository.url.trim();
    }
  } catch {}

  return "";
}

async function readGitOriginUrl() {
  try {
    const result = await runCommand("git", ["remote", "get-url", "origin"]);
    return result.stdout.trim();
  } catch {
    return "";
  }
}

function toGitHubRepoId(value = "") {
  let raw = String(value || "").trim();
  if (!raw) return "";

  if (/^[\w.-]+\/[\w.-]+$/i.test(raw)) {
    return raw.replace(/\.git$/i, "");
  }

  if (raw.startsWith("git@github.com:")) {
    raw = raw.slice("git@github.com:".length);
  } else if (raw.startsWith("ssh://git@github.com/")) {
    raw = raw.slice("ssh://git@github.com/".length);
  } else {
    try {
      const parsed = new URL(raw);
      if (!/github\.com$/i.test(parsed.hostname)) return "";
      raw = parsed.pathname.replace(/^\/+/, "");
    } catch {
      return "";
    }
  }

  const parts = raw.replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length < 2) return "";

  return `${parts[0]}/${parts[1]}`;
}

async function resolveUpdateSource(preferredBranch = "") {
  const candidates = [
    process.env.UPDATE_REPO_URL,
    process.env.BOT_REPO_URL,
    process.env.REPO_URL,
    process.env.REPOSITORY_URL,
    process.env.GIT_REPOSITORY_URL,
    process.env.RENDER_GIT_REPOSITORY_URL,
    process.env.RAILWAY_GIT_REPOSITORY_URL,
    process.env.GITHUB_REPOSITORY
      ? `https://github.com/${process.env.GITHUB_REPOSITORY}.git`
      : "",
    await readGitOriginUrl(),
    readRepositoryUrlFromPackageJson(),
  ];

  const repoId = candidates.map((value) => toGitHubRepoId(value)).find(Boolean);
  if (!repoId) {
    throw new Error(
      "No encontre la URL del repositorio. Configura `repository.url` en package.json o una variable como UPDATE_REPO_URL."
    );
  }

  const branch = await resolveCurrentBranch(preferredBranch);

  return {
    repoId,
    repoLabel: repoId,
    repoUrl: `https://github.com/${repoId}.git`,
    branch,
    archiveUrl: `https://github.com/${repoId}/archive/refs/heads/${encodeURIComponent(branch)}.tar.gz`,
  };
}

async function resolveUpdateSourceSafe(preferredBranch = "") {
  try {
    return await resolveUpdateSource(preferredBranch);
  } catch {
    return null;
  }
}

function getWritableTempBaseDir() {
  const candidates = [os.tmpdir(), path.join(process.cwd(), "tmp")];

  for (const candidate of candidates) {
    if (!candidate) continue;

    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.accessSync(candidate, fs.constants.W_OK);
      return candidate;
    } catch {}
  }

  return process.cwd();
}

function createUpdateTempDir() {
  return fs.mkdtempSync(path.join(getWritableTempBaseDir(), "dvyer-update-"));
}

function isProtectedArchivePath(filePath, settings = {}) {
  const normalized = normalizeGitPath(filePath);
  if (!normalized) return false;

  if (isProtectedLocalPath(normalized)) return true;

  for (const prefix of ARCHIVE_PROTECTED_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return true;
    }
  }

  for (const folder of getAuthFolders(settings)) {
    if (normalized === folder || normalized.startsWith(`${folder}/`)) {
      return true;
    }
  }

  return false;
}

function shouldSkipArchiveEntry(filePath, settings = {}) {
  const normalized = normalizeGitPath(filePath);
  if (!normalized) return false;

  const [root] = normalized.split("/");
  if (ARCHIVE_SKIPPED_ROOTS.has(root)) return true;

  return isProtectedArchivePath(normalized, settings);
}

function filesDiffer(sourcePath, targetPath) {
  if (!fs.existsSync(targetPath)) return true;

  const sourceStat = fs.statSync(sourcePath);
  const targetStat = fs.statSync(targetPath);
  if (sourceStat.size !== targetStat.size) return true;

  const sourceBuffer = fs.readFileSync(sourcePath);
  const targetBuffer = fs.readFileSync(targetPath);
  return !sourceBuffer.equals(targetBuffer);
}

function syncDirectoryFromSource(sourceDir, targetDir, settings = {}) {
  const changedFiles = [];

  const walk = (currentSource, relativeRoot = "") => {
    for (const entry of fs.readdirSync(currentSource, { withFileTypes: true })) {
      const relativePath = normalizeGitPath(
        relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name
      );

      if (shouldSkipArchiveEntry(relativePath, settings)) {
        continue;
      }

      const sourcePath = path.join(currentSource, entry.name);
      const targetPath = path.join(
        targetDir,
        relativePath.split("/").join(path.sep)
      );

      if (entry.isDirectory()) {
        fs.mkdirSync(targetPath, { recursive: true });
        walk(sourcePath, relativePath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!filesDiffer(sourcePath, targetPath)) continue;

      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
      changedFiles.push(relativePath);
    }
  };

  walk(sourceDir);
  return { changedFiles };
}

function downloadFile(url, destinationPath, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "dvyer-bot-update",
          Accept: "application/octet-stream",
        },
      },
      (response) => {
        const statusCode = response.statusCode || 0;

        if (
          statusCode >= 300 &&
          statusCode < 400 &&
          response.headers.location &&
          redirectCount < 5
        ) {
          response.resume();
          const nextUrl = new URL(response.headers.location, url).toString();
          downloadFile(nextUrl, destinationPath, redirectCount + 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (statusCode !== 200) {
          response.resume();
          reject(new Error(`GitHub respondio con estado ${statusCode}.`));
          return;
        }

        const chunks = [];

        response.on("data", (chunk) => {
          chunks.push(Buffer.from(chunk));
        });

        response.on("end", () => {
          try {
            fs.writeFileSync(destinationPath, Buffer.concat(chunks));
            resolve(destinationPath);
          } catch (error) {
            reject(error);
          }
        });

        response.on("error", reject);
      }
    );

    request.on("error", reject);
  });
}

async function extractTarArchive(archivePath, destinationDir) {
  try {
    await runCommand("tar", ["-xzf", archivePath, "-C", destinationDir]);
    return;
  } catch {}

  try {
    await runCommand("tar", ["-xf", archivePath, "-C", destinationDir]);
    return;
  } catch {
    throw new Error(
      "No pude extraer la descarga del repo. Verifica que tu hosting tenga `tar` habilitado."
    );
  }
}

function getExtractedSourceRoot(directory) {
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());

  if (!entries.length) {
    throw new Error("La descarga del repo no trajo archivos para aplicar.");
  }

  return path.join(directory, entries[0].name);
}

function buildRestartBootstrap(delayMs = RESTART_DELAY_MS) {
  const args = process.argv.slice(1);

  if (process.platform === "win32") {
    const waitSeconds = Math.max(1, Math.ceil(delayMs / 1000));
    const command = [
      `timeout /t ${waitSeconds} >nul`,
      `${quoteForShell(process.execPath)} ${args.map(quoteForShell).join(" ")}`,
    ].join(" && ");

    return {
      command: "cmd.exe",
      args: ["/c", command],
    };
  }

  const waitSeconds = Math.max(1, Math.ceil(delayMs / 1000));
  const command = [
    `sleep ${waitSeconds}`,
    `${quoteForSh(process.execPath)} ${args.map(quoteForSh).join(" ")}`,
  ].join("; ");

  return {
    command: "sh",
    args: ["-c", command],
  };
}

function scheduleRestart(delayMs = RESTART_DELAY_MS) {
  const restartMode = getRestartMode();
  if (restartMode.allowsInternalRestart === false) {
    return {
      ...restartMode,
      scheduled: false,
    };
  }

  if (restartMode.needsBootstrap) {
    const bootstrap = buildRestartBootstrap(delayMs);
    const child = spawn(bootstrap.command, bootstrap.args, {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: "ignore",
    });

    child.unref();
  }

  setTimeout(() => {
    process.kill(process.pid, "SIGINT");
  }, restartMode.needsBootstrap ? 1200 : delayMs).unref?.();

  return {
    ...restartMode,
    scheduled: true,
  };
}

function runCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
        return;
      }

      reject(
        new Error(
          stderr.trim() ||
            stdout.trim() ||
            `El comando ${command} fallo con codigo ${code}.`
        )
      );
    });
  });
}

async function getRepoStatus(settings) {
  const statusResult = await runCommand("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  const allLines = toLines(statusResult.stdout);
  const blockingLines = allLines.filter(
    (line) => !isIgnorableRuntimePath(extractGitStatusPath(line), settings)
  );

  return {
    allLines,
    blockingLines,
  };
}

async function getMergeConflictPaths() {
  try {
    const result = await runCommand("git", ["diff", "--name-only", "--diff-filter=U"]);
    return uniquePaths(toLines(result.stdout));
  } catch {
    return [];
  }
}

function backupProtectedLocalFiles(filePaths = []) {
  const backups = new Map();

  for (const filePath of uniquePaths(filePaths)) {
    if (!isProtectedLocalPath(filePath)) continue;

    const absolutePath = path.join(process.cwd(), filePath.split("/").join(path.sep));
    if (!fs.existsSync(absolutePath)) {
      backups.set(filePath, { exists: false, content: "" });
      continue;
    }

    backups.set(filePath, {
      exists: true,
      content: fs.readFileSync(absolutePath, "utf-8"),
    });
  }

  return backups;
}

function restoreProtectedLocalFiles(backups = new Map()) {
  let restored = 0;

  for (const [filePath, snapshot] of backups.entries()) {
    if (!snapshot?.exists) continue;

    const absolutePath = path.join(process.cwd(), filePath.split("/").join(path.sep));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, String(snapshot.content || ""));
    restored += 1;
  }

  return restored;
}

async function getChangedProtectedLocalPaths() {
  const changed = [];

  for (const filePath of PROTECTED_LOCAL_PATHS) {
    try {
      const result = await runCommand("git", [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        filePath,
      ]);

      if (toLines(result.stdout).length) {
        changed.push(filePath);
      }
    } catch {}
  }

  return uniquePaths(changed);
}

async function resetProtectedLocalFilesToHead(filePaths = []) {
  const targets = uniquePaths(filePaths).filter((filePath) => isProtectedLocalPath(filePath));
  if (!targets.length) {
    return 0;
  }

  await runCommand("git", ["restore", "--source=HEAD", "--worktree", "--staged", "--", ...targets]);
  return targets.length;
}

async function findStashRefByLabel(label) {
  if (!label) return "";

  const stashList = await runCommand("git", ["stash", "list"]);
  const stashLine = toLines(stashList.stdout).find((line) => line.includes(label));
  if (!stashLine) return "";

  return stashLine.split(":")[0].trim();
}

async function getStashPaths(stashRef) {
  if (!stashRef) return [];

  try {
    const result = await runCommand("git", [
      "stash",
      "show",
      "--name-only",
      "--include-untracked",
      stashRef,
    ]);
    return uniquePaths(toLines(result.stdout));
  } catch {
    return [];
  }
}

async function dropStashRef(stashRef) {
  if (!stashRef) return false;
  await runCommand("git", ["stash", "drop", stashRef]);
  return true;
}

async function stashWorkspaceIfNeeded(reason = "update", filePaths = []) {
  const label = `bot-update-${reason}-${Date.now()}`;
  const normalizedPaths = uniquePaths(filePaths);
  const args = [
    "stash",
    "push",
    "--include-untracked",
    "-m",
    label,
  ];

  if (normalizedPaths.length) {
    args.push("--", ...normalizedPaths);
  }

  const result = await runCommand("git", args);
  const created = !/No local changes to save/i.test(result.stdout || "");

  return {
    label,
    created,
    result,
    filePaths: normalizedPaths,
  };
}

async function restoreWorkspaceFromStash(label, options = {}) {
  if (!label) return { restored: false };

  const stashRef = await findStashRefByLabel(label);
  if (!stashRef) {
    return { restored: false };
  }

  const filePaths = uniquePaths(
    options.filePaths?.length ? options.filePaths : await getStashPaths(stashRef)
  );
  const nonProtectedPaths = filePaths.filter((filePath) => !isProtectedLocalPath(filePath));
  const protectedBackups = options.protectedBackups instanceof Map
    ? options.protectedBackups
    : new Map();

  if (!nonProtectedPaths.length && protectedBackups.size) {
    const restoredFiles = restoreProtectedLocalFiles(protectedBackups);
    await dropStashRef(stashRef);

    return {
      restored: restoredFiles > 0,
      stashRef,
      mode: "protected-backup-only",
      restoredFiles,
    };
  }

  await runCommand("git", ["stash", "pop", stashRef]);

  if (protectedBackups.size) {
    restoreProtectedLocalFiles(protectedBackups);
  }

  return {
    restored: true,
    stashRef,
    mode: "stash-pop",
  };
}

async function performGitPullUpdate({ settings, sock, from, quoted }) {
  let stashLabel = "";
  let stashCreated = false;
  let stashRestored = false;
  let protectedBackups = new Map();

  try {
    const status = await getRepoStatus(settings);
    if (status.blockingLines.length) {
      const protectedPaths = await getChangedProtectedLocalPaths();
      protectedBackups = backupProtectedLocalFiles(protectedPaths);

      if (protectedPaths.length) {
        await resetProtectedLocalFilesToHead(protectedPaths);
      }

      const remainingStatus = await getRepoStatus(settings);
      if (remainingStatus.blockingLines.length) {
        const stash = await stashWorkspaceIfNeeded("workspace");
        stashLabel = stash.label;
        stashCreated = stash.created;
      }
    }

    const currentBranch = (await runCommand("git", ["branch", "--show-current"])).stdout.trim() || "main";
    const oldHead = (await runCommand("git", ["rev-parse", "--short", "HEAD"])).stdout.trim();
    await runCommand("git", ["fetch", "--prune", "origin", currentBranch]);
    const pullResult = await runCommand("git", [
      "pull",
      "--ff-only",
      "origin",
      currentBranch,
    ]);
    const newHead = (await runCommand("git", ["rev-parse", "--short", "HEAD"])).stdout.trim();
    const updated = oldHead !== newHead;

    let changedFiles = [];
    let depsInstalled = false;

    if (updated) {
      const diffResult = await runCommand("git", [
        "diff",
        "--name-only",
        oldHead,
        "HEAD",
      ]);
      changedFiles = toLines(diffResult.stdout);

      if (changedFiles.some((file) => DEPENDENCY_MANIFESTS.includes(file))) {
        await sock.sendMessage(
          from,
          {
            text:
              "*UPDATE BOT*\n\n" +
              "Se detectaron cambios en dependencias. Instalando paquetes...",
            ...global.channelInfo,
          },
          quoted
        );

        await runCommand(getNpmCommand(), ["install"]);
        depsInstalled = true;
      }
    }

    if (stashCreated) {
      await restoreWorkspaceFromStash(stashLabel, {
        protectedBackups,
      });
      stashRestored = true;
    } else if (protectedBackups.size) {
      restoreProtectedLocalFiles(protectedBackups);
    }

    return {
      mode: "git",
      methodLabel: "git pull",
      repoLabel: `origin/${currentBranch}`,
      branch: currentBranch,
      oldHead,
      newHead,
      updated,
      changedFiles,
      depsInstalled,
      detailLine: pickMainLine(pullResult),
      stashSummary: stashCreated
        ? protectedBackups.size
          ? "Cambios locales: *guardados y config local conservada*"
          : "Cambios locales: *guardados y restaurados*"
        : protectedBackups.size
          ? "Cambios locales: *config local conservada*"
          : "Cambios locales: *limpio*",
    };
  } catch (error) {
    if (stashCreated && !stashRestored && stashLabel) {
      try {
        await restoreWorkspaceFromStash(stashLabel, {
          protectedBackups,
        });
      } catch {}
    } else if (protectedBackups.size) {
      try {
        restoreProtectedLocalFiles(protectedBackups);
      } catch {}
    }

    throw error;
  }
}

async function performPreferredUpdate({
  settings,
  sock,
  from,
  quoted,
  branchHint = "",
}) {
  const gitRepoAvailable = await isInsideGitWorkTree();

  if (gitRepoAvailable) {
    try {
      return await performGitPullUpdate({ settings, sock, from, quoted });
    } catch (gitError) {
      const source = await resolveUpdateSourceSafe(branchHint);
      if (!source) {
        throw gitError;
      }

      const fallbackResult = await performArchiveUpdate({
        settings,
        sock,
        from,
        quoted,
        branchHint,
        source,
      });

      return {
        ...fallbackResult,
        fallbackNote:
          `git pull fallo y use GitHub directo como respaldo.\n` +
          `Motivo: ${String(gitError?.message || gitError || "sin detalle").slice(0, 220)}`,
      };
    }
  }

  return await performArchiveUpdate({
    settings,
    sock,
    from,
    quoted,
    branchHint,
  });
}

async function performArchiveUpdate({
  settings,
  sock,
  from,
  quoted,
  branchHint = "",
  source = null,
}) {
  const resolvedSource = source || (await resolveUpdateSource(branchHint));
  const tempDir = createUpdateTempDir();
  const archivePath = path.join(tempDir, "repo.tar.gz");
  const extractDir = path.join(tempDir, "extract");
  const beforeManifests = readDependencyManifestSnapshot();

  fs.mkdirSync(extractDir, { recursive: true });

  try {
    await downloadFile(resolvedSource.archiveUrl, archivePath);
    await extractTarArchive(archivePath, extractDir);

    const snapshotRoot = getExtractedSourceRoot(extractDir);
    const syncResult = syncDirectoryFromSource(snapshotRoot, process.cwd(), settings);
    const afterManifests = readDependencyManifestSnapshot();

    let depsInstalled = false;
    if (dependencyManifestsChanged(beforeManifests, afterManifests)) {
      await sock.sendMessage(
        from,
        {
          text:
            "*UPDATE BOT*\n\n" +
            "Se detectaron cambios en dependencias. Instalando paquetes...",
          ...global.channelInfo,
        },
        quoted
      );

      await runCommand(getNpmCommand(), ["install"]);
      depsInstalled = true;
    }

    return {
      mode: "archive",
      methodLabel: "GitHub directo",
      repoLabel: resolvedSource.repoLabel,
      branch: resolvedSource.branch,
      updated: syncResult.changedFiles.length > 0,
      changedFiles: syncResult.changedFiles,
      depsInstalled,
      detailLine: `Snapshot descargado desde ${resolvedSource.repoId}`,
      stashSummary: "Cambios locales: *config, sesiones y datos conservados*",
    };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

async function buildUpdateInfo(settings, msg, from, esOwner) {
  const ownerAccess = resolveOwnerAccess({ esOwner, settings, msg, from });
  const gitRepoAvailable = await isInsideGitWorkTree();
  const branch = await resolveCurrentBranch();
  const source = await resolveUpdateSourceSafe(branch);
  const restartMode = getRestartMode();
  const head = gitRepoAvailable
    ? (await runCommand("git", ["rev-parse", "--short", "HEAD"])).stdout.trim()
    : "sin repo git";
  const status = gitRepoAvailable
    ? await getRepoStatus(settings)
    : { allLines: [], blockingLines: [] };

  return {
    ownerAccess,
    gitRepoAvailable,
    source,
    branch,
    head,
    status,
    restartMode,
    updateMode: gitRepoAvailable
      ? "git pull (preferido)"
      : source
        ? "GitHub directo"
        : "sin origen configurado",
  };
}

export default {
  name: "update",
  command: ["update", "actualizar", "actualiza", "upgrade"],
  category: "sistema",
  description:
    "Actualiza el bot con git pull cuando el repo local esta disponible; si falla usa GitHub directo como respaldo",

  run: async ({ sock, msg, from, args = [], esOwner, settings }) => {
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const ownerAccess = resolveOwnerAccess({ esOwner, settings, msg, from });
    const normalizedArgs = (Array.isArray(args) ? args : []).map((value) =>
      String(value || "").trim().toLowerCase()
    );
    const subcommand = normalizedArgs[0] || "";

    if (subcommand === "info" || subcommand === "check" || subcommand === "debug") {
      try {
        const info = await buildUpdateInfo(settings, msg, from, esOwner);
        const dirtyCount = info.status.blockingLines.length;

        return sock.sendMessage(
          from,
          {
            text: buildUpdateMessage(
              "UPDATE INFO",
              [
                `• Owner detectado: *${info.ownerAccess.isOwner ? "SI" : "NO"}*`,
                `• Matches owner: *${info.ownerAccess.matches.join(", ") || "ninguno"}*`,
                `• Sender IDs: ${info.ownerAccess.senderIds.join(", ") || "ninguno"}`,
                `• Owners config: ${info.ownerAccess.ownerIds.join(", ") || "ninguno"}`,
                `• Repo local git: *${info.gitRepoAvailable ? "SI" : "NO"}*`,
                `• Metodo: *${info.updateMode}*`,
                `• Origen: *${info.source?.repoLabel || "no detectado"}*`,
                `• Rama: *${info.branch}*`,
                `• Commit: *${info.head}*`,
                `• Entorno: *${info.restartMode.label}*`,
                `• Reinicio interno: *${info.restartMode.allowsInternalRestart ? "SI" : "NO"}*`,
                `• Hot-reload runtime: *${global?.botRuntime?.applyHotRuntimeRefresh ? "SI" : "NO"}*`,
                `• Cambios bloqueantes: *${dirtyCount}*`,
              ],
              "`.update` sin reinicio\n`.update hot` actualiza y recarga\n`.update restart` actualiza y reinicia\n`.update norestart` actualiza sin reiniciar"
            ),
            ...global.channelInfo,
          },
          quoted
        );
      } catch (error) {
        return sock.sendMessage(
          from,
          {
            text: buildUpdateMessage("ERROR UPDATE INFO", [
              `${error?.message || "No pude revisar el estado del bot."}`,
            ]),
            ...global.channelInfo,
          },
          quoted
        );
      }
    }

    if (!ownerAccess.isOwner) {
      return sock.sendMessage(
        from,
        {
          text: buildUpdateMessage(
            "UPDATE BLOQUEADO",
            [
              "Solo el owner puede usar .update.",
              `• Sender detectado: *${ownerAccess.senderIds.join(", ") || "ninguno"}*`,
              `• Owners guardados: *${ownerAccess.ownerIds.join(", ") || "ninguno"}*`,
            ],
            "Prueba tambien con *.update info* o *.whoami* para revisar el owner."
          ),
          ...global.channelInfo,
        },
        quoted
      );
    }

    if (updateInProgress) {
      return sock.sendMessage(
        from,
        {
          text: "Ya hay una actualizacion en proceso. Espera a que termine.",
          ...global.channelInfo,
        },
        quoted
      );
    }

    updateInProgress = true;
    let restartScheduled = false;

    try {
      const forceRestart = normalizedArgs.some((value) =>
        ["force", "restart", "reboot"].includes(value)
      );
      const requestedHotReload = normalizedArgs.some((value) =>
        ["hot", "reload", "recargar", "hotreload", "hot-reload"].includes(value)
      );
      const requestedNoRestart = normalizedArgs.some((value) =>
        ["norestart", "no-restart", "sinreinicio", "sin-reinicio"].includes(value)
      );
      const restartMode = getRestartMode();
      const allowAutomaticRestart = forceRestart && !requestedNoRestart;
      const skipRestart = !allowAutomaticRestart;
      const gitRepoAvailable = await isInsideGitWorkTree();

      await sock.sendMessage(
        from,
        {
          text: buildUpdateMessage(
            "UPDATE BOT",
            [
              skipRestart
                ? `• ${gitRepoAvailable ? "Actualizando con git pull" : "Descargando desde GitHub"} sin reiniciar el proceso`
                : `• ${gitRepoAvailable ? "Actualizando con git pull" : "Descargando desde GitHub"}`,
              requestedHotReload
                ? "• Modo hot-reload: *activo*"
                : "• Modo hot-reload: *inactivo*",
              `• Entorno: *${restartMode.label}*`,
            ]
          ),
          ...global.channelInfo,
        },
        quoted
      );

      const updateResult = await performPreferredUpdate({
        settings,
        sock,
        from,
        quoted,
      });

      if (!updateResult.updated && !forceRestart) {
        await sock.sendMessage(
          from,
          {
            text: buildUpdateMessage(
              "BOT ACTUALIZADO",
              [
                updateResult.mode === "git"
                  ? "No habia cambios nuevos en GitHub."
                  : "No detecte archivos nuevos para copiar desde GitHub.",
                updateResult.mode === "git"
                  ? `• Commit actual: *${updateResult.newHead}*`
                  : `• Rama remota: *${updateResult.branch}*`,
              ]
            ),
            ...global.channelInfo,
          },
          quoted
        );
        updateInProgress = false;
        return;
      }

      const summary = updateResult.mode === "git"
        ? updateResult.updated
          ? `Commit: *${updateResult.oldHead}* -> *${updateResult.newHead}*`
          : `Commit actual: *${updateResult.newHead}*`
        : `Rama remota: *${updateResult.branch}*`;
      const changedSummary = updateResult.changedFiles.length
        ? `Archivos: *${updateResult.changedFiles.length}*`
        : "Archivos: *sin cambios nuevos*";
      const depsSummary = updateResult.depsInstalled
        ? "Dependencias: *actualizadas*"
        : "Dependencias: *sin cambios*";
      const restartNeededByFiles = forceRestart || updateRequiresRestart(updateResult);
      const hotReloadEligible = canHotApplyWithoutRestart(updateResult);
      let hotReloadResult = {
        attempted: false,
        ok: false,
        message: "No ejecutado.",
      };

      if (updateResult.updated && (requestedHotReload || (skipRestart && hotReloadEligible))) {
        hotReloadResult = await tryApplyHotRuntimeUpdate();
      }

      const restartNeeded =
        forceRestart
          ? true
          : restartNeededByFiles && !(hotReloadEligible && hotReloadResult.ok);

      if (skipRestart) {
        await sock.sendMessage(
          from,
          {
            text: buildUpdateMessage(
              "UPDATE OK",
              [
                `• Metodo: *${updateResult.methodLabel}*`,
                `• Origen: *${updateResult.repoLabel}*`,
                `• ${summary}`,
                `• ${changedSummary}`,
                `• ${depsSummary}`,
                `• ${updateResult.stashSummary}`,
                `• Detalle: ${updateResult.detailLine}`,
                ...(updateResult.fallbackNote ? [`• ${updateResult.fallbackNote}`] : []),
                `• Hot reload: *${hotReloadResult.attempted ? (hotReloadResult.ok ? "OK" : "PARCIAL/ERROR") : "NO EJECUTADO"}*`,
                ...(hotReloadResult.attempted ? [`• Detalle hot: ${hotReloadResult.message}`] : []),
                "• Aplicacion: *sin reinicio*",
              ],
              restartNeeded
                ? "Los archivos ya se actualizaron en disco. Aun hay cambios que requieren `.restart` para quedar activos."
                : "Los cambios quedaron aplicados y cargados sin reinicio."
            ),
            ...global.channelInfo,
          },
          quoted
        );
        updateInProgress = false;
        return;
      }

      if (restartMode.allowsInternalRestart === false) {
        await sock.sendMessage(
          from,
          {
            text: buildUpdateMessage(
              "UPDATE OK",
              [
                `• Metodo: *${updateResult.methodLabel}*`,
                `• Origen: *${updateResult.repoLabel}*`,
                `• ${summary}`,
                `• ${changedSummary}`,
                `• ${depsSummary}`,
                `• ${updateResult.stashSummary}`,
                `• Detalle: ${updateResult.detailLine}`,
                ...(updateResult.fallbackNote ? [`• ${updateResult.fallbackNote}`] : []),
                "• Aplicacion: *reinicio manual requerido*",
              ],
              "Este hosting no usa reinicio interno seguro desde el bot. Los archivos ya quedaron actualizados, pero debes reiniciar desde tu panel, PM2 o consola cuando quieras cargar el codigo nuevo."
            ),
            ...global.channelInfo,
          },
          quoted
        );
        updateInProgress = false;
        return;
      }

      await sock.sendMessage(
        from,
        {
          text: buildUpdateMessage(
            "UPDATE OK",
            [
              `• Metodo: *${updateResult.methodLabel}*`,
              `• Origen: *${updateResult.repoLabel}*`,
              `• ${summary}`,
              `• ${changedSummary}`,
              `• ${depsSummary}`,
              `• ${updateResult.stashSummary}`,
              `• Detalle: ${updateResult.detailLine}`,
              ...(updateResult.fallbackNote ? [`• ${updateResult.fallbackNote}`] : []),
              `• Reinicio: *${restartMode.label}*`,
            ],
            "Reiniciando el bot en unos segundos.\nLa sesion de WhatsApp se conserva, aunque puede haber una reconexion breve."
          ),
          ...global.channelInfo,
        },
        quoted
      );

      await delay(1500);
      restartScheduled = true;
      const restartResult = scheduleRestart(RESTART_DELAY_MS);

      if (restartResult?.scheduled === false) {
        restartScheduled = false;
        updateInProgress = false;
        await sock.sendMessage(
          from,
          {
            text: buildUpdateMessage(
              "UPDATE OK",
              [
                `• Metodo: *${updateResult.methodLabel}*`,
                `• Origen: *${updateResult.repoLabel}*`,
                `• ${summary}`,
                `• ${changedSummary}`,
                `• ${depsSummary}`,
                `• ${updateResult.stashSummary}`,
                `• Detalle: ${updateResult.detailLine}`,
                ...(updateResult.fallbackNote ? [`• ${updateResult.fallbackNote}`] : []),
                "• Aplicacion: *reinicio manual requerido*",
              ],
              "Bloquee el reinicio interno para no tumbar tu servidor. Reinicia manualmente cuando quieras cargar el codigo nuevo."
            ),
            ...global.channelInfo,
          },
          quoted
        );
        return;
      }
    } catch (error) {
      await sock.sendMessage(
        from,
        {
          text: buildUpdateMessage("ERROR UPDATE", [
            `${error?.message || "No pude actualizar el bot."}`,
          ]),
          ...global.channelInfo,
        },
        quoted
      );
      updateInProgress = false;
      return;
    } finally {
      if (!restartScheduled) {
        updateInProgress = false;
      }
    }
  },
};
