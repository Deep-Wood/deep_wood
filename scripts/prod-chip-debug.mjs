// Why do prod chips read 0 while the mirror holds the raw word?
// Dump WHO last wrote the gemstrip and what renderGems sees right now.
import puppeteer from 'puppeteer';

const URL = 'https://deepwood-two.vercel.app/?cb=dbg' + Date.now();
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.setCacheEnabled(false);
await page.setViewport({ width: 1280, height: 900 });

await page.evaluateOnNewDocument((addr) => {
  window.__ADDR = addr;
  const RPCS = ['https://robinhood-testnet.drpc.org', 'https://rpc.testnet.chain.robinhood.com'];
  const READS = new Set(['eth_chainId', 'eth_accounts', 'eth_requestAccounts', 'eth_getBalance', 'eth_call', 'eth_blockNumber', 'eth_getBlockByNumber']);
  const provider = {
    isMetaMask: true,
    async request({ method, params }) {
      if (!READS.has(method)) throw new Error('ro provider: ' + method);
      if (method === 'eth_chainId') return '0xb626';
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [window.__ADDR];
      if (method === 'eth_getBlockByNumber') return { number: '0x1', timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) };
      let last;
      for (const u of RPCS) {
        try {
          const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
          const j = await r.json();
          if (j.error) return { error: j.error };
          return j.result;
        } catch (e) { last = String(e); await new Promise((x) => setTimeout(x, 600)); }
      }
      throw new Error('all RPCs failed: ' + last);
    },
    on() {}, removeListener() {},
  };
  window.ethereum = provider;
  window.dispatchEvent(new Event('ethereum#initialized'));
}, '0xd1bd8e3d34b5f8ed38A56aA804A45B15a3FE848d');

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

for (let i = 0; i < 240; i++) {
  const st = await page.evaluate(() => {
    const s = window.__scene;
    const bal = window.__scene?.econ?.gems;
    // Force a repaint and read back immediately.
    let after = null;
    try { window.renderGems?.(); after = [...document.querySelectorAll('#gemstrip .gs-row:first-child .gc')].map((e) => e.textContent); } catch (e) { after = ['ERR ' + String(e).slice(0, 60)]; }
    return {
      mode: document.getElementById('belt-mode')?.textContent?.trim() ?? null,
      gems: bal ? [...bal].map((v) => (typeof v === 'bigint' ? 'BIG:' + v.toString() : 'num:' + String(v))) : null,
      chipsNow: [...document.querySelectorAll('#gemstrip .gs-row:first-child .gc')].map((e) => e.textContent),
      chipsAfterForcedRender: after,
    };
  }).catch((e) => ({ err: String(e).slice(0, 90) }));
  if (i % 10 === 0) console.log('POLL', i, JSON.stringify({mode: st?.mode, gems0: st?.gems?.[0], chips0: st?.chipsNow?.[0]}));
  if (st?.gems?.[0] && /BIG:[1-9]/.test(st.gems[0])) {
    console.log('STATE:', JSON.stringify(st, null, 1));
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
await browser.close();
