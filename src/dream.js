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

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const url = require('url');
const { loadConfig } = require('./config');

// ── Parse CLI args ──────────────────────────────────────────────────────
const argv = {
  force: process.argv.includes('--force'),
  daemon: process.argv.includes('--daemon'),
  endpoint: cliArg('--endpoint'),
  model: cliArg('--model'),
  apiKey: cliArg('--apiKey'),
  provider: cliArg('--provider'),
};

function cliArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx < process.argv.length - 1 ? process.argv[idx + 1] : null;
}

// ── Load config ─────────────────────────────────────────────────────────
const config = loadConfig(argv);

// ── Auto-detect paths ──────────────────────────────────────────────────
const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(process.env.HOME, '.claude');
const MEMORY_DIR = detectMemoryDir();
const PROJECT_DIR = path.dirname(MEMORY_DIR);
const LOG_DIR = process.argv.includes('--daemon')
  ? path.join(process.env.HOME, '.claude', 'plugins', 'cache', 'claude-auto-dream', 'logs')
  : path.join(MEMORY_DIR, 'logs');
const LOCK_FILE = path.join(MEMORY_DIR, '.consolidate-lock');
const LAST_CONSOLIDATED = path.join(MEMORY_DIR, '.last-consolidated');

fs.mkdirSync(LOG_DIR, { recursive: true });

function detectMemoryDir() {
  // Try: process.cwd() memory dir, then scan .claude/projects for projects with memory/
  const cwd = process.cwd();
  const cwdMemory = path.join(cwd, '.claude', 'projects', '*', 'memory');

  // Check env override
  if (process.env.CLAUDE_AUTO_DREAM_MEMORY_DIR) {
    return process.env.CLAUDE_AUTO_DREAM_MEMORY_DIR;
  }

  // Scan .claude/projects for directories containing memory/
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

  // Fallback
  const fallback = path.join(CLAUDE_DIR, 'projects', '-Users-' + process.env.USER + '-workspaces', 'memory');
  if (fs.existsSync(fallback)) return fallback;

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
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const content = fs.readFileSync(LOCK_FILE, 'utf-8').trim().split(/\s+/);
      const pid = content[0];
      const lockTime = parseInt(content[1]) || 0;
      const lockAge = Math.floor((Date.now() - lockTime) / 1000);
      if (lockAge < 3600 && pid && killSilent(pid)) {
        log(`gate: lock held by PID ${pid}, skipping`);
        return false;
      }
    } catch (e) {}
    fs.unlinkSync(LOCK_FILE);
  }

  // Time gate
  if (fs.existsSync(LAST_CONSOLIDATED)) {
    try {
      const raw = fs.readFileSync(LAST_CONSOLIDATED, 'utf-8').trim();
      const lastTs = raw.length > 12 ? Math.floor(parseInt(raw) / 1000) : parseInt(raw);
      const hoursSince = Math.floor((Date.now() - lastTs * 1000) / 3600000);
      if (hoursSince < config.gates.minHours) {
        log(`gate: time gate — only ${hoursSince}h since last (min: ${config.gates.minHours}), skipping`);
        return false;
      }
    } catch (e) {}
  }

  // Session gate
  if (fs.existsSync(LAST_CONSOLIDATED)) {
    try {
      const raw = fs.readFileSync(LAST_CONSOLIDATED, 'utf-8').trim();
      const lastTs = raw.length > 12 ? Math.floor(parseInt(raw) / 1000) : parseInt(raw);
      const refFile = path.join(LOG_DIR, '.session-ref-' + Date.now());
      execSync(`touch -t $(date -r ${lastTs} +%Y%m%d%H%M.%S 2>/dev/null || date +%Y%m%d%H%M.%S) "${refFile}" 2>/dev/null`, { encoding: 'utf-8' });
      const count = execSync(`find "${PROJECT_DIR}" -maxdepth 1 -name "*.jsonl" -type f -newer "${refFile}" 2>/dev/null | wc -l`, { encoding: 'utf-8' }).trim();
      fs.unlinkSync(refFile);
      if (parseInt(count) < config.gates.minSessions) {
        log(`gate: session gate — only ${count} sessions (min: ${config.gates.minSessions}), skipping`);
        return false;
      }
    } catch (e) {}
  }

  log('gate: all gates passed');
  return true;
}

function killSilent(pid) {
  try { process.kill(parseInt(pid), 0); return true; } catch (e) { return false; }
}

// ── Acquire lock ────────────────────────────────────────────────────────
function acquireLock() {
  fs.writeFileSync(LOCK_FILE, `${process.pid} ${Date.now()}`);
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
}

// ── Context Gathering ──────────────────────────────────────────────────
function gatherContext() {
  let sessionCount = 0;
  let sessionList = [];

  try {
    if (fs.existsSync(LAST_CONSOLIDATED)) {
      const raw = fs.readFileSync(LAST_CONSOLIDATED, 'utf-8').trim();
      const lastTs = raw.length > 12 ? Math.floor(parseInt(raw) / 1000) : parseInt(raw);
      const refFile = path.join(LOG_DIR, '.session-ref-' + Date.now());
      execSync(`touch -t $(date -r ${lastTs} +%Y%m%d%H%M.%S 2>/dev/null || date +%Y%m%d%H%M.%S) "${refFile}" 2>/dev/null`, { encoding: 'utf-8' });
      const files = execSync(`find "${PROJECT_DIR}" -maxdepth 1 -name "*.jsonl" -type f -newer "${refFile}" 2>/dev/null`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
      sessionCount = files.length;
      sessionList = files.slice(0, 20).map(f => path.basename(f, '.jsonl'));
      fs.unlinkSync(refFile);
    } else {
      const files = execSync(`find "${PROJECT_DIR}" -maxdepth 1 -name "*.jsonl" -type f 2>/dev/null`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
      sessionCount = files.length;
      sessionList = files.slice(0, 20).map(f => path.basename(f, '.jsonl'));
    }
  } catch (e) {}

  let memoryIndex = '';
  try { memoryIndex = fs.readFileSync(path.join(MEMORY_DIR, 'MEMORY.md'), 'utf-8'); } catch (e) {}

  return { sessionCount, sessionList, memoryIndex };
}

// ── Build Dream Prompt ─────────────────────────────────────────────────
function buildPrompt(ctx) {
  const { sessionCount, sessionList, memoryIndex } = ctx;
  const maxLines = 200;

  return `# Dream: Memory Consolidation

You are performing a dream -- a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.

Memory directory: ${MEMORY_DIR}
Session transcripts: ${PROJECT_DIR} (large JSONL files -- grep narrowly, don't read whole files)

---

## Phase 1 -- Orient

- List files in the memory directory to see what already exists
- Read MEMORY.md to understand the current index
- Skim existing topic files so you improve them rather than creating duplicates

## Phase 2 -- Gather recent signal

Look for new information worth persisting. Sources in rough priority order:

1. Daily logs if present
2. Existing memories that drifted
3. Transcript search -- grep the JSONL transcripts for narrow terms

Don't exhaustively read transcripts. Look only for things you already suspect matter.

## Phase 3 -- Consolidate

For each thing worth remembering, write or update a memory file at the top level of the memory directory.

Memory file format:
\`\`\`markdown
---
name: {{memory name}}
description: {{one-line description}}
type: {{user, feedback, project, reference}}
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

---

Return a brief summary of what you consolidated, updated, or pruned.

## Additional context

Sessions since last consolidation (${sessionCount}):
${sessionList.map(s => '- ' + s).join('\n')}

Current MEMORY.md:
${memoryIndex}`;
}

// ── Tool Definitions (dual format) ──────────────────────────────────────
function getToolDefs(format) {
  const base = [
    {
      name: 'read_file',
      description: 'Read the contents of a file',
      params: {
        type: 'object',
        properties: { file_path: { type: 'string', description: 'Absolute path to the file' } },
        required: ['file_path'],
      },
    },
    {
      name: 'write_file',
      description: 'Write content to a file (creates if not exists)',
      params: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['file_path', 'content'],
      },
    },
    {
      name: 'edit_file',
      description: 'Edit a file by replacing old_string with new_string',
      params: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          old_string: { type: 'string', description: 'Text to replace' },
          new_string: { type: 'string', description: 'Replacement text' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
    {
      name: 'bash',
      description: 'Execute a read-only shell command',
      params: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Shell command to execute' } },
        required: ['command'],
      },
    },
    {
      name: 'grep',
      description: 'Search for a pattern in files',
      params: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['pattern', 'path'],
      },
    },
    {
      name: 'glob',
      description: 'Find files matching a glob pattern',
      params: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['pattern'],
      },
    },
  ];

  if (format === 'anthropic') {
    return base.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.params,
    }));
  }

  // OpenAI format
  return base.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.params,
    },
  }));
}

// ── Permission Check ────────────────────────────────────────────────────
function canUseTool(toolName, input) {
  // Allowed read-only commands (whitelist approach)
  const allowedCommands = /^(ls|find|grep|cat|stat|wc|head|tail|echo|date|whoami|pwd|file|basename|dirname|diff|sort|uniq|md5sum|sha1sum|sha256sum|tree|du|xargs|true|false|test)\b/;
  // Dangerous patterns
  const dangerousOps = />>|sudo\s|rm\s[^.]|mkfs|dd\s[^i]|chmod\s[^0]|chown\s|kill\s/;

  if (['read_file', 'grep', 'glob'].includes(toolName)) return { allowed: true };
  if (toolName === 'bash') {
    const cmd = (input.command || '').trim();
    if (allowedCommands.test(cmd) && !dangerousOps.test(cmd)) return { allowed: true };
    return { allowed: false, reason: `Bash blocked: only read-only commands allowed. "${cmd.slice(0, 80)}"` };
  }
  if (['write_file', 'edit_file'].includes(toolName)) {
    if ((input.file_path || '').startsWith(MEMORY_DIR)) return { allowed: true };
    return { allowed: false, reason: `Path must be within ${MEMORY_DIR}` };
  }
  return { allowed: false, reason: `Tool "${toolName}" not allowed` };
}

// ── Tool Execution ──────────────────────────────────────────────────────
function executeTool(toolName, input) {
  try {
    switch (toolName) {
      case 'read_file':
        return fs.readFileSync(input.file_path, 'utf-8').slice(0, 50000);

      case 'write_file': {
        fs.mkdirSync(path.dirname(input.file_path), { recursive: true });
        fs.writeFileSync(input.file_path, input.content, 'utf-8');
        return `Written ${input.file_path} (${input.content.length} bytes)`;
      }

      case 'edit_file': {
        const content = fs.readFileSync(input.file_path, 'utf-8');
        if (!content.includes(input.old_string)) return `Error: old_string not found in ${input.file_path}`;
        const newContent = content.replaceAll(input.old_string, input.new_string);
        fs.writeFileSync(input.file_path, newContent, 'utf-8');
        return `Edited ${input.file_path} (${content.length} -> ${newContent.length} bytes)`;
      }

      case 'bash':
        return execSync(input.command, { timeout: 30000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' }).slice(0, 50000);

      case 'grep': {
        const cmd = `grep -rn "${(input.pattern || '').replace(/"/g, '\\"')}" "${input.path || '.'}" 2>&1 | head -100`;
        return (execSync(cmd, { timeout: 30000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' }) || 'No matches').slice(0, 50000);
      }

      case 'glob': {
        const p = input.pattern || '*';
        const sp = input.path || MEMORY_DIR;
        if (p.includes('**')) {
          const ext = p.replace('**/', '').replace('*', '');
          const cmd = ext ? `find "${sp}" -name "${ext}" -type f 2>/dev/null` : `find "${sp}" -type f 2>/dev/null`;
          return (execSync(cmd, { timeout: 15000, encoding: 'utf-8' }) || '').slice(0, 50000);
        }
        const re = new RegExp('^' + p.replace(/\*/g, '.*') + '$');
        return fs.readdirSync(sp, { withFileTypes: true })
          .filter(e => re.test(e.name)).map(e => path.join(sp, e.name)).join('\n') || 'No matches';
      }

      default:
        return `Error: Unknown tool "${toolName}"`;
    }
  } catch (err) {
    return `Error: ${err.message || err}`.slice(0, 5000);
  }
}

// ── API Calls ───────────────────────────────────────────────────────────
function callAPI(messages) {
  const { endpoint, apiKey, authHeader, authPrefix, model, format } = config;
  const parsedUrl = new url.URL(endpoint);
  const transport = parsedUrl.protocol === 'https:' ? https : http;

  let body;
  if (format === 'anthropic') {
    body = JSON.stringify({
      model,
      max_tokens: config.dream.maxTokens,
      system: messages.filter(m => m.role === 'system').map(m => m.content).join('\n'),
      messages: messages.filter(m => m.role !== 'system'),
      tools: getToolDefs('anthropic'),
    });
  } else {
    body = JSON.stringify({
      model,
      messages,
      tools: getToolDefs('openai'),
      max_tokens: config.dream.maxTokens,
      temperature: config.dream.temperature,
    });
  }

  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [authHeader]: authPrefix + apiKey,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 120000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error: ${data.slice(0, 500)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Extract tool calls from response ────────────────────────────────────
function extractToolCalls(response) {
  const { format } = config;

  if (format === 'anthropic') {
    // Anthropic: message.content = [{ type: 'tool_use', id, name, input }, ...]
    const content = response.content || [];
    const toolUse = content.filter(c => c.type === 'tool_use');
    const textContent = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    return { toolUse, textContent, message: { content: textContent, tool_calls: null, raw: response } };
  }

  // OpenAI: choices[0].message
  const choice = response.choices && response.choices[0];
  const msg = choice && choice.message;
  if (!msg) return { toolUse: [], textContent: '', message: null };

  const toolCalls = msg.tool_calls || [];
  const textContent = msg.content || '';

  // Normalize tool_calls format
  const normalizedToolUse = toolCalls.map(tc => ({
    id: tc.id,
    name: tc.function && tc.function.name,
    input: tc.function && JSON.parse(tc.function.arguments || '{}'),
  }));

  return { toolUse: normalizedToolUse, textContent, message: msg };
}

// ── Main Loop ───────────────────────────────────────────────────────────
async function runDream(prompt) {
  log(`starting dream (provider: ${config.provider}, model: ${config.model}, format: ${config.format})`);

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

  let turn = 0;
  let totalTokens = 0;

  for (turn = 0; turn < config.dream.maxTurns; turn++) {
    log(`turn ${turn + 1}/${config.dream.maxTurns}: calling API...`);

    let response;
    for (let retry = 0; retry <= 2; retry++) {
      try {
        response = await callAPI(messages);
        break;
      } catch (err) {
        if (retry >= 2) { log(`API failed after 3 retries: ${err.message}`); process.exit(1); }
        log(`API failed (retry ${retry + 1}/2), retrying: ${err.message}`);
        await new Promise(r => setTimeout(r, 2000 * (retry + 1)));
      }
    }

    if (!response) { log('No response'); process.exit(1); }

    // Track usage
    if (response.usage) totalTokens += (response.usage.total_tokens || 0);
    if (response.usage && response.usage.output_tokens) totalTokens += response.usage.output_tokens;

    const { toolUse, textContent } = extractToolCalls(response);

    if (toolUse.length === 0) {
      log('model completed');
      log(textContent.slice(0, 500));
      log(`total tokens: ~${totalTokens}`);
      return true;
    }

    log(`  ${toolUse.length} tool(s): ${toolUse.map(t => t.name).join(', ')}`);

    for (const tc of toolUse) {
      const perm = canUseTool(tc.name, tc.input);
      if (!perm.allowed) {
        log(`  DENIED ${tc.name}: ${perm.reason}`);
        if (config.format === 'anthropic') {
          messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: tc.id, content: perm.reason }] });
        } else {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: perm.reason });
        }
        continue;
      }

      const result = executeTool(tc.name, tc.input);
      log(`  -> ${result.slice(0, 120)}`);
      if (config.format === 'anthropic') {
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: tc.id, content: result }] });
      } else {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }
  }

  log(`reached max turns (${config.dream.maxTurns})`);
  return true;
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  // In daemon mode, just run; otherwise check gates
  if (!argv.daemon && !checkGates()) return;

  acquireLock();
  process.on('exit', releaseLock);

  const ctx = gatherContext();
  const prompt = buildPrompt(ctx);

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

main();
