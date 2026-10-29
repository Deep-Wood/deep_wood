// Verify the V4 pool from the LIVE GAME CONTRACT, not from any transcribed
// constant. The game exposes POOL_MANAGER() and POOL_ID(); those are the only
// trustworthy source for the pool identity, and every client-side copy has
// already been proven wrong by transcription errors.
//
// Usage: node scripts/verify-v4.mjs

const GAME = '0x950c43d73051e7ad875c3a2e108a5828e5dffb4c';
const RPCS = [
  'https://rpc.testnet.chain.robinhood.com',
  'https://robinhood-testnet.drpc.org',
];

const SEL_POOL_MANAGER = '0x62308e85'; // POOL_MANAGER()
const SEL_POOL_ID = '0xe0d7d0e9'; // POOL_ID()

async function rpcFirst(urls, to, data, method = 'eth_call') {
  let lastErr;
  for (const url of urls) {
    try {
      const params = method === 'eth_call' ? [{ to, data }, 'latest'] : [to, 'latest'];
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await res.json();
      if (j.error) throw new Error(`${url}: ${j.error.message}`);
      return { url, result: j.result };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

const wordToAddress = (hex) => '0x' + hex.replace(/^0x/, '').slice(-40).toLowerCase();

async function main() {
  console.log('== reading POOL_MANAGER() and POOL_ID() from the live game contract ==');
  const pm = await rpcFirst(RPCS, GAME, SEL_POOL_MANAGER);
  const pid = await rpcFirst(RPCS, GAME, SEL_POOL_ID);
  const poolManager = wordToAddress(pm.result);
  const poolId = '0x' + pid.result.replace(/^0x/, '').slice(-64).toLowerCase();

  console.log('POOL_MANAGER() ->', poolManager, '(len after 0x:', poolManager.slice(2).length, ')');
  console.log('POOL_ID()      ->', poolId, '(len after 0x:', poolId.slice(2).length, ')');

  console.log('\n== confirming the PoolManager is a deployed contract ==');
  const code = await rpcFirst(RPCS, poolManager, null, 'eth_getCode');
  console.log('code bytes at POOL_MANAGER:', (code.result.length - 2) / 2);

  console.log('\n== spot price from PoolManager.slot0(poolId) ==');
  const SEL_SLOT0 = '0xdf90153a'; // slot0(bytes32)
  const s0 = await rpcFirst(RPCS, poolManager, SEL_SLOT0 + poolId.slice(2));
  const h = s0.result.replace(/^0x/, '');
  const sqrtPriceX96 = BigInt('0x' + h.slice(0, 64));
  const tickWord = BigInt('0x' + h.slice(64, 128));
  const tickRaw = tickWord & 0xffffffn;
  const tick = Number(tickRaw >= 0x800000n ? tickRaw - 0x1000000n : tickRaw);

  const Q96 = 2n ** 96n;
  const ratio = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) / (Q96 * Q96);
  const deepPerEth = Number(ratio) / 1e18;

  console.log('sqrtPriceX96   :', sqrtPriceX96.toString());
  console.log('tick           :', tick);
  console.log('DEEP per ETH   :', deepPerEth.toFixed(6));

  // Sanity: an empty pool reads tick 0 and price 1.0e0 -> ~1 DEEP per ETH,
  // which is nonsense for a token with liquidity. Flag it rather than
  // presenting a fake estimate.
  if (tick === 0 && ratio === 10n ** 18n) {
    console.log('\n!! tick 0 and ratio 1.0 -- this pool looks UNINITIALISED (no liquidity).');
    console.log('!! A swap into it would return ~0 tokens. Do NOT show an estimate.');
  } else {
    for (const eth of ['0.005', '0.01']) {
      const wei = BigInt(Math.floor(Number(eth) * 1e18));
      const out = (Number(wei * ratio) / 10n ** 18n) / 1e18;
      console.log(`est. ${eth} ETH -> ${out.toFixed(4)} DeepWood (spot, before hook cut + slippage)`);
    }
  }

  // Read the client constants OUT OF src/chain.js rather than retyping them
  // here: every hand-transcription of these addresses this session has been
  // wrong at least once, and a checker that can itself corrupt the value it
  // is checking proves nothing.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/chain.js', import.meta.url), 'utf8');
  const grab = (name) => {
    const m = src.match(new RegExp(`export const ${name} = '([^']+)'`));
    return m ? m[1] : null;
  };
  const cMgr = grab('V4_POOL_MANAGER');
  const cKey = grab('V4_POOL_KEY');
  console.log('\n== client constants (read from src/chain.js) vs chain ==');
  console.log('chain.js V4_POOL_MANAGER :', cMgr);
  console.log('chain()      POOL_MANAGER:', poolManager);
  console.log('chain.js V4_POOL_KEY     :', cKey);
  console.log('chain()      POOL_ID     :', poolId);
  console.log('MANAGER MATCH:', cMgr === poolManager);
  console.log('POOL_ID MATCH:', cKey === poolId);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
