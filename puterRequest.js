/*
Non-streaming Puter.ai request helper that performs the POST fetch attempts with retry/rotation logic,
parses the response, and returns a normalized Puter-like result.

Usage:
  import { generatePuterResponse } from './puterRequest.js';
  // or if you're on another project, do this instead:
  // import { generatePuterResponse } from 'https://noname-isaidnoname.github.io/MyAIUtilities/puterRequest.js';

  const result = await generatePuterResponse({
    url,
    payload,           // payload.messages and other cleaned request args
    reqBody,           // original reqBody object (may contain .model etc)
    getCurrentToken,   // function returning current token string
    rotateToken,       // function to rotate tokens on auth failure
    saveTokensToStorage, // optional function to persist token metadata
    showLoadingIndicator, // optional UI callback to indicate attempts
    effectiveMaxRetries,  // numeric retries to attempt
  });

tools  — array of tool definitions, same format as streamPuterCompletion.
            e.g. [{ type: 'web_search' }]
            or OpenAI function tools:
            [{
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Get current weather',
                parameters: {
                  type: 'object',
                  properties: { location: { type: 'string' } },
                  required: ['location']
                }
              }
            }]

The returned result gains a normalized `toolCalls` array:
  result.toolCalls = [{ id, name, input }]

If the model responded with tool calls instead of text, result.choices[0].message.content
will be empty/null and result.toolCalls will be populated.

Errors thrown by this helper carry a stable `code`:
  'NO_FALLBACK_MODEL'  — Puter reported no model could serve the request
  'USAGE_LIMIT_REACHED' — the current token hit its usage limit (and retries were exhausted)
  'HTTP_ERROR'         — resp.ok was false (err.status holds the status code)
  'INVALID_ARGS'       — required options were missing/invalid
The legacy message prefixes (NO_FALLBACK_MODEL:, USAGE_LIMIT_REACHED:) are kept
so existing message-matching callers keep working.
*/
import {
  normalizeAIContent,
  extractPuterMessage,
  extractPuterContent,
  extractPuterReasoning,
  extractInlineReasoning,
  normalizeToolCalls,
  createToolCallAccumulator,
  isNoFallbackModelError,
  isUsageLimited,
  makePuterError,
} from './puterResponse.js';

export async function generatePuterResponse({
  url = 'https://api.puter.com/drivers/call',
  payload,
  reqBody,
  getCurrentToken,
  rotateToken,
  tools = null,              // tool definitions array
  saveTokensToStorage = () => {},
  showLoadingIndicator = (outputElement, modeConfig, model, attempt) => {},
  effectiveMaxRetries = 1,
  modeConfig = null,
  documentOutputElement = null,
  signal = null
} = {}) {
  if (!url) throw makePuterError('INVALID_ARGS', 'url is required');
  if (!payload) throw makePuterError('INVALID_ARGS', 'payload is required');
  if (!reqBody) throw makePuterError('INVALID_ARGS', 'reqBody is required');
  if (typeof getCurrentToken !== 'function') throw makePuterError('INVALID_ARGS', 'getCurrentToken function is required');
  if (typeof rotateToken !== 'function') throw makePuterError('INVALID_ARGS', 'rotateToken function is required');

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // ── Build the args object once; include tools only when provided ───────────
  const buildArgs = () => {
    const args = {
      messages: payload.messages,
      model: reqBody.model,
      stream: false
    };
    if (tools && Array.isArray(tools) && tools.length > 0) {
      args.tools = tools;
    }
    return args;
  };

  const persistTokensSafely = () => {
    try { saveTokensToStorage(); } catch (e) { /* ignore */ }
  };

  for (let attempt = 1; attempt <= effectiveMaxRetries + 1; attempt++) {
    try {
      if (showLoadingIndicator && documentOutputElement && modeConfig) {
        try {
          showLoadingIndicator(documentOutputElement, modeConfig, reqBody.model, attempt);
        } catch (e) { /* ignore */ }
      }

      console.log(`Attempt ${attempt}/${effectiveMaxRetries + 1} using Puter AI model: ${reqBody.model}`);
      const token = getCurrentToken();
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token || ''}`,
          'Accept': '*/*',
          'Origin': 'https://docs.puter.com',
          'Referer': 'https://docs.puter.com'
        },
        body: JSON.stringify({
          "interface": "puter-chat-completion",
          "driver": "ai-chat",
          "test_mode": true, // attempts to prevent token usage, do not delete this comment or set it back to false.
          "method": "complete",
          "args": buildArgs()
        }),
        signal
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        let errorObj = {};
        try { errorObj = JSON.parse(errorText); } catch (e) { errorObj = { details: { error: { message: errorText || `HTTP error ${resp.status}` } } }; }

        if (resp.status === 403 || resp.status === 401) {
          console.error(`HTTP ${resp.status} error: ${errorText}`);
          rotateToken();
          persistTokensSafely();
          if (attempt <= effectiveMaxRetries) {
            await sleep(300 * Math.pow(2, attempt - 1));
            continue;
          }
          throw makePuterError('HTTP_ERROR', `API ${resp.status} error: ${errorText}`);
        }

        const err = makePuterError('HTTP_ERROR', `Puter.com request failed: HTTP ${resp.status} ${errorObj.details?.error?.message || errorText || 'Unknown error'}`);
        err.status = resp.status;
        throw err;
      }

      // Parse the body — tolerating the driver answering NDJSON on a
      // stream: false request (it happens; see puterStream.js).
      const rawText = await resp.text();
      const result = parsePuterBody(rawText);
      console.log(`AI Response (Puter): ${JSON.stringify(result)}`);

      if (isNoFallbackModelError(result) || isNoFallbackModelError(rawText)) {
        throw makePuterError('NO_FALLBACK_MODEL', 'NO_FALLBACK_MODEL: No fallback model available. Please try a different model or check your API configuration.');
      }

      const messageObj = extractPuterMessage(result);
      if (!messageObj) {
        throw new Error("AI response did not contain a valid message object.");
      }
      if (!result.choices) result.choices = [{ message: messageObj }];

      let content = normalizeAIContent(messageObj.content);
      let reasoningContent = extractPuterReasoning(result);

      // ── Normalize tool_calls from the response ─────────────────────────────
      // OpenAI format: message.tool_calls = [{ id, type:'function', function:{ name, arguments } }]
      // We expose a flat result.toolCalls = [{ id, name, input }] for convenience.
      const rawToolCalls = messageObj.tool_calls;
      if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
        result.toolCalls = normalizeToolCalls(rawToolCalls);
        console.log(`Tool calls requested by model:`, result.toolCalls);
      } else {
        result.toolCalls = [];
      }

      if (isUsageLimited(result, messageObj, content)) {
        console.warn("Usage limit reached for current token. Rotating...");
        rotateToken();
        persistTokensSafely();
        if (attempt <= effectiveMaxRetries) {
          await sleep(500);
          continue;
        }
        throw makePuterError('USAGE_LIMIT_REACHED', "USAGE_LIMIT_REACHED: You have reached your AI usage limit for this account/token.");
      }

      if (!reasoningContent && content) {
        const { reasoning } = extractInlineReasoning(content);
        if (reasoning) reasoningContent = reasoning;
      }

      if (reasoningContent) {
        result.choices[0].message.reasoning_content = reasoningContent;
      }

      return result;
    } catch (error) {
      console.error(`generatePuterResponse Attempt ${attempt} Error:`, error);

      if (error.code === 'NO_FALLBACK_MODEL' || (error.message && error.message.includes('NO_FALLBACK_MODEL'))) {
        throw error;
      }

      if (attempt === effectiveMaxRetries + 1) {
        throw error;
      }
      await sleep(300 * Math.pow(2, attempt - 1));
    }
  }

  throw new Error('Unreachable: exhausted retries without returning or throwing.');
}

// Parse a response body that may be a single JSON document or NDJSON.
// NDJSON lines are aggregated: text/reasoning concatenated, tool_calls merged.
function parsePuterBody(rawText) {
  const text = String(rawText || '').trim();
  try { return JSON.parse(text); } catch (e) { /* maybe NDJSON */ }

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw new Error('Empty response body from Puter.');
  }

  const aggregate = {
    success: true,
    result: { message: { role: 'assistant', content: '' } },
  };
  const toolCallAccumulator = createToolCallAccumulator();
  for (const line of lines) {
    const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
    if (!payload || payload === '[DONE]') continue;
    let obj;
    try { obj = JSON.parse(payload); } catch (e) { continue; }
    if (isNoFallbackModelError(obj)) return obj; // let the caller's check flag it
    const piece = extractPuterContent(obj);
    const reasoningPiece = extractPuterReasoning(obj);
    if (piece) aggregate.result.message.content += piece;
    if (reasoningPiece) {
      aggregate.result.message.reasoning_content = (aggregate.result.message.reasoning_content || '') + reasoningPiece;
    }
    const deltaToolCalls = obj.choices?.[0]?.delta?.tool_calls;
    const fullToolCalls = obj.result?.message?.tool_calls || obj.choices?.[0]?.message?.tool_calls;
    if (Array.isArray(deltaToolCalls) && deltaToolCalls.length > 0) {
      toolCallAccumulator.push(deltaToolCalls);
    }
    if (Array.isArray(fullToolCalls) && fullToolCalls.length > 0) {
      aggregate.result.message.tool_calls = [...(aggregate.result.message.tool_calls || []), ...fullToolCalls];
    }
  }
  const flushed = toolCallAccumulator.flush().map(({ id, name, input }) => ({ id, function: { name, arguments: input } }));
  if (flushed.length > 0) {
    aggregate.result.message.tool_calls = [...(aggregate.result.message.tool_calls || []), ...flushed];
  }
  return aggregate;
}
