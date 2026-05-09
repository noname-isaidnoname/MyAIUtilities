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
*/
export async function generatePuterResponse({
  url = 'https://api.puter.com/drivers/call',
  payload,
  reqBody,
  getCurrentToken,
  rotateToken,
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

  // small helper for backoff
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // Normalize helper to join string parts if needed
  const normalizeAIContent = (val) => {
    if (Array.isArray(val)) {
      return val.map(part => (typeof part === 'string' ? part : (part.text || ''))).join('');
    }
    return typeof val === 'string' ? val : '';
  };

  for (let attempt = 1; attempt <= effectiveMaxRetries + 1; attempt++) {
    try {
      // Optionally update UI loading indicator
      if (showLoadingIndicator && documentOutputElement && modeConfig) {
        try {
          // Best-effort; caller may pass nulls
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
          "args": {
            "messages": payload.messages,
            "model": reqBody.model,
            "stream": false
          }
        }),
        signal
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        let errorObj = {};
        try { errorObj = JSON.parse(errorText); } catch (e) { errorObj = { details: { error: { message: errorText || `HTTP error ${resp.status}` } } }; }

        // Handle auth/permission errors by rotating token
        if (resp.status === 403 || resp.status === 401) {
          console.error(`HTTP ${resp.status} error: ${errorText}`);
          rotateToken();
          // If tokens persisted, attempt to save metadata
          if (typeof saveTokensToStorage === 'function') {
            try { saveTokensToStorage(); } catch (e) {}
          }
          // Allow retry loop to continue (will re-run with rotated token)
          if (attempt <= effectiveMaxRetries) {
            await sleep(300 * Math.pow(2, attempt - 1));
            continue;
          } else {
            throw new Error(`API ${resp.status} error: ${errorText}`);
          }
        }

        // Non-auth HTTP error -> either retry or throw
        const err = new Error(`Puter.com request failed: HTTP ${resp.status} ${errorObj.details?.error?.message || errorText || 'Unknown error'}`);
        throw err;
      }

      const result = await resp.json();
      console.log(`AI Response (Puter): ${JSON.stringify(result)}`);

      // Check for no fallback model available error with structural validation
      const resultStr = JSON.stringify(result);
      if (resultStr.includes('no fallback model available')) {
        // More robust check: verify this is actually an error response, not generated content
        const isActualError = (
          // Check if it's the exact error structure from Puter API
          (result.success === false && result.error === 'no fallback model available') ||
          // Check if the string appears at the end of the response (typical for error responses)
          (resultStr.endsWith('"no fallback model available"}') || resultStr.endsWith('"no fallback model available"}]')) ||
          // Check if it's a minimal error response structure
          (Object.keys(result).length <= 3 && !result.choices && !result.result)
        );
        
        if (isActualError) {
          throw new Error('NO_FALLBACK_MODEL: No fallback model available. Please try a different model or check your API configuration.');
        }
      }

      // Normalize nested shapes
      const messageObj = result.choices?.[0]?.message || result.result?.message;
      if (!messageObj) {
        throw new Error("AI response did not contain a valid message object.");
      }

      if (!result.choices) result.choices = [{ message: messageObj }];

      let content = normalizeAIContent(messageObj.content);
      let reasoningContent = normalizeAIContent(messageObj.reasoning_content || messageObj.reasoning);

      // Detect usage-limited semantics and rotate if found
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

      // Try to extract reasoning if present inside content tags
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

      // Attach reasoning if found
      if (reasoningContent) {
        result.choices[0].message.reasoning_content = reasoningContent;
      }

      // Final success
      return result;
    } catch (error) {
      console.error(`generatePuterResponse Attempt ${attempt} Error:`, error);
      
      // Don't retry for no fallback model errors
      if (error.message && error.message.includes('NO_FALLBACK_MODEL')) {
        throw error;
      }
      
      if (attempt === effectiveMaxRetries + 1) {
        throw error;
      }
      // exponential backoff
      await sleep(300 * Math.pow(2, attempt - 1));
    }
  }

  throw new Error('Unreachable: exhausted retries without returning or throwing.');
}