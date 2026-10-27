/**
 * Privy embedded wallet integration for DeepWood.
 *
 * This module initializes Privy and provides a `connectPrivy()` function that
 * returns an EIP-1193 provider. That provider is then passed to wallet.js's
 * `connect({ provider })` so the rest of the flow (chain switching, signing,
 * state management) remains exactly the same.
 *
 * NO PRIVATE KEYS. The embedded wallet lives inside Privy's iframe; every
 * transaction is signed by the user in the Privy UI. This module never sees
 * key material.
 *
 * Env: VITE_PRIVY_APP_ID (required for production; dev can use a local default).
 */

import PrivyClient from '@privy-io/js-sdk-core';
import { config } from './config.js';

let privyClient = null;
let isInitialized = false;

/**
 * Initialize the Privy client. Idempotent; safe to call multiple times.
 * Returns the client instance or null if initialization failed.
 */
export async function initPrivy() {
  if (isInitialized && privyClient) return privyClient;

  const appId = (() => {
    // Vite injects import.meta.env at build time
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_PRIVY_APP_ID) {
      return import.meta.env.VITE_PRIVY_APP_ID;
    }
    // Node test fallback
    if (typeof process !== 'undefined' && process.env?.VITE_PRIVY_APP_ID) {
      return process.env.VITE_PRIVY_APP_ID;
    }
    return null;
  })();

  if (!appId) {
    console.warn('[Privy] VITE_PRIVY_APP_ID not set — Privy login will not work');
    return null;
  }

  try {
    privyClient = new PrivyClient(appId, {
      // Don't auto-connect; we want explicit user action
      loginMethods: ['email', 'wallet'],
      appearance: {
        theme: 'dark',
        accentColor: '#4a7c59', // DeepWood green
        logo: '/art/deepwood-emblem-round.png',
        showWalletLoginFirst: false, // Show email/social first for embedded wallet
      },
      embeddedWallets: {
        createOnLogin: 'users-without-wallets', // Create embedded wallet for email/social users
        requireUserPasswordOnCreate: false, // Optional: add password protection
      },
      // Chain configuration for the embedded wallet
      supportedChains: [
        {
          id: config.chainId,
          name: 'Robinhood Chain Testnet',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: [config.rpcUrl],
          blockExplorerUrls: ['https://explorer.testnet.chain.robinhood.com'],
        },
      ],
      defaultChain: config.chainId,
    });

    // Wait for Privy to be ready
    await privyClient.ready();
    isInitialized = true;
    console.log('[Privy] Initialized with app ID:', appId);
    return privyClient;
  } catch (err) {
    console.error('[Privy] Initialization failed:', err);
    privyClient = null;
    isInitialized = false;
    return null;
  }
}

/**
 * Get the Privy client, initializing if needed.
 */
export async function getPrivyClient() {
  if (!isInitialized) await initPrivy();
  return privyClient;
}

/**
 * Connect via Privy (email/social login -> embedded wallet).
 *
 * Returns an EIP-1193 provider that can be passed to wallet.js connect().
 * The result format matches wallet.js connect() for consistency:
 *   { ok: true, provider, account, chainId } 
 *   { ok: false, code, reason }
 */
export async function connectPrivy() {
  const client = await getPrivyClient();
  if (!client) {
    return {
      ok: false,
      code: 'not-configured',
      reason: 'Privy not initialized (missing VITE_PRIVY_APP_ID)',
    };
  }

  try {
    // Trigger Privy login flow. This opens the modal.
    const { user } = await client.login();

    if (!user) {
      return {
        ok: false,
        code: 'rejected',
        reason: 'Privy login was cancelled or failed',
      };
    }

    // Get the embedded wallet provider (EIP-1193)
    const provider = await user.getEthereumProvider();

    if (!provider || typeof provider.request !== 'function') {
      return {
        ok: false,
        code: 'no-provider',
        reason: 'Privy did not return a valid EIP-1193 provider',
      };
    }

    // Get the connected account
    const accounts = await provider.request({ method: 'eth_accounts' });
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return {
        ok: false,
        code: 'no-accounts',
        reason: 'Privy wallet returned no accounts',
      };
    }

    // Get the chain ID
    const chainIdHex = await provider.request({ method: 'eth_chainId' });
    const chainId = Number(BigInt(chainIdHex));

    return {
      ok: true,
      provider,
      account: accounts[0],
      chainId,
    };
  } catch (err) {
    // Map Privy errors to our standard codes
    const msg = String(err?.message || err);
    if (msg.includes('User rejected') || msg.includes('cancelled') || msg.includes('dismissed')) {
      return { ok: false, code: 'rejected', reason: 'Privy login rejected' };
    }
    if (msg.includes('network') || msg.includes('fetch')) {
      return { ok: false, code: 'network-error', reason: 'Privy network error' };
    }
    return { ok: false, code: 'provider-error', reason: `Privy connect failed: ${msg}` };
  }
}

/**
 * Disconnect from Privy (clears local session).
 * Note: This does not delete the embedded wallet; it only logs out of the current session.
 */
export async function disconnectPrivy() {
  const client = await getPrivyClient();
  if (!client) return { ok: true }; // Already not connected

  try {
    await client.logout();
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'provider-error', reason: String(err?.message || err) };
  }
}

/**
 * Check if user has an active Privy session.
 */
export async function getPrivyUser() {
  const client = await getPrivyClient();
  if (!client) return null;

  try {
    // client.user is set after login; null if not authenticated
    return client.user || null;
  } catch {
    return null;
  }
}

/**
 * Reset module state (for tests).
 */
export function resetPrivy() {
  privyClient = null;
  isInitialized = false;
}