# MyAIUtilities

A collection of reusable JavaScript utilities for integrating with the Puter.ai API. These utilities simplify both streaming and non-streaming AI interactions, with built-in error handling, retry logic, and tool use support.

## 🚀 Features

- **puterStream.js** - Real-time streaming helper with tool use support
- **puterRequest.js** - Non-streaming requests with retry logic and token rotation
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

## 🏗️ Architecture

### puterStream.js
- Handles newline-delimited JSON streaming
- Supports tool use (web search, function calls)
- Provides callbacks for chunks, partial updates, and completion
- Automatic error detection and handling

### puterRequest.js
- Implements exponential backoff retry logic
- Automatic token rotation on auth failures
- Usage limit detection and handling
- Normalizes different response formats

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
- `signal` (AbortSignal): Optional abort controller signal

**Returns:** Promise resolving to normalized Puter API response

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
