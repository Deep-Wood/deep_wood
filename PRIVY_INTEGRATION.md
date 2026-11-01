# DeepWood — Privy Embedded Wallet Integration

## Overview

DeepWood uses **@privy-io/js-sdk-core** (v0.79.1), the low-level vanilla Privy SDK — NOT @privy-io/react-auth and NOT wagmi. There is no built-in login modal; the game renders its own email dialog in `index.html` and drives Privy through `src/privy.js`.

The EIP-1193 provider returned by Privy plugs directly into `src/wallet.js`'s `connect({ provider })`, which then handles chain switching, transaction signing, and state listeners.

---

## Files

| File | Purpose |
|---|---|
| `src/privy.js` | Privy client init, email OTP login, embedded wallet provider, chain switch |
| `src/wallet.js` | EIP-1193 connect/switch/send, shared by all wallet types |
| `index.html` | UI wiring: email dialog, OTP verify, connect button, boot-restore |
| `src/onchain.js` | `walletBalanceWeiOnchain()` — live balance read |

---

## src/privy.js — full integration

js
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
import { defineChain } from 'viem';

// Client-side chain definition so the EmbeddedWalletProvider knows about
// 46630 even before/without a dashboard sync. Still add the same chain in
// the Privy dashboard (custom network) for full compatibility.
export const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Explorer', url: 'https://explorer.testnet.chain.robinhood.com' },
  },
  testnet: true,
});

const GAME_CHAIN_ID = 46630;

let privy = null;        // single client instance (SDK requirement)
let initPromise = null;   // in-flight initialize()
let secureIframe = null;  // hidden secure-context iframe
let messageListener = null;
let privyProvider = null; // the EIP-1193 provider from the last successful login, used for switchChain
let privyWallet = null;   // the LinkedAccountEthereumEmbeddedWallet from the last login
let privyEntropy = null;  // { entropyId, entropyIdVerifier } from the last login

function resolveAppId() {
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_PRIVY_APP_ID) {
    return import.meta.env.VITE_PRIVY_APP_ID;
  }
  if (typeof process !== 'undefined' && process.env?.VITE_PRIVY_APP_ID) {
    return process.env.VITE_PRIVY_APP_ID;
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
    const config = {
      appId,
      storage: new LocalStorage(),
      // Critical: give the embedded wallet provider the chain definition
      // so wallet_switchEthereumChain(46630) does not fail with 4901.
      supportedChains: [robinhoodTestnet],
    };
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_PRIVY_CLIENT_ID) {
      config.clientId = import.meta.env.VITE_PRIVY_CLIENT_ID;
    }
    // Auto-create embedded wallets for users who don't have one yet,
    // so getEthereumProvider() always has a wallet to work with.
    config.embeddedWallets = { ethereum: { createOnLogin: 'users-without-wallets' } };
    const client = new Privy(config);
    // Establishes the backend connection and restores any stored session.
    // This also fetches the app's supported chains from the Privy backend —
    // if you add Robinhood Testnet (46630) to the dashboard AFTER this call,
    // the chain won't be fully visible until you call reinitialize().
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
 * Re-initialize the Privy client so it picks up chain configuration changes
 * made in the Privy dashboard (e.g. adding Robinhood Testnet 46630 to
 * supported chains). The client caches chains from initialize(), so a
 * dashboard change made after the first login won't be visible to the
 * existing provider until we re-initialize.
 *
 * Call this before loginPrivyWithCode() or restorePrivyProvider() when
 * the chain switch fails with "Unsupported chainId".
 */
export async function reinitialize() {
  privy = null;
  initPromise = null;
  return initPrivy();
}

/**
 * Return the stored Privy EIP-1193 provider from the last login, or null.
 * wallet.js's connect() uses this directly.
 */
export function getStoredPrivyProvider() {
  return privyProvider;
}

/**
 * Switch the Privy embedded wallet to a chain by calling
 * wallet_switchEthereumChain on the stored provider. This updates Privy's
 * internal _chainId so subsequent transactions are signed on the right
 * chain — the vanilla-SDK equivalent of wallet.switchChain(chainId) from
 * @privy-io/react-auth.
 *
 * Returns { ok: true } or { ok: false, code, reason }.
 */
export async function switchChain(chainId) {
  const p = privyProvider;
  if (!p || typeof p.request !== "function") {
    return { ok: false, code: "no-provider", reason: "no Privy provider stored — log in first" };
  }
  const target = "0x" + Number(chainId).toString(16);
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: target }] });

    // Verify the provider actually updated its internal chain
    const currentHex = await p.request({ method: "eth_chainId" });
    const current = Number(BigInt(currentHex));
    if (current !== Number(chainId)) {
      return {
        ok: false,
        code: "switch-failed",
        reason: `switch reported success but eth_chainId is still ${current}`,
      };
    }

    return { ok: true, chainId: current };
  } catch (e) {
    const code = e?.code;
    // 4901 = "Unsupported chainId" from Privy's EmbeddedWalletProvider — the
    // chain is not in the provider's _chains (dashboard config not yet
    // picked up or missing from supportedChains). Treat it like chain-unknown
    // so callers can re-init.
    if (code === 4901 || code === 4902) {
      return { ok: false, code: "chain-unknown", reason: `chain ${chainId} not in Privy's supported chains — re-initialize and retry` };
    }
    if (code === 4001) return { ok: false, code: "rejected", reason: "chain switch rejected in the wallet" };
    return { ok: false, code: "provider-error", reason: String(e?.message || e) };
  }
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
 *
 * After a successful login we store the provider, wallet, and entropy so
 * that switchChain() can use the provider later. We also immediately switch
 * to the game chain (46630) so the wallet starts on the right chain instead
 * of chain 1.
 */
export async function loginPrivyWithCode(email, code) {
  const client = await initPrivy();
  if (!client) {
    return { ok: false, code: 'not-configured', reason: 'Privy not configured (missing App ID)' };
  }
  try {
    // loginWithCode returns the AuthenticatedUser directly (SDK v0.79.1),
    // NOT wrapped in { session: { user } }.
    let user;
    try {
      user = await client.auth.email.loginWithCode(email, code);
    } catch (loginErr) {
      return { ok: false, code: 'login-error', reason: `Login failed: ${String(loginErr?.message || loginErr)}` };
    }
    if (!user) {
      return { ok: false, code: 'login-failed', reason: 'Privy returned no user' };
    }

    try {
      mountSecureContext(client);
    } catch (iframeErr) {
      return { ok: false, code: 'iframe-error', reason: `Secure context failed: ${String(iframeErr?.message || iframeErr)}` };
    }
    // After loginWithCode, refresh the user via client.user.get() so we
    // have the full profile including linked_accounts. loginWithCode's
    // return value may not include it.
    let walletUser;
    try {
      const { user: refreshed } = await client.user.get();
      walletUser = refreshed || user;
    } catch {
      walletUser = user;
    }

    // Find an embedded Ethereum wallet for this user. The SDK helper reads
    // user.linked_accounts and calls .filter() on it — wrap in try/catch since
    // linked_accounts may be undefined on a freshly signed-up user.
    let wallet;
    try {
      wallet = getUserEmbeddedEthereumWallet(walletUser);
    } catch {
      wallet = null;
    }

    // No wallet yet: provision one on first sign-in. create() may throw
    // embedded_wallet_already_exists on re-login — that's fine. After
    // creating, refresh the user via client.user.get() so linked_accounts
    // reflects the new wallet, then try reading it again.
if (!wallet) {
      try {
        await client.embeddedWallet.create({});
      } catch (createErr) {
        const msg = String(createErr?.message || createErr);
        if (!msg.includes('already_exists')) throw createErr;
      }
      // Re-fetch the user AFTER creation so wallet and entropy details are
      // consistent with the newly created embedded wallet. Using a stale
      // walletUser here causes getEthereumProvider to throw
      // "Embedded wallet proxy not initialized".
      try {
        const { user: refreshed } = await client.user.get();
        if (refreshed) walletUser = refreshed;
      } catch {}
      try {
        wallet = getUserEmbeddedEthereumWallet(walletUser);
      } catch {
        wallet = null;
      }
    }
    if (!wallet) {
      return { ok: false, code: 'no-wallet', reason: 'Privy did not return an embedded wallet' };
    }
    // Re-resolve entropy details from the FINAL walletUser (post-create),
    // not the pre-create snapshot. Stale entropy causes the same
    // "proxy not initialized" error.
    let entropyId, entropyIdVerifier;
    try {
      const ent = getEntropyDetailsFromUser(walletUser);
      if (!ent) {
        return { ok: false, code: 'no-entropy', reason: 'Privy could not resolve wallet entropy' };
      }
      entropyId = ent.entropyId;
      entropyIdVerifier = ent.entropyIdVerifier;
    } catch (entErr) {
      return { ok: false, code: 'entropy-error', reason: `Entropy resolution failed: ${String(entErr?.message || entErr)}` };
    }
    // Retry getEthereumProvider: the embedded-wallet proxy may need a moment
    // to initialize after wallet creation. "Embedded wallet proxy not
    // initialized" is the transient failure we retry on.
    let provider, lastProvErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        provider = await client.embeddedWallet.getEthereumProvider({
          wallet,
          entropyId,
          entropyIdVerifier,
        });
        break;
      } catch (provErr) {
        lastProvErr = provErr;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!provider) {
      return { ok: false, code: 'provider-error', reason: `getEthereumProvider failed: ${String(lastProvErr?.message || lastProvErr)}` };
    }
    if (!provider || typeof provider.request !== 'function') {
      return { ok: false, code: 'no-provider', reason: 'Privy did not return a valid EIP-1193 provider' };
    }

    let accounts;
    try {
      accounts = await provider.request({ method: 'eth_accounts' });
    } catch (acctErr) {
      return { ok: false, code: 'accounts-error', reason: `eth_accounts failed: ${String(acctErr?.message || acctErr)}` };
    }
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return { ok: false, code: 'no-accounts', reason: 'Embedded wallet returned no accounts' };
    }
    let chainIdHex;
    try {
      chainIdHex = await provider.request({ method: 'eth_chainId' });
    } catch (chainErr) {
      return { ok: false, code: 'chain-error', reason: `eth_chainId failed: ${String(chainErr?.message || chainErr)}` };
    }

    // Store references so switchChain() can use the provider later.
    privyProvider = provider;
    privyWallet = wallet;
    privyEntropy = { entropyId, entropyIdVerifier };

    // Immediately switch to the game chain (46630) so the wallet starts on
    // the right chain instead of chain 1. If the chain isn't in Privy's
    // supported chains yet, we report chain-unknown and let the caller
    // re-initialize + retry.
    const currentChain = Number(BigInt(chainIdHex));
    if (currentChain !== GAME_CHAIN_ID) {
      const sw = await switchChain(GAME_CHAIN_ID);
      if (!sw.ok) {
        // Return success for the login but flag the chain issue so the UI
        // can offer a re-init + retry path.
        return {
          ok: true,
          provider,
          account: accounts[0],
          chainId: currentChain,
          email: user.email?.address || null,
          switchChainError: sw.reason,
        };
      }
    }

    return {
      ok: true,
      provider,
      account: accounts[0],
      chainId: GAME_CHAIN_ID,
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
    return { ok: false, code: 'unexpected-error', reason: msg };
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
 * Boot-restore for a returning Privy user: if a session is still stored and
 * an embedded wallet exists for that user, return an EIP-1193 provider so
 * the connection can be re-attached without re-prompting for email/OTP.
 * Swallows all errors — a first-time or logged-out visitor is not an error.
 *
 * Also switches to the game chain (46630) so the restored session starts
 * on the correct network.
 */
export async function restorePrivyProvider() {
  const client = await initPrivy();
  if (!client) return null;
  try {
    mountSecureContext(client);
    const { user } = await client.user.get();
    if (!user) return null;
    // linked_accounts may be undefined — guard the read.
    let wallet;
    try {
      wallet = getUserEmbeddedEthereumWallet(user);
    } catch {
      wallet = null;
    }
    if (!wallet) return null;
    // Entropy details can throw on a freshly linked user; guard it.
    let entropyId, entropyIdVerifier;
    try {
      const ent = getEntropyDetailsFromUser(user);
      if (!ent) return null;
      entropyId = ent.entropyId;
      entropyIdVerifier = ent.entropyIdVerifier;
    } catch {
      return null;
    }
    // Retry getEthereumProvider: the embedded-wallet proxy may need a moment
    // to initialize. "Embedded wallet proxy not initialized" is transient.
    let provider, lastProvErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        provider = await client.embeddedWallet.getEthereumProvider({
          wallet,
          entropyId,
          entropyIdVerifier,
        });
        break;
      } catch (provErr) {
        lastProvErr = provErr;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!provider) {
      console.error('[Privy] restore failed: getEthereumProvider', lastProvErr);
      return null;
    }
    if (!provider || typeof provider.request !== 'function') return null;
    const accounts = await provider.request({ method: 'eth_accounts' });
    if (!Array.isArray(accounts) || accounts.length === 0) return null;

    // Store references so switchChain() can use the provider later.
    privyProvider = provider;
    privyWallet = wallet;
    privyEntropy = { entropyId, entropyIdVerifier };

    // Ensure we are on the game chain for returning users as well.
    let chainIdHex;
    try {
      chainIdHex = await provider.request({ method: 'eth_chainId' });
    } catch {
      chainIdHex = null;
}
    const currentChain = chainIdHex ? Number(BigInt(chainIdHex)) : null;
    if (currentChain !== GAME_CHAIN_ID) {
      const sw = await switchChain(GAME_CHAIN_ID);
      if (!sw.ok) {
        console.warn('[Privy] restore: chain switch failed', sw.reason);
        // Still return the provider so the caller can decide what to do
        return {
          provider,
          account: accounts[0],
          email: user.email?.address || null,
          chainId: currentChain,
          switchChainError: sw.reason,
        };
      }
    }

    return {
      provider,
      account: accounts[0],
      email: user.email?.address || null,
      chainId: GAME_CHAIN_ID,
    };
  } catch (err) {
    console.error('[Privy] restorePrivyProvider failed:', err?.message || err);
    return null;
  }
}

/**
 * End the Privy session (called from the wallet-menu Disconnect item).
 * Fire-and-forget by design: wallet.js owns the on-chain disconnect; this
 * only clears the Privy auth cookie/session so the next connect re-prompts.
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
  privyProvider = null;
  privyWallet = null;
  privyEntropy = null;
}

---

## index.html — UI wiring (key excerpts)

**Module imports** — Privy is code-split (dynamic import) to keep the cold-start bundle small:

js
import { connect, disconnect, switchToGameChain, getState, onWallet, GAME_CHAIN_ID, setChainBalanceWei } from '/src/wallet.js';
// Privy SDK is code-split: only loaded when the Privy dialog is actually
// opened (email send / OTP verify / disconnect).
let privyMod = null;
async function privy() {
  if (!privyMod) privyMod = await import('/src/privy.js');
  return privyMod;
}

**Email send:**

js
privySend.addEventListener('click', async () => {
  const email = privyEmail.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { privyError('Enter a valid email address.'); return; }
  privySend.disabled = true; privyError('Sending code…');
  const r = await (await privy()).sendPrivyEmailCode(email);
  privySend.disabled = false;
  if (!r.ok) {
    privyError(r.reason || 'Could not send the code.');
    if (r.code === 'not-configured') closePrivyDialog();
    return;
  }
  privyAddress = email;
  privySentTo.textContent = email;
  privyError(''); privyCode.value = '';
  privyStep1.classList.add('hidden');
  privyStep2.classList.remove('hidden');
  privyCode.focus();
});

**OTP verify** — handles `switchChainError` by re-initializing Privy (picks up dashboard chain changes) and retrying:

js
privyVerify.addEventListener('click', async () => {
  const code = privyCode.value.trim();
  if (!/^\d{6}$/.test(code)) { privyError('Enter the 6-digit code from the email.'); return; }
  privyVerify.disabled = true; privyError('Signing you in…');
  const r = await (await privy()).loginPrivyWithCode(privyAddress, code);
  privyVerify.disabled = false;
  if (!r.ok) {
    privyError(r.reason || 'Login failed.');
    if (r.code === 'not-configured') closePrivyDialog();
    return;
  }

  let provider = r.provider;
  if (r.switchChainError) {
    privyError('Switching to Robinhood Testnet…');
    const ri = await (await privy()).reinitialize();
    if (!ri) {
      privyError('Could not re-initialize Privy. Check your App ID.');
      return;
    }
    const restored = await (await privy()).restorePrivyProvider();
    if (!restored) {
      privyError('Could not restore the wallet session. Log in again.');
return;
    }
    provider = restored.provider;
    const sw = await (await privy()).switchChain(46630);
    if (!sw.ok) {
      privyError('Chain switch failed: ' + sw.reason + '. Make sure 46630 is in your Privy dashboard supported chains and that supportedChains is passed to the client.');
      return;
    }
  }

  closePrivyDialog();
  btn.disabled = true;
  try {
    const walletResult = await connect({ provider });
    if (!walletResult.ok && walletResult.code === 'wrong-chain') {
      const sw = await switchToGameChain();
      if (sw.ok) { render(); return; }
      setPending('Connected, but could not switch to chain ' + GAME_CHAIN_ID
        + ' (' + switchReasonText(sw, walletResult.chainId) + ').');
      render();
      return;
    }
    if (!walletResult.ok) {
      setPending('Wallet connect failed: ' + walletResult.reason);
    }
    render();
  } finally {
    btn.disabled = false;
  }
});

**Boot-restore** (returning user, no OTP):

js
setTimeout(async () => {
  const pm = await privy();
  pm.restorePrivyProvider()
    .then((r) => {
      if (!r) return null;
      // restorePrivyProvider now attempts the switch itself
      return connect({ provider: r.provider });
    })
    .then((r) => { if (r && r.ok) render(); })
    .catch(() => {});
}, 0);

**Disconnect:**

js
item.addEventListener('click', async (e) => {
  e.stopPropagation();
  closeWalletMenu();
  btn.disabled = true;
  const r = await disconnect();
  btn.disabled = false;
  if (!r.ok) setPending('Disconnect failed: ' + (r.reason || 'unknown'));
  else if (r.revoked === false) setPending('Disconnected. The wallet may still remember this site -- clear it there too if you want a fresh prompt.');
  render();
  await (await privy()).disconnectPrivy();
});

---

## src/wallet.js — chain switch fix

`errCode()` treats Privy's 4901 ("Unsupported chainId") as `chain-unknown`, matching 4902:

js
function errCode(e) {
  if (e && e.code === 4001) return "rejected";
  if (e && (e.code === 4901 || e.code === 4902)) return "chain-unknown";
  if (e && e.code === -32002) return "request-pending";
  return "provider-error";
}

This enables `switchToGameChain()` to attempt the `wallet_addEthereumChain` fallback when Privy reports the chain as unsupported (note: Privy's provider chains come from the dashboard/backend + the `supportedChains` passed at construction, not from `wallet_addEthereumChain` — the real fix is the client-side chain definition + dashboard entry + `reinitialize()` if needed).

---

## Key behaviors

| Scenario | Behavior |
|---|---|
| First-time user | `loginWithCode` → `create()` (auto-created via `createOnLogin`) → `getEthereumProvider()` (retried 3×) → auto-switch to 46630 + verify → `connect()` |
| Returning user | `restorePrivyProvider()` (retried 3×) → switch to 46630 + verify → `connect()` |
| Chain not in dashboard / supportedChains | `switchChain()` returns `chain-unknown` → UI calls `reinitialize()` → `restorePrivyProvider()` → `switchChain()` again |
| "proxy not initialized" | Retried up to 3× with 500ms delay in both `loginPrivyWithCode` and `restorePrivyProvider` |
| Disconnect | `disconnect()` (wallet.js) + `disconnectPrivy()` (clears Privy session) |

---

## Bundle structure (production build)

```
index-Ch3fGdX8.js   — main bundle (1.7MB, gzip 415KB) — no Privy SDK
privy-loslThVI.js   — code-split Privy chunk (796KB, gzip 206KB) — loaded only when Privy dialog opens
```

The Privy chunk is fetched via dynamic `import('/src/privy.js')` only when:
- User clicks "Send code" (email login step 1)
- User clicks "Verify" (email login step 2)
- User clicks "Disconnect" in the wallet menu
- Boot-restore on page load (returning Privy user)

---

## Gotchas

1. **Privy's `EmbeddedWalletProvider` manages `_chainId` locally**, not via RPC. `wallet_switchEthereumChain` looks up the chain in `_chains` (from `supportedChains` passed at construction + dashboard config fetched at `initialize()`). If 46630 isn't there, it throws 4901.
2. **wallet_addEthereumChain is NOT supported** by Privy's provider — chains come from the client-side `supportedChains` array and/or the dashboard/backend, not from client-side RPC.
3. **Dashboard changes require `reinitialize()`** — the client caches chains at `initialize()`. Add 46630 to the dashboard (and pass it in `supportedChains`), then call `reinitialize()` before switching if you change the dashboard after the first initialize().
4. **"Embedded wallet proxy not initialized"** — transient after wallet creation; retry `getEthereumProvider()` 3× with 500ms delay.
5. **Stale wallet/entropy objects** — after `create()`, re-fetch the user via `client.user.get()` before reading wallet and entropy details.
6. **No wagmi/useWallets()/wallet.switchChain()** — DeepWood uses vanilla EIP-1193 via @privy-io/js-sdk-core. The equivalent of `wallet.switchChain(chainId)` is `switchChain()` in `src/privy.js`, which calls `wallet_switchEthereumChain` on the provider and verifies with `eth_chainId`.
7. **Always pass the chain definition client-side** — `supportedChains: [robinhoodTestnet]` in the Privy constructor is required so the provider can switch to 46630. Dashboard configuration alone is not sufficient for the vanilla SDK if the chain was added after the first initialize().
8. Also add chain ID **46630** as a custom network in the Privy dashboard for the app.

### Key changes made

- Added `robinhoodTestnet` chain definition with `defineChain`.
- Passed `supportedChains: [robinhoodTestnet]` into the `Privy` constructor.
- Updated `switchChain()` to verify the new chain via `eth_chainId` after the switch.
- Updated `restorePrivyProvider()` to also switch to 46630 and return chain status (including any switch error).
- Minor comment and error-message updates to reflect the dual requirement (client-side `supportedChains` + dashboard).