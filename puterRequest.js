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
*
* tools  — array of tool definitions, same format as streamPuterCompletion.  
*             e.g. [{ type: 'web_search' }]  
*             or OpenAI function tools:  
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
* The returned result gains a normalized `toolCalls` array:  
*   result.toolCalls = [{ id, name, input }]  
*  
* If the model responded with tool calls instead of text, result.choices[0].message.content  
* will be empty/null and result.toolCalls will be populated.  
*/  
export async function generatePuterResponse({  
  url = 'https://api.puter.com/drivers/call',  
  payload,  
  reqBody,  
  getCurrentToken,  
  rotateToken,  
  tools = null,              // NEW: tool definitions array  
  saveTokensToStorage = () => {},  
  showLoadingIndicator = (outputElement, modeConfig, model, attempt) => {},  
  effectiveMaxRetries = 1,  
  modeConfig = null,  
  documentOutputElement = null,  
  signal = null
} = {}) {  
  if (!url) throw new Error('url is required');  
  if (!payload) throw new Error('payload is required');  
  if (!reqBody) throw new Error('reqBody is required');  
  if (typeof getCurrentToken !== 'function') throw new Error('getCurrentToken function is required');  
  if (typeof rotateToken !== 'function') throw new Error('rotateToken function is required');  
  
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));  
  
  const normalizeAIContent = (val) => {  
    if (Array.isArray(val)) {  
      return val.map(part => (typeof part === 'string' ? part : (part.text || ''))).join('');  
    }  
    return typeof val === 'string' ? val : '';  
  };  
  
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
          if (typeof saveTokensToStorage === 'function') {  
            try { saveTokensToStorage(); } catch (e) {}  
          }  
          if (attempt <= effectiveMaxRetries) {  
            await sleep(300 * Math.pow(2, attempt - 1));  
            continue;  
          } else {  
            throw new Error(`API ${resp.status} error: ${errorText}`);  
          }  
        }  
  
        const err = new Error(`Puter.com request failed: HTTP ${resp.status} ${errorObj.details?.error?.message || errorText || 'Unknown error'}`);  
        throw err;  
      }  
  
      const result = await resp.json();  
      console.log(`AI Response (Puter): ${JSON.stringify(result)}`);  
  
      const resultStr = JSON.stringify(result);  
      if (resultStr.includes('no fallback model available')) {  
        const isActualError = (  
          (result.success === false && result.error === 'no fallback model available') ||  
          (resultStr.endsWith('"no fallback model available"}') || resultStr.endsWith('"no fallback model available"}]')) ||  
          (Object.keys(result).length <= 3 && !result.choices && !result.result)  
        );  
        if (isActualError) {  
          throw new Error('NO_FALLBACK_MODEL: No fallback model available. Please try a different model or check your API configuration.');  
        }  
      }  
  
      const messageObj = result.choices?.[0]?.message || result.result?.message;  
      if (!messageObj) {  
        throw new Error("AI response did not contain a valid message object.");  
      }  
  
      if (!result.choices) result.choices = [{ message: messageObj }];  
  
      let content = normalizeAIContent(messageObj.content);  
      let reasoningContent = normalizeAIContent(messageObj.reasoning_content || messageObj.reasoning);  
  
      // ── Normalize tool_calls from the response ─────────────────────────────  
      // OpenAI format: message.tool_calls = [{ id, type:'function', function:{ name, arguments } }]  
      // We expose a flat result.toolCalls = [{ id, name, input }] for convenience.  
      const rawToolCalls = messageObj.tool_calls;  
      if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {  
        result.toolCalls = rawToolCalls.map(tc => ({  
          id: tc.id,  
          name: tc.function?.name || tc.name,  
          input: (() => {  
            try { return JSON.parse(tc.function?.arguments || '{}'); }  
            catch (e) { return tc.function?.arguments || tc.input || {}; }  
          })()  
        }));  
        console.log(`Tool calls requested by model:`, result.toolCalls);  
      } else {  
        result.toolCalls = [];  
      }  
  
      const isUsageLimited = result.metadata?.usage_limited === true ||  
                            (messageObj && messageObj.model === 'usage-limited') ||  
                            (content && content.toLowerCase().includes("usage limit"));  
      if (isUsageLimited) {  
        console.warn("Usage limit reached for current token. Rotating...");  
        rotateToken();  
        if (typeof saveTokensToStorage === 'function') {  
          try { saveTokensToStorage(); } catch (e) {}  
        }  
        if (attempt <= effectiveMaxRetries) {  
          await sleep(500);  
          continue;  
        }  
        const limitError = new Error("USAGE_LIMIT_REACHED: You have reached your AI usage limit for this account/token.");  
        throw limitError;  
      }  
  
      if (!reasoningContent && content) {  
        const xmlTagsToCheck = ['think', 'thinking', 'reasoning'];  
        for (const tag of xmlTagsToCheck) {  
          const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);  
          const matches = content.match(regex);  
          if (matches) {  
            reasoningContent = matches[1].trim();  
            break;  
          }  
        }  
      }  
  
      if (reasoningContent) {  
        result.choices[0].message.reasoning_content = reasoningContent;  
      }  
  
      return result;  
    } catch (error) {  
      console.error(`generatePuterResponse Attempt ${attempt} Error:`, error);  
  
      if (error.message && error.message.includes('NO_FALLBACK_MODEL')) {  
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