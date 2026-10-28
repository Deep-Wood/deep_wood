// DeepWood — Privy embedded wallet (email OTP) connection.
//
// Built on @privy-io/js-sdk-core, the low-level vanilla SDK documented at
// https://docs.privy.io/recipes/core-js. There is NO built-in login modal:
// the game renders its own email dialog (see index.html) and drives this
// module. Key material lives in a hidden secure-context iframe that we
// mount and wire up below.
//
// Env: VITE_PRIVY_APP_ID (required — public client ID, ships in the bundle
// by design). VITE_PRIVY_CLIENT_ID is optional extra config.
//
// Result shape matches wallet.js: { ok: true, ... } / { ok: false, code, reason }.

import Privy, {
  LocalStorage,
  getUserEmbeddedEthereumWallet,
  getEntropyDetailsFromUser,
} from '@privy-io/js-sdk-core';

let privy = null;        // single client instance (SDK requirement)
let initPromise = null;   // in-flight initialize()
let secureIframe = null;  // hidden secure-context iframe
let messageListener = null;

function resolveAppId() {
  // Vite injects import.meta.env at build time; VITE_PRIVY_APP_ID is baked
  // into the bundle from .env.production / the build environment.
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_PRIVY_APP_ID) {
    return import.meta.env.VITE_PRIVY_APP_ID;
  }
  if (typeof process !== 'undefined' && process.env?.VITE_PRIVY_APP_ID) {
    return process.env.VITE_PRIVY_APP_ID; // Node test fallback
  }
  return null;
}

/**
 * Create + initialize the single Privy client. Idempotent; safe to await
 * from multiple call sites concurrently. Returns the client or null when
 * the app ID is missing / the backend is unreachable.
 */
async function initPrivy() {
  if (privy) return privy;
  if (initPromise) return initPromise;

  const appId = resolveAppId();
  if (!appId) {
    console.warn('[Privy] VITE_PRIVY_APP_ID not set — email login will not work');
    return null;
  }

  initPromise = (async () => {
    const config = { appId, storage: new LocalStorage() };
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_PRIVY_CLIENT_ID) {
      config.clientId = import.meta.env.VITE_PRIVY_CLIENT_ID;
    }
    const client = new Privy(config);
    // Establishes the backend connection and restores any stored session.
    await client.initialize();
    privy = client;
    return client;
  })().catch((err) => {
    console.error('[Privy] Initialization failed:', err);
    initPromise = null; // allow retry on a later click
    return null;
  });
  return initPromise;
}

/**
 * Mount the secure-context iframe that holds embedded-wallet key material,
 * and wire bidirectional message passing (per the core-js recipe).
 */
function mountSecureContext(client) {
  if (secureIframe) return;
  secureIframe = document.createElement('iframe');
  secureIframe.src = client.embeddedWallet.getURL();
  secureIframe.style.display = 'none';
  secureIframe.setAttribute('aria-hidden', 'true');
  secureIframe.setAttribute('tabindex', '-1');
  secureIframe.title = 'Privy secure context';
  document.body.appendChild(secureIframe);

  // Client -> iframe.
  client.setMessagePoster(secureIframe.contentWindow);
  // Iframe -> client.
  messageListener = (e) => {
    if (e.source !== secureIframe.contentWindow) return;
    let data = e.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { return; }
    }
    client.embeddedWallet.onMessage(data);
  };
  window.addEventListener('message', messageListener);
}

/**
 * Step 1 of login: send the 6-digit code to an email address.
 * The game's dialog collects the address; this fires the Privy API call.
 */
export async function sendPrivyEmailCode(email) {
  const client = await initPrivy();
  if (!client) {
    return { ok: false, code: 'not-configured', reason: 'Privy not configured (missing App ID)' };
  }
  try {
    mountSecureContext(client);
    await client.auth.email.sendCode(email);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'send-failed', reason: String(err?.message || err) };
  }
}

/**
 * Step 2 of login: verify the OTP. On success, provisions (or restores)
 * the embedded wallet and returns an EIP-1193 provider that plugs straight
 * into wallet.js connect({ provider }).
 */
export async function loginPrivyWithCode(email, code) {
  const client = await initPrivy();
  if (!client) {
    return { ok: false, code: 'not-configured', reason: 'Privy not configured (missing App ID)' };
  }
  try {
    const session = await client.auth.email.loginWithCode(email, code);
    const user = session?.user || null;
    if (!user) {
      return { ok: false, code: 'login-failed', reason: 'Privy returned no user' };
    }

    mountSecureContext(client);
    const wallet = getUserEmbeddedEthereumWallet(user);
    if (!wallet) {
      return { ok: false, code: 'no-wallet', reason: 'No embedded wallet on this account' };
    }
    const { entropyId, entropyIdVerifier } = getEntropyDetailsFromUser(user);
    const provider = await client.embeddedWallet.getEthereumProvider({
      wallet,
      entropyId,
      entropyIdVerifier,
    });
    if (!provider || typeof provider.request !== 'function') {
      return { ok: false, code: 'no-provider', reason: 'Privy did not return a valid EIP-1193 provider' };
    }

    const accounts = await provider.request({ method: 'eth_accounts' });
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return { ok: false, code: 'no-accounts', reason: 'Embedded wallet returned no accounts' };
    }
    const chainIdHex = await provider.request({ method: 'eth_chainId' });
    return {
      ok: true,
      provider,
      account: accounts[0],
      chainId: Number(BigInt(chainIdHex)),
      email: user.email?.address || null,
    };
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes('User rejected') || msg.includes('cancelled') || msg.includes('dismissed')) {
      return { ok: false, code: 'rejected', reason: 'Privy login rejected' };
    }
    if (msg.toLowerCase().includes('incorrect') || msg.toLowerCase().includes('invalid code')) {
      return { ok: false, code: 'bad-code', reason: 'That code did not match. Check the email and try again.' };
    }
    return { ok: false, code: 'provider-error', reason: `Privy connect failed: ${msg}` };
  }
}

/**
 * Returning-user check for a future boot path: resolves the user if a valid
 * Privy session is already stored, else null. Does not open any UI.
 */
export async function getPrivySession() {
  const client = await initPrivy();
  if (!client) return null;
  try {
    const { user } = await client.user.get();
    return user || null;
  } catch {
    return null;
  }
}

/**
 * End the Privy session (called from the wallet-menu Disconnect item).
 * Fire-and-forget by design: wallet.js owns the on-chain disconnect; this
 * only clears the Privy auth session so the next connect re-prompts.
 */
export async function disconnectPrivy() {
  if (!privy) return { ok: true, note: 'no privy session' };
  try {
    const { user } = await privy.user.get();
    if (user) await privy.auth.logout({ userId: user.id });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

/**
 * Reset module state (for tests).
 */
export function resetPrivy() {
  privy = null;
  initPromise = null;
}
