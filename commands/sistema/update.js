import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const RESTART_DELAY_MS = 3000;
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
    };
  }

  return {
    kind: "self",
    label: "Node directo / VPS",
    needsBootstrap: true,
  };
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

  return restartMode;
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

async function buildUpdateInfo(settings, msg, from, esOwner) {
  const ownerAccess = resolveOwnerAccess({ esOwner, settings, msg, from });
  const branch = (await runCommand("git", ["branch", "--show-current"])).stdout.trim() || "main";
  const head = (await runCommand("git", ["rev-parse", "--short", "HEAD"])).stdout.trim();
  const status = await getRepoStatus(settings);
  const restartMode = getRestartMode();

  return {
    ownerAccess,
    branch,
    head,
    status,
    restartMode,
  };
}

export default {
  name: "update",
  command: ["update"],
  category: "sistema",
  description: "Actualiza el bot con git pull y reinicia sin perder la sesion",

  run: async ({ sock, msg, from, args = [], esOwner, settings }) => {
    const quoted = msg?.key ? { quoted: msg } : undefined;
    const ownerAccess = resolveOwnerAccess({ esOwner, settings, msg, from });
    const subcommand = String(args[0] || "").toLowerCase();

    if (subcommand === "info" || subcommand === "check" || subcommand === "debug") {
      try {
        const info = await buildUpdateInfo(settings, msg, from, esOwner);
        const dirtyCount = info.status.blockingLines.length;

        return sock.sendMessage(
          from,
          {
            text:
              "*UPDATE INFO*\n\n" +
              `Owner detectado: *${info.ownerAccess.isOwner ? "SI" : "NO"}*\n` +
              `Matches owner: *${info.ownerAccess.matches.join(", ") || "ninguno"}*\n` +
              `Sender IDs: ${info.ownerAccess.senderIds.join(", ") || "ninguno"}\n` +
              `Owners config: ${info.ownerAccess.ownerIds.join(", ") || "ninguno"}\n` +
              `Branch: *${info.branch}*\n` +
              `Commit: *${info.head}*\n` +
              `Entorno: *${info.restartMode.label}*\n` +
              `Cambios bloqueantes: *${dirtyCount}*`,
            ...global.channelInfo,
          },
          quoted
        );
      } catch (error) {
        return sock.sendMessage(
          from,
          {
            text:
              "*ERROR UPDATE INFO*\n\n" +
              `${error?.message || "No pude revisar el estado del bot."}`,
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
          text:
            "*UPDATE BLOQUEADO*\n\n" +
            "Solo el owner puede usar .update.\n" +
            `Sender detectado: *${ownerAccess.senderIds.join(", ") || "ninguno"}*\n` +
            `Owners guardados: *${ownerAccess.ownerIds.join(", ") || "ninguno"}*\n\n` +
            "Prueba tambien con *.update info* o *.whoami* para revisar el owner.",
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
    let stashLabel = "";
    let stashCreated = false;
    let stashRestored = false;
    let protectedPaths = [];
    let protectedBackups = new Map();

    try {
      const forceRestart = ["force", "restart", "reboot"].includes(subcommand);
      const restartMode = getRestartMode();
      const mergeConflicts = await getMergeConflictPaths();

      if (mergeConflicts.length) {
        await sock.sendMessage(
          from,
          {
            text:
              "*UPDATE BLOQUEADO*\n\n" +
              "Tu repo ya tiene archivos en conflicto.\n" +
              `Conflictos: *${mergeConflicts.join(", ")}*\n\n` +
              "Primero resuelve ese merge y luego vuelve a usar .update.",
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
          text:
            "*UPDATE BOT*\n\n" +
            "Buscando cambios en GitHub y preparando reinicio...\n" +
            `Entorno: *${restartMode.label}*`,
          ...global.channelInfo,
        },
        quoted
      );

      const status = await getRepoStatus(settings);
      if (status.blockingLines.length) {
        protectedPaths = await getChangedProtectedLocalPaths();
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

      const currentBranch = (
        await runCommand("git", ["branch", "--show-current"])
      ).stdout.trim() || "main";
      const oldHead = (
        await runCommand("git", ["rev-parse", "--short", "HEAD"])
      ).stdout.trim();
      const pullResult = await runCommand("git", [
        "pull",
        "--ff-only",
        "origin",
        currentBranch,
      ]);
      const newHead = (
        await runCommand("git", ["rev-parse", "--short", "HEAD"])
      ).stdout.trim();
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

        if (
          changedFiles.some((file) =>
            ["package.json", "package-lock.json", "npm-shrinkwrap.json"].includes(file)
          )
        ) {
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

      if (!updated && !forceRestart) {
        await sock.sendMessage(
          from,
          {
            text:
              "*BOT ACTUALIZADO*\n\n" +
              `No habia cambios nuevos en GitHub.\n` +
              `Commit actual: *${newHead}*`,
            ...global.channelInfo,
          },
          quoted
        );
        updateInProgress = false;
        return;
      }

      const summary =
        updated
          ? `Commit: *${oldHead}* -> *${newHead}*`
          : `Commit actual: *${newHead}*`;
      const pullDetail = pickMainLine(pullResult);
      const changedSummary = changedFiles.length
        ? `Archivos: *${changedFiles.length}*`
        : "Archivos: *sin cambios nuevos*";
      const depsSummary = depsInstalled
        ? "Dependencias: *actualizadas*"
        : "Dependencias: *sin cambios*";
      const stashSummary = stashCreated
        ? protectedBackups.size
          ? "Cambios locales: *guardados y config local conservada*"
          : "Cambios locales: *guardados y restaurados*"
        : protectedBackups.size
          ? "Cambios locales: *config local conservada*"
          : "Cambios locales: *limpio*";

      await sock.sendMessage(
        from,
        {
          text:
            "*UPDATE OK*\n\n" +
            `${summary}\n` +
            `${changedSummary}\n` +
            `${depsSummary}\n` +
            `${stashSummary}\n` +
            `Git: ${pullDetail}\n` +
            `Reinicio: *${restartMode.label}*\n\n` +
            "Reiniciando el bot en unos segundos.\n" +
            "La sesion de WhatsApp se conserva, aunque puede haber una reconexion breve.",
          ...global.channelInfo,
        },
        quoted
      );

      await delay(1500);
      restartScheduled = true;
      scheduleRestart(RESTART_DELAY_MS);
    } catch (error) {
      if (stashCreated && !stashRestored && stashLabel) {
        try {
          await restoreWorkspaceFromStash(stashLabel, {
            protectedBackups,
          });
          stashRestored = true;
        } catch {}
      } else if (protectedBackups.size) {
        try {
          restoreProtectedLocalFiles(protectedBackups);
        } catch {}
      }

      let extra = "";

      if (stashCreated && stashLabel) {
        extra =
          "\n\nSe intento guardar el workspace antes del update.\n" +
          (stashRestored
            ? "Los cambios locales fueron restaurados."
            : "Si algo quedo pendiente, revisa `git stash list`.");
      }

      await sock.sendMessage(
        from,
        {
          text:
            "*ERROR UPDATE*\n\n" +
            `${error?.message || "No pude actualizar el bot."}${extra}`,
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
