// Draft-sync decision logic: pure functions, shared by app.js and node tests.

// Grace period during which local typing beats any remote draft update.
var DRAFT_LOCAL_GRACE_MS = 2500;
// Debounce before a local edit is pushed to the gateway.
var DRAFT_PUSH_DELAY_MS = 600;

function draftSyncDecision(remote, deviceId, lastTypedAt, now) {
  if (!remote || typeof remote !== "object") return null;
  if (remote.origin === deviceId) return null;
  if (typeof remote.text !== "string") return null;
  if (now - (lastTypedAt || 0) < DRAFT_LOCAL_GRACE_MS) return null;
  return remote.text;
}

function draftChanged(local, remote) {
  return String(local || "") !== String(remote || "");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DRAFT_LOCAL_GRACE_MS: DRAFT_LOCAL_GRACE_MS,
    DRAFT_PUSH_DELAY_MS: DRAFT_PUSH_DELAY_MS,
    draftSyncDecision: draftSyncDecision,
    draftChanged: draftChanged,
  };
}
