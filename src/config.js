/**
 * Config loader for claude-auto-dream
 * Priority: CLI args > env vars > JSON config > defaults
 */

const fs = require('fs');
const path = require('path');

// Provider presets
const PROVIDERS = {
  anthropic: {
    endpoint: 'https://api.anthropic.com/v1/messages',
    model: 'claude-sonnet-4-6',
    format: 'anthropic',
    authHeader: 'x-api-key',
    authPrefix: '',
  },
  openai: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o',
    format: 'openai',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
  },
  openai_compat: {
    endpoint: null,       // must be provided via config or env
    model: null,
    format: 'openai',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
  },
};

function loadConfig(argv) {
  const config = { ...DEFAULTS };

  // 1. Load JSON config
  const configPaths = [
    path.join(process.env.HOME, '.claude-auto-dream', 'config.json'),     // install.sh default
    path.join(process.env.HOME, '.claude', 'plugins', 'cache', 'claude-auto-dream', 'config.json'), // plugin dir
    path.join(process.env.HOME, '.claude-auto-dream.json'),               // flat file fallback
  ];
  for (const p of configPaths) {
    if (fs.existsSync(p)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(p, 'utf-8'));
        Object.assign(config, loaded);
        break;
      } catch (e) { /* ignore parse errors */ }
    }
  }

  // 2. Override with env vars
  if (process.env.DREAM_PROVIDER) config.provider = process.env.DREAM_PROVIDER;
  if (process.env.DREAM_ENDPOINT) config.endpoint = process.env.DREAM_ENDPOINT;
  if (process.env.DREAM_MODEL) config.model = process.env.DREAM_MODEL;
  if (process.env.DREAM_API_KEY) config.apiKey = process.env.DREAM_API_KEY;
  if (process.env.DREAM_MIN_HOURS) config.gates.minHours = parseInt(process.env.DREAM_MIN_HOURS);
  if (process.env.DREAM_MIN_SESSIONS) config.gates.minSessions = parseInt(process.env.DREAM_MIN_SESSIONS);

  // 3. Override with CLI args
  if (argv.endpoint) config.endpoint = argv.endpoint;
  if (argv.model) config.model = argv.model;
  if (argv.apiKey) config.apiKey = argv.apiKey;
  if (argv.provider) config.provider = argv.provider;

  // 4. Apply provider preset
  const preset = PROVIDERS[config.provider] || PROVIDERS.openai;
  if (!config.endpoint) config.endpoint = preset.endpoint;
  if (!config.model) config.model = preset.model;
  if (!config.authHeader) config.authHeader = preset.authHeader;
  if (!config.authPrefix) config.authPrefix = preset.authPrefix;
  if (config.format === 'auto') config.format = preset.format;

  return config;
}

const DEFAULTS = {
  provider: 'openai',
  endpoint: null,
  model: null,
  apiKey: '',
  format: 'auto',    // 'anthropic' | 'openai' | 'auto'
  authHeader: 'Authorization',
  authPrefix: 'Bearer ',
  gates: {
    minHours: 24,
    minSessions: 5,
  },
  dream: {
    maxTurns: 30,
    maxTokens: 65536,
    temperature: 0.3,
  },
};

module.exports = { loadConfig, PROVIDERS, DEFAULTS };
