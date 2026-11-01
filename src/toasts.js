// DeepWood client-side juice: connected toast, dig streak, share, recovery.
// All additive — nothing touches contracts, nothing goes on-chain.

export function haptic(ms = 20) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

/**
 * One-shot toast shown after a successful Privy (or any) wallet connect.
 * Call from the success path once the provider is connected and balance is known.
 */
export function showConnectedToast({ account, ethBalance, chainId }) {
  const wrap = document.getElementById('badge-toasts') || document.body;
  const el = document.createElement('div');
  el.className = 'badge-toast connected-toast';
  const short = account ? `${account.slice(0, 6)}…${account.slice(-4)}` : 'wallet';
  const bal = ethBalance != null ? Number(ethBalance) / 1e18 : null;
  el.innerHTML = `
    <div class="bt-text">
      <b>Connected on Robinhood Testnet</b>
      <span>${short}${bal != null ? ` · ${bal.toFixed(4)} ETH` : ''}</span>
      <a href="https://faucet.testnet.chain.robinhood.com" target="_blank" rel="noopener" style="color:var(--gold);text-decoration:underline">Get test ETH →</a>
    </div>`;
  wrap.appendChild(el);
  haptic(40);
  setTimeout(() => { el.classList.add('gone'); setTimeout(() => el.remove(), 600); }, 8000);
}

/** Session-only dig counter (reset on reload). */
let sessionDigs = 0;

export function bumpDigStreak() {
  sessionDigs++;
  const el = document.getElementById('dig-streak');
  if (el) {
    el.textContent = sessionDigs;
    el.classList.add('pulse');
    setTimeout(() => el.classList.remove('pulse'), 300);
  }
  haptic(15);
}

export function resetDigStreak() {
  sessionDigs = 0;
  const el = document.getElementById('dig-streak');
  if (el) el.textContent = '0';
}

/** Share a canvas capture via Web Share API, falling back to download. */
export async function shareHaul(canvas, title = 'DeepWood haul') {
  if (!canvas || !navigator.share) {
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'deepwood-haul.png';
    a.click();
    return;
  }
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const file = new File([blob], 'deepwood-haul.png', { type: 'image/png' });
  try {
    await navigator.share({ title, files: [file] });
  } catch { /* user cancelled */ }
}

/** Transient recovery card shown when settle reverts. Dismissible, auto-removes after 10s. */
export function showSettleRecovery(reason) {
  const el = document.createElement('div');
  el.className = 'recovery-card';
  el.innerHTML = `
    <b>Settle didn't go through</b>
    <p>${reason || 'Your digs are still queued.'}</p>
    <button type="button" onclick="this.closest('.recovery-card').remove()">Try again</button>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 10000);
}
