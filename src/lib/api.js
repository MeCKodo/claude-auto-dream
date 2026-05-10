/**
 * Provider-agnostic LLM call. Speaks Anthropic Messages API and OpenAI
 * Chat Completions API. Tool definitions are produced by lib/tools.js
 * (passed in via the `tools` argument).
 *
 * Options:
 *   - maxTokens   number, default 4096
 *   - temperature number, optional (only sent for non-anthropic for now)
 *   - timeoutMs   number, default 120000
 */

const https = require('https');
const http = require('http');
const url = require('url');

function callAPI(messages, tools, config, options) {
  const opts = options || {};
  const { endpoint, apiKey, authHeader, authPrefix, model, format } = config;
  const parsedUrl = new url.URL(endpoint);
  const transport = parsedUrl.protocol === 'https:' ? https : http;
  const maxTokens = opts.maxTokens != null ? opts.maxTokens : 4096;
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 120000;

  let body;
  if (format === 'anthropic') {
    body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: messages.filter(m => m.role === 'system').map(m => m.content).join('\n'),
      messages: messages.filter(m => m.role !== 'system'),
      tools,
    });
  } else {
    const payload = { model, messages, tools, max_tokens: maxTokens };
    if (opts.temperature !== undefined) payload.temperature = opts.temperature;
    body = JSON.stringify(payload);
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
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            const errMsg = (parsed.error && parsed.error.message) || parsed.message || data.slice(0, 300);
            reject(new Error(`API ${res.statusCode}: ${errMsg}`));
            return;
          }
          resolve(parsed);
        }
        catch (e) { reject(new Error(`Parse error (HTTP ${res.statusCode}): ${data.slice(0, 500)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// Returns { toolUse: [{id, name, input}], textContent, message }.
function extractToolCalls(response, format) {
  if (format === 'anthropic') {
    const content = response.content || [];
    const toolUse = content.filter(c => c.type === 'tool_use');
    const textContent = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    return { toolUse, textContent, message: { content: textContent, tool_calls: null, raw: response } };
  }
  const choice = response.choices && response.choices[0];
  const msg = choice && choice.message;
  if (!msg) return { toolUse: [], textContent: '', message: null };
  const toolCalls = msg.tool_calls || [];
  const textContent = msg.content || '';
  const normalizedToolUse = toolCalls.map(tc => ({
    id: tc.id,
    name: tc.function && tc.function.name,
    input: tc.function && JSON.parse(tc.function.arguments || '{}'),
  }));
  return { toolUse: normalizedToolUse, textContent, message: msg };
}

// Append a tool_result message in the format the active provider expects.
function appendToolResult(messages, format, toolCallId, content) {
  if (format === 'anthropic') {
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolCallId, content }] });
  } else {
    messages.push({ role: 'tool', tool_call_id: toolCallId, content });
  }
}

// Push the assistant turn back onto the conversation. Required between
// API calls so that the next request is well-formed:
//   - Anthropic: tool_result must directly follow the assistant.tool_use it
//     answers; without this push, the API rejects the request.
//   - OpenAI:   the next "tool" role message must reference an assistant
//     message that contained the matching tool_calls.
// Lenient gateways (some self-hosted Claude proxies) tolerate a missing
// assistant turn, but real Anthropic / OpenAI / DashScope do not.
function appendAssistantMessage(messages, format, response, message) {
  if (format === 'anthropic') {
    const content = (response && response.content) || [];
    messages.push({ role: 'assistant', content });
  } else {
    if (!message) return;
    const entry = { role: 'assistant', content: message.content || '' };
    if (message.tool_calls) entry.tool_calls = message.tool_calls;
    messages.push(entry);
  }
}

module.exports = { callAPI, extractToolCalls, appendToolResult, appendAssistantMessage };
