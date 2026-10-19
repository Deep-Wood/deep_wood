// Prod proof of the raw-count fix: the served bundle must carry the BigInt
// keep (no /1e18 in refreshChainGems), and the gemstrip must show the honest
// raw count for trader2 (quartz word 6000000000000000005 -> "6.0" compact).
// Cache-busted: ?cb= + setCacheEnabled(false), per the Vercel lesson.
import puppeteer from 'puppeteer';

const URL = 'https://deepwood-two.vercel.app/?cb=raw' + Date.now();
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-script'] }).catch(() => null)
  ?? await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });

const page = await browser.newPage();
await page.setCacheEnabled(false);
await page.setViewport({ width: 1280, height: 900 });
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

// 1. Which bundle is served, and does it hold the fix?
const bundle = await page.evaluate(async () => {
  const el = document.querySelector('script[type="module"]');
  const src = el?.getAttribute('src') || '';
  let keep = null;
  try {
    const r = await fetch(src);
    const t = await r.text();
    // Match the FUNCTION BODY (the first hit is the commit-message comment
    // embedded in the Vite env blob).
    const i = t.indexOf('async refreshChainGems');
    const seg = t.slice(i, i + 900);
    keep = { hasBigIntKeep: /map\([^)]*=>[^)]*\?\?0n\)/.test(seg), hasDivision: /\/1e18/.test(seg) };
  } catch (e) { keep = { err: String(e).slice(0, 80) }; }
  return { src, keep };
});
console.log('BUNDLE:', JSON.stringify(bundle));

// 2. The inline script's balDisplay must exist (raw-count display helper).
const inline = await page.evaluate(() => ({
  balDisplay: typeof window.balDisplay !== 'undefined' || document.body.innerHTML.includes('balDisplay'),
}));
console.log('INLINE balDisplay present:', JSON.stringify(inline));

// 3. Inject the wallet provider the parity harness uses, boot the scene, and
//    read the gemstrip counts for trader2.
await page.evaluateOnNewDocument((addr) => {
  window.__ADDR = addr;
  const RPCS = ['https://robinhood-testnet.drpc.org', 'https://rpc.testnet.chain.robinhood.com'];
  const READS = new Set(['eth_chainId', 'eth_accounts', 'eth_requestAccounts', 'eth_getBalance', 'eth_call', 'eth_blockNumber', 'eth_getBlockByNumber']);
  const provider = {
    isMetaMask: true,
    async request({ method, params }) {
      if (!READS.has(method)) throw new Error('ro provider: ' + method);
      if (method === 'eth_chainId') return '0xb626'; // 46630, the game chain
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

// Reload with the provider in place from document start.
await page.goto(URL + '&boot=1', { waitUntil: "domcontentloaded", timeout: 60000 });

let strip = null;
for (let i = 0; i < 120; i++) {
  strip = await page.evaluate(() => {
    const s = window.__scene;
    const chips = [...document.querySelectorAll('#gemstrip .gc')].map((e) => e.textContent);
    return {
      onchain: !!s && !!(s.econ),
      gems: s ? [...(s.econ?.gems ?? [])].map((v) => (typeof v === 'bigint' ? v.toString() : String(v))) : null,
      chips,
      mode: document.getElementById('belt-mode')?.textContent?.trim() ?? null,
    };
  }).catch((e) => ({ err: String(e).slice(0, 80) }));
  // Wait for ON-CHAIN mode AND a non-zero gem word (preview boots with zeros),
  // then force one renderGems() pass so the chips can never lag the mirror.
  if (strip?.onchain && /ON-CHAIN/i.test(strip?.mode || '') && strip?.gems?.[0] && strip.gems[0] !== '0') {
    strip = await page.evaluate(() => {
      window.renderGems?.();
      const chips = [...document.querySelectorAll('#gemstrip .gc')].map((e) => e.textContent);
      const s = window.__scene;
      return {
        onchain: true,
        gems: [...(s.econ?.gems ?? [])].map((v) => (typeof v === 'bigint' ? v.toString() : String(v))),
        chips,
        mode: document.getElementById('belt-mode')?.textContent?.trim() ?? null,
      };
    });
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log('STRIP:', JSON.stringify(strip));

const rawWord = '6000000000000000005';
const shown = strip?.gems?.[0] === rawWord;
const chip0 = strip?.chips?.[0];
const chipOk = chip0 === '6.0' || chip0 === '6' || (chip0 ?? '').startsWith('6');
console.log('VERDICT:', JSON.stringify({ rawWordOnMirror: shown, chip0, chipOk }));

await browser.close();
process.exit(shown && chipOk ? 0 : 1);
