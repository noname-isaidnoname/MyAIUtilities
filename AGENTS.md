# AGENTS.md

Plain-JS ES modules for the Puter.ai API, served statically (GitHub Pages / CDN). No package.json, build, lint, test, or CI — do not invent npm scripts.

## Repo layout
- `puterStream.js` — streaming helper (`streamPuterCompletion`), newline-delimited JSON over fetch.
- `puterRequest.js` — non-streaming (`generatePuterResponse`) with retry/backoff and token rotation.
- `puterResponse.js` — shared, pure normalizers for Puter's inconsistent response shapes (content/reasoning extraction, tool-call fragment accumulation, no-fallback/usage-limit detection). Imported by both modules above; keep it dependency-free and free of fetch/DOM so it stays unit-testable in Node.
- `scrapeWeb.js` — same-origin web crawler (`scrapeWeb`, `sampleFiles`, plus `isLibraryUrl`, `extractLinksFromHTML`, etc.).
- `index.html` — self-contained demo/landing page; loads the modules via `<script type="module">` inline.
- `README.md` — the docs; keep it in sync when changing exports or options.

## Constraints
- Browser-first ES modules, no dependencies, no bundler. Files are imported directly by URL (e.g. `https://noname-isaidnoname.github.io/MyAIUtilities/puterStream.js`), so **named exports and file paths are the public API** — do not rename/remove exports or files without updating README + index.html.
- No Node entrypoints; utilities rely on browser globals (fetch, localStorage via caller callbacks, DOM via optional args).
- scrapeWeb is same-origin only by design; don't "fix" that.
- Tools merge behavior in streamPuterCompletion: explicit `tools` param wins over `requestBody.args.tools`.
- NEVER use subagents UNLESS the user asks you to use them (whether explicitly at the start of the task or mid-task, user message containing `@explore` or `@general` count as explicit ask).

## Verifying changes
- No automated tests. Serve locally and check the demo page: `python -m http.server 8000` → http://localhost:8000 (ES modules won't load from file://).
- Full API calls hit `https://api.puter.com` and need a Puter token; without one you can only verify syntax/imports (`node --check <file>.js` works) or use the browser console.
- README's sample outputs and option defaults (maxPages 30, maxFiles 300, maxDepth 3, concurrency 6, sampleFiles 32KB/600KB) reflect actual defaults in source — check the source, not just the README, when changing them.
