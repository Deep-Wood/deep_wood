// Deep repro: connected wallet, THREE digs, watch badge + settle button +
// a second reveal after settle-drop. This is the exact user complaint:
// "new hunts are still not getting added in the UI".
import puppeteer from 'puppeteer';

const URL = 'https://deepwood-two.vercel.app/?cb=hunt3' + Date.now();
const ACCT = '0xd1Bd8e3D34B5f8ed38A56aA804A45B15a3FE848d'; // trader2

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.emulate({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 180), '\nSTACK:', (e.stack || '').slice(0, 600)));

await page.evaluateOnNewDocument((acct) => {
  const RPC = 'https://robinhood-testnet.drpc.org';
  window.ethereum = {
    isMetaMask: true,
    request: async ({ method, params }) => {
      if (method === 'eth_chainId') return '0xb626';
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [acct];
      if (method === 'wallet_addEthereumChain' || method === 'wallet_switchEthereumChain') return null;
      if (['eth_call', 'eth_blockNumber', 'eth_sendTransaction', 'eth_getLogs'].includes(method)) {
        const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        const j = await r.json();
        if (j.error) throw new Error(j.error.message);
        return j.result;
      }
      return null;
    },
    on: () => {},
    removeListener: () => {},
  };
}, ACCT);

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForFunction('window.__scene && window.deepwoodChain && window.deepwoodChain.ok', { timeout: 60000 }).catch(() => console.log('boot timeout'));
// silent reconnect can take a couple seconds
await page.waitForFunction('window.__syncBalance && window.__scene && window.__scene.econ && window.__scene.econ.tier > 0', { timeout: 30000 }).catch(() => console.log('tier wait timeout'));

const dig = async (label) => page.evaluate(async (label) => {
  const s = window.__scene;
  const node = { x: 100, y: 100, setData: () => {}, active: true, getData: () => false, setVisible: () => {} };
  try {
    await s.reveal(node);
  } catch (e) { return { label, error: e.message.slice(0, 150) }; }
  const badge = document.getElementById('queue-badge');
  const settle = document.getElementById('belt-settle');
  return {
    label,
    queue: s.queue ? s.queue.size : null,
    badge: badge?.textContent ?? null,
    badgeHidden: badge?.classList.contains('hidden') ?? null,
    settleText: settle ? (settle.textContent || '').trim().slice(0, 40) : null,
    settleDisabled: settle ? settle.disabled : null,
    econTier: s.econ?.tier ?? null,
    econLeft: s.econ?.left ?? null,
  };
}, label);

console.log('DIG-A:', JSON.stringify(await dig('A')));
await new Promise((r) => setTimeout(r, 1500));
console.log('DIG-B:', JSON.stringify(await dig('B')));
await new Promise((r) => setTimeout(r, 1500));
console.log('DIG-C:', JSON.stringify(await dig('C')));
await page.screenshot({ path: '/tmp/hunt-three.png' });
await browser.close();
