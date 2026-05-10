#!/usr/bin/env node
/**
 * claude-auto-dream: Auto Memory Consolidation Agent
 *
 * Replicates Claude Code's auto-dream by calling the LLM API directly
 * with tool_use support. Works with Anthropic, OpenAI, and any
 * OpenAI-compatible provider (DashScope, OpenRouter, Ollama, etc.).
 *
 * Usage:
 *   node dream.js                      # Normal mode (respects throttle)
 *   node dream.js --force              # Bypass throttle
 *   node dream.js --daemon             # Run as daemon (called by hook)
 *   node dream.js --endpoint URL --apiKey KEY --model NAME  # Inline config
 */

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const {
  readHookPayload,
  listSessionsSince,
  acquireLock,
  releaseLock,
  inspectLock,
  readTimestampFile,
} = require('./lib/fs-helpers');
const { getToolDefs, canUseTool, executeTool } = require('./lib/tools');
const { callAPI, extractToolCalls, appendToolResult, appendAssistantMessage } = require('./lib/api');

// ── Parse CLI args ──────────────────────────────────────────────────────
const argv = {
  force: process.argv.includes('--force'),
  daemon: process.argv.includes('--daemon'),
  prune: process.argv.includes('--prune'),
  endpoint: cliArg('--endpoint'),
  model: cliArg('--model'),
  apiKey: cliArg('--apiKey'),
  provider: cliArg('--provider'),
};

function cliArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx < process.argv.length - 1 ? process.argv[idx + 1] : null;
}

// ── Load hook payload (set by trigger.sh) ──────────────────────────────
// Claude Code SessionEnd payload: { cwd, session_id, reason, ... }
// reason ∈ {"clear", "logout", "prompt_input_exit", "other"}.
// "clear" and "prompt_input_exit" are noise (user cleared the screen / hit
// the input cancel) — skip dream entirely on those.
const HOOK_PAYLOAD = readHookPayload();
if (HOOK_PAYLOAD && (HOOK_PAYLOAD.reason === 'clear' || HOOK_PAYLOAD.reason === 'prompt_input_exit')) {
  process.stderr.write(`[claude-auto-dream] skipping: hook reason=${HOOK_PAYLOAD.reason}\n`);
  process.exit(0);
}

// ── Load config ─────────────────────────────────────────────────────────
const config = loadConfig(argv);

// ── Auto-detect paths ──────────────────────────────────────────────────
const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(process.env.HOME, '.claude');
const MEMORY_DIR = detectMemoryDir(HOOK_PAYLOAD && HOOK_PAYLOAD.cwd);
const PROJECT_DIR = path.dirname(MEMORY_DIR);
const LOG_DIR = process.argv.includes('--daemon')
  ? path.join(process.env.HOME, '.claude', 'plugins', 'cache', 'claude-auto-dream', 'logs')
  : path.join(MEMORY_DIR, 'logs');
const LOCK_FILE = path.join(MEMORY_DIR, '.consolidate-lock');
const LAST_CONSOLIDATED = path.join(MEMORY_DIR, '.last-consolidated');

fs.mkdirSync(LOG_DIR, { recursive: true });

function detectMemoryDir(cwdOverride) {
  // Check env override first
  if (process.env.CLAUDE_AUTO_DREAM_MEMORY_DIR) {
    return process.env.CLAUDE_AUTO_DREAM_MEMORY_DIR;
  }

  // Prefer cwd from hook payload (authoritative — process.cwd() may be stale
  // when the hook was launched detached via nohup).
  const cwd = cwdOverride || process.cwd();
  const sanitizedCwd = cwd.replace(/[/\\]/g, '-');
  const projectMemDir = path.join(CLAUDE_DIR, 'projects', sanitizedCwd, 'memory');
  if (fs.existsSync(path.join(projectMemDir, 'MEMORY.md'))) {
    return projectMemDir;
  }

  // Fallback: scan .claude/projects for any directory with memory/
  const projectsRoot = path.join(CLAUDE_DIR, 'projects');
  if (fs.existsSync(projectsRoot)) {
    try {
      const entries = fs.readdirSync(projectsRoot);
      for (const e of entries) {
        const memDir = path.join(projectsRoot, e, 'memory');
        if (fs.existsSync(path.join(memDir, 'MEMORY.md'))) {
          return memDir;
        }
      }
    } catch (e) { /* ignore */ }
  }

  return path.join(CLAUDE_DIR, 'memory');
}

// ── Logging ─────────────────────────────────────────────────────────────
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LOG_FILE = path.join(LOG_DIR, `dream-${TIMESTAMP}.log`);

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  process.stderr.write(line + '\n');  // stderr so it doesn't mix with stdout
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

// ── Throttle / Gating ──────────────────────────────────────────────────
function checkGates() {
  if (argv.force) {
    log('gate: --force mode, bypassing all gates');
    return true;
  }

  // Lock file check
  const lock = inspectLock(LOCK_FILE, 3600);
  if (lock.held) {
    log(`gate: lock held by PID ${lock.pid}, skipping`);
    return false;
  }
  if (lock.stale) {
    log(`gate: stale lock (age ${lock.ageSec}s, pid ${lock.pid}), removing`);
    releaseLock(LOCK_FILE);
  } else if (lock.unreadable) {
    log('gate: lock file unreadable, removing');
    releaseLock(LOCK_FILE);
  }

  // Resolve lastTs (epoch seconds). Missing/unparseable file → 0, which makes
  // both gates evaluate as if dream has never run (correct first-run behavior).
  const lastTs = readTimestampFile(LAST_CONSOLIDATED);

  // Time gate
  const hoursSince = Math.floor((Date.now() - lastTs * 1000) / 3600000);
  if (hoursSince < config.gates.minHours) {
    log(`gate: time gate — only ${hoursSince}h since last (min: ${config.gates.minHours}), skipping`);
    return false;
  }

  // Session gate
  const sessions = listSessionsSince(PROJECT_DIR, lastTs * 1000);
  if (sessions.length < config.gates.minSessions) {
    log(`gate: session gate — only ${sessions.length} sessions (min: ${config.gates.minSessions}), skipping`);
    return false;
  }

  log('gate: all gates passed');
  return true;
}

// ── Context Gathering ──────────────────────────────────────────────────
function gatherContext() {
  const lastTs = readTimestampFile(LAST_CONSOLIDATED);
  const sessions = listSessionsSince(PROJECT_DIR, lastTs * 1000);
  const sessionCount = sessions.length;
  const sessionList = sessions.slice(0, 20).map(s => s.basename);

  let memoryIndex = '';
  try { memoryIndex = fs.readFileSync(path.join(MEMORY_DIR, 'MEMORY.md'), 'utf-8'); } catch (e) {}

  return { sessionCount, sessionList, memoryIndex };
}

// ── Build Dream Prompt ─────────────────────────────────────────────────
function buildPrompt(ctx) {
  const { sessionCount, sessionList, memoryIndex } = ctx;
  const maxLines = 200;
  const claudeMdPath = path.join(process.cwd(), 'CLAUDE.md');
  const hasClaudeMd = fs.existsSync(claudeMdPath);

  return `# Dream: Memory Consolidation

You are performing a dream -- a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.

Memory directory: ${MEMORY_DIR}
Session transcripts: ${PROJECT_DIR} (large JSONL files -- grep narrowly, don't read whole files)

---

## Phase 1 -- Orient

- List files in the memory directory to see what already exists
- Read MEMORY.md to understand the current index
- Skim existing topic files so you improve them rather than creating duplicates
- \`ls -R logs/\` -- recent activity logs (one file per session under \`YYYY/MM/DD/\`).
  If a \`sessions/\` subdirectory also exists, review recent entries there too

## Phase 2 -- Gather recent signal

Look for new information worth persisting. Sources in rough priority order:

1. **Session logs** (\`logs/YYYY/MM/DD/<id>-<title>.md\`) -- the append-only activity
   stream, one file per session. Read the most recent 1-3 days of sessions (the
   filename title tells you what each was about); each line is prefix-coded
   (\`>\` user, \`<\` assistant, \`.\` tool call)
2. **Existing memories that drifted** -- facts that contradict something you see
   in the codebase now
3. **Transcript search** -- if you need specific context, grep the JSONL transcripts
   for narrow terms:
   \`grep -rn "<narrow term>" \${PROJECT_DIR}/ --include="*.jsonl" | tail -50\`

Don't exhaustively read transcripts. Look only for things you already suspect matter.

## Phase 3 -- Consolidate

For each thing worth remembering, write or update a memory file at the top level of the memory directory.

Memory file format:
\`\`\`markdown
---
name: {{memory name}}
description: {{one-line description}}
type: {{user, feedback, project, reference}}
created: {{YYYY-MM-DD}}
---

{{memory content}}
\`\`\`

Types:
- **user**: User's role, preferences, responsibilities, knowledge
- **feedback**: Guidance about how to approach work
- **project**: Ongoing work, goals, bugs, or decisions
- **reference**: Pointers to external systems and resources

Focus on:
- Merging new signal into existing topic files rather than creating near-duplicates
- Converting relative dates to absolute dates
- Deleting contradicted facts

**What NOT to save**: Code patterns, git history, debugging solutions, CLAUDE.md content, ephemeral task details.

## Phase 4 -- Prune and index

Update MEMORY.md so it stays under ${maxLines} lines AND under ~25KB.
Each entry: \`- [Title](file.md) -- one-line hook\`
${hasClaudeMd ? `
### Reconcile memories against CLAUDE.md

For each \`feedback\` or \`project\` memory, check whether it contradicts a CLAUDE.md
instruction on the same topic:

- **Memory is stale** -- CLAUDE.md and the memory describe different procedures for
  the same task: CLAUDE.md is the maintained, checked-in source. Delete the memory,
  or rewrite it to agree if it carries context worth keeping.
- **CLAUDE.md may be stale** -- the memory is clearly dated after CLAUDE.md and
  explicitly corrects it: do NOT edit CLAUDE.md during a dream. Annotate the memory
  with "contradicts CLAUDE.md -- verify which is current" and list it in your summary.
- **Not a conflict** -- the memory adds detail CLAUDE.md doesn't cover. Leave it.

CLAUDE.md path: ${claudeMdPath}
` : ''}
---

Return a brief summary of what you consolidated, updated, or pruned.

## Additional context

Sessions since last consolidation (${sessionCount}):
${sessionList.map(s => '- ' + s).join('\n')}

Current MEMORY.md:
${memoryIndex}`;
}

function buildPruningPrompt(ctx) {
  const { memoryIndex } = ctx;

  return `# Dream: Memory Pruning

You are performing a dream -- a pruning pass over your memory files.
The job is small: delete stale or invalidated memories, and collapse duplicates.

Memory directory: ${MEMORY_DIR}

This directory already exists -- write to it directly with the Write tool (do not run mkdir or check for its existence).

Memory files are immutable: never edit them in place.
Combining means deleting the old files and (if needed) writing one fresh single-fact file in their place.

## What to do
1. \`find ${MEMORY_DIR} -name '*.md'\` to enumerate every memory file.
2. For each file, decide:
   - **Stale or invalidated** -- the fact no longer holds (contradicted by current code, the project moved on, the user's preference changed). Delete the file.
   - **Duplicate or near-duplicate** -- another memory already covers the same fact. Delete the redundant copies. If a single richer single-fact memory would replace the cluster, delete the cluster and write one fresh file. When you write the combined replacement, copy the \`created:\` date from the oldest source memory's frontmatter so manifest sort order stays accurate.
   - **Still good** -- leave it alone.

Return a brief summary of what you deleted, combined, or left alone. If nothing changed, say so.

## Current MEMORY.md
${memoryIndex}`;
}

// ── Main Loop ───────────────────────────────────────────────────────────
async function runDream(prompt) {
  log(`starting dream (provider: ${config.provider}, model: ${config.model}, format: ${config.format})`);

  const tools = getToolDefs(config.format);
  const apiOpts = {
    maxTokens: config.dream.maxTokens,
    temperature: config.dream.temperature,
  };

  // Build messages
  let messages;
  if (config.format === 'anthropic') {
    messages = [
      { role: 'system', content: 'You are a memory consolidation agent. Follow the dream prompt exactly.' },
      { role: 'user', content: prompt },
    ];
  } else {
    messages = [
      { role: 'system', content: prompt },
      { role: 'user', content: 'Begin the dream. Follow the 4 phases described above.' },
    ];
  }

  let totalTokens = 0;

  for (let turn = 0; turn < config.dream.maxTurns; turn++) {
    log(`turn ${turn + 1}/${config.dream.maxTurns}: calling API...`);

    let response;
    for (let retry = 0; retry <= 2; retry++) {
      try {
        response = await callAPI(messages, tools, config, apiOpts);
        break;
      } catch (err) {
        if (retry >= 2) {
          throw new Error(`API failed after 3 retries: ${err.message}`);
        }
        log(`API failed (retry ${retry + 1}/2), retrying: ${err.message}`);
        await new Promise(r => setTimeout(r, 2000 * (retry + 1)));
      }
    }

    if (!response) throw new Error('No response from API');

    if (response.usage) totalTokens += (response.usage.total_tokens || response.usage.output_tokens || 0);

    const { toolUse, textContent, message } = extractToolCalls(response, config.format);

    if (toolUse.length === 0) {
      log('model completed');
      log(textContent.slice(0, 500));
      log(`total tokens: ~${totalTokens}`);
      return true;
    }

    // Required by both Anthropic and OpenAI tool-use protocols: the assistant
    // turn that issued the tool_use must precede the user/tool tool_result.
    appendAssistantMessage(messages, config.format, response, message);

    log(`  ${toolUse.length} tool(s): ${toolUse.map(t => t.name).join(', ')}`);

    for (const tc of toolUse) {
      const perm = canUseTool(tc.name, tc.input, MEMORY_DIR);
      if (!perm.allowed) {
        log(`  DENIED ${tc.name}: ${perm.reason}`);
        appendToolResult(messages, config.format, tc.id, perm.reason);
        continue;
      }
      const result = executeTool(tc.name, tc.input, MEMORY_DIR);
      log(`  -> ${String(result).slice(0, 120)}`);
      appendToolResult(messages, config.format, tc.id, result);
    }
  }

  log(`reached max turns (${config.dream.maxTurns})`);
  return true;
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  if (HOOK_PAYLOAD) {
    log(`hook payload: reason=${HOOK_PAYLOAD.reason || 'n/a'} session_id=${HOOK_PAYLOAD.session_id || 'n/a'} cwd=${HOOK_PAYLOAD.cwd || 'n/a'}`);
  }

  // In daemon mode, just run; otherwise check gates first (before expensive I/O)
  if (!argv.daemon && !checkGates()) return;

  acquireLock(LOCK_FILE);
  process.on('exit', () => releaseLock(LOCK_FILE));

  log(`gathering context... (mode: ${argv.prune ? 'prune' : 'consolidate'})`);
  const ctx = gatherContext();
  const prompt = argv.prune ? buildPruningPrompt(ctx) : buildPrompt(ctx);

  try {
    const success = await runDream(prompt);
    if (success) {
      fs.writeFileSync(LAST_CONSOLIDATED, String(Date.now()));
      try { fs.appendFileSync(path.join(LOG_DIR, 'activity.log'), `${new Date().toISOString()} dream_completed\n`); } catch (e) {}
      log('completed successfully');
    }
  } catch (err) {
    log('FATAL: ' + err.stack);
    process.exit(1);
  }
}

main().catch(err => {
  try { log('FATAL (uncaught): ' + (err && err.stack ? err.stack : err)); } catch (e) {}
  process.exit(1);
});
