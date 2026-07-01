const DELETE_TTL_MS = 2 * 60 * 1000;
const moderationDeletes = new Map();

function buildDeleteKey(groupId = "", messageKey = {}) {
  const chatId = String(groupId || messageKey?.remoteJid || "").trim();
  const messageId = String(messageKey?.id || "").trim();
  return chatId && messageId ? `${chatId}|${messageId}` : "";
}

function pruneModerationDeletes() {
  const now = Date.now();
  for (const [key, expiresAt] of moderationDeletes) {
    if (Number(expiresAt || 0) <= now) {
      moderationDeletes.delete(key);
    }
  }
}

export function markModerationDelete(groupId, messageKey) {
  const key = buildDeleteKey(groupId, messageKey);
  if (!key) return false;
  pruneModerationDeletes();
  moderationDeletes.set(key, Date.now() + DELETE_TTL_MS);
  return true;
}

export function unmarkModerationDelete(groupId, messageKey) {
  const key = buildDeleteKey(groupId, messageKey);
  return key ? moderationDeletes.delete(key) : false;
}

export function consumeModerationDelete(groupId, messageKey) {
  const key = buildDeleteKey(groupId, messageKey);
  if (!key) return false;
  pruneModerationDeletes();
  if (!moderationDeletes.has(key)) return false;
  moderationDeletes.delete(key);
  return true;
}

export async function deleteMessageForModeration(sock, groupId, messageKey) {
  if (!sock?.sendMessage || !messageKey?.id) return false;
  markModerationDelete(groupId, messageKey);

  try {
    await sock.sendMessage(groupId, { delete: messageKey });
    return true;
  } catch {
    unmarkModerationDelete(groupId, messageKey);
    return false;
  }
}
