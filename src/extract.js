#!/usr/bin/env node
/**
 * claude-auto-dream extract: incremental memory writer.
 *
 * Runs on every Stop hook. Reads the transcript window since the last
 * extraction (cursor file), decides whether anything is worth saving,
 * and asks the LLM to write/edit memory files in the project's memory dir.
 *
 * Mirrors official Claude Code 2.1.x extractMemories (qn5/$n5/Kn5):
 *   - skip when stop_hook_active (recursion guard)
 *   - skip when assistant already wrote to memory in window
 *   - skip when user-prose word count < minProseWords
 *   - skip when extract lock held (sibling extract running)
 *
 * Usage:
 *   node extract.js                  # normal (called by Stop hook via env payload)
 *   node extract.js --dry-run        # parse window + run skip checks, no API
 */

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const {
  readHookPayload,
  acquireLock,
  releaseLock,
  inspectLock,
} = require('./lib/fs-helpers');
const { getToolDefs, canUseTool, executeTool } = require('./lib/tools');
const { callAPI, extractToolCalls, appendToolResult, appendAssistantMessage } = require('./lib/api');

// ── Parse CLI args ──────────────────────────────────────────────────────
const argv = {
  dryRun: process.argv.includes('--dry-run'),
};

// ── Hook payload + recursion guard ─────────────────────────────────────
const HOOK_PAYLOAD = readHookPayload();
if (HOOK_PAYLOAD && HOOK_PAYLOAD.stop_hook_active) {
  process.stderr.write('[claude-auto-dream extract] skipping: stop_hook_active\n');
  process.exit(0);
}

// ── Config ─────────────────────────────────────────────────────────────
const config = loadConfig({});
const extractCfg = (config.extract && typeof config.extract === 'object') ? config.extract : {};
if (extractCfg.enabled === false) {
  process.stderr.write('[claude-auto-dream extract] disabled in config\n');
  process.exit(0);
}

// ── Paths ──────────────────────────────────────────────────────────────
const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(process.env.HOME, '.claude');
const MEMORY_DIR = detectMemoryDir(HOOK_PAYLOAD && HOOK_PAYLOAD.cwd);
const LOG_DIR = path.join(process.env.HOME, '.claude', 'plugins', 'cache', 'claude-auto-dream', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(MEMORY_DIR, { recursive: true });

const CURSOR_FILE = path.join(MEMORY_DIR, '.last-extracted');
const EXTRACT_LOCK = path.join(MEMORY_DIR, '.extract-lock');
const COUNTER_FILE = path.join(MEMORY_DIR, '.extract-counter');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LOG_FILE = path.join(LOG_DIR, `extract-${TIMESTAMP}.log`);

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] [extract] ${msg}`;
  process.stderr.write(line + '\n');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

function detectMemoryDir(cwdOverride) {
  if (process.env.CLAUDE_AUTO_DREAM_MEMORY_DIR) return process.env.CLAUDE_AUTO_DREAM_MEMORY_DIR;
  const cwd = cwdOverride || process.cwd();
  const sanitized = cwd.replace(/[/\\]/g, '-');
  return path.join(CLAUDE_DIR, 'projects', sanitized, 'memory');
}

// ── Transcript parsing ─────────────────────────────────────────────────
// Parse the JSONL transcript and return messages newer than sinceUuid.
// If sinceUuid is null/missing in the file, return everything.
function parseTranscript(transcriptPath, sinceUuid) {
  let raw;
  try { raw = fs.readFileSync(transcriptPath, 'utf-8'); }
  catch (e) { return { messages: [], lastUuid: sinceUuid }; }

  const all = [];
  for (const ln of raw.split('\n')) {
    if (!ln) continue;
    try { all.push(JSON.parse(ln)); }
    catch (e) { /* skip bad line */ }
  }

  let startIdx = 0;
  if (sinceUuid) {
    const i = all.findIndex(m => m.uuid === sinceUuid);
    if (i >= 0) startIdx = i + 1;
  }
  const window = all.slice(startIdx);
  // Real transcripts end with meta rows (last-prompt, permission-mode, ai-title…)
  // that don't have a uuid. Walk backwards to find the last uuid-bearing entry
  // so the cursor advances correctly.
  let lastUuid = sinceUuid;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i] && all[i].uuid) { lastUuid = all[i].uuid; break; }
  }
  return { messages: window, lastUuid };
}

// ── Skip checks ────────────────────────────────────────────────────────
// Did assistant in window already use a write/edit tool on a path under memDir?
function assistantAlreadyWroteMemory(messages, memDir) {
  const memRoot = path.resolve(memDir) + path.sep;
  for (const m of messages) {
    if (m.type !== 'assistant') continue;
    const content = m.message && m.message.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type !== 'tool_use') continue;
      const name = (c.name || '').toLowerCase();
      if (!/(write|edit|create_file|update_file|create|new_file)/.test(name)) continue;
      const input = c.input || {};
      const filePath = input.file_path || input.path || input.target_file || '';
      if (!filePath) continue;
      const resolved = path.resolve(filePath);
      if (resolved === path.resolve(memDir) || resolved.startsWith(memRoot)) return true;
    }
  }
  return false;
}

// Count user-authored prose units in window. Skip tool_result, slash commands,
// system tags. CJK-aware: each CJK char counts as 1 unit so Chinese/Japanese/
// Korean prose isn't underestimated by whitespace-splitting.
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;
function isCjkChar(ch) { return CJK_RE.test(ch); }

function countProseUnits(text) {
  let units = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (isCjkChar(ch)) { units++; i++; continue; }
    // English word: read until whitespace or CJK
    let j = i;
    while (j < text.length && !/\s/.test(text[j]) && !isCjkChar(text[j])) j++;
    if (j > i) units++;
    i = j;
  }
  return units;
}

function userProseWordCount(messages) {
  let count = 0;
  for (const m of messages) {
    if (m.type !== 'user') continue;
    const msg = m.message;
    if (!msg) continue;
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c && c.type === 'text') text += '\n' + (c.text || '');
        else if (typeof c === 'string') text += '\n' + c;
      }
    }
    text = text.trim();
    if (!text) continue;
    if (text.startsWith('<')) continue;          // <command-name>, <system_reminder>, ...
    if (/^\/[a-zA-Z]/.test(text)) continue;       // slash command
    count += countProseUnits(text);
  }
  return count;
}

// ── Throttle counter (B3) ──────────────────────────────────────────────
// Returns true if this turn should run, advancing the counter either way.
function shouldRunThisTurn() {
  const everyTurns = extractCfg.everyTurns != null ? extractCfg.everyTurns : 1;
  if (everyTurns <= 1) return true;
  let n = 0;
  try { n = parseInt(fs.readFileSync(COUNTER_FILE, 'utf-8').trim()) || 0; } catch (e) {}
  n += 1;
  try { fs.writeFileSync(COUNTER_FILE, String(n)); } catch (e) {}
  return (n % everyTurns) === 0;
}

// ── Prompt building ────────────────────────────────────────────────────
function listTopicFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isFile() && d.name.endsWith('.md'))
      .map(d => d.name)
      .join('\n');
  } catch (e) { return ''; }
}

function formatMessagesForPrompt(messages, maxBytes) {
  const lines = [];
  let bytes = 0;
  for (const m of messages) {
    let prefix, text;
    if (m.type === 'user') {
      prefix = 'USER';
      const c = m.message && m.message.content;
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) text = c.filter(x => x.type === 'text').map(x => x.text).join(' ');
      else text = '';
    } else if (m.type === 'assistant') {
      prefix = 'ASSISTANT';
      const c = m.message && m.message.content;
      text = Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join(' ') : (typeof c === 'string' ? c : '');
    } else continue;
    text = (text || '').trim();
    if (!text) continue;
    const line = `${prefix}: ${text.slice(0, 2000)}`;
    if (bytes + line.length > maxBytes) break;
    lines.push(line);
    bytes += line.length;
  }
  return lines.join('\n\n');
}

function buildExtractPrompt(messages) {
  const maxTurns = extractCfg.maxTurns != null ? extractCfg.maxTurns : 5;
  const topics = listTopicFiles(MEMORY_DIR) || '(none yet)';
  return `# Extract Memories

You are an incremental memory writer. Read the recent conversation snippet
below and write any durable facts, decisions, project conventions, or
recurring commands worth preserving into the memory directory.

Memory dir: ${MEMORY_DIR}

Existing topic files:
${topics}

Recent messages (since last extraction):
${formatMessagesForPrompt(messages, 24000)}

Rules:
- Only write information the future-self would benefit from (durable facts,
  preferences, decisions, recurring commands, project conventions).
- Append to or edit an existing topic file when one fits; create a new file
  only when no existing topic matches.
- If nothing is worth saving, do nothing and finish.
- You have at most ${maxTurns} tool turns. Be terse.
`;
}

// ── Main loop ──────────────────────────────────────────────────────────
async function runExtract(messages) {
  log(`starting extract (provider: ${config.provider}, model: ${config.model}, format: ${config.format})`);
  const tools = getToolDefs(config.format);
  const apiOpts = {
    maxTokens: extractCfg.maxTokens != null ? extractCfg.maxTokens : 8192,
    temperature: config.dream && config.dream.temperature,
  };
  const maxTurns = extractCfg.maxTurns != null ? extractCfg.maxTurns : 5;

  const prompt = buildExtractPrompt(messages);
  let convo;
  if (config.format === 'anthropic') {
    convo = [
      { role: 'system', content: 'You are an incremental memory extraction agent.' },
      { role: 'user', content: prompt },
    ];
  } else {
    convo = [
      { role: 'system', content: prompt },
      { role: 'user', content: 'Begin. Write only durable facts; otherwise finish without using any tools.' },
    ];
  }

  for (let turn = 0; turn < maxTurns; turn++) {
    log(`turn ${turn + 1}/${maxTurns}: calling API...`);
    let response;
    try { response = await callAPI(convo, tools, config, apiOpts); }
    catch (err) { throw new Error(`extract API failed: ${err.message}`); }

    const { toolUse, textContent, message } = extractToolCalls(response, config.format);
    if (toolUse.length === 0) {
      log('extract finished without writes');
      if (textContent) log(textContent.slice(0, 300));
      return;
    }
    // Push assistant turn before tool_results (Anthropic / OpenAI protocol).
    appendAssistantMessage(convo, config.format, response, message);
    log(`  ${toolUse.length} tool(s): ${toolUse.map(t => t.name).join(', ')}`);
    for (const tc of toolUse) {
      const perm = canUseTool(tc.name, tc.input, MEMORY_DIR);
      if (!perm.allowed) {
        log(`  DENIED ${tc.name}: ${perm.reason}`);
        appendToolResult(convo, config.format, tc.id, perm.reason);
        continue;
      }
      const result = executeTool(tc.name, tc.input, MEMORY_DIR);
      log(`  -> ${String(result).slice(0, 120)}`);
      appendToolResult(convo, config.format, tc.id, result);
    }
  }
  log(`reached max turns (${maxTurns})`);
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  if (!HOOK_PAYLOAD || !HOOK_PAYLOAD.transcript_path) {
    log('no transcript_path in hook payload; nothing to do');
    return;
  }
  log(`hook payload: session_id=${HOOK_PAYLOAD.session_id || 'n/a'} cwd=${HOOK_PAYLOAD.cwd || 'n/a'} transcript=${HOOK_PAYLOAD.transcript_path}`);

  // Lock check (sibling extract running)
  const lock = inspectLock(EXTRACT_LOCK, 5 * 60);
  if (lock.held) {
    log(`skipping: extract lock held by PID ${lock.pid}`);
    return;
  }
  if (lock.stale || lock.unreadable) {
    releaseLock(EXTRACT_LOCK);
  }

  // Per-turn throttle (advance counter even on skip so the counter tracks turns).
  if (!shouldRunThisTurn()) {
    log('skipping: throttle (everyTurns)');
    return;
  }

  // Load cursor
  let sinceUuid = null;
  try { sinceUuid = fs.readFileSync(CURSOR_FILE, 'utf-8').trim() || null; } catch (e) {}

  const { messages, lastUuid } = parseTranscript(HOOK_PAYLOAD.transcript_path, sinceUuid);
  if (messages.length === 0) {
    log('no new messages since last extract');
    return;
  }
  log(`window: ${messages.length} new message(s) since uuid=${sinceUuid || '(none)'}`);

  if (assistantAlreadyWroteMemory(messages, MEMORY_DIR)) {
    log('skipping: assistant already wrote to memory in window; advancing cursor');
    advanceCursor(lastUuid);
    return;
  }

  const minProse = extractCfg.minProseWords != null ? extractCfg.minProseWords : 3;
  const proseWords = userProseWordCount(messages);
  if (proseWords < minProse) {
    log(`skipping: only ${proseWords} user-prose words (min ${minProse}); advancing cursor`);
    advanceCursor(lastUuid);
    return;
  }

  if (argv.dryRun) {
    log(`[dry-run] would extract from ${messages.length} message(s) with ${proseWords} prose words`);
    log(`[dry-run] memory dir: ${MEMORY_DIR}`);
    if (lastUuid) log(`[dry-run] cursor would advance to: ${lastUuid}`);
    return;
  }

  acquireLock(EXTRACT_LOCK);
  process.on('exit', () => releaseLock(EXTRACT_LOCK));
  try {
    await runExtract(messages);
    advanceCursor(lastUuid);
    log('extract completed');
  } catch (err) {
    log('FATAL: ' + (err && err.stack ? err.stack : err));
    releaseLock(EXTRACT_LOCK);
    process.exit(1);
  }
}

// Best-effort cursor write — never abort the run if the FS is wedged.
function advanceCursor(uuid) {
  if (!uuid) return;
  try { fs.writeFileSync(CURSOR_FILE, uuid); }
  catch (e) { log(`cursor write failed (non-fatal): ${e.message || e}`); }
}

main().catch(err => {
  // Last-resort guard: any uncaught error from main() lands here so we exit
  // cleanly with a logged stack instead of an unhandledRejection trace.
  try { log('FATAL (uncaught): ' + (err && err.stack ? err.stack : err)); } catch (e) {}
  process.exit(1);
});
