import puppeteer from 'puppeteer';
const W = '0xd1Bd8e3D34B5f8ed38A56aA804A45B15a3FE848d';
const RPC = 'https://rpc.testnet.chain.robinhood.com';

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
// emulate a touch-capable mobile
const ctx = browser.defaultBrowserContext();
await page.setViewport({ width: 430, height: 900, hasTouch: true, isMobile: true });

await page.evaluateOnNewDocument((ACCOUNT, RPC_URL) => {
  window.ethereum = {
    isMetaMask: true,
    request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
      if (method === 'eth_chainId') return '0xb646';
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'wallet_addEthereumChain') return null;
      if (method === 'wallet_revokePermissions') return null;
      if (method === 'eth_sendTransaction') {
        console.log('[wallet-stub] TX', JSON.stringify(params[0]).slice(0, 300));
        throw Object.assign(new Error('user rejected signing'), { code: 4001 });
      }
      const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then(x => x.json());
      if (r.error) { const e = new Error(r.error.message); e.code = r.error.code; throw e; }
      return r.result;
    },
    on: () => {},
    removeListener: () => {},
  };
}, W, RPC);

const logs = [];
page.on('console', (m) => logs.push(m.type() + ': ' + m.text().slice(0, 200)));
page.on('pageerror', (e) => logs.push('pageerror: ' + String(e).slice(0, 300)));

await page.goto('https://deepwood-two.vercel.app/?cb=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__scene, { timeout: 60000 });
await new Promise(r => setTimeout(r, 3000));
await page.click('button#connect');
await new Promise(r => setTimeout(r, 5000));

// Now do ONE dig via the canvas-side hunt flow: position + hunt
const digOut = await page.evaluate(async () => {
  const s = window.__scene;
  const n = s.nodes.find(x => !x.getData('used'));
  if (!n) return { err: 'no nodes' };
  s.player.setPosition(n.x + 14, n.y);
  s.doHunt(n);
  for (let k = 0; k < 6; k++) {
    await new Promise(r => setTimeout(r, 300));
    s.mineStrike(s.time.now);
  }
  let waited = 0;
  while (s.busy && waited < 60) { await new Promise(r => setTimeout(r, 250)); waited++; }
  return {
    busy: s.busy,
    _huntIndex: s._huntIndex,
    queue: s.queue ? { size: s.queue.size, base: String(s.queue.base) } : null,
  };
});
console.log('after 1 dig:', JSON.stringify(digOut));

// Get the badge position and click it via raw coords -- NOT via DOM selector
const rect = await page.evaluate(() => {
  const b = document.getElementById('queue-badge');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  const cs = getComputedStyle(b);
  return { x: r.x, y: r.y, w: r.width, h: r.height, pe: cs.pointerEvents, text: b.textContent, visible: !b.classList.contains('hidden') };
});
console.log('badge rect:', JSON.stringify(rect));

// click via raw pointer (simulating touch tap)
if (rect && rect.visible) {
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  console.log('tapping at', cx, cy);
  await page.touchscreen.tap(cx, cy);
  await new Promise(r => setTimeout(r, 1500));
  const after = await page.evaluate(() => {
    const s = window.__scene;
    return {
      leaderboardOpen: s?.leaderboardOpen,
      badgeShown: !document.getElementById('queue-badge')?.classList.contains('hidden'),
    };
  });
  console.log('after tap:', JSON.stringify(after));
  await page.screenshot({ path: '/tmp/tap-result.png' });
}

console.log('--- last 20 logs ---');
logs.slice(-20).forEach(l => console.log(l));
await browser.close();
