#!/bin/bash
# Hook: PostSessionEnd — triggers auto-dream when a Claude Code session ends.
# Uses nohup + disown so it survives the Claude process exiting.

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DREAM_SRC="${PLUGIN_ROOT}/src/dream.js"
LOG_DIR="${HOME}/.claude/plugins/cache/claude-auto-dream/logs"
mkdir -p "$LOG_DIR"

if command -v node &>/dev/null && [ -f "$DREAM_SRC" ]; then
    nohup node "$DREAM_SRC" --daemon >> "$LOG_DIR/trigger.log" 2>&1 &
    disown
fi
