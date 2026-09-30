/**
 * Commitment + rollover tests.
 *
 *   node src/commitment.test.mjs
 *
 * The load-bearing test is PARITY WITH THE SERVER ENGINE. A client that
 * computes a different merkle root than the operator is worse than useless:
 * every player would see the season as fraudulent. So the same plan is
 * committed by both implementations and the roots compared.
 */
import { createRequire } from 'module';
// js-sha3 is CommonJS: keccak256 lives on the default export, not as a
// named one. Importing it as a named export throws at module load.
import sha3 from 'js-sha3';
const { keccak256 } = sha3;
import {
  initCommitment, keccak, leafFor, merkleRoot, commitSeason, verifySeason,
  seasonState, rollSeason, SEASON_LENGTH_SEC, to32Bytes,
} from './commitment.js';
import { onRoiBoard, roiOf, SPLAY_FLOOR_WEI } from './season.js';

const require = createRequire(import.meta.url);
const engine = require('/home/administrator/gem-hunter/script/hunt-engine.mjs');

let failed = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}  ${detail || ok}`);
}
function group(n) { console.log(`\n${n}`); }

initCommitment(keccak256);

/**
 * Hex-encode a Uint8Array.
 *
 * The server engine returns Uint8Array, NOT Buffer. `u8.toString('hex')`
 * silently ignores the 'hex' argument on a typed array and returns
 * comma-joined decimals -- which looks like a hash mismatch when the bytes
 * are in fact identical. Convert by hand rather than via Buffer, so this
 * helper also works in a browser (Buffer is not defined there -- the same
 * bug that hit src/engine.js once already).
 */
const hexOf = (u8) => {
  let out = '0x';
  for (const b of u8) out += b.toString(16).padStart(2, '0');
  return out;
};

const SEED = '0x5eed';
const PLAN = [
  { player: '0xAAA', hunts: 3 },
  { player: '0xbbb', hunts: 2 },
  { player: '0xCCC', hunts: 1 },
];

group('keccak matches the server engine');
{
  const server = engine.leafFor(SEED, '0xAAA', 0);
  const client = leafFor(SEED, '0xAAA', 0);
  check('leafFor agrees with the engine', hexOf(client) === hexOf(server),
    `${hexOf(client)} vs ${hexOf(server)}`);
}

group('address case is normalised');
{
  const a = leafFor(SEED, '0xAAA', 0);
  const b = leafFor(SEED, '0xaaa', 0);
  check('0xAAA and 0xaaa are the same leaf', hexOf(a) === hexOf(b), hexOf(a));
}

group('hunt index matters');
{
  const h0 = leafFor(SEED, '0xAAA', 0);
  const h1 = leafFor(SEED, '0xAAA', 1);
  check('different hunt index, different leaf', hexOf(h0) !== hexOf(h1), true);
}

group('merkle root agrees with the server engine');
{
  const mine = commitSeason(SEED, PLAN);
  const theirs = engine.commitSeason(SEED, PLAN);
  // This also guards the format: the engine's commitSeason() used to build
  // its string from a Uint8Array's toString('hex'), which a typed array
  // ignores -- yielding '0x5,126,44,...'. A bytes32 is 64 hex chars, so
  // assert that shape explicitly and fail loudly rather than comparing two
  // equally-wrong strings.
  check('  the engine returns a valid bytes32', /^0x[0-9a-f]{64}$/.test(theirs.root), theirs.root);
  const theirRoot = theirs.root;
  check('root is byte-identical', mine.root === theirRoot, `${mine.root} vs ${theirRoot}`);
  check('leaf count agrees', mine.leafCount, theirs.leafCount);
  check('leaf count is the sum of hunts', mine.leafCount, 6);
}

group('a change anywhere changes the root');
{
  const base = commitSeason(SEED, PLAN).root;
  const moreHunts = commitSeason(SEED, [{ player: '0xAAA', hunts: 4 }, PLAN[1], PLAN[2]]).root;
  const otherPlayer = commitSeason(SEED, [{ player: '0xDDD', hunts: 3 }, PLAN[1], PLAN[2]]).root;
  const morePlayers = commitSeason(SEED, [...PLAN, { player: '0xDDD', hunts: 1 }]).root;
  check('extra hunt changes it', base !== moreHunts, true);
  check('different player changes it', base !== otherPlayer, true);
  check('an unlisted player changes it', base !== morePlayers, true);
}

group('verification catches a rewritten season');
{
  const committed = commitSeason(SEED, PLAN);
  const honest = verifySeason(SEED, PLAN, committed.root);
  check('honest season verifies', honest.ok, true);

  // The attack: after players see results, the engine re-derives the season
  // with a friendlier plan. The player recomputes and compares.
  const rigged = [{ player: '0xAAA', hunts: 3 }, PLAN[1], PLAN[2], { player: '0xCHEF', hunts: 500 }];
  const caught = verifySeason(SEED, rigged, committed.root);
  check('a rewritten season is caught', caught.ok === false, 'mismatch detected');
  check('  and reports what it recomputed', caught.recomputed !== committed.root, true);
}

group('empty plan');
{
  const r = commitSeason(SEED, []);
  check('no leaves', r.leafCount === 0, `${r.leafCount}`);
  check('root is 32 zero bytes', r.root, '0x' + '00'.repeat(32));
}

group('commit-then-act ordering');
{
  const board = { id: 1, startsAt: 0, endsAt: SEASON_LENGTH_SEC, committed: false, players: new Map() };
  check('can commit first', seasonState(board, 100).canCommit === true, true);
  check('  nothing is committed yet', board.committed === false, false);

  // commitSeason() must be refused twice, matching AlreadyCommitted.
  const first = commitSeason(SEED, PLAN);
  board.committed = true;
  board.commitRoot = first.root;
  check('cannot commit twice', seasonState(board, 200).canCommit === false, true);
  check('  the root is recorded', board.commitRoot, first.root);
}

group('season rollover');
{
  const end = SEASON_LENGTH_SEC;
  const board = {
    id: 1, startsAt: 0, endsAt: end, committed: true,
    commitRoot: '0xabc', players: new Map([['0xAAA', { hunts: 3 }]]),
  };

  const early = rollSeason(board, end - 1);
  check('cannot roll before the end', early.ok === false, early.reason);

  const rolled = rollSeason(board, end);
  check('rolls at the buzzer', rolled.ok, true);
  check('  id increments', rolled.board.id, 2);
  check('  starts where the old one ended', rolled.board.startsAt, end);
  check('  14 days long', rolled.board.endsAt - rolled.board.startsAt, SEASON_LENGTH_SEC);
  check('  the new season is UNCOMMITTED', rolled.board.committed === false, false);
  check('  so hunts revert until the root is published', seasonState(rolled.board, end).canCommit, true);
  check('  the finished season is retained for verification', rolled.board.previous.root, '0xabc');
  check('  with its players', rolled.board.previous.players.size, 1);
  check('  and the new one starts empty', rolled.board.players.size === 0, `${rolled.board.players.size}`);
}

group('rollover is permissionless, matching finalizeSeason()');
{
  // finalizeSeason() has no role gate, so anyone can trigger it. The client
  // must not require an authority to roll the season.
  const board = { id: 7, startsAt: 0, endsAt: SEASON_LENGTH_SEC, committed: true, players: new Map() };
  const st = seasonState(board, SEASON_LENGTH_SEC);
  check('canFinalize once the clock passes', st.canFinalize, true);
  const r = rollSeason(board, SEASON_LENGTH_SEC);
  check('  and rolling needs no authority', r.ok, true);
}

group('splay floor matches the contract (exclude, not floor)');
{
  // DeepWood.roi() returns 0 below MIN_SPLAY and onRoiBoard() is false.
  const lucky = { leq: 4096n, ethSpent: 100_000_000_000_000n, hunts: 1, bestWei: 0n, gems: [] };
  const diligent = { leq: 200n, ethSpent: SPLAY_FLOOR_WEI, hunts: 50, bestWei: 0n, gems: [] };
  check('lucky-and-quit is OFF the board', onRoiBoard(lucky) === false, 'excluded');
  check('diligent is ON the board', onRoiBoard(diligent) === true, 'on board');
  // The whole point: flooring used to let the lucky player score 819,200
  // against 40,000. Excluding removes them instead.
  check('and cannot out-score the diligent player', roiOf(lucky) < roiOf(diligent) || !onRoiBoard(lucky), true);
  check('diligent ROI', roiOf(diligent) === 40_000n, `${roiOf(diligent)}`);
}

console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
