/**
 * Filesystem helpers shared by dream.js and extract.js.
 *
 * Pure functions, no side effects beyond fs/process. Logging is the
 * caller's responsibility — these helpers return data and let the caller
 * decide how loud to be.
 */

const fs = require('fs');
const path = require('path');

// Read the Claude Code hook payload that trigger.sh wrote to a tempfile.
// Returns the parsed JSON object, or null if no payload / unreadable / invalid.
// The temp file is consumed (deleted) on successful read so the next process
// invocation starts clean.
function readHookPayload() {
  const payloadFile = process.env.CLAUDE_HOOK_PAYLOAD_FILE;
  if (!payloadFile) return null;
  try {
    const raw = fs.readFileSync(payloadFile, 'utf-8');
    try { fs.unlinkSync(payloadFile); } catch (e) { /* best effort */ }
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// List .jsonl session transcripts in projectDir with mtimeMs >= sinceMs.
// Sorted desc by mtimeMs (newest first). Optional excludeId filters out the
// transcript whose filename contains that id.
function listSessionsSince(projectDir, sinceMs, excludeId) {
  let entries;
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const out = [];
  for (const d of entries) {
    if (!d.isFile()) continue;
    if (!d.name.endsWith('.jsonl')) continue;
    if (excludeId && d.name.includes(excludeId)) continue;
    const fullPath = path.join(projectDir, d.name);
    try {
      const st = fs.statSync(fullPath);
      if (st.mtimeMs < sinceMs) continue;
      out.push({ path: fullPath, mtimeMs: st.mtimeMs, basename: d.name.replace(/\.jsonl$/, '') });
    } catch (e) { /* skip unreadable */ }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function isProcessAlive(pid) {
  try { process.kill(parseInt(pid), 0); return true; } catch (e) { return false; }
}

// Atomic-ish lock acquire: write `<pid> <ms>` to lockFile. Caller is expected
// to have checked inspectLock first and removed any stale lock.
function acquireLock(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, `${process.pid} ${Date.now()}`);
}

function releaseLock(lockFile) {
  try { fs.unlinkSync(lockFile); } catch (e) { /* best effort */ }
}

// Inspect a lock file. Returns:
//   { held: false }                                     no lock file
//   { held: true, pid, lockTime, ageSec }               held by a live pid within maxAgeSec
//   { held: false, stale: true, pid, ageSec }           lock exists but stale
//   { held: false, unreadable: true }                   lock file unreadable
function inspectLock(lockFile, maxAgeSec) {
  if (!fs.existsSync(lockFile)) return { held: false };
  try {
    const content = fs.readFileSync(lockFile, 'utf-8').trim().split(/\s+/);
    const pid = content[0];
    const lockTime = parseInt(content[1]) || 0;
    const ageSec = Math.floor((Date.now() - lockTime) / 1000);
    if (ageSec < maxAgeSec && pid && isProcessAlive(pid)) {
      return { held: true, pid, lockTime, ageSec };
    }
    return { held: false, stale: true, pid, ageSec };
  } catch (e) {
    return { held: false, unreadable: true };
  }
}

// Parse a timestamp file storing either ms (>12 chars) or seconds. Returns
// epoch seconds, or 0 if missing/unparseable.
function readTimestampFile(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    const parsed = parseInt(raw);
    if (isNaN(parsed)) return 0;
    return raw.length > 12 ? Math.floor(parsed / 1000) : parsed;
  } catch (e) {
    return 0;
  }
}

module.exports = {
  readHookPayload,
  listSessionsSince,
  isProcessAlive,
  acquireLock,
  releaseLock,
  inspectLock,
  readTimestampFile,
};
