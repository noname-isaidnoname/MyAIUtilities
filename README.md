# MyAIUtilities

A collection of reusable JavaScript utilities for integrating with the Puter.ai API. These utilities simplify both streaming and non-streaming AI interactions, with built-in error handling, retry logic, and tool use support.

## 🚀 Features

- **puterStream.js** - Real-time streaming helper with tool use support
- **puterRequest.js** - Non-streaming requests with retry logic and token rotation
- **puterResponse.js** - Shared normalization helpers for Puter's inconsistent response shapes
- **scrapeWeb.js** - Web scraping utilities for content extraction

## 📦 Installation

You can use these utilities in two ways:

### Local Usage
```bash
git clone https://github.com/noname-isaidnoname/MyAIUtilities.git
cd MyAIUtilities
```

### CDN Usage
```javascript
// Import directly from GitHub Pages
import { streamPuterCompletion } from 'https://noname-isaidnoname.github.io/MyAIUtilities/puterStream.js';
import { generatePuterResponse } from 'https://noname-isaidnoname.github.io/MyAIUtilities/puterRequest.js';
import { scrapeWeb, sampleFiles } from 'https://noname-isaidnoname.github.io/MyAIUtilities/scrapeWeb.js';
// puterResponse.js is imported by the two modules above automatically —
// you only import it yourself if you want the shared normalizers directly.
```

## 🔧 Usage Examples

### puterStream.js - Streaming AI Responses

Perfect for chat applications and real-time interfaces:

```javascript
import { streamPuterCompletion } from './puterStream.js';
// or if you're on another project, do this instead:
// import { streamPuterCompletion } from 'https://noname-isaidnoname.github.io/MyAIUtilities/puterStream.js';

const result = await streamPuterCompletion({
  requestBody: {
    interface: 'puter-chat-completion',
    driver: 'openai',
    method: 'complete',
    args: {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'What happened in the news today?' }],
      stream: true,
      tools: [{ type: 'web_search' }],  // Enable web search
    },
  },
  tools: [{ type: 'web_search' }],      // Alternatively, pass tools at top level
  onChunk: (chunk) => {
    console.log('Raw chunk:', chunk);
  },
  onToolUse: (toolUse) => {
    console.log('Tool called:', toolUse.name, toolUse.input);
    // Display tool usage in UI
  },
  onPartialUpdate: ({ accumulatedContent, accumulatedReasoning, accumulatedToolUses }) => {
    // Update your UI with streaming content
    // For example, you could update a textarea or div with the content
    // document.getElementById('output').value = accumulatedContent;
    console.log('Streaming:', accumulatedContent);
    if (accumulatedReasoning) {
      // You could also display the reasoning in a separate element
      // -- preferably a collapsible element
      // document.getElementById('reasoning').textContent = accumulatedReasoning;
      console.log('Thinking:', accumulatedReasoning);
    }
  },
  onComplete: (finalState) => {
    console.log('Complete:', finalState);
  },
  onError: (error) => {
    console.error('Stream error:', error);
  }
});
```

#### Web Search Capabilities

To find models with web search capabilities, visit:
`https://api.puter.com/puterai/chat/models/details`

Search for models that support web search functionality (look for models with "web_search" in their costs dictionary). To enable web search, include `tools: [{ type: 'web_search' }]` in your request. See above for an example.

### puterRequest.js - Non-Streaming with Retry Logic

Ideal for one-shot requests with automatic retry on failures:

```javascript
import { generatePuterResponse } from './puterRequest.js';
// or if you're on another project, do this instead:
// import { generatePuterResponse } from 'https://noname-isaidnoname.github.io/MyAIUtilities/puterRequest.js';

const result = await generatePuterResponse({
  url: 'https://api.puter.com/drivers/call',
  payload: {
    messages: [{ role: 'user', content: 'Explain quantum computing' }]
  },
  reqBody: {
    model: 'openai/gpt-4o'
  },
  getCurrentToken: () => 'your-puter-api-token',
  rotateToken: () => {
    // Switch to next available token
    // console.log('Rotating token...');
  },
  saveTokensToStorage: () => {
    // Persist token metadata
    localStorage.setItem('tokens', JSON.stringify(tokens));
  },
  effectiveMaxRetries: 3,
  showLoadingIndicator: (element, config, model, attempt) => {
    element.textContent = `Thinking... (Attempt ${attempt})`;
  }
});

console.log('AI Response:', result.choices[0].message.content);
```

### scrapeWeb.js - Web Scraping Utilities

Extract content from websites with intelligent crawling and filtering:

```javascript
import { scrapeWeb, sampleFiles } from './scrapeWeb.js';
// or if you're on another project, do this instead:
// import { scrapeWeb, sampleFiles } from 'https://noname-isaidnoname.github.io/MyAIUtilities/scrapeWeb.js';

const files = await scrapeWeb('https://example.com', {
  maxPages: 30,        // Maximum HTML pages to process
  maxFiles: 300,       // Absolute safety limit on total files
  maxDepth: 3,         // Maximum crawl depth
  concurrency: 6,      // Concurrent worker count
  onProgress: ({ current, maxPages, pages, filesCount, totalBytes }) => {
    console.log(`Progress: ${filesCount} files, ${pages} pages, ${Math.round(totalBytes/1024)}KB`);
  },
  onLog: (message) => {
    console.log('[Scraper]', message);
  },
  onFileFound: (fileEntry, stats) => {
    console.log(`Found: ${fileEntry.url} (${fileEntry.type}, ${fileEntry.size} bytes)`);
  }
});

// Sample files for AI context (limits size)
const sampled = sampleFiles(files, 32, 300); // 32KB per file, 300KB total
console.log(`Scraped ${files.length} files, sampled ${sampled.length} for AI`);
```

#### Key Features

- **Smart Filtering**: Automatically excludes libraries, bundles, and binary files
- **Concurrent Crawling**: Configurable worker pool for efficient scraping
- **Content Extraction**: Parses HTML links, CSS imports, and JS modules
- **Size Management**: Built-in sampling to manage content size for AI context
- **Progress Tracking**: Real-time callbacks for monitoring progress
- **Abort Support**: Cancellable operations with AbortController

#### Common Use Cases

```javascript
// Scrape a documentation site
const docs = await scrapeWeb('https://docs.example.com', {
  maxPages: 50,
  maxDepth: 4,
  onProgress: (stats) => updateUI(stats)
});

// Extract code samples from a tutorial
const tutorial = await scrapeWeb('https://tutorial.example.com', {
  maxPages: 10,
  onFileFound: (file) => {
    if (file.url.includes('/code/')) {
      processCodeSample(file.content);
    }
  }
});

// Create AI context from website content
const context = sampleFiles(files, 64, 1024); // Larger limits for AI
const aiPrompt = `Context from website:\n${context.map(f => 
  `--- ${f.url} ---\n${f.sample}`
).join('\n\n')}`;
```

## 🏗️ Architecture

### puterStream.js
- Handles newline-delimited JSON streaming (tolerates `data:` prefixes and `[DONE]`)
- Supports tool use (web search, function calls)
- Accumulates fragmented OpenAI `delta.tool_calls` per index; emits complete, parsed tool calls
- Falls back to NDJSON aggregation when a `stream: false` request is answered "streamed anyway"
- Provides callbacks for chunks, partial updates, and completion
- Automatic error detection and handling (errors carry a stable `code`)

### puterRequest.js
- Implements exponential backoff retry logic
- Automatic token rotation on auth failures
- Usage limit detection and handling
- Normalizes Puter's `{ success, result: { message } }` and OpenAI `{ choices: [...] }` shapes
- Tolerates NDJSON bodies on non-streaming requests
- Normalizes different response formats

### puterResponse.js
- Dependency-free normalizers shared by puterStream.js and puterRequest.js
- Extracts content/reasoning/message objects across every known Puter response shape
- Tool-call argument fragment accumulation and normalization
- No-fallback-model and usage-limit detection
- Inline `<think>` / `<thinking>` / `<reasoning>` tag extraction

### scrapeWeb.js
- Intelligent web crawling with concurrent workers
- Automatic library and bundle filtering
- Content extraction from HTML, CSS, and JavaScript
- Size management and sampling for AI context
- Progress tracking and abort support

## 🔧 API Reference

### streamPuterCompletion(options)

**Parameters:**
- `apiUrl` (string): Puter API endpoint (default: 'https://api.puter.com/drivers/call')
- `requestBody` (object): Request payload with interface, driver, method, and args
- `headers` (object): Additional HTTP headers
- `onChunk` (function): Callback for each raw chunk
- `onPartialUpdate` (function): Callback for accumulated content updates
- `onComplete` (function): Callback when streaming completes
- `onError` (function): Callback for errors
- `onToolUse` (function): Callback when AI uses tools
- `signal` (AbortSignal): Optional abort controller signal

**Returns:** Promise resolving to `{ accumulatedContent, accumulatedReasoning, accumulatedToolUses }`

**Tool call behavior:** Puter-native `{ type: 'tool_use' }` chunks fire `onToolUse` immediately. OpenAI-style `choices[0].delta.tool_calls` arrive in fragments; they are accumulated per `index` and emitted via `onToolUse` (and included in `accumulatedToolUses`) once the stream completes, with fully parsed `input` — never as unparseable partial JSON.

**Errors:** Errors passed to `onError` (and re-thrown) carry a stable `code`: `'NO_FALLBACK_MODEL'`, `'HTTP_ERROR'` (with `.status`), `'PARSE_ERROR'`, `'INVALID_ARGS'`.

### generatePuterResponse(options)

**Parameters:**
- `url` (string): API endpoint URL
- `payload` (object): Cleaned request arguments
- `reqBody` (object): Original request body with model info
- `getCurrentToken` (function): Returns current API token
- `rotateToken` (function): Rotates to next available token
- `saveTokensToStorage` (function): Persists token metadata
- `effectiveMaxRetries` (number): Number of retry attempts
- `showLoadingIndicator` (function): UI callback for loading state
- `modeConfig` (object): Optional mode configuration for loading indicator
- `documentOutputElement` (HTMLElement): Optional DOM element reference for loading indicator
- `signal` (AbortSignal): Optional abort controller signal
- `tools` (array): Array of tool definitions forwarded to the model. Supports:
  - Web search: `[{ type: 'web_search' }]`
  - OpenAI function tools: `[{ type: 'function', function: { name, description, parameters } }]`

**Returns:** Promise resolving to normalized Puter API response with an additional `toolCalls` array: `[{ id, name, input }, ...]`

**Errors:** Thrown errors carry a stable `code`: `'INVALID_ARGS'`, `'HTTP_ERROR'` (with `.status`), `'NO_FALLBACK_MODEL'`, `'USAGE_LIMIT_REACHED'`. The legacy message prefixes (`NO_FALLBACK_MODEL:`, `USAGE_LIMIT_REACHED:`) are kept for backwards compatibility.

### puterResponse.js (shared normalizers)

Imported automatically by `puterStream.js` and `puterRequest.js`; import it directly only if you want the helpers yourself.

- `normalizeAIContent(val)` - Coercion of string/array/object content into a single string
- `extractPuterContent(obj)` - Assistant text from any known response shape (incl. streaming `delta.content`)
- `extractPuterReasoning(obj)` - Reasoning/CoT text from any known response shape
- `extractPuterMessage(obj)` - The message object from `choices[0]` / `result` / bare shapes (synthesizes `obj.choices` when missing, as before)
- `extractInlineReasoning(content)` - Pulls `<think>` / `<thinking>` / `<reasoning>` tags out of content; returns `{ reasoning, cleaned }`
- `normalizeToolCalls(rawToolCalls)` - Flattens OpenAI tool_calls into `[{ id, name, input }]` with parsed arguments
- `createToolCallAccumulator()` - Buffers fragmented streamed `delta.tool_calls`; `push(deltas)` per chunk, `flush()` at the end
- `parseToolArguments(args)` - JSON.parse with a graceful fallback to the raw string/object
- `isNoFallbackModelError(value)` - Heuristic detection of Puter's "no fallback model available" error (accepts an object or raw string)
- `isUsageLimited(result, messageObj?, content?)` - Detects Puter's usage-limit signal
- `parseStreamLine(line)` - Parses one NDJSON line; tolerates `data:` prefixes and the `[DONE]` sentinel
- `makePuterError(code, message)` - Error factory with a stable `code` (keeps legacy message prefixes)

### scrapeWeb(startUrl, options)

**Parameters:**
- `startUrl` (string): Starting URL for crawl (must be same-origin)
- `options.maxPages` (number): Maximum HTML pages to process (default: 30)
- `options.maxFiles` (number): Absolute safety limit on total files (default: 300)
- `options.maxDepth` (number): Maximum crawl depth (default: 3)
- `options.concurrency` (number): Concurrent worker count (default: 6)
- `options.aborter` (AbortSignal): Signal to abort crawl
- `options.onProgress` (function): Progress callback ({current, maxPages, pages, filesCount, totalBytes})
- `options.onLog` (function): Log callback (message)
- `options.onFileFound` (function): File found callback (fileEntry, stats)

**Returns:** Promise resolving to Array of file entries: `[{url, type, size, content}, ...]`

### sampleFiles(files, maxKBPerFile, maxTotalKB)

**Parameters:**
- `files` (Array): Array of file entries from scrapeWeb
- `maxKBPerFile` (number): Maximum KB per file sample (default: 32)
- `maxTotalKB` (number): Maximum total KB for all samples (default: 600)

**Returns:** Promise resolving to Array of sampled file entries: `[{url, type, size, sample}, ...]`

### Utility Functions

- `isLibraryUrl(url)` - Checks if URL points to known library/bundle
- `isAllowedType(contentType, url)` - Determines if resource type is allowed
- `normalizeUrl(raw, base)` - Normalizes relative URLs to absolute
- `sameOrigin(url, origin)` - Checks if URL shares same origin
- `extractLinksFromHTML(html, baseUrl)` - Extracts URLs from HTML content
- `extractImportsFromCSS(css, baseUrl)` - Extracts URLs from CSS imports
- `extractImportsFromJS(js, baseUrl)` - Extracts URLs from JS imports

## 🛠️ Development

### Local Testing
```bash
# Serve the files locally (required for ES modules)
python -m http.server 8000
# or
npx http-server -p 8000
```

Open `http://localhost:8000` to view the landing page.

### File Structure
```
MyAIUtilities/
├── index.html          # Landing page
├── README.md           # This documentation
├── puterStream.js      # Streaming utility
├── puterRequest.js     # Non-streaming utility
├── puterResponse.js    # Shared Puter response normalizers
└── scrapeWeb.js        # Web scraping utility
```

## 📄 License

MIT License - feel free to use these utilities in your projects!

## 🔗 Related Projects

- [Puter.ai](https://puter.ai) - The AI platform these utilities integrate with

## 🆘 Support

If you encounter issues or have questions:

1. Review the API documentation in the source files
2. Open an issue on this repository

---
