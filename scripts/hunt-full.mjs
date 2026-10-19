// Full on-chain dig repro: inject a mock EIP-1193 wallet BEFORE the page
// loads (auto-connecting as trader2), let the site go on-chain, then dig via
// the real dig flow (finishDig path) and watch: queue badge, belt settle
// button, satchel. Preview-mode digs are also covered (same reveal path).
import puppeteer from 'puppeteer';

const URL = 'https://deepwood-two.vercel.app/?cb=huntfull' + Date.now();
const ACCT = '0xd1Bd8e3D34B5f8ed38A56aA804A45B15a3FE848d'; // trader2

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.emulate({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 180)));
page.on('console', (m) => m.type() === 'error' && console.log('CONSOLE:', m.text().slice(0, 120)));

// Mock wallet that answers read calls itself (eth_chainId, eth_accounts) and
// proxies eth_call/eth_sendTransaction to the real RPC. No signing needed for
// digs (preview + queue are read-only); SETTLE would need a signer, out of
// scope for this repro.
await page.evaluateOnNewDocument((acct) => {
  const RPC = 'https://robinhood-testnet.drpc.org';
  window.__mockTx = [];
  window.ethereum = {
    isMetaMask: true,
    request: async ({ method, params }) => {
      if (method === 'eth_chainId') return '0xb626'; // 46630
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [acct];
      if (method === 'wallet_addEthereumChain' || method === 'wallet_switchEthereumChain') return null;
      if (method === 'eth_call' || method === 'eth_blockNumber' || method === 'eth_sendTransaction') {
        const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        const j = await r.json();
        if (j.error) throw new Error(j.error.message);
        if (method === 'eth_sendTransaction') window.__mockTx.push({ method, hash: j.result });
        return j.result;
      }
      return null;
    },
    on: () => {},
    removeListener: () => {},
  };
}, ACCT);

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForFunction('window.__scene && window.deepwoodChain && window.deepwoodChain.ok', { timeout: 60000 }).catch(() => console.log('boot wait timeout'));

const state1 = await page.evaluate(async () => {
  const s = window.__scene;
  // Module registry is internal on prod; read the same facts off the scene
  // and the DOM instead of importing /src/wallet.js (Vercel serves the built
  // app -- /src/* is not uploaded, so dynamic import 404s there).
  return {
    wallet: s.wallet ?? null,
    queue: s.queue ? s.queue.size : null,
    huntIndex: s.huntIndex ?? null,
    econTier: s.econ?.tier ?? null,
    chainChip: document.getElementById('chaintext')?.textContent ?? null,
  };
});
console.log('STATE:', JSON.stringify(state1));

// Now dig. The real flow: the scene's reveal(node) with onchain active queues.
const dig = await page.evaluate(async () => {
  const s = window.__scene;
  const node = { x: 100, y: 100, setData: () => {}, active: true, getData: () => false, setVisible: () => {} };
  const before = s.queue ? s.queue.size : null;
  try {
    const ok = await s.reveal(node);
    return {
      ok, before,
      after: s.queue ? s.queue.size : null,
      huntIndexAfter: s.huntIndex ?? null,
      badge: (document.getElementById('queue-badge')?.textContent) ?? null,
      badgeHidden: document.getElementById('queue-badge')?.classList.contains('hidden') ?? null,
    };
  } catch (e) {
    return { error: e.message.slice(0, 250), before, after: s.queue ? s.queue.size : null };
  }
});
console.log('DIG1:', JSON.stringify(dig));
await page.screenshot({ path: '/tmp/hunt-dig1.png' });
await browser.close();
