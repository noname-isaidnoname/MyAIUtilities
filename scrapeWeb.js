/**
 * ScrapeWeb Utility Module/API
 * A modular crawler for extracting same-origin website content including modules.
 * Made reusable by design, so it integrates well with other projects.
 * 
 * Features:
 * - Concurrent crawling with configurable limits
 * - Automatic library/bundle detection and exclusion
 * - Support for HTML, CSS, and JavaScript import extraction
 * - Fallback fetching mechanism using Puter.js and native fetch
 * - Progress tracking and event callbacks
 * 
 * @module scrapeWeb
 */

/**
 * Determines if a URL points to a known library or bundle.
 * Used to exclude third-party dependencies from crawling.
 * 
 * Checks for:
 * - Library names in filename (e.g., 'react.js', 'bootstrap.min.css')
 * - Bundle indicators (minified, webpack, source maps)
 * - Common library directories (node_modules, vendors, dist)
 * 
 * @param {string} url - The URL to check
 * @returns {boolean} True if URL is identified as a library/bundle
 */
export function isLibraryUrl(url) {
  if (!url) return false;
  const u = url.split("?")[0].toLowerCase().replace(/\/$/, "");
  const pathParts = u.split('/');
  const fileName = pathParts.pop() || "";
  
  const libraryPatterns = [
    'tailwind', 'bootstrap', 'jquery', 'react', 'vue', 'lit', 'three', 
    'cannon', 'ammo', 'fontawesome', 'lucide', 'lodash', 'moment', 
    'chart.js', 'd3', 'pixi', 'phaser'
  ];
  
  const isExactLib = libraryPatterns.some(lib => {
      const parts = fileName.split('.');
      const base = parts[0];
      return base === lib && (parts.length <= 3);
  });
  
  const isBundle = /min\.(js|css)$|bundle\.js$|vendors~|webpack|\.map$/.test(fileName);
  const isLibFolder = pathParts.some(part => libraryPatterns.includes(part) || part === 'node_modules' || part === 'vendors' || part === 'dist');

  return isExactLib || isBundle || isLibFolder;
}

/**
 * Determines if a content type and URL combination represents an allowed resource type.
 * 
 * Allowed types include:
 * - HTML, CSS, JavaScript/TypeScript
 * - JSON, plain text, markdown
 * 
 * Excluded:
 * - Images, fonts, videos, audio, archives, maps
 * - Library URLs (via isLibraryUrl)
 * 
 * @param {string} ct - Content-Type header value
 * @param {string} url - Resource URL
 * @returns {boolean} True if resource type is allowed for crawling
 */
export const isAllowedType = (ct, url) => {
  const u = url.split("?")[0].toLowerCase();
  if (/\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf|mp4|webm|mp3|wav|ogg|pdf|zip|gz|map|tar|rar)$/.test(u)) return false;
  if (isLibraryUrl(url)) return false;

  return /(text\/html|text\/css|application\/javascript|text\/javascript|application\/json|text\/plain|application\/typescript)/.test(ct) ||
         /\.(html?|css|js|mjs|cjs|ts|tsx|json|md|txt)$/.test(u);
};

/**
 * Normalizes a URL by resolving relative paths and removing fragments.
 * 
 * @param {string} raw - Raw URL (can be relative)
 * @param {string} base - Base URL for resolution
 * @returns {string|null} Normalized absolute URL, or null if invalid
 */
export function normalizeUrl(raw, base) {
  try { 
    const u = new URL(raw, base);
    u.hash = ''; // Strip fragments to avoid treating index.html#a and index.html#b as different pages
    return u.toString(); 
  } catch { 
    return null; 
  }
}

/**
 * Checks if a URL shares the same origin as the specified origin.
 * 
 * @param {string} u - URL to check
 * @param {string} origin - Origin to compare against (e.g., 'https://example.com')
 * @returns {boolean} True if same origin
 */
export function sameOrigin(u, origin) {
  try { return new URL(u).origin === origin; } catch { return false; }
}

/**
 * Fetches text content from a URL using the browser fetch API.
 * Respects an optional AbortSignal and returns { text, ct, size }.
 *
 * @param {string} u - URL to fetch
 * @param {AbortSignal|null} aborter - Optional abort signal for cancellation
 * @returns {Promise<{text: string, ct: string, size: number}>}
 * @throws {Error} If the fetch fails or returns a non-OK status
 */
export async function fetchText(u, aborter) {
  console.log(`[Scraper] Fetching: ${u}`);
  try {
    const fetchOptions = {
      mode: "cors",
      redirect: "follow",
      headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    };
    if (aborter?.signal) fetchOptions.signal = aborter.signal;

    const res = await fetch(u, fetchOptions);
    console.log(`[Scraper] fetch response for ${u}: status=${res.status} ok=${res.ok}`);
    if (!res.ok) {
      // Provide a helpful message for common access issues
      const statusText = res.statusText || String(res.status);
      throw new Error(`HTTP ${res.status} ${statusText}`);
    }

    const ct = res.headers.get("content-type") || "";
    const text = await res.text();

    // Detect common host-level blocks in small responses
    if (text.length < 2000) {
      const lowerText = text.toLowerCase();
      if (/(forbidden|access denied|restricted|403 forbidden|error 1020|cloudflare)/.test(lowerText)) {
        throw new Error(`Forbidden: Access restricted by host.`);
      }
    }

    return { text, ct, size: text.length };
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new Error(`Fetch failed: ${err.message}`);
  }
}

/**
 * Extracts all absolute URLs from HTML content.
 * 
 * @param {string} html - HTML content to parse
 * @param {string} baseUrl - Base URL for resolving relative links
 * @returns {string[]} Array of absolute URLs
 */
export function extractLinksFromHTML(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const urls = new Set();
  const push = (u) => { 
    const n = normalizeUrl(u, baseUrl); 
    if (n) urls.add(n); 
  };
  
  doc.querySelectorAll("a[href]").forEach(a => push(a.getAttribute("href")));
  doc.querySelectorAll('link[rel="stylesheet"][href]').forEach(l => push(l.getAttribute("href")));
  doc.querySelectorAll('script[src], script[type="module"][src]').forEach(s => push(s.getAttribute("src")));
  
  doc.querySelectorAll('link[rel~="preload"][as], link[rel~="prefetch"][as]').forEach(l => {
    const as = l.getAttribute("as");
    if (as === 'script' || as === 'style' || as === 'fetch') push(l.getAttribute("href"));
  });
  
  return Array.from(urls);
}

/**
 * Extracts URLs from CSS @import and url() directives.
 * 
 * @param {string} cssText - CSS content to parse
 * @param {string} baseUrl - Base URL for resolution
 * @returns {string[]} Array of absolute URLs
 */
export function extractImportsFromCSS(cssText, baseUrl) {
  const urls = new Set();
  const importRe = /@import\s+(?:url\()?['"]?([^'")\s]+)['"]?\)?/gi;
  const urlRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  
  let m;
  while ((m = importRe.exec(cssText))) {
    try { urls.add(new URL(m[1], baseUrl).toString()); } catch {}
  }
  while ((m = urlRe.exec(cssText))) {
    const raw = m[1];
    if (raw.startsWith('data:') || raw.startsWith('http')) continue;
    try { urls.add(new URL(raw, baseUrl).toString()); } catch {}
  }
  return Array.from(urls);
}

/**
 * Extracts import/require URLs from JavaScript/TypeScript.
 * 
 * @param {string} jsText - JS/TS content to parse
 * @param {string} baseUrl - Base URL for resolution
 * @returns {string[]} Array of absolute URLs
 */
export function extractImportsFromJS(jsText, baseUrl) {
  const urls = new Set();
  const importRe = /(?:import|export)(?:\s+[^'"`]+?\s+from|\s*)\s*['"`](.*?)['"`]/g;
  const dynamicRe = /(?:import|require)\s*\(\s*['"`](.*?)['"`]\s*\)/g;
  
  const push = (raw) => {
    try {
      urls.add(new URL(raw, baseUrl).toString());
    } catch {}
  };
  
  let m;
  while ((m = importRe.exec(jsText))) push(m[1]);
  while ((m = dynamicRe.exec(jsText))) push(m[1]);
  
  return Array.from(urls);
}

/**
 * Main crawl engine for extracting same-origin website content.
 * 
 * Crawling behavior:
 * - Starts from startUrl and follows same-origin links
 * - Extracts imports from HTML, CSS, and JS files
 * - Respects depth limit and concurrency settings
 * - Automatically excludes library/bundle files
 * - Collects file metadata (URL, type, size, content)
 * 
 * @param {string} startUrl - Starting URL for crawl (must be same-origin)
 * @param {Object} options - Configuration options
 * @param {number} [options.maxPages=30] - Maximum HTML pages to process
 * @param {number} [options.maxFiles=300] - Absolute safety limit on total files
 * @param {number} [options.maxDepth=3] - Maximum crawl depth
 * @param {number} [options.concurrency=6] - Concurrent worker count
 * @param {AbortSignal} [options.aborter] - Signal to abort crawl
 * @param {function} [options.onProgress] - Progress callback ({current, maxPages, pages, filesCount, totalBytes})
 * @param {function} [options.onLog] - Log callback (message)
 * @param {function} [options.onFileFound] - File found callback (fileEntry, stats)
 * @returns {Promise<Array<{url: string, type: string, size: number, content: string}>>} Array of file entries
 */
export async function scrapeWeb(startUrl, options = {}) {
  const {
    maxPages = 30,
    maxFiles = 300, // Absolute safety limit
    maxDepth = 3,
    concurrency = 6,
    aborter = null,
    onProgress = () => {},
    onLog = () => {},
    onFileFound = () => {}
  } = options;

  const origin = new URL(startUrl).origin;
  const visitedUrls = new Set([startUrl]);
  const files = [];
  
  let pagesCount = 0;
  let totalBytes = 0;
  let activeWorkers = 0;

  const queue = [{ url: startUrl, depth: 0 }];

  const enq = (u, d) => {
    if (!u || d > maxDepth || !sameOrigin(u, origin) || isLibraryUrl(u) || visitedUrls.has(u)) return;
    if (visitedUrls.size >= maxFiles) return; // Prevent OOM
    
    visitedUrls.add(u);
    queue.push({ url: u, depth: d });
  };

  const processUrl = async (url, depth) => {
    onLog(`GET ${url}`);
    const { text, ct, size } = await fetchText(url, aborter);
    const typeHint = (ct.split(";")[0] || "").trim();
    const fileEntry = { url, type: typeHint, size, content: text };
    const discovered = [];
    let isHtml = false;

    if (/text\/html/.test(ct) || /\.html?$/i.test(url)) {
      isHtml = true;
      extractLinksFromHTML(text, url).forEach(l => {
        discovered.push({ url: l, depth: depth + 1 });
      });
    } else if (/text\/css/.test(ct) || /\.css$/i.test(url)) {
      extractImportsFromCSS(text, url).forEach(i => discovered.push({ url: i, depth: depth + 1 }));
    } else if (/(application|text)\/(javascript|typescript|ecmascript)/.test(ct) || /\.(mjs|js|ts|tsx|jsx)$/i.test(url)) {
      extractImportsFromJS(text, url).forEach(i => discovered.push({ url: i, depth: depth + 1 }));
    }

    return { fileEntry, discovered, isHtml };
  };

  const worker = async () => {
    while (true) {
      if (aborter?.signal.aborted) return;
      
      const item = queue.shift();
      
      if (!item) {
        if (activeWorkers === 0) return; 
        await new Promise(r => setTimeout(r, 20));
        continue;
      }

      const isLikelyAsset = /\.(css|js|mjs|cjs|ts|tsx|json|xml|txt|ico|png|jpe?g|gif|svg|woff2?)$/i.test(item.url.split('?')[0]);
      if (!isLikelyAsset && pagesCount >= maxPages) {
          continue;
      }

      activeWorkers++;
      try {
        const { fileEntry, discovered, isHtml } = await processUrl(item.url, item.depth);
        
        files.push(fileEntry);
        totalBytes += fileEntry.size;
        if (isHtml) pagesCount++;
        
        onFileFound(fileEntry, { pages: pagesCount, totalBytes, visitedCount: visitedUrls.size });
        discovered.forEach(({ url, depth }) => enq(url, depth));
        
        onProgress({ current: visitedUrls.size, maxPages, pages: pagesCount, filesCount: files.length, totalBytes });
      } catch (e) {
        onLog(`ERR ${item.url} → ${e.message}`);
      } finally {
        activeWorkers--;
      }
    }
  };

  await Promise.all(Array(concurrency).fill(0).map(() => worker()));
  return files;
}

/**
 * Creates a sampled subset of scraped files with size constraints.
 * 
 * @param {Array<{url: string, type: string, size: number, content: string}>} files - Array of file entries
 * @param {number} [maxKBPerFile=32] - Maximum KB per file sample (default: 32)
 * @param {number} [maxTotalKB=600] - Maximum total KB for all samples (default: 600)
 * @returns {Array<{url: string, type: string, size: number, sample: string}>} Sampled file entries
 */
export function sampleFiles(files, maxKBPerFile = 32, maxTotalKB = 600) {
  const maxBytesPerFile = maxKBPerFile * 1024;
  const maxTotalBytes = maxTotalKB * 1024;
  const picked = [];
  let acc = 0;
  for (const f of files) {
    if (!isAllowedType(f.type || "", f.url)) continue;
    const chunk = (f.content || "").slice(0, maxBytesPerFile);
    const entry = {
      url: f.url,
      type: f.type || "unknown",
      size: f.size,
      sample: chunk,
    };
    picked.push(entry);
    acc += chunk.length;
    if (acc >= maxTotalBytes) break;
  }
  return picked;
}
