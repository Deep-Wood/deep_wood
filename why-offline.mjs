// Run the CLIENT's own bootChain() against the deployed site and print the
// real failure reason, instead of inferring it from the rendered chip.
import puppeteer from 'puppeteer';

const URL = process.argv[2] || 'https://deepwood-two.vercel.app/';
const b = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const p = await b.newPage();
const netlog = [];
p.on('requestfailed', (r) => netlog.push('FAILED ' + r.url().slice(0, 70) + ' :: ' + (r.failure()?.errorText || '')));
await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

// wait for the page's own chain check to land
await p.waitForFunction('window.deepwoodChain !== undefined', { timeout: 30000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2500));

const out = await p.evaluate(() => {
  const res = { windowDeepwoodChain: window.deepwoodChain, chipText: null };
  const chip = document.getElementById('chainstat');
  res.chipText = chip ? chip.innerText.trim() : null;
  const hint = document.getElementById('hint');
  res.hint = hint ? hint.innerText.trim().slice(0, 160) : null;
  return res;
});

console.log('deepwoodChain:', JSON.stringify(out && out.windowDeepwoodChain));
console.log('chip          :', out.chipText);
console.log('hint          :', out.hint);
console.log('net failures  :', netlog.length ? netlog.slice(0, 5) : 'none');

// Probe each raw call the client makes, straight from the page, so CORS and UA
// are exactly what the player gets.
const probe = await p.evaluate(async () => {
  const url = (window.__rpcUrl || 'https://rpc.testnet.chain.robinhood.com');
  const to = '0xD7633c0623BC5a1FD82677c34f97612633ADe720';
  const call = async (label, method, params) => {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await r.json();
      return { label, http: r.status, ok: 'result' in j, msg: j.error ? String(j.error.message).slice(0, 70) : null };
    } catch (e) { return { label, http: 0, ok: false, msg: String(e.message).slice(0, 70) }; }
  };
  const out = [];
  out.push(await call('chainId', 'eth_chainId', []));
  out.push(await call('paused 5c975abb', 'eth_call', [{ to, data: '0x5c975abb' }, 'latest']));
  out.push(await call('config 79502c55', 'eth_call', [{ to, data: '0x79502c55' }, 'latest']));
  out.push(await call('current 9fa6a6e3', 'eth_call', [{ to, data: '0x9fa6a6e3' }, 'latest']));
  out.push(await call('bps e1a45218', 'eth_call', [{ to, data: '0xe1a45218' }, 'latest']));
  out.push(await call('priceOf(0)', 'eth_call', [{ to, data: '0xb0c36bb3' + '0'.repeat(63) + '0' }, 'latest']));
  return out;
});
console.log('\nin-page RPC probes:');
for (const r of probe) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${String(r.label).padEnd(18)} http=${r.http} ${r.msg || ''}`);

await b.close();