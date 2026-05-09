/*
Reusable Puter.ai streaming helper that reads newline-delimited JSON chunks from a Puter streaming response and returns accumulated content and reasoning while invoking callbacks for chunks, partial updates, completion and errors.
/*  
 * Reusable Puter.ai streaming helper — with web-search / tool_use support  
 *  
 * Usage (web search via OpenAI built-in tool):  
 *  
 *   await streamPuterCompletion({  
 *     requestBody: {  
 *       interface: 'puter-chat-completion',  
 *       driver: 'openai',  
 *       method: 'complete',  
 *       args: {  
 *         model: 'openai/gpt-4o-search-preview',  // or gpt-4o, o3, o4-mini, etc.  
 *         messages: [{ role: 'user', content: 'What happened in the news today?' }],  
 *         stream: true,  
 *         tools: [{ type: 'web_search' }],         // <-- enables web search  
 *       },  
 *     },  
 *     onChunk: (obj) => { ... },  
 *     onToolUse: (toolUse) => {  
 *       // called when the model signals a tool/web-search call  
 *       // toolUse = { type: 'tool_use', id, name, input: { ... } }  
 *       console.log('Tool called:', toolUse.name, toolUse.input);  
 *     },  
 *     onPartialUpdate: ({ accumulatedContent, accumulatedReasoning, accumulatedToolUses }) => { ... },  
 *     onComplete: (finalState) => { ... },  
 *     onError: (err) => { ... },  
 *   });  
 *  
 * Models with built-in web search (pass tools:[{type:"web_search"}]):  
 *   openai/gpt-4o-search-preview, openai/gpt-4o, openai/o3, openai/o4-mini, openai/o4-mini-high  
 *  
 * Models with web search via OpenRouter (same tools param works):  
 *   openrouter:perplexity/sonar-pro, openrouter:perplexity/sonar-reasoning-pro  
 *  
 * The helper returns a promise resolving to:  
 *   { accumulatedContent, accumulatedReasoning, accumulatedToolUses }  
 *  
 * tools  — array of tool definitions forwarded to the model, e.g.  
 *             [{ type: 'web_search' }]  
 *             or OpenAI-style function tools:  
 *             [{  
 *               type: 'function',  
 *               function: {  
 *                 name: 'get_weather',  
 *                 description: 'Get current weather',  
 *                 parameters: {  
 *                   type: 'object',  
 *                   properties: { location: { type: 'string' } },  
 *                   required: ['location']  
 *                 }  
 *               }  
 *             }]  
 *  
 * If tools are already present in requestBody.args.tools they are preserved;  
 * the explicit `tools` parameter is merged on top (explicit wins).  
 */  
export async function streamPuterCompletion({  
  apiUrl = 'https://api.puter.com/drivers/call',  
  requestBody,  
  headers = {},  
  tools = null,              // NEW: tool definitions array  
  onChunk = () => {},  
  onPartialUpdate = () => {},  
  onComplete = () => {},  
  onError = () => {},  
  onToolUse = () => {},  
  signal = null  
} = {}) {  
  if (!requestBody) {  
    const err = new Error('requestBody is required for streamPuterCompletion');  
    onError(err);  
    throw err;  
  }  
  
  // ── Merge tools into requestBody.args if provided ──────────────────────────  
  if (tools && Array.isArray(tools) && tools.length > 0) {  
    requestBody = {  
      ...requestBody,  
      args: {  
        ...(requestBody.args || {}),  
        tools                          // explicit param wins over anything in args  
      }  
    };  
  }  
  
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
      onError(err);  
      throw err;  
    }  
  
    if (!response.body || !response.body.getReader) {  
      const text = await response.text();  
  
      if (text.includes('no fallback model available')) {  
        let result;  
        try { result = JSON.parse(text); } catch (e) { /* ignore */ }  
        const isActualError = !result || (  
          (result.success === false && result.error === 'no fallback model available') ||  
          (Object.keys(result).length <= 3 && !result.choices && !result.result)  
        );  
        if (isActualError) {  
          const err = new Error('NO_FALLBACK_MODEL: No fallback model available. Please try a different model or check your API configuration.');  
          onError(err);  
          throw err;  
        }  
      }  
  
      try {  
        const obj = JSON.parse(text);  
        onChunk(obj);  
        const accumulatedContent = (obj.text || obj.content || '') + '';  
        const accumulatedReasoning = (obj.reasoning || '') + '';  
        const accumulatedToolUses = [];  
        // ── handle tool_use in non-streaming fallback ──────────────────────  
        if (obj.type === 'tool_use') {  
          accumulatedToolUses.push(obj);  
          try { onToolUse(obj); } catch (e) { /* swallow */ }  
        }  
        // ── handle OpenAI-style tool_calls in non-streaming fallback ───────  
        const toolCalls = obj.choices?.[0]?.message?.tool_calls  
                       || obj.result?.message?.tool_calls;  
        if (Array.isArray(toolCalls)) {  
          for (const tc of toolCalls) {  
            const toolUse = {  
              type: 'tool_use',  
              id: tc.id,  
              name: tc.function?.name,  
              input: (() => {  
                try { return JSON.parse(tc.function?.arguments || '{}'); }  
                catch (e) { return tc.function?.arguments || {}; }  
              })()  
            };  
            accumulatedToolUses.push(toolUse);  
            try { onToolUse(toolUse); } catch (e) { /* swallow */ }  
          }  
        }  
        const finalState = { accumulatedContent, accumulatedReasoning, accumulatedToolUses };  
        onPartialUpdate(finalState);  
        onComplete(finalState);  
        return finalState;  
      } catch (e) {  
        const err = new Error('Response was not streamable and could not be parsed as JSON.');  
        onError(err);  
        throw err;  
      }  
    }  
  
    const reader = response.body.getReader();  
    const decoder = new TextDecoder();  
    let buffer = '';  
  
    let accumulatedContent = '';  
    let accumulatedReasoning = '';  
    let accumulatedToolUses = [];  
  
    const emitPartial = () => {  
      try {  
        onPartialUpdate({ accumulatedContent, accumulatedReasoning, accumulatedToolUses });  
      } catch (e) { /* swallow */ }  
    };  
  
    const processChunk = (obj) => {  
      if (!obj) return;  
  
      const objStr = JSON.stringify(obj);  
      if (objStr.includes('no fallback model available')) {  
        const isActualError = (  
          (obj.success === false && obj.error === 'no fallback model available') ||  
          (objStr.endsWith('"no fallback model available"}') ||  
           objStr.endsWith('"no fallback model available"}]')) ||  
          (Object.keys(obj).length <= 3 &&  
           !obj.choices && !obj.result && !obj.text && !obj.content)  
        );  
        if (isActualError) {  
          throw new Error('NO_FALLBACK_MODEL: No fallback model available. Please try a different model or check your API configuration.');  
        }  
      }  
  
      try { onChunk(obj); } catch (e) { /* swallow */ }  
  
      // ── text / content ─────────────────────────────────────────────────────  
      if ((obj.type === 'text' && obj.text) || obj.text || obj.content) {  
        accumulatedContent += obj.text || obj.content || '';  
      }  
  
      // ── reasoning ──────────────────────────────────────────────────────────  
      if ((obj.type === 'reasoning' || obj.reasoning) && (obj.text || obj.reasoning)) {  
        accumulatedReasoning += (obj.reasoning || obj.text || '');  
      }  
  
      // ── Puter-native tool_use chunk ────────────────────────────────────────  
      if (obj.type === 'tool_use') {  
        accumulatedToolUses.push(obj);  
        try { onToolUse(obj); } catch (e) { /* swallow */ }  
      }  
  
      // ── OpenAI-style tool_calls (delta or full) ────────────────────────────  
      // Streaming: choices[0].delta.tool_calls  
      // Non-streaming inside a stream: choices[0].message.tool_calls  
      const deltaToolCalls = obj.choices?.[0]?.delta?.tool_calls  
                          || obj.choices?.[0]?.message?.tool_calls  
                          || obj.result?.message?.tool_calls;  
      if (Array.isArray(deltaToolCalls)) {  
        for (const tc of deltaToolCalls) {  
          // Only emit complete tool calls (must have id + name)  
          if (!tc.id && !tc.function?.name) continue;  
          const toolUse = {  
            type: 'tool_use',  
            id: tc.id,  
            name: tc.function?.name,  
            input: (() => {  
              try { return JSON.parse(tc.function?.arguments || '{}'); }  
              catch (e) { return tc.function?.arguments || {}; }  
            })()  
          };  
          accumulatedToolUses.push(toolUse);  
          try { onToolUse(toolUse); } catch (e) { /* swallow */ }  
        }  
      }  
  
      emitPartial();  
    };  
  
    while (true) {  
      const { value, done } = await reader.read();  
      if (done) break;  
  
      buffer += decoder.decode(value, { stream: true });  
      const parts = buffer.split('\n');  
      buffer = parts.pop();  
  
      for (const part of parts) {  
        const line = part.trim();  
        if (!line) continue;  
  
        let obj = null;  
        try {  
          obj = JSON.parse(line);  
        } catch (e) {  
          if (line.includes('no fallback model available')) {  
            const err = new Error('NO_FALLBACK_MODEL: No fallback model available. Please try a different model or check your API configuration.');  
            onError(err);  
            throw err;  
          }  
          continue;  
        }  
  
        try {  
          processChunk(obj);  
        } catch (err) {  
          onError(err);  
          throw err;  
        }  
      }  
    }  
  
    if (buffer.trim()) {  
      try {  
        const finalObj = JSON.parse(buffer);  
        processChunk(finalObj);  
      } catch (e) { /* ignore */ }  
    }  
  
    const finalState = { accumulatedContent, accumulatedReasoning, accumulatedToolUses };  
    try { onComplete(finalState); } catch (e) { /* swallow */ }  
    return finalState;  
  
  } catch (error) {  
    try { onError(error); } catch (e) { /* swallow */ }  
    throw error;  
  }  
}