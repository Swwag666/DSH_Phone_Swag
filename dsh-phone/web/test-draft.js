// Node tests for draftsync.js decision logic.
const ds = require("./draftsync.js");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log("FAIL: " + name); }
}

const NOW = 100000;
const remote = (text, origin) => ({ sessionId: "s1", text, origin, ts: NOW });

// 1. remote draft from another device applies
ok("applies remote draft", ds.draftSyncDecision(remote("привет", "dev-2"), "dev-1", 0, NOW) === "привет");

// 2. own echo is ignored
ok("ignores own echo", ds.draftSyncDecision(remote("привет", "dev-1"), "dev-1", 0, NOW) === null);

// 3. local typing within grace wins
ok("local typing wins",
  ds.draftSyncDecision(remote("другое", "dev-2"), "dev-1", NOW - 1000, NOW) === null);

// 4. stale local typing (past grace) lets remote apply
ok("stale local typing loses",
  ds.draftSyncDecision(remote("другое", "dev-2"), "dev-1", NOW - ds.DRAFT_LOCAL_GRACE_MS - 1, NOW) === "другое");

// 5. non-string text is rejected
ok("rejects non-string text", ds.draftSyncDecision({ sessionId: "s1", origin: "dev-2", text: 5 }, "dev-1", 0, NOW) === null);
ok("rejects missing text", ds.draftSyncDecision({ sessionId: "s1", origin: "dev-2" }, "dev-1", 0, NOW) === null);

// 6. garbage input is rejected
ok("rejects null remote", ds.draftSyncDecision(null, "dev-1", 0, NOW) === null);
ok("rejects undefined remote", ds.draftSyncDecision(undefined, "dev-1", 0, NOW) === null);

// 7. empty text (clear) applies like any text
ok("applies clear", ds.draftSyncDecision(remote("", "dev-2"), "dev-1", 0, NOW) === "");

// 8. draftChanged detects real differences
ok("changed detected", ds.draftChanged("a", "b") === true);
ok("same text no change", ds.draftChanged("a", "a") === false);
ok("null vs empty no change", ds.draftChanged(null, "") === false);
ok("undefined vs empty no change", ds.draftChanged(undefined, "") === false);
ok("text vs empty change", ds.draftChanged("текст", "") === true);

// 9. debounce constant is sane
ok("push delay in range", ds.DRAFT_PUSH_DELAY_MS >= 300 && ds.DRAFT_PUSH_DELAY_MS <= 2000);

console.log(`draft-sync: ${pass} passed, ${fail} failed`);
if (fail > 0 || pass < 15) process.exit(1);
