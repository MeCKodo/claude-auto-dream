#!/bin/bash
# Hook: Stop — fires after every assistant message.
# Triggers extract.js to incrementally write memories from the conversation
# window. Like trigger.sh, runs detached so the agent isn't held up.

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXTRACT_SRC="${PLUGIN_ROOT}/src/extract.js"
LOG_DIR="${HOME}/.claude/plugins/cache/claude-auto-dream/logs"
mkdir -p "$LOG_DIR"

# Capture stdin payload (Stop hook protocol pipes JSON: transcript_path,
# session_id, cwd, stop_hook_active, ...).
PAYLOAD_TMP=""
if [ ! -t 0 ]; then
    PAYLOAD_TMP="$(mktemp -t claude-auto-dream-extract-payload.XXXXXX 2>/dev/null || echo "")"
    if [ -n "$PAYLOAD_TMP" ]; then
        cat > "$PAYLOAD_TMP"
    else
        cat > /dev/null
    fi
fi

if command -v node &>/dev/null && [ -f "$EXTRACT_SRC" ]; then
    if [ -n "$PAYLOAD_TMP" ]; then
        CLAUDE_HOOK_PAYLOAD_FILE="$PAYLOAD_TMP" \
            nohup node "$EXTRACT_SRC" >> "$LOG_DIR/extract.log" 2>&1 &
    else
        nohup node "$EXTRACT_SRC" >> "$LOG_DIR/extract.log" 2>&1 &
    fi
    disown
fi
