#!/bin/bash
# Install script for claude-auto-dream
# Usage:
#   git clone https://github.com/YOUR_NAME/claude-auto-dream.git
#   cd claude-auto-dream
#   ./install.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== claude-auto-dream installer ==="

# 1. Check prerequisites
command -v node &>/dev/null || { echo "ERROR: Node.js is required (node >= 14)"; exit 1; }
echo "✓ Node.js found: $(node --version)"

# 2. Determine installation target
INSTALL_TARGET="${CLAUDE_AUTO_DREAM_INSTALL_TARGET:-$HOME/.claude/plugins/cache/claude-auto-dream}"

echo "Installing to: $INSTALL_TARGET"

# 3. Copy files
mkdir -p "$INSTALL_TARGET"
cp -r "$SCRIPT_DIR/.claude-plugin" "$INSTALL_TARGET/"
cp -r "$SCRIPT_DIR/hooks" "$INSTALL_TARGET/"
cp -r "$SCRIPT_DIR/src" "$INSTALL_TARGET/"
echo "✓ Files copied"

# 4. Create config directory and default config
CONFIG_DIR="$HOME/.claude-auto-dream"
mkdir -p "$CONFIG_DIR"

if [ ! -f "$CONFIG_DIR/config.json" ]; then
    cat > "$CONFIG_DIR/config.json" << 'EOF'
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
    echo "⚠️  Default config created at $CONFIG_DIR/config.json"
    echo "   EDIT THIS FILE to set your API key and provider."
else
    echo "✓ Existing config found at $CONFIG_DIR/config.json"
fi

# 5. Register hook in settings.json
SETTINGS="$HOME/.claude/settings.json"
TRIGGER_PATH="${INSTALL_TARGET}/hooks/trigger.sh"

if [ -f "$SETTINGS" ]; then
    node -e "
      const fs = require('fs');
      const settings = JSON.parse(fs.readFileSync('$SETTINGS', 'utf8'));
      if (!settings.hooks) settings.hooks = {};

      settings.hooks.SessionEnd = [{
        matcher: '',
        hooks: [{
          type: 'command',
          command: '$TRIGGER_PATH',
          timeout: 1,
          async: true
        }]
      }];
      fs.writeFileSync('$SETTINGS', JSON.stringify(settings, null, 2) + '\n');
      console.log('✓ Hook registered in settings.json (PostSessionEnd)');
    "
else
    echo "⚠️  No settings.json found at $SETTINGS"
    echo "   Create one or manually add the PostSessionEnd hook."
fi

# 6. Make trigger executable
chmod +x "$TRIGGER_PATH"

echo ""
echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit $CONFIG_DIR/config.json to set your API key"
echo "  2. Supported providers: anthropic, openai, openai_compat"
echo "  3. Test: cd $INSTALL_TARGET && node src/dream.js --force"
echo ""
echo "Provider examples:"
echo "  Anthropic:  provider=anthropic, apiKey=sk-ant-..., model=claude-sonnet-4-6"
echo "  OpenAI:     provider=openai, apiKey=sk-..., model=gpt-4o"
echo "  DashScope:  provider=openai_compat, endpoint=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions, model=qwen3.6-plus"
echo ""
