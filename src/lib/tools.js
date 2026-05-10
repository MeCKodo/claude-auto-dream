/**
 * Tool definitions, permission check, and execution sandbox for the
 * sub-agent that dream.js / extract.js drive via tool_use.
 *
 * `sandboxRoot` is the only directory writes (write_file/edit_file) are
 * permitted under. Reads (read_file/grep/glob) are unrestricted because the
 * dream prompt explicitly asks the agent to read session transcripts and
 * memory files outside any single sandbox.
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

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
          old_string: { type: 'string', description: 'Text to replace (must match exactly one occurrence)' },
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
  return base.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.params,
    },
  }));
}

function canUseTool(toolName, input, sandboxRoot) {
  const allowedCommands = /^(ls|find|grep|cat|stat|wc|head|tail|echo|date|whoami|pwd|file|basename|dirname|diff|sort|uniq|md5sum|sha1sum|sha256sum|tree|du|true|false|test)\b/;
  const shellMetachars = /[;&|`$()<>]/;
  const argEscapes = /(^|\s)(-exec|-execdir|xargs)(\s|$)/;
  const dangerousOps = />>|sudo\s|rm\s[^.]|mkfs|dd\s[^i]|chmod\s[^0]|chown\s|kill\s/;

  if (['read_file', 'grep', 'glob'].includes(toolName)) return { allowed: true };
  if (toolName === 'bash') {
    const cmd = (input.command || '').trim();
    if (shellMetachars.test(cmd)) {
      return { allowed: false, reason: `Bash blocked: shell metacharacters (;&|\`$()<>) are not allowed. "${cmd.slice(0, 80)}"` };
    }
    if (argEscapes.test(cmd)) {
      return { allowed: false, reason: `Bash blocked: -exec/-execdir/xargs not allowed. "${cmd.slice(0, 80)}"` };
    }
    if (allowedCommands.test(cmd) && !dangerousOps.test(cmd)) return { allowed: true };
    return { allowed: false, reason: `Bash blocked: only read-only commands allowed. "${cmd.slice(0, 80)}"` };
  }
  if (['write_file', 'edit_file'].includes(toolName)) {
    const resolved = path.resolve(input.file_path || '');
    const normalizedSandbox = path.resolve(sandboxRoot) + path.sep;
    if (resolved.startsWith(normalizedSandbox) || resolved === path.resolve(sandboxRoot)) return { allowed: true };
    return { allowed: false, reason: `Path must be within ${sandboxRoot}` };
  }
  return { allowed: false, reason: `Tool "${toolName}" not allowed` };
}

function executeTool(toolName, input, sandboxRoot) {
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
        const occurrences = input.old_string ? content.split(input.old_string).length - 1 : 0;
        if (occurrences === 0) return `Error: old_string not found in ${input.file_path}`;
        if (occurrences > 1) return `Error: old_string matches ${occurrences} occurrences in ${input.file_path}; provide more surrounding context to make it unique`;
        const idx = content.indexOf(input.old_string);
        const newContent = content.slice(0, idx) + input.new_string + content.slice(idx + input.old_string.length);
        fs.writeFileSync(input.file_path, newContent, 'utf-8');
        return `Edited ${input.file_path} (${content.length} -> ${newContent.length} bytes)`;
      }

      case 'bash':
        return execSync(input.command, { timeout: 30000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' }).slice(0, 50000);

      case 'grep': {
        const out = execFileSync('grep', ['-rn', '--', input.pattern || '', input.path || '.'], { timeout: 30000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' });
        return (out || 'No matches').split('\n').slice(0, 100).join('\n').slice(0, 50000);
      }

      case 'glob': {
        const p = input.pattern || '*';
        const sp = input.path || sandboxRoot;
        if (p.includes('**')) {
          const ext = p.replace('**/', '').replace('*', '');
          const findArgs = ext ? [sp, '-name', ext, '-type', 'f'] : [sp, '-type', 'f'];
          const out = execFileSync('find', findArgs, { timeout: 15000, encoding: 'utf-8' });
          return (out || '').slice(0, 50000);
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

module.exports = { getToolDefs, canUseTool, executeTool };
