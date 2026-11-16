/*
Shared, dependency-free helpers for normalizing Puter.ai API responses.

Puter's chat-completion driver is inconsistent: the same logical response can
appear as { choices: [{ message }] } (OpenAI shape), { success, result: { message } }
(Puter-native shape), a plain { text } / { content } object, or — when a
non-streaming request is answered "in stream mode anyway" — as newline-delimited
JSON (NDJSON). These helpers centralize the messy extraction so puterStream.js
and puterRequest.js (and downstream projects like PuterGPT) don't re-implement
it each time.

Everything here is a pure function; no fetch, no DOM, no globals.
*/

/**
 * Coerce Puter's many "content" shapes into a single string.
 * Handles strings, arrays of parts ([{type,text}, ...] or [string, ...]),
 * and objects with a .text property. Returns '' for anything else.
 */
export function normalizeAIContent(val) {
  if (Array.isArray(val)) {
    return val.map(part => (typeof part === 'string' ? part : (part?.text || ''))).join('');
  }
  if (typeof val === 'string') return val;
  if (val && typeof val === 'object' && typeof val.text === 'string') return val.text;
  return '';
}

/**
 * Extract the message object from any of the shapes Puter uses:
 *   { choices: [{ message }] }        (OpenAI-style)
 *   { result: { message } }           (Puter-native)
 *   { result: { choices: [{ message }] } }
 *   { message }                       (bare)
 * Returns null when nothing message-like is present.
 * When the shape is choices/result-based, also ensures result.choices exists
 * on the original object (the historical behavior callers rely on).
 */
export function extractPuterMessage(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const messageObj =
    obj.choices?.[0]?.message ||
    obj.result?.message ||
    obj.result?.choices?.[0]?.message ||
    obj.message ||
    null;
  if (messageObj && !obj.choices && (obj.result || obj.message)) {
    // Preserve the historical side effect: synthesize a choices array so
    // callers can uniformly read result.choices[0].message.
    obj.choices = [{ message: messageObj }];
  }
  return messageObj;
}

/**
 * Extract the assistant text content from any known Puter response shape.
 * Tries (in order): result.message.content, result.output,
 * result.choices[0].message.content, choices[0].message.content (+ reasoning_content
 * is NOT mixed in), message.content, text, content, output.
 * Returns '' when nothing usable is found.
 */
export function extractPuterContent(obj) {
  if (typeof obj === 'string') return obj;
  if (!obj || typeof obj !== 'object') return '';

  const candidates = [
    obj.result?.message?.content,
    obj.result?.output,
    obj.result?.choices?.[0]?.message?.content,
    obj.result?.choices?.[0]?.delta?.content,
    obj.choices?.[0]?.message?.content,
    obj.choices?.[0]?.delta?.content,
    obj.choices?.[0]?.delta?.text,
    obj.delta?.content,
    obj.message?.content,
    obj.text,
    obj.content,
    obj.output,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeAIContent(candidate);
    if (normalized) return normalized;
  }
  return '';
}

/**
 * Extract reasoning / chain-of-thought text from any known Puter response shape.
 * Checks message-level reasoning_content / reasoning on choices and result,
 * plus top-level reasoning. Returns '' when absent.
 */
export function extractPuterReasoning(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const candidates = [
    obj.choices?.[0]?.message?.reasoning_content,
    obj.choices?.[0]?.message?.reasoning,
    obj.choices?.[0]?.delta?.reasoning_content,
    obj.choices?.[0]?.delta?.reasoning,
    obj.choices?.[0]?.delta?.thinking,
    obj.result?.message?.reasoning_content,
    obj.result?.message?.reasoning,
    obj.result?.choices?.[0]?.message?.reasoning_content,
    obj.result?.choices?.[0]?.message?.reasoning,
    obj.result?.choices?.[0]?.delta?.reasoning_content,
    obj.result?.choices?.[0]?.delta?.reasoning,
    obj.message?.reasoning_content,
    obj.message?.reasoning,
    obj.reasoning,
    obj.reasoning_content,
    obj.thinking,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeAIContent(candidate);
    if (normalized) return normalized;
  }
  return '';
}

/**
 * Normalize OpenAI-style tool_calls into the flat shape this library exposes:
 *   [{ id, name, input }]
 * where input is the parsed arguments object (or the raw string when it isn't
 * valid JSON — e.g. a fragment that never got completed).
 */
export function normalizeToolCalls(rawToolCalls) {
  if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) return [];
  return rawToolCalls.map(tc => ({
    id: tc?.id,
    name: tc?.function?.name || tc?.name,
    input: parseToolArguments(tc?.function?.arguments ?? tc?.input),
  }));
}

export function parseToolArguments(args) {
  if (args == null) return {};
  if (typeof args === 'object') return args; // already parsed
  try { return JSON.parse(args); } catch { return args; }
}

/**
 * Accumulates OpenAI-style streamed tool_calls deltas.
 * In a stream, choices[0].delta.tool_calls arrives in fragments: the first
 * fragment carries index/id/function.name, subsequent fragments carry only
 * function.arguments chunks. Parsing each fragment eagerly yields garbage,
 * so buffer per index and finalize at the end (or when the stream closes).
 *
 * Usage:
 *   const acc = createToolCallAccumulator();
 *   acc.push(deltaToolCalls);   // on every chunk
 *   const toolUses = acc.flush(); // once, at the end of the stream
 */
export function createToolCallAccumulator() {
  const buffers = new Map(); // index -> { id, name, arguments: string, sawAny: boolean }

  const push = (deltaToolCalls) => {
    if (!Array.isArray(deltaToolCalls)) return;
    for (const tc of deltaToolCalls) {
      if (!tc) continue;
      const index = Number.isInteger(tc.index) ? tc.index : 0;
      let buf = buffers.get(index);
      if (!buf) {
        buf = { id: undefined, name: undefined, arguments: '', sawAny: false };
        buffers.set(index, buf);
      }
      if (tc.id) buf.id = tc.id;
      if (tc.function?.name) buf.name = tc.function.name;
      else if (tc.name) buf.name = tc.name;
      const argChunk = tc.function?.arguments ?? (typeof tc.arguments === 'string' ? tc.arguments : undefined);
      if (typeof argChunk === 'string') buf.arguments += argChunk;
      buf.sawAny = true;
    }
  };

  const flush = () => {
    const toolUses = [];
    const entries = [...buffers.entries()].sort(([a], [b]) => a - b);
    for (const [, buf] of entries) {
      if (!buf.sawAny) continue;
      // A tool call with no id AND no name is not a real call — skip it.
      if (!buf.id && !buf.name) continue;
      toolUses.push({
        type: 'tool_use',
        id: buf.id,
        name: buf.name,
        input: parseToolArguments(buf.arguments || '{}'),
      });
    }
    return toolUses;
  };

  return { push, flush, get size() { return buffers.size; } };
}

/**
 * The heuristic Puter uses (poorly) to signal "no model could serve this".
 * Accepts a raw object, a serialized string, or an Error-ish value.
 * Returns true only when the value genuinely looks like the error and not
 * like content that merely mentions the phrase.
 */
export function isNoFallbackModelError(value) {
  const objStr = typeof value === 'string' ? value : safeStringify(value);
  if (!objStr || !objStr.includes('no fallback model available')) return false;

  let obj = value;
  if (typeof value === 'string') {
    try { obj = JSON.parse(value); } catch { obj = null; }
  }
  if (!obj || typeof obj !== 'object') {
    // Unparseable text — treat as the error only when it ends with a bare marker
    // (i.e. it's just the error, not prose containing the phrase).
    return /^\s*\{[^{}]*"?no fallback model available"?[^{}]*\}\s*$/.test(objStr)
      || objStr.trim() === 'no fallback model available';
  }
  return (
    (obj.success === false && obj.error === 'no fallback model available') ||
    (objStr.endsWith('"no fallback model available"}') || objStr.endsWith('"no fallback model available"}]')) ||
    (Object.keys(obj).length <= 3 && !obj.choices && !obj.result && !obj.text && !obj.content && !obj.message)
  );
}

/**
 * Detect Puter's "usage limited" signal across the shapes it shows up in.
 */
export function isUsageLimited(result, messageObj = undefined, content = undefined) {
  const msg = messageObj === undefined ? extractPuterMessage(result) : messageObj;
  const text = content === undefined ? extractPuterContent(result) : content;
  return Boolean(
    result?.metadata?.usage_limited === true ||
    msg?.model === 'usage-limited' ||
    (typeof text === 'string' && text.toLowerCase().includes('usage limit'))
  );
}

/**
 * Pull an inline <think>/<thinking>/<reasoning> block out of content text.
 * Returns { reasoning, cleaned } where cleaned has the tag removed.
 * If no tag is present, reasoning is '' and cleaned is the input unchanged.
 */
export function extractInlineReasoning(content) {
  if (typeof content !== 'string' || !content) return { reasoning: '', cleaned: content || '' };
  for (const tag of ['think', 'thinking', 'reasoning']) {
    const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
    const matches = content.match(regex);
    if (matches) {
      return { reasoning: matches[1].trim(), cleaned: content.replace(regex, '').trim() };
    }
  }
  return { reasoning: '', cleaned: content };
}

/**
 * Parse one line of a streaming (NDJSON) response.
 * Tolerates an SSE-style "data: " prefix and the [DONE] sentinel.
 * Returns one of:
 *   { done: true }           — the stream terminator
 *   { value: <object> }      — a parsed chunk
 *   null                     — blank line or unparseable line (caller may ignore)
 */
export function parseStreamLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
  if (!payload) return null;
  if (payload === '[DONE]') return { done: true };
  try { return { value: JSON.parse(payload) }; } catch { return null; }
}

/**
 * Create an Error with a stable machine-readable `code`, keeping the legacy
 * message prefixes (NO_FALLBACK_MODEL:, USAGE_LIMIT_REACHED:) so existing
 * callers that match on error.message keep working.
 */
export function makePuterError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function safeStringify(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}
