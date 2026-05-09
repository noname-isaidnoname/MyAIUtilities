/**
 * Token creation utility for Puter.ai authentication.
 * Provides a multi-strategy approach to create/obtain Puter auth tokens:
 *   1. (optional) Quick temp account via REST API (no popup)
 *   2. Puter SDK sign-in with temp user creation attempt
 *   3. Standard Puter SDK sign-in popup (fallback)
 *
 * Usage:
 *   import { createNewToken } from './puterToken.js';
 *   // or if you're on another project, do this instead:
 *   // import { createNewToken } from 'https://noname-isaidnoname.github.io/MyAIUtilities/puterToken.js';
 *
 *   createNewToken(
 *     (result) => { console.log('Token:', result.token); },
 *     (error) => { console.error('Failed:', error); },
 *     true,
 *     (data) => { console.log('Temp account created:', data.user); },
 *     { // options // }
 *   );
 */

/**
 * Creates a temporary account on Puter via REST API (no popup required).
 * This is the fastest path — the server auto-generates an account.
 *
 * @returns {Promise<{token: string, user: object}>}
 * @throws {Error} If the request fails or response lacks a token.
 */
async function createTempAccount() {
  const res = await fetch('https://api.puter.com/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_temp: true }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error?.message || `Temp account creation failed: HTTP ${res.status}`);
  }

  if (!data.token) {
    if (data.user?.token) {
      return { token: data.user.token, user: data.user };
    }
    throw new Error('Temp account response did not contain a token');
  }

  return data; // { token, user: { username, uuid, ... } }
}

/**
 * Dynamically loads the Puter JavaScript SDK from the specified URL.
 * Resolves with the `puter` global object once the script has loaded.
 *
 * @param {string} sdkUrl - URL of the Puter SDK script.
 * @returns {Promise<object>} The `puter` global object.
 */
async function loadPuterLibrary(sdkUrl = 'https://js.puter.com/v2/') {
  // Already loaded?
  if (window.puter) {
    return window.puter;
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = sdkUrl;
    script.id = 'puter-sdk';
    script.async = true;

    script.onload = () => {
      if (window.puter) {
        resolve(window.puter);
      } else {
        reject(new Error('Puter SDK loaded but `puter` object is not available'));
      }
    };

    script.onerror = () => {
      reject(new Error('Failed to load Puter SDK script'));
    };

    document.head.appendChild(script);
  });
}

/**
 * Removes the dynamically added Puter SDK script tag from the DOM.
 */
function unloadPuterLibrary() {
  const script = document.getElementById('puter-sdk');
  if (script) {
    script.remove();
  }
}

/**
 * Attempts to create a new Puter auth token using a multi-strategy approach.
 *
 * Strategy order:
 *   1. Quick temp account via REST API (only if `shouldTryTempCreation === true`).
 *      If successful, fires `onTempCreation(data)` and returns early.
 *   2. Puter SDK popup with `attempt_temp_user_creation: true`.
 *      If successful, fires `onSuccess(result)` and returns.
 *   3. Standard Puter SDK sign-in popup (fallback).
 *      Fires `onSuccess(result)` on success or `onError(error)` on failure.
 *
 * @param {function} onSuccess - Callback with the sign-in result object
 *        `{ token, username, ... }` when a token is obtained via the SDK.
 * @param {function} onError   - Callback with an `Error` when all strategies fail.
 * @param {boolean}  shouldTryTempCreation - Whether to attempt the REST temp account first.
 * @param {function} onTempCreation - Callback with the temp account data
 *        `{ token, user }` when REST temp creation succeeds.
 * @param {object}   [options={}] - Optional overrides:
 *        { signupUrl, puterSdkUrl }
 */
export async function createNewToken(
  onSuccess,
  onError,
  shouldTryTempCreation,
  onTempCreation,
  options = {}
) {
  const { puterSdkUrl } = options;

  // ── 1. Temp account via REST API (no popup) ──────────────────────────────
  if (shouldTryTempCreation) {
    try {
      const data = await createTempAccount();
      // Success — fire the temp-creation callback and return early
      if (typeof onTempCreation === 'function') {
        onTempCreation(data);
      }
      return;
    } catch (tempErr) {
      // Temp creation failed — fall through to SDK strategy
      console.warn('Temp account creation failed, falling back to SDK:', tempErr.message);
    }
  }

  let puter;

  // ── 2. Load Puter SDK ────────────────────────────────────────────────────
  try {
    puter = await loadPuterLibrary(puterSdkUrl);
  } catch (loadErr) {
    if (typeof onError === 'function') {
      onError(loadErr);
    }
    return;
  }

  try {
    // ── 3. SDK sign-in with temp user creation attempt ─────────────────────
    const result = await puter.auth.signIn({
      attempt_temp_user_creation: true,
    });

    if (result && result.token) {
      if (typeof onSuccess === 'function') {
        onSuccess(result);
      }
      return;
    }
  } catch (sdkErr) {
    // SDK temp attempt failed — fall through to standard popup
    console.warn('Puter SDK sign-in (with temp) failed, trying standard popup:', sdkErr.message);
  }

  try {
    // ── 4. Standard sign-in popup (fallback) ──────────────────────────────
    const result = await puter.auth.signIn();

    if (result && result.token) {
      if (typeof onSuccess === 'function') {
        onSuccess(result);
      }
    } else {
      throw new Error('Sign-in completed but no token was returned');
    }
  } catch (finalErr) {
    if (typeof onError === 'function') {
      onError(finalErr);
    }
  } finally {
    unloadPuterLibrary();
  }
}