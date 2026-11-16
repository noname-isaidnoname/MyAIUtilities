/*
Reusable Puter.ai streaming helper that reads newline-delimited JSON (NDJSON)
chunks from a Puter streaming response and returns accumulated content,
reasoning and tool uses while invoking callbacks for chunks, partial updates,
completion and errors.

Usage (web search via OpenAI built-in tool):

  await streamPuterCompletion({
    requestBody: {
      interface: 'puter-chat-completion',
      driver: 'openai',
      method: 'complete',
      args: {
        model: 'openai/gpt-4o-search-preview',  // or gpt-4o, o3, o4-mini, etc.
        messages: [{ role: 'user', content: 'What happened in the news today?' }],
        stream: true,
        tools: [{ type: 'web_search' }],         // <-- enables web search
      },
    },
    onChunk: (obj) => { ... },
    onToolUse: (toolUse) => {
      // called when the model signals a tool/web-search call
      // toolUse = { type: 'tool_use', id, name, input: { ... } }
      console.log('Tool called:', toolUse.name, toolUse.input);
    },
    onPartialUpdate: ({ accumulatedContent, accumulatedReasoning, accumulatedToolUses }) => { ... },
    onComplete: (finalState) => { ... },
    onError: (err) => { ... },
  });

Models with built-in web search (pass tools:[{type:"web_search"}]):
  openai/gpt-4o-search-preview, openai/gpt-4o, openai/o3, openai/o4-mini, openai/o4-mini-high

Models with web search via OpenRouter (same tools param works):
  openrouter:perplexity/sonar-pro, openrouter:perplexity/sonar-reasoning-pro

The helper returns a promise resolving to:
  { accumulatedContent, accumulatedReasoning, accumulatedToolUses }

tools  — array of tool definitions forwarded to the model, e.g.
            [{ type: 'web_search' }]
            or OpenAI-style function tools:
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

If tools are already present in requestBody.args.tools they are preserved;
the explicit `tools` parameter is merged on top (explicit wins).

Notes on tool calls:
  * Puter-native `{ type: 'tool_use', ... }` chunks are complete objects and
    fire `onToolUse` immediately.
  * OpenAI-style `choices[0].delta.tool_calls` arrive in fragments (the name
    first, then argument JSON piece by piece). They are accumulated per
    `index` and emitted via `onToolUse` once the stream completes, with the
    full parsed `input` — never as unparseable partial JSON.
*/
import {
  normalizeAIContent,
  extractPuterContent,
  extractPuterReasoning,
  extractInlineReasoning,
  normalizeToolCalls,
  createToolCallAccumulator,
  isNoFallbackModelError,
  parseStreamLine,
  makePuterError,
} from './puterResponse.js';

const NO_FALLBACK_MESSAGE = 'NO_FALLBACK_MODEL: No fallback model available. Please try a different model or check your API configuration.';

export async function streamPuterCompletion({
  apiUrl = 'https://api.puter.com/drivers/call',
  requestBody,
  headers = {},
  tools = null,              // tool definitions array
  onChunk = () => {},
  onPartialUpdate = () => {},
  onComplete = () => {},
  onError = () => {},
  onToolUse = () => {},
  signal = null
} = {}) {
  if (!requestBody) {
    const err = new Error('requestBody is required for streamPuterCompletion');
    err.code = 'INVALID_ARGS';
    onError(err);
    throw err;
  }

  // ── Merge tools into requestBody.args if provided ─────────────────────────
  if (tools && Array.isArray(tools) && tools.length > 0) {
    requestBody = {
      ...requestBody,
      args: {
        ...(requestBody.args || {}),
        tools                          // explicit param wins over anything in args
      }
    };
  }

  // Guards against calling onError twice for the same failure (the callback
  // sites report, then the outer catch would report again).
  let errorReported = false;
  const reportError = (err) => {
    if (errorReported) return;
    errorReported = true;
    try { onError(err); } catch (e) { /* swallow */ }
    throw err;
  };

  const toolCallAccumulator = createToolCallAccumulator();

  const newState = () => ({ accumulatedContent: '', accumulatedReasoning: '', accumulatedToolUses: [] });

  const emitToolUseSafe = (toolUse) => {
    try { onToolUse(toolUse); } catch (e) { /* swallow */ }
  };

  // Flush fragmented OpenAI tool_calls; completes each buffered call and
  // emits onToolUse for it. Returns the number of tool uses flushed.
  const flushToolCalls = (state) => {
    const flushed = toolCallAccumulator.flush();
    for (const toolUse of flushed) {
      state.accumulatedToolUses.push(toolUse);
      emitToolUseSafe(toolUse);
    }
    return flushed.length;
  };

  // Accumulate a single parsed chunk into `state`. Never throws for ordinary
  // chunks; throws (via reportError) only for the fatal no-fallback-model marker.
  const accumulateChunk = (obj, state) => {
    if (!obj) return;

    if (isNoFallbackModelError(obj)) {
      reportError(makePuterError('NO_FALLBACK_MODEL', NO_FALLBACK_MESSAGE));
    }

    try { onChunk(obj); } catch (e) { /* swallow */ }

    const isReasoningChunk = obj.type === 'reasoning' ||
      Boolean(obj.reasoning && !obj.text && !obj.content && !obj.choices && !obj.result);

    // ── reasoning ───────────────────────────────────────────────────────────
    const reasoningDelta = isReasoningChunk
      ? normalizeAIContent(obj.reasoning ?? obj.text)
      : extractPuterReasoning(obj);
    if (reasoningDelta) state.accumulatedReasoning += reasoningDelta;

    // ── text / content (reasoning chunks never leak into content) ──────────
    if (!isReasoningChunk) {
      const textDelta = extractPuterContent(obj);
      if (textDelta) state.accumulatedContent += textDelta;
    }

    // ── Puter-native tool_use chunk (complete object — emit immediately) ───
    if (obj.type === 'tool_use') {
      state.accumulatedToolUses.push(obj);
      emitToolUseSafe(obj);
    }

    // ── OpenAI-style tool_calls (delta fragments or complete) ─────────────
    const deltaToolCalls = obj.choices?.[0]?.delta?.tool_calls
                        || obj.choices?.[0]?.message?.tool_calls
                        || obj.result?.message?.tool_calls;
    if (Array.isArray(deltaToolCalls) && deltaToolCalls.length > 0) {
      const isCompleteMessage = Boolean(obj.choices?.[0]?.message?.tool_calls || obj.result?.message?.tool_calls);
      if (isCompleteMessage) {
        for (const toolUse of normalizeToolCalls(deltaToolCalls)) {
          const full = { type: 'tool_use', ...toolUse };
          state.accumulatedToolUses.push(full);
          emitToolUseSafe(full);
        }
      } else {
        toolCallAccumulator.push(deltaToolCalls);
      }
    }
  };

  // Handle a full (non-streaming) response parsed as a single JSON object.
  const handleFullResponseObject = (obj) => {
    if (isNoFallbackModelError(obj)) {
      reportError(makePuterError('NO_FALLBACK_MODEL', NO_FALLBACK_MESSAGE));
    }
    try { onChunk(obj); } catch (e) { /* swallow */ }
    const state = newState();
    state.accumulatedContent = extractPuterContent(obj);
    state.accumulatedReasoning = extractPuterReasoning(obj);
    if (!state.accumulatedReasoning) {
      state.accumulatedReasoning = extractInlineReasoning(state.accumulatedContent).reasoning;
    }
    const toolCalls = obj.result?.message?.tool_calls
                   || obj.choices?.[0]?.message?.tool_calls
                   || obj.message?.tool_calls;
    for (const toolUse of normalizeToolCalls(toolCalls)) {
      const full = { type: 'tool_use', ...toolUse };
      state.accumulatedToolUses.push(full);
      emitToolUseSafe(full);
    }
    try { onPartialUpdate({ ...state }); } catch (e) { /* swallow */ }
    try { onComplete({ ...state }); } catch (e) { /* swallow */ }
    return state;
  };

  // Handle NDJSON that arrived in a non-streamed body: aggregate every line.
  const handleNdjsonBody = (lines) => {
    const state = newState();
    for (const line of lines) {
      const parsed = parseStreamLine(line);
      if (!parsed) {
        if (isNoFallbackModelError(line)) {
          reportError(makePuterError('NO_FALLBACK_MODEL', NO_FALLBACK_MESSAGE));
        }
        continue;
      }
      if (parsed.done) continue;
      accumulateChunk(parsed.value, state);
    }
    flushToolCalls(state);
    try { onPartialUpdate({ ...state }); } catch (e) { /* swallow */ }
    try { onComplete({ ...state }); } catch (e) { /* swallow */ }
    return state;
  };

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        ...headers,
        'Origin': 'https://docs.puter.com',
        'Referer': 'https://docs.puter.com/'
      },
      body: JSON.stringify(requestBody),
      signal
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      const err = new Error(`Puter.ai request failed: ${response.status} ${response.statusText} - ${bodyText}`);
      err.code = 'HTTP_ERROR';
      err.status = response.status;
      reportError(err);
    }

    if (!response.body || !response.body.getReader) {
      // ── Non-streamable (or non-streaming) full-body response ──────────────
      const text = await response.text();

      if (isNoFallbackModelError(text)) {
        reportError(makePuterError('NO_FALLBACK_MODEL', NO_FALLBACK_MESSAGE));
      }

      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

      // Single JSON document (the normal case for stream: false)
      if (lines.length <= 1) {
        try {
          return handleFullResponseObject(JSON.parse(text));
        } catch (e) {
          if (errorReported) throw e;
          const err = new Error('Response was not streamable and could not be parsed as JSON.');
          err.code = 'PARSE_ERROR';
          reportError(err);
        }
      }

      // NDJSON fallback — the driver "streamed anyway"
      return handleNdjsonBody(lines);
    }

    // ── Streaming NDJSON body ────────────────────────────────────────────────
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const state = newState();

    const emitPartial = () => {
      try {
        onPartialUpdate({ ...state });
      } catch (e) { /* swallow */ }
    };

    const processChunk = (obj) => {
      accumulateChunk(obj, state);
      emitPartial();
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop();

      for (const part of parts) {
        const parsed = parseStreamLine(part);
        if (!parsed) {
          if (part.trim() && isNoFallbackModelError(part)) {
            reportError(makePuterError('NO_FALLBACK_MODEL', NO_FALLBACK_MESSAGE));
          }
          continue;
        }
        if (parsed.done) continue;
        processChunk(parsed.value);
      }
    }

    if (buffer.trim()) {
      const parsed = parseStreamLine(buffer);
      if (parsed?.value) processChunk(parsed.value);
    }

    flushToolCalls(state);
    emitPartial();

    const finalState = { ...state };
    try { onComplete(finalState); } catch (e) { /* swallow */ }
    return finalState;

  } catch (error) {
    if (!errorReported) {
      errorReported = true;
      try { onError(error); } catch (e) { /* swallow */ }
    }
    throw error;
  }
}
