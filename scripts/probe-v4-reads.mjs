// Probe the real view-function selectors on the PoolManager. Do not guess which
// signature a V4 fork exposes: try the candidates and report what answers.
//
// Usage: node scripts/probe-v4-reads.mjs

const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const POOL_ID = '0x03a370182b086617172ce27a70b612d30ae635113f06f7088254586914abfdab';
const RPCS = [
  'https://rpc.testnet.chain.robinhood.com',
  'https://robinhood-testnet.drpc.org',
];

// keccak256(signature)[0:4] computed locally so the candidates cannot be
// mistyped.
function keccakBytes(bytes) {
  // Minimal keccak-256 (public domain implementation) for a fixed 4-byte need.
  const RC = [0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b,
    0x80000001, 0x80008081, 0x00008009, 0x0000008a, 0x00000088, 0x80008009,
    0x8000000a, 0x8000808b, 0x0000008b, 0x00008089, 0x00008003, 0x00008002,
    0x00000080, 0x0000800a, 0x8000000a, 0x80008081, 0x00008080, 0x80000001,
    0x80008008];
  const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
  function keccakF(s) {
    for (let round = 0; round < 24; round++) {
      const C = [0, 0, 0, 0, 0], D = [0, 0, 0, 0, 0];
      for (let x = 0; x < 5; x++) {
        C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
      }
      for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) s[x + 5 * y] ^= D[x];
      }
      const B = new Array(25);
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ((x + 3 * y) % 5) * 1 > 0 ? [0, 1, 6, 12, 20, 24, 4, 10, 16, 22, 3, 9, 14, 19, 2, 8, 15, 21, 5, 11, 17, 23, 7, 13, 18][(x + 3 * y) % 25] : 0);
      }
      for (let i = 0; i < 25; i++) s[i] = B[i];
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) s[x + 5 * y] ^= RC[((x + y) % 5) === 0 ? 0 : 0];
      }
      s[0] ^= 0;
    }
    return s;
  }
  // NOTE: the rotation table above is intentionally NOT used; see keccak256 below.
  throw new Error('use keccak256 import');
}
void keccakBytes;

// --- Keccak-256, straightforward sponge over 64-bit lanes ---
const KECCAK_ROUNDS = 24;
const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROTATION = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];
const MASK = (1n << 64n) - 1n;
const rotl64 = (x, n) => ((x << n) | (x >> (64n - n))) & MASK;

function keccakF1600(state) {
  for (let round = 0; round < KECCAK_ROUNDS; round++) {
    const C = [];
    for (let x = 0; x < 5; x++) {
      C.push(state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]);
    }
    const D = [];
    for (let x = 0; x < 5; x++) D.push(C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1n));
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) state[x + 5 * y] ^= D[x];
    }
    const B = [];
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(state[x + 5 * y], BigInt(ROTATION[x + 5 * y]));
    }
    for (let i = 0; i < 25; i++) state[i] = B[i];
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) state[x + 5 * y] ^= ROUND_CONSTANTS[(x + y) % 5];
    }
    state[0] ^= BigInt(round);
  }
}

function keccak256(input) {
  const rate = 136; // bytes, for 1088-bit rate / 512-bit capacity
  const padded = Buffer.from(input);
  const padLen = rate - (padded.length % rate);
  const total = padded.length + padLen;
  const buf = Buffer.concat([padded, Buffer.alloc(padLen)]);
  buf[padded.length] ^= 0x01;
  buf[total - 1] ^= 0x80;
  const state = new Array(25).fill(0n);
  for (let off = 0; off < total; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      state[i] ^= buf.readBigUInt64LE(off + i * 8);
    }
    keccakF1600(state);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(state[i], i * 8);
  return out;
}

const selector = (sig) => '0x' + keccak256(Buffer.from(sig, 'utf8')).slice(0, 4).toString('hex');

async function callFirst(to, data) {
  let last;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
      });
      const j = await res.json();
      if (j.error) { last = new Error(j.error.message); continue; }
      return { url, result: j.result };
    } catch (e) { last = e; }
  }
  throw last;
}

const CANDIDATES = [
  ['slot0(bytes32)', selector('slot0(bytes32)')],
  ['getSlot0(bytes32)', selector('getSlot0(bytes32)')],
  ['liquidity(bytes32)', selector('liquidity(bytes32)')],
  ['getLiquidity(bytes32)', selector('getLiquidity(bytes32)')],
  ['poolSlot0(bytes32)', selector('poolSlot0(bytes32)')],
  ['tickSpacing(bytes32)', selector('tickSpacing(bytes32)')],
  ['feeProtocol(bytes32)', selector('feeProtocol(bytes32)')],
];

console.log('poolId:', POOL_ID);
console.log('manager:', POOL_MANAGER, '\n');
for (const [sig, sel] of CANDIDATES) {
  const label = `${sig} [${sel}]`;
  try {
    const { url, result } = await callFirst(POOL_MANAGER, sel + POOL_ID.slice(2));
    const words = (result.replace(/^0x/, '').length / 64) | 0;
    console.log(`OK    ${label}  words=${words}  ${result.slice(0, 74)}${result.length > 74 ? '…' : ''}`);
  } catch (e) {
    console.log(`FAIL  ${label}  ${e.message}`);
  }
}
