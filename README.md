# Claude Auto Dream

Automatic memory consolidation for Claude Code. Replicates Claude Code 2.1.x's
built-in `dream` + `extractMemories` features and works with any LLM provider
(Anthropic, OpenAI, DashScope, Ollama, ...). Designed primarily for users who
drive Claude Code with third-party model APIs and don't get the official
features for free.

## What It Does

This plugin installs **two hooks** that work together:

| Hook         | Script                  | Runs                    | Purpose                                                                |
| ------------ | ----------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `Stop`       | `trigger-extract.sh`    | After every assistant turn | Incrementally writes durable facts from the latest conversation window into the memory dir. |
| `SessionEnd` | `trigger.sh`            | When the session ends   | Big consolidation pass: re-orders, prunes, and updates the MEMORY.md index. |

Both hooks fire detached (`nohup … & disown`) so they never block Claude Code.

## Quick Start

### 1. Install (recommended — Claude Code marketplace)

Inside Claude Code, add the marketplace once and install the plugin:

```
/plugin marketplace add MeCKodo/claude-auto-dream
/plugin install claude-auto-dream@claude-auto-dream
```

Claude Code copies the source to
`~/.claude/plugins/cache/claude-auto-dream/claude-auto-dream/<version>/` and
auto-registers `hooks/hooks.json` (no manual `settings.json` edits needed).

Future updates: `/plugin update claude-auto-dream@claude-auto-dream` — or just
restart Claude Code, since the marketplace is registered with `autoUpdate: true`.

### 1b. Seed the default config

Run once to drop a starter file at `~/.claude-auto-dream/config.json`:

```bash
git clone https://github.com/MeCKodo/claude-auto-dream.git
cd claude-auto-dream
./install.sh
```

`install.sh` no longer touches `settings.json` or the plugin cache; it only
seeds the default config.

### 2. Configure API

Edit `~/.claude-auto-dream/config.json`:

```json
{
  "provider": "openai",
  "endpoint": "https://api.openai.com/v1/chat/completions",
  "model": "gpt-4o",
  "apiKey": "sk-...",
  "gates": { "minHours": 24, "minSessions": 5 },
  "extract": { "enabled": true, "everyTurns": 1, "minProseWords": 3, "maxTurns": 5 }
}
```

### 3. Test

The plugin lives under
`~/.claude/plugins/cache/claude-auto-dream/claude-auto-dream/<version>/`.

```bash
# Pick the latest installed version
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/claude-auto-dream/claude-auto-dream/*/ | sort -V | tail -1)

# Force a dream pass right now
node "${PLUGIN_DIR}src/dream.js" --force

# Dry-run extract (parses an existing transcript, runs all skip checks, no API call)
CLAUDE_HOOK_PAYLOAD_FILE=/tmp/payload.json \
  node "${PLUGIN_DIR}src/extract.js" --dry-run
```

The payload file should look like a Claude Code Stop hook payload:

```json
{ "transcript_path": "/abs/path/to/session.jsonl",
  "cwd": "/abs/path/to/project",
  "session_id": "...", "stop_hook_active": false }
```

## Supported Providers

### OpenAI

```json
{ "provider": "openai", "model": "gpt-4o", "apiKey": "sk-..." }
```

### Anthropic

```json
{ "provider": "anthropic", "model": "claude-sonnet-4-6", "apiKey": "sk-ant-..." }
```

### DashScope / CCR / Any OpenAI-compatible API

```json
{
  "provider": "openai_compat",
  "endpoint": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  "model": "qwen3.6-plus",
  "apiKey": "sk-..."
}
```

### Environment Variables

```bash
export DREAM_PROVIDER=anthropic
export DREAM_MODEL=claude-sonnet-4-6
export DREAM_API_KEY=sk-ant-...
export DREAM_MIN_HOURS=12
export DREAM_MIN_SESSIONS=3
export DREAM_EXTRACT_ENABLED=true
export DREAM_EXTRACT_EVERY_TURNS=1
export DREAM_EXTRACT_MIN_PROSE=3
```

Env vars override JSON config. CLI flags (`--endpoint`, `--apiKey`, ...) override both.

## Configuration

| Field                       | Default | Description                                                            |
| --------------------------- | ------- | ---------------------------------------------------------------------- |
| `provider`                  | `openai` | API provider: `anthropic`, `openai`, `openai_compat`                  |
| `endpoint`                  | (auto)  | API endpoint URL                                                       |
| `model`                     | (auto)  | Model name                                                             |
| `apiKey`                    | `""`    | Your API key                                                           |
| `gates.minHours`            | `24`    | Min hours between dreams                                               |
| `gates.minSessions`         | `5`     | Min sessions between dreams                                            |
| `dream.maxTurns`            | `30`    | Max API turns per dream                                                |
| `dream.maxTokens`           | `65536` | Max output tokens per dream API call                                   |
| `dream.temperature`         | `0.3`   | Model temperature for dream                                            |
| `extract.enabled`           | `true`  | Master switch for the Stop-hook extract pipeline                       |
| `extract.everyTurns`        | `1`     | Run extract on every Nth Stop hook (`1` = every turn)                  |
| `extract.minProseWords`     | `3`     | Skip if user-prose word count in window is below this                  |
| `extract.maxTurns`          | `5`     | Sub-agent turn budget for extract                                      |
| `extract.maxTokens`         | `8192`  | Max output tokens per extract API call                                 |

### Throttle Gates (dream)

Dream runs only when **all** gates pass:

1. **Time gate**: `now - lastConsolidated >= minHours`
2. **Session gate**: at least `minSessions` `.jsonl` transcripts touched since `lastConsolidated`
3. **Lock**: no other dream currently holding `.consolidate-lock`

A missing `.last-consolidated` file is treated as `lastTs = 0` (epoch) — first
runs still pass through both gates instead of bypassing them. Use `--force` to
skip every gate.

### Skip Conditions (extract)

Extract on a Stop hook is skipped (cheaply, no API call) when any of:

1. `stop_hook_active` is `true` in the payload (recursion guard).
2. The throttle counter says it's not this turn (see `extract.everyTurns`).
3. `.extract-lock` is held by a live process (sibling extract still running).
4. The assistant in the new conversation window already used a write/edit tool
   on a path under the memory dir — the model just wrote, no need to re-extract.
5. The user-prose word count in the window is below `extract.minProseWords`
   (e.g. user only ran a slash command).

### Cursor & Lock Files

| Path                              | Owner   | Purpose                                                       |
| --------------------------------- | ------- | ------------------------------------------------------------- |
| `MEMORY_DIR/.last-consolidated`   | dream   | Epoch ms timestamp of the last successful dream               |
| `MEMORY_DIR/.consolidate-lock`    | dream   | `<pid> <ms>` lock to prevent overlapping dreams               |
| `MEMORY_DIR/.last-extracted`      | extract | UUID cursor — last transcript message processed by extract    |
| `MEMORY_DIR/.extract-lock`        | extract | `<pid> <ms>` lock to prevent overlapping extracts             |
| `MEMORY_DIR/.extract-counter`     | extract | Turn counter for `everyTurns` throttle                        |

`SessionEnd` waits up to 60 s for `.extract-lock` to release before launching
dream, so dream always sees the freshest extracted memories.

## How It Works

### Stop hook (extract)
1. Capture the JSON payload Claude Code pipes on stdin.
2. Bail on `stop_hook_active` (recursion guard) or if `extract.enabled = false`.
3. Read cursor (`.last-extracted`), parse the transcript JSONL window since.
4. Apply skip conditions; advance cursor and exit if any fire.
5. Build a tight extract prompt; run the model with `extract.maxTurns` budget.
6. Persist the new cursor.

### SessionEnd hook (dream)
1. Capture payload; short-circuit on `reason in {clear, prompt_input_exit}`.
2. Wait up to 60 s for any in-flight extract to release `.extract-lock`.
3. Run gates; skip if blocked.
4. Build the 4-phase dream prompt; run up to `dream.maxTurns` turns.
5. Update `.last-consolidated`.

### Sandbox

The sub-agent (dream + extract) can only:

- Read files (unrestricted).
- Search with grep / glob (unrestricted).
- Run a small set of read-only shell commands (ls, cat, wc, ...). Shell
  metacharacters (`; & | $ ` ` ` ( ) < >`) and `-exec / -execdir / xargs` are
  blocked at the permission layer.
- Write / edit files **only inside the memory directory**.

`edit_file` rejects `old_string` matches that aren't unique (0 or >1
occurrences) — replace must always be a single, well-anchored swap.

## Changelog

### 1.1.1

- **Fix**: add config file pre-check in trigger scripts — if
  `~/.claude-auto-dream/config.json` is missing, the hook now logs a
  detailed setup guide instead of failing silently.
- **Fix**: validate `apiKey` at load time in `src/config.js` — placeholder
  or empty keys are caught early with a clear error message and
  `process.exit(1)`.

### 1.1.0

- **New**: `extractMemories` companion that mirrors Claude Code 2.1.x. Runs on
  every `Stop` hook with a transcript-cursor + recursion guard + per-turn throttle.
- **Fix**: turn loop now appends the assistant message between API calls — the
  plugin works against real Anthropic / OpenAI / DashScope APIs, not just lenient
  proxies.
- **Fix**: `config.json` is deep-merged into defaults, so partial overrides like
  `{ gates: { minHours: 0 } }` no longer wipe the rest of `gates`.
- **Fix**: `SessionEnd` short-circuits on `reason ∈ {clear, prompt_input_exit}`
  before paying the 60 s extract-drain wait.
- **Fix**: `edit_file` rejects ambiguous matches (0 or >1 occurrences); `bash`
  blocks shell metacharacters and `-exec / -execdir / xargs`.
- **Fix**: CJK-aware prose counter; Chinese / Japanese / Korean prompts no longer
  get misclassified as "no signal".
- **Fix**: extract cursor walks back to the last uuid-bearing entry — the trailing
  `last-prompt / permission-mode / ai-title` meta rows in real transcripts no
  longer block cursor advancement.
- **Chore**: `install.sh` slimmed down to "seed default config + print install
  hint". Distribution is now exclusively through the Claude Code plugin
  marketplace; the plugin's own `hooks/hooks.json` registers `SessionEnd` and
  `Stop` automatically — no more manual `settings.json` edits.

### 1.0.0

- Initial release: SessionEnd-based dream pipeline, multi-provider config.

## Uninstall

Inside Claude Code:

```
/plugin uninstall claude-auto-dream@claude-auto-dream
```

Then optionally drop the config:

```bash
rm -rf ~/.claude-auto-dream
```

## License

MIT
