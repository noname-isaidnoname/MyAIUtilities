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
 */

export async function streamPuterCompletion({  
  apiUrl = 'https://api.puter.com/drivers/call',  
  requestBody,  
  headers = {},  
  onChunk = () => {},  
  onPartialUpdate = () => {},  
  onComplete = () => {},  
  onError = () => {},  
  onToolUse = () => {},       // NEW: called for every tool_use chunk  
  signal = null  
} = {}) {  
  if (!requestBody) {  
    const err = new Error('requestBody is required for streamPuterCompletion');  
    onError(err);  
    throw err;  
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
      // Not a streaming response; attempt to parse the full body as fallback  
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
        if (obj.type === 'tool_use') {  
          accumulatedToolUses.push(obj);  
          try { onToolUse(obj); } catch (e) { /* swallow */ }  
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
    let accumulatedToolUses = [];   // NEW: collects every tool_use chunk  
  
    const emitPartial = () => {  
      try {  
        onPartialUpdate({ accumulatedContent, accumulatedReasoning, accumulatedToolUses });  
      } catch (e) { /* swallow */ }  
    };  
  
    // ── helper: process one parsed chunk object ──────────────────────────────  
    const processChunk = (obj) => {  
      if (!obj) return;  
  
      // ── error detection ────────────────────────────────────────────────────  
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
  
      // ── raw chunk to caller ────────────────────────────────────────────────  
      try { onChunk(obj); } catch (e) { /* swallow */ }  
  
      // ── text / content ─────────────────────────────────────────────────────  
      if ((obj.type === 'text' && obj.text) || obj.text || obj.content) {  
        accumulatedContent += obj.text || obj.content || '';  
      }  
  
      // ── reasoning ──────────────────────────────────────────────────────────  
      if ((obj.type === 'reasoning' || obj.reasoning) && (obj.text || obj.reasoning)) {  
        accumulatedReasoning += (obj.reasoning || obj.text || '');  
      }  
  
      // ── tool_use (web search call or function call) ────────────────────────  
      // Puter emits { type: 'tool_use', id, name, input: { ... } }  
      // For OpenAI built-in web_search the name is typically 'web_search'.  
      // For custom function tools the name matches the function you defined.  
      if (obj.type === 'tool_use') {  
        accumulatedToolUses.push(obj);  
        try { onToolUse(obj); } catch (e) { /* swallow */ }  
      }  
  
      // ── extra_content (Gemini metadata, citations, etc.) ───────────────────  
      // Already forwarded via onChunk above; callers can inspect obj.extra_content.  
      // No accumulation needed here unless you want to collect it.  
  
      // ── usage (end-of-stream token counts) ────────────────────────────────  
      // Already forwarded via onChunk; obj.usage contains the counts.  
  
      emitPartial();  
    };  
  
    // ── main read loop ───────────────────────────────────────────────────────  
    while (true) {  
      const { value, done } = await reader.read();  
      if (done) break;  
  
      buffer += decoder.decode(value, { stream: true });  
      const parts = buffer.split('\n');  
      buffer = parts.pop(); // keep last partial line  
  
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
          continue; // not a JSON chunk; skip  
        }  
  
        try {  
          processChunk(obj);  
        } catch (err) {  
          onError(err);  
          throw err;  
        }  
      }  
    }  
  
    // ── flush remaining buffer ───────────────────────────────────────────────  
    if (buffer.trim()) {  
      try {  
        const finalObj = JSON.parse(buffer);  
        processChunk(finalObj);  
      } catch (e) {  
        // ignore final parse / processing error  
      }  
    }  
  
    const finalState = { accumulatedContent, accumulatedReasoning, accumulatedToolUses };  
    try { onComplete(finalState); } catch (e) { /* swallow */ }  
    return finalState;  
  
  } catch (error) {  
    try { onError(error); } catch (e) { /* swallow */ }  
    throw error;  
  }  
} 