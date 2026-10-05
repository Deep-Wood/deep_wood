import puppeteer from 'puppeteer';
const W = '0xd1Bd8e3D34B5f8ed38A56aA804A45B15a3FE848d';
const RPC = 'https://rpc.testnet.chain.robinhood.com';

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 900, hasTouch: true, isMobile: true });

await page.evaluateOnNewDocument((ACCOUNT, RPC_URL) => {
  window.__log = (...a) => console.log('[page]', ...a);
  window.ethereum = {
    isMetaMask: true,
    request: async ({ method, params }) => {
      console.log('[w]', method);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
      if (method === 'eth_chainId') return '0xb646';
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'wallet_addEthereumChain') return null;
      if (method === 'wallet_revokePermissions') return null;
      if (method === 'eth_sendTransaction') { throw Object.assign(new Error('rejected'), { code: 4001 }); }
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
page.on('console', (m) => logs.push(m.type() + ': ' + m.text().slice(0, 250)));
page.on('pageerror', (e) => logs.push('pageerror: ' + String(e).slice(0, 300)));

await page.goto('https://deepwood-two.vercel.app/?cb=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__scene, { timeout: 60000 });
await new Promise(r => setTimeout(r, 3000));
await page.click('button#connect');
await new Promise(r => setTimeout(r, 6000));

const pre = await page.evaluate(async () => {
  const s = window.__scene;
  return {
    econ_tier: s?.econ?.tier,
    _huntIndex: s?._huntIndex,
    _wasConnected: s?._wasConnected,
    btnText: document.getElementById('connect')?.textContent,
  };
});
console.log('pre-dig state:', JSON.stringify(pre));

// try dig + ALSO probe what doHunt actually does
const digOut = await page.evaluate(async () => {
  const s = window.__scene;
  const n = s.nodes.find(x => !x.getData('used'));
  const out = { node: !!n, initial: { busy: s.busy, mining: s.mining } };
  s.player.setPosition(n.x + 14, n.y);
  s.doHunt(n);
  out.after_doHunt = { busy: s.busy, mining: s.mining, hunting: s.hunting };
  // strike 3 times (3 swings to complete)
  for (let k = 0; k < 6; k++) {
    await new Promise(r => setTimeout(r, 400));
    s.mineStrike(s.time.now);
    out['after_strike_' + k] = { busy: s.busy, reveal_called: s.queue != null, tier: s.econ.tier };
  }
  // wait for reveal
  let waited = 0;
  while (s.busy && waited < 50) { await new Promise(r => setTimeout(r, 250)); waited++; }
  out.final = {
    waited,
    busy: s.busy,
    _huntIndex: s._huntIndex,
    queue: s.queue ? { size: s.queue.size, base: String(s.queue.base) } : null,
    badge: document.getElementById('queue-badge')?.textContent,
  };
  return out;
});
console.log('dig trace:', JSON.stringify(digOut, null, 2));

console.log('--- last 30 logs ---');
logs.slice(-30).forEach(l => console.log(l));

// try to take screenshot
await page.screenshot({ path: '/tmp/after-dig.png' });
await browser.close();
