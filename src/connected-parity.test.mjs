/**
 * CONNECTED-PATH INTEGRITY TEST. No mocks of the chain, no preview mode.
 *
 * Why this file exists
 * --------------------
 * Three fixes were reported as verified in this session -- the chain tool
 * mirror, the chain gem mirror, and the ROI units. Every one of them was
 * verified in a browser with NO WALLET CONNECTED. In that state
 * `onchainActive()` is false, so `refreshChainTool()` and `refreshChainGems()`
 * return immediately and the preview simulation is the only thing being
 * observed. The tests could not fail because the code under test never ran.
 *
 * The screenshot that followed showed a card reading "WOOD 0/20 BROKEN" and
 * "107 gems" for a wallet that the chain reports as tier 1, 20/20, not broken,
 * with zero gems in all five rarities. So: the card was rendering a game that
 * was not happening, while the status chip said "live".
 *
 * What this does differently
 * --------------------------
 * It reads the DEPLOYED contract on 46630 for a real address, injects a
 * wallet provider into a headless browser so the connected path actually
 * executes, and then asserts the rendered DOM equals the chain's answer.
 * If the card disagrees with the chain, this fails.
 *
 * It never touches the private key of the address under test -- only public
 * eth_call reads. The injected provider refuses every write method.
 *
 * Run: node --test src/connected-parity.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const GAME = '0x871cb5c1d764788c17d2d9ba7df266c32fe6a7fa';
const RPCS = [
  'https://robinhood-testnet.drpc.org',
  'https://rpc.testnet.chain.robinhood.com',
];
const CHAIN_ID = 46630;

// The wallet from the screenshot. Public address only; no key is used or needed.
const WALLET = '0xd1bd8e3d34b5f8ed38a56aa804a45b15a3fe848d';

/** Minimal JSON-RPC read against the deployed testnet, with failover. */
async function rpc(method, params) {
  let lastErr = 'no attempt made';
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await res.json();
      // An explicit JSON-RPC error is a valid answer, not a transport failure:
      // do not walk the failover list on it, or a real revert reads as a dead
      // endpoint.
      if (j.error) return { error: j.error };
      return j.result;
    } catch (e) {
      lastErr = String(e);
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw new Error(`every RPC failed: ${lastErr}`);
}

/**
 * Encode calldata the way `cast` does.
 *
 * My first attempt stripped `0x` and concatenated, producing a 42-char address
 * where a 64-char ABI word is required -- so every eth_call reverted and the
 * whole suite errored. Fixed-point, left-padded, 32 bytes each.
 */
function encodeArgs(args) {
  return args.map((a) => BigInt(a).toString(16).padStart(64, '0')).join('');
}

async function readContract(selector, argTypes, args) {
  const data = selector + encodeArgs(args);
  const r = await rpc('eth_call', [{ to: GAME, data }, 'latest']);
  if (!r || r.error) throw new Error(`eth_call failed: ${JSON.stringify(r?.error ?? r)}`);
  return r;
}

/** Ground truth, read straight from the deployed contract. */
async function chainTruth() {
  // toolOf(address) -> (uint8 tier, uint8 durability, bool broken)
  // AWAITED. Without it this is a Promise, so `tool.slice` was undefined and
  // the ground truth never existed -- which is exactly the kind of silent
  // harness fault that makes an integration test worthless.
  const tool = await readContract(await toolSelector(), [], [WALLET]);
  const words = tool.slice(2).match(/.{64}/g) ?? [];
  const toolTier = parseInt(words[0], 16);
  const durability = parseInt(words[1], 16);
  const broken = parseInt(words[2], 16) !== 0;

  const gems = [];
  for (let r = 0; r < 5; r++) {
    const out = await readContract(await gemsSelector(), ['address', 'uint8'], [WALLET, r]);
    gems.push(Number(BigInt('0x' + out.slice(2))));
  }
  const balWei = BigInt(await rpc('eth_getBalance', [WALLET, 'latest']));
  return { toolTier, durability, broken, gems, balWei, held: gems.reduce((a, b) => a + b, 0) };
}

/** Selectors are derived from the deployed ABI, not hand-typed. */
let ABI = null;
async function loadAbi() {
  if (ABI) return ABI;
  const fs = await import('fs');
  const p = '/home/administrator/gem-hunter/out/DeepWoodV2.sol/DeepWoodV2.json';
  ABI = JSON.parse(fs.readFileSync(p, 'utf8')).abi;
  return ABI;
}
async function selectorOf(sig) {
  // loadAbi() must be called: ABI starts null and this used to read it
  // straight away, so every test died on `null.find` before touching the app.
  await loadAbi();
  const { keccak256 } = (await import('js-sha3')).default;
  const name = sig.split('(')[0];
  const canonical = ABI.find((f) => f.type === 'function' && f.name === name);
  if (!canonical) throw new Error(`no ${name} in the V2 ABI`);
  const types = canonical.inputs.map((i) => i.type).join(',');
  return '0x' + keccak256(`${name}(${types})`).slice(0, 8);
}
const toolSelector = () => selectorOf('toolOf(address)');
const gemsSelector = () => selectorOf('gemsOf(address,uint8)');

/**
 * A wallet provider that satisfies the EIP-1193 surface the app uses for
 * CONNECTING, and refuses every write. This is not a chain mock: reads are
 * proxied to the real endpoints below, so the app performs real eth_calls.
 */
function injectedProvider() {
  const READS = new Set([
    'eth_chainId', 'eth_accounts', 'eth_requestAccounts', 'eth_getBalance',
    'eth_call', 'eth_blockNumber', 'eth_getBlockByNumber',
  ]);
  return {
    isMetaMask: true,
    request: async ({ method, params }) => {
      if (!READS.has(method)) {
        throw new Error(`test provider refuses ${method} -- this suite must not write`);
      }
      // Derived from CHAIN_ID. I hardcoded '0xb65a' by hand once; that is
      // 46682, not 46630, so the app correctly demanded a chain switch and the
      // suite sat in preview forever.
      if (method === 'eth_chainId') return '0x' + CHAIN_ID.toString(16);
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [WALLET];
      if (method === 'eth_getBlockByNumber') {
        return { number: '0x1', timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) };
      }
      let lastErr;
      for (const url of RPCS) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          });
          const j = await res.json();
          if (j.error) return { error: j.error }; // a real revert, not a dead node
          return j.result;
        } catch (e) { lastErr = String(e); await new Promise((r) => setTimeout(r, 700)); }
      }
      throw new Error(`injected provider: all RPCs failed (${lastErr})`);
    },
    on: () => {}, removeListener: () => {},
  };
}

let browser, page, truth;

before(async () => {
  truth = await chainTruth();
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900 });
  await page.evaluateOnNewDocument((addr) => {
    window.ethereum = {
      isMetaMask: true,
      request: (a) => window.__prov.request(a),
    };
    window.__prov = null; // set below
    window.__ADDR = addr;
  }, WALLET);
  await page.evaluateOnNewDocument((CHAIN_ID_P) => {
    // Build the provider inside the page so it can reach window.ethereum.
    const READS = new Set([
      'eth_chainId', 'eth_accounts', 'eth_requestAccounts', 'eth_getBalance',
      'eth_call', 'eth_blockNumber', 'eth_getBlockByNumber',
    ]);
    const RPCS = ['https://robinhood-testnet.drpc.org', 'https://rpc.testnet.chain.robinhood.com'];
    const provider = {
      isMetaMask: true,
      async request({ method, params }) {
        if (!READS.has(method)) throw new Error('test provider refuses ' + method);
        if (method === 'eth_chainId') return '0x' + CHAIN_ID_P.toString(16);
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [window.__ADDR];
        if (method === 'eth_getBlockByNumber') {
          return { number: '0x1', timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) };
        }
        let last;
        for (const u of RPCS) {
          try {
            const r = await fetch(u, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            });
            const j = await r.json();
            if (j.error) return { error: j.error };
            return j.result;
          } catch (e) { last = String(e); await new Promise((x) => setTimeout(x, 700)); }
        }
        throw new Error('all RPCs failed: ' + last);
      },
      on() {}, removeListener() {},
    };
    window.ethereum = provider;
    window.dispatchEvent(new Event('ethereum#initialized'));
  }, CHAIN_ID);
  await page.goto(process.env.PARITY_URL || 'http://localhost:4188', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await new Promise((r) => setTimeout(r, 4000));

  // CONNECT. The app never connects on its own -- it waits for a click on
  // #connect, which is why every earlier "verification" sat in preview with
  // the reconciliation code short-circuiting. Clicking the real button is what
  // exercises the path a player actually takes.
  await page.evaluate(() => document.getElementById('connect')?.click());
  // Then let bootChain + refreshChainTool + refreshChainGems settle.
  await new Promise((r) => setTimeout(r, 12000));
});

test.after(async () => { await browser?.close(); });

const dom = () => page.evaluate(() => {
  const s = window.__scene;
  return {
    tool: document.getElementById('belt-tool')?.textContent.trim() ?? null,
    counts: document.getElementById('belt-counts')?.textContent.trim() ?? null,
    roi: document.getElementById('roi')?.textContent.trim() ?? null,
    rank: document.getElementById('rank')?.textContent.trim() ?? null,
    finds: document.getElementById('finds')?.textContent.trim() ?? null,
    mode: document.getElementById('belt-mode')?.textContent.trim() ?? null,
    chain: document.getElementById('chaintext')?.textContent.trim() ?? null,
    mirror: s ? { tier: s.econ.tier, left: s.econ.left, max: s.econ.max, gems: [...s.econ.gems] } : null,
    connected: window.__walletState?.connected ?? null,
  };
});

test('the wallet is actually connected in the harness', async () => {
  const d = await dom();
  const onchain = d.mode && /ON-CHAIN/i.test(d.mode);
  assert.ok(onchain,
    `the app must be in ON-CHAIN mode for this suite to mean anything. mode=${JSON.stringify(d.mode)}`);
});

test('the card shows the chain tool state, not the local simulation', async () => {
  const d = await dom();
  // Ground truth: tier 1, 20/20, not broken.
  assert.equal(truth.broken, false, 'precondition: chain reports not broken');
  assert.ok(!/BROKEN/i.test(d.tool || ''),
    `card claims the tool is broken; chain says tier ${truth.toolTier} ${truth.durability}/${truth.durability} broken=false. tool=${JSON.stringify(d.tool)}`);
  assert.match(d.tool || '', new RegExp(`${truth.durability}/${truth.durability}`),
    `card must show ${truth.durability}/${truth.durability} from the chain. got ${JSON.stringify(d.tool)}`);
});

test('the mirror holds the chain tool, not zeros', async () => {
  const d = await dom();
  assert.equal(d.mirror?.tier, truth.toolTier,
    `mirror tier ${d.mirror?.tier} != chain ${truth.toolTier}`);
  assert.equal(d.mirror?.left, truth.durability,
    `mirror left ${d.mirror?.left} != chain ${truth.durability}`);
});

test('the satchel shows the chain gem balances, not local finds', async () => {
  const d = await dom();
  if (truth.held === 0) {
    // The chain has no gems. Any non-zero number on the card is invented.
    assert.ok(!/gems/i.test(d.counts || '') || /no gems/i.test(d.counts || ''),
      `chain holds 0 gems in all rarities; card says ${JSON.stringify(d.counts)}`);
  }
  assert.deepEqual(d.mirror?.gems, truth.gems,
    `mirror gems ${JSON.stringify(d.mirror?.gems)} != chain ${JSON.stringify(truth.gems)}`);
});

test('a page that boots with an already-authorised wallet is ON-CHAIN', async () => {
  // This is the case that produced the screenshot: a returning player whose
  // wallet was already authorised. The app only ever connected on a BUTTON
  // CLICK, so it booted into PREVIEW with an empty mirror and told a player
  // holding a full 20/20 pick to "buy Wood". Silent reconnect on boot fixes it.
  //
  // A separate browser: the main `before` clicks Connect, which would mask
  // this entirely.
  const b2 = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const pg = await b2.newPage();
    await pg.evaluateOnNewDocument((ADDR, CHAIN_ID_P, RPCS_P) => {
      const READS = new Set(['eth_chainId', 'eth_accounts', 'eth_requestAccounts',
        'eth_getBalance', 'eth_call', 'eth_blockNumber', 'eth_getBlockByNumber']);
      window.ethereum = {
        isMetaMask: true,
        async request({ method, params }) {
          if (!READS.has(method)) throw new Error('refuses ' + method);
          if (method === 'eth_chainId') return '0x' + CHAIN_ID_P.toString(16);
          // An authorised wallet answers without a prompt, and emits NO
          // accountsChanged event -- which is precisely why nothing fired.
          if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [ADDR];
          if (method === 'eth_getBlockByNumber') {
            return { number: '0x1', timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) };
          }
          let last;
          for (const u of RPCS_P) {
            try {
              const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
              const j = await r.json();
              if (j.error) return { error: j.error };
              return j.result;
            } catch (e) { last = String(e); await new Promise((x) => setTimeout(x, 700)); }
          }
          throw new Error('all RPCs failed: ' + last);
        },
        on() {}, removeListener() {},
      };
    }, WALLET, CHAIN_ID, RPCS);

    await pg.goto(process.env.PARITY_URL || 'http://localhost:4188', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await new Promise((r) => setTimeout(r, 15000));

    const d = await pg.evaluate(() => ({
      mode: document.getElementById('belt-mode')?.textContent.trim() ?? '',
      tool: document.getElementById('belt-tool')?.textContent.trim() ?? '',
      tier: window.__scene?.econ.tier,
      left: window.__scene?.econ.left,
    }));
    assert.match(d.mode, /ON-CHAIN/i,
      `an already-authorised wallet must not boot into preview. got ${JSON.stringify(d.mode)}`);
    assert.equal(d.tier, truth.toolTier, `mirror tier ${d.tier} != chain ${truth.toolTier}`);
    assert.equal(d.left, truth.durability, `mirror left ${d.left} != chain ${truth.durability}`);
  } finally {
    await b2.close();
  }
});

test('the harness itself is sound: it read a real chain', async () => {
  // If this fails the other assertions are meaningless -- e.g. if every RPC
  // failed and truth came back as zeros, "card matches chain" would pass
  // against a broken harness.
  assert.ok(truth.toolTier >= 1 && truth.toolTier <= 5, `implausible tier ${truth.toolTier}`);
  assert.ok(truth.durability > 0, 'a bought tool has durability');
  assert.ok(truth.balWei > 0n, 'the wallet holds ETH on testnet');
  assert.ok(truth.gems.length === 5);
});

test('a connected HUNT routes through the contract, not the local roll', async () => {
  // The connected reveal must call the contract's previewHunt (an eth_call)
  // rather than rolling locally. This harness's provider refuses WRITES, so
  // settleHuntOnchain returns send-failed and reveal() must report failure,
  // grant NOTHING, and leave the hunt index unmoved.
  const before = await page.evaluate(() => ({
    gems: window.__scene ? [...window.__scene.econ.gems] : null,
    hunts: window.__scene ? window.__scene.huntIndex : null,
  }));
  const r = await page.evaluate(async () => {
    const s = window.__scene;
    if (!s) return { err: 'no scene' };
    // A synthetic dig-node: reveal only needs x/y/active/setData/scale tweens.
    const calls = { previews: 0 };
    const node = { x: 0, y: 0, active: true, depth: 5, setData() {} };
    const out = { ok: null, gems: null, hunts: null };
    try {
      out.ok = await s.reveal(node);
      out.gems = [...s.econ.gems];
      out.hunts = s.huntIndex;
    } catch (e) { out.err = String((e && e.message) || e); }
    return out;
  });
  assert.equal(r.ok, false,
    `settlement through a read-only provider must fail cleanly, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.gems, before.gems, 'a failed settlement must not credit gems');
  assert.equal(r.hunts, before.hunts, 'a failed settlement must not advance the hunt index');
});