# Claude Auto Dream

Automatic memory consolidation for Claude Code. Replicates Anthropic's auto-dream feature, working with any LLM API provider (Anthropic, OpenAI, DashScope, Ollama, etc.).

## What It Does

At the end of each Claude Code session, it automatically:
1. **Reads** your existing memory files and session transcripts
2. **Consolidates** new information into your memory system
3. **Updates** the MEMORY.md index
4. **Prunes** stale or contradicted memories

Inspired by Claude Code's internal auto-dream feature, this plugin works by directly calling the LLM API with tool-use support — no proxy or special setup required.

## Quick Start

### 1. Install

```bash
git clone https://github.com/YOUR_NAME/claude-auto-dream.git
cd claude-auto-dream
./install.sh
```

### 2. Configure API

Edit `~/.claude-auto-dream/config.json`:

```json
{
  "provider": "openai",
  "endpoint": "https://api.openai.com/v1/chat/completions",
  "model": "gpt-4o",
  "apiKey": "sk-...",
  "gates": {
    "minHours": 24,
    "minSessions": 5
  }
}
```

### 3. Test

```bash
node ~/.claude/plugins/cache/claude-auto-dream/src/dream.js --force
```

## Supported Providers

### OpenAI

```json
{
  "provider": "openai",
  "model": "gpt-4o",
  "apiKey": "sk-..."
}
```

### Anthropic

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "apiKey": "sk-ant-..."
}
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

All settings can also be set via environment variables:

```bash
export DREAM_PROVIDER=anthropic
export DREAM_MODEL=claude-sonnet-4-6
export DREAM_API_KEY=sk-ant-...
export DREAM_MIN_HOURS=12
export DREAM_MIN_SESSIONS=3
```

Environment variables override JSON config.

## Configuration

### JSON Config (`~/.claude-auto-dream/config.json`)

| Field | Default | Description |
|---|---|---|
| `provider` | `openai` | API provider: `anthropic`, `openai`, `openai_compat` |
| `endpoint` | (auto) | API endpoint URL (auto-set for anthropic/openai) |
| `model` | (auto) | Model name (auto-set for anthropic/openai) |
| `apiKey` | `""` | Your API key |
| `gates.minHours` | `24` | Minimum hours between dreams |
| `gates.minSessions` | `5` | Minimum sessions between dreams |
| `dream.maxTurns` | `30` | Maximum API turns per dream |
| `dream.maxTokens` | `65536` | Max output tokens |
| `dream.temperature` | `0.3` | Model temperature |

### Throttle Gates

The dream only runs when ALL gates pass:

1. **Time gate**: At least `minHours` (default: 24h) since last dream
2. **Session gate**: At least `minSessions` (default: 5) new sessions since last dream
3. **Lock**: No other dream currently running

Use `--force` to bypass all gates:

```bash
node ~/.claude/plugins/cache/claude-auto-dream/src/dream.js --force
```

## How It Works

1. **Trigger**: PostSessionEnd hook fires when a Claude Code session ends
2. **Gates**: Checks throttle rules (time, sessions, lock)
3. **API Call**: Calls the LLM with a multi-turn tool-use loop (up to 30 turns)
4. **Tools**: The dream agent can only:
   - Read files (unrestricted)
   - Search with grep/glob (unrestricted)
   - Run read-only bash commands (ls, cat, wc, etc.)
   - Write/Edit files (only within the memory directory)
5. **Result**: Memory files and MEMORY.md are updated

## Uninstall

```bash
# Remove hook from settings.json (edit manually)
# Remove plugin files
rm -rf ~/.claude/plugins/cache/claude-auto-dream
# Remove config
rm -rf ~/.claude-auto-dream
```

## License

MIT
