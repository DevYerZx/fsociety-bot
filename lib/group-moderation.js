import path from "path";
import { createScheduledJsonStore } from "./json-store.js";

const FILE = path.join(process.cwd(), "database", "moderation.json");
const store = createScheduledJsonStore(FILE, () => ({ groups: {} }));
const MAX_LOGS = 300;

function ensureGroup(groupId = "") {
  const key = String(groupId || "").trim();
  if (!store.state.groups || typeof store.state.groups !== "object") {
    store.state.groups = {};
  }
  if (!store.state.groups[key]) {
    store.state.groups[key] = {
      enabled: true,
      maxWarnings: 3,
      warnings: {},
      logs: [],
    };
  }
  return store.state.groups[key];
}

function userKey(value = "") {
  return String(value || "").trim().toLowerCase();
}

export function getModerationConfig(groupId) {
  const group = ensureGroup(groupId);
  return {
    enabled: group.enabled !== false,
    maxWarnings: Math.max(2, Math.min(10, Number(group.maxWarnings || 3))),
  };
}

export function setModerationConfig(groupId, changes = {}) {
  const group = ensureGroup(groupId);
  if (typeof changes.enabled === "boolean") group.enabled = changes.enabled;
  if (changes.maxWarnings !== undefined) {
    group.maxWarnings = Math.max(2, Math.min(10, Number(changes.maxWarnings || 3)));
  }
  store.saveNow();
  return getModerationConfig(groupId);
}

export function addModerationLog(groupId, payload = {}) {
  const group = ensureGroup(groupId);
  if (!Array.isArray(group.logs)) group.logs = [];
  group.logs.push({ at: new Date().toISOString(), ...payload });
  group.logs = group.logs.slice(-MAX_LOGS);
  store.saveNow();
}

export function getModerationLogs(groupId, limit = 15) {
  const group = ensureGroup(groupId);
  return (Array.isArray(group.logs) ? group.logs : [])
    .slice(-Math.max(1, Math.min(50, Number(limit || 15))))
    .reverse();
}

export function addWarning(groupId, user, payload = {}) {
  const group = ensureGroup(groupId);
  const key = userKey(user);
  if (!key) return { ok: false, count: 0, maxWarnings: group.maxWarnings || 3 };
  if (!group.warnings || typeof group.warnings !== "object") group.warnings = {};
  if (!Array.isArray(group.warnings[key])) group.warnings[key] = [];
  group.warnings[key].push({
    at: new Date().toISOString(),
    reason: String(payload.reason || "Sin motivo").slice(0, 300),
    by: String(payload.by || ""),
    source: String(payload.source || "manual"),
  });
  const count = group.warnings[key].length;
  addModerationLog(groupId, {
    action: "warning",
    user: key,
    reason: payload.reason || "Sin motivo",
    source: payload.source || "manual",
    count,
  });
  return {
    ok: true,
    count,
    maxWarnings: Math.max(2, Math.min(10, Number(group.maxWarnings || 3))),
    shouldKick: group.enabled !== false && count >= Number(group.maxWarnings || 3),
  };
}

export function getWarnings(groupId, user) {
  const group = ensureGroup(groupId);
  return Array.isArray(group.warnings?.[userKey(user)])
    ? [...group.warnings[userKey(user)]]
    : [];
}

export function clearWarnings(groupId, user) {
  const group = ensureGroup(groupId);
  const key = userKey(user);
  const existed = Boolean(group.warnings?.[key]);
  if (group.warnings) delete group.warnings[key];
  store.saveNow();
  return existed;
}
