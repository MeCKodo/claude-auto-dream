#!/bin/bash
# claude-auto-dream — first-run setup
#
# This plugin is distributed through the Claude Code plugin marketplace.
# To install / upgrade, run inside Claude Code:
#
#     /plugin install claude-auto-dream@claude-auto-dream
#
# Claude Code copies the source into
#   ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
# and auto-registers `hooks/hooks.json` — no manual settings.json edits needed.
#
# This script ONLY seeds the default config at ~/.claude-auto-dream/config.json
# the first time around. It is safe to re-run.

set -euo pipefail

echo "=== claude-auto-dream setup ==="

command -v node &>/dev/null || { echo "ERROR: Node.js >= 14 is required"; exit 1; }
echo "✓ Node.js $(node --version)"

CONFIG_DIR="$HOME/.claude-auto-dream"
CONFIG_FILE="$CONFIG_DIR/config.json"
mkdir -p "$CONFIG_DIR"

if [ ! -f "$CONFIG_FILE" ]; then
    cat > "$CONFIG_FILE" << 'EOF'
{
  "provider": "openai",
  "endpoint": "https://api.openai.com/v1/chat/completions",
  "model": "gpt-4o",
  "apiKey": "YOUR_API_KEY_HERE",
  "gates": {
    "minHours": 24,
    "minSessions": 5
  }
}
EOF
    echo "⚠️  Created default config at $CONFIG_FILE"
    echo "   EDIT IT to set your API key and provider before the next session ends."
else
    echo "✓ Existing config: $CONFIG_FILE"
fi

cat <<EOM

=== Setup done ===

Provider examples:
  Anthropic:  provider=anthropic, apiKey=sk-ant-..., model=claude-sonnet-4-6
  OpenAI:     provider=openai,    apiKey=sk-...,     model=gpt-4o
  OpenAI cmp: provider=openai_compat, endpoint=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions, model=qwen3.6-plus

Plugin install / upgrade (run inside Claude Code):
    /plugin install claude-auto-dream@claude-auto-dream

EOM
