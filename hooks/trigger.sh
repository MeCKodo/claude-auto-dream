#!/bin/bash
# Hook: SessionEnd — triggers auto-dream when a Claude Code session ends.
# Uses nohup + disown so it survives the Claude process exiting.
#
# Claude Code pipes the hook payload (JSON: cwd, session_id, reason, ...)
# on stdin. We capture it to a temp file so dream.js can inspect it and
# short-circuit on noise events.

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DREAM_SRC="${PLUGIN_ROOT}/src/dream.js"
LOG_DIR="${HOME}/.claude/plugins/cache/claude-auto-dream/logs"
mkdir -p "$LOG_DIR"

# Capture stdin payload (if any). dream.js deletes the temp file after read.
PAYLOAD_TMP=""
if [ ! -t 0 ]; then
    PAYLOAD_TMP="$(mktemp -t claude-auto-dream-payload.XXXXXX 2>/dev/null || echo "")"
    if [ -n "$PAYLOAD_TMP" ]; then
        cat > "$PAYLOAD_TMP"
    else
        # mktemp failed; drain stdin so the parent isn't blocked
        cat > /dev/null
    fi
fi

# Inspect payload once: extract reason + cwd so we can short-circuit on noise
# events (clear / prompt_input_exit) without paying the 60s drain wait, and
# so we know which project's .extract-lock to wait on otherwise.
PAYLOAD_REASON=""
PAYLOAD_CWD=""
if [ -n "$PAYLOAD_TMP" ] && command -v node &>/dev/null; then
    PAYLOAD_INFO="$(node -e 'try{const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8"));process.stdout.write((p.reason||"")+"\n"+(p.cwd||""))}catch(e){}' "$PAYLOAD_TMP" 2>/dev/null)"
    PAYLOAD_REASON="$(printf '%s' "$PAYLOAD_INFO" | sed -n '1p')"
    PAYLOAD_CWD="$(printf '%s' "$PAYLOAD_INFO" | sed -n '2p')"
fi

# Bail early on noise events (user just cleared the screen / closed the input
# prompt). Avoids both the drain wait and a wasted dream.js fork.
if [ "$PAYLOAD_REASON" = "clear" ] || [ "$PAYLOAD_REASON" = "prompt_input_exit" ]; then
    [ -n "$PAYLOAD_TMP" ] && rm -f "$PAYLOAD_TMP"
    echo "[trigger.sh] skip: reason=$PAYLOAD_REASON" >> "$LOG_DIR/trigger.log"
    exit 0
fi

# Drain wait: if extract.js is still writing memories (Stop hook running),
# wait up to 60s for its lock to release so dream sees the freshest state.
if [ -n "$PAYLOAD_CWD" ]; then
    SANITIZED="${PAYLOAD_CWD//\//-}"
    EXTRACT_LOCK="${HOME}/.claude/projects/${SANITIZED}/memory/.extract-lock"
    WAITED=0
    while [ -f "$EXTRACT_LOCK" ] && [ $WAITED -lt 60 ]; do
        sleep 1
        WAITED=$((WAITED + 1))
    done
    if [ -f "$EXTRACT_LOCK" ]; then
        echo "[trigger.sh] extract lock still held after 60s; proceeding anyway" >> "$LOG_DIR/trigger.log"
    elif [ "$WAITED" -gt 0 ]; then
        echo "[trigger.sh] waited ${WAITED}s for extract lock" >> "$LOG_DIR/trigger.log"
    fi
fi

# ---------- Config pre-check ----------
CONFIG_FOUND=0
for cfg in "$HOME/.claude-auto-dream/config.json" \
           "$HOME/.claude/plugins/cache/claude-auto-dream/config.json" \
           "$HOME/.claude-auto-dream.json"; do
    [ -f "$cfg" ] && CONFIG_FOUND=1 && break
done

if [ "$CONFIG_FOUND" -eq 0 ]; then
    cat >> "$LOG_DIR/trigger.log" <<'MISS'

╔══════════════════════════════════════════════════════════════╗
║  claude-auto-dream: config file not found — dream skipped   ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Create ~/.claude-auto-dream/config.json with your API key:  ║
║                                                              ║
║  mkdir -p ~/.claude-auto-dream                               ║
║  cat > ~/.claude-auto-dream/config.json << 'EOF'             ║
║  {                                                           ║
║    "provider": "openai",                                     ║
║    "model": "gpt-4o",                                        ║
║    "apiKey": "sk-YOUR_KEY_HERE",                             ║
║    "gates": { "minHours": 24, "minSessions": 5 }            ║
║  }                                                           ║
║  EOF                                                         ║
║                                                              ║
║  Providers: anthropic | openai | openai_compat               ║
║  For openai_compat, also set "endpoint": "https://..."       ║
║                                                              ║
║  Or run: bash <plugin_root>/install.sh                       ║
╚══════════════════════════════════════════════════════════════╝
MISS
    [ -n "$PAYLOAD_TMP" ] && rm -f "$PAYLOAD_TMP"
    exit 0
fi

if command -v node &>/dev/null && [ -f "$DREAM_SRC" ]; then
    if [ -n "$PAYLOAD_TMP" ]; then
        CLAUDE_HOOK_PAYLOAD_FILE="$PAYLOAD_TMP" \
            nohup node "$DREAM_SRC" >> "$LOG_DIR/trigger.log" 2>&1 &
    else
        nohup node "$DREAM_SRC" >> "$LOG_DIR/trigger.log" 2>&1 &
    fi
    disown
fi
