// Endless forest: does the world actually not end?
//
// The claim under test is "the character should not hit a wall while walking".
// The old world stopped dead at 1280x960. This walks the player far past that
// -- several thousand pixels, through several chunk boundaries -- and checks
// that (a) they keep moving, (b) chunks load and unload around them, and (c)
// collision is still live afterwards, which is the regression that a naive
// unloadChunk would introduce.
//
//   node endless-smoke.mjs
import puppeteer from 'puppeteer';

const URL = process.argv[2] || 'http://127.0.0.1:5173/';
let fails = 0;
const check = (n, ok, d = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}${d ? ' — ' + d : ''}`);
  if (!ok) fails++;
};

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForFunction('window.__scene && window.__scene.player', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1200));

// Teleport the player and let the streamer do its work. Driving with real key
// presses for 4000px would take over half a minute and test the input path
// rather than the streaming path.
const walk = async (toX, toY, label) => {
  await page.evaluate(([x, y]) => {
    const s = window.__scene;
    s.player.setPosition(x, y);
    s.refreshChunks(true);
  }, [toX, toY]);
  await new Promise((r) => setTimeout(r, 700));
  return page.evaluate(() => {
    const s = window.__scene;
    return {
      x: Math.round(s.player.x), y: Math.round(s.player.y),
      chunks: s.chunks.size,
      nodes: s.nodes.length,
      trunks: s.trunks.children.size,
      sortables: s.sortables.length,
    };
  });
};

const atSpawn = await page.evaluate(() => ({
  x: Math.round(window.__scene.player.x),
  chunks: window.__scene.chunks.size,
}));

const far = await walk(4200, 3100, 'far east');
check('player exists well past the old 1280x960 world', far.x >= 4000, `x=${far.x}`);
check('chunks streamed in around the new position', far.chunks > 0, `${far.chunks} chunks`);
check('nodes exist out there', far.nodes > 0, `${far.nodes} nodes`);
check('trees have colliders out there', far.trunks > 0, `${far.trunks} trunks`);

// Walk far the OTHER way, so we cross a negative boundary and the floor() path
// in chunkOf is exercised rather than assumed.
const west = await walk(-3800, -2600, 'far west');
check('player reaches negative coordinates', west.x <= -3000, `x=${west.x}`);
check('chunks streamed in the negative direction', west.chunks > 0, `${west.chunks} chunks`);

// Nothing must be unloaded-but-still-referenced, and the display list must not
// grow without bound. If unloadChunk leaks, sortables climbs forever.
const near = await walk(0, 0, 'back to spawn');
check('returning to spawn restores a normal chunk count', near.chunks > 0 && near.chunks < 40,
  `${near.chunks} chunks, ${near.sortables} sortables`);
check('object count is bounded after a long walk', near.sortables < 2000,
  `${near.sortables} sortables`);

// Collision must still work. This is the regression that colliders.destroy()
// would have caused: walk into a tree and stop short of its far side.
const collide = await page.evaluate(async () => {
  const s = window.__scene;
  // Use getChildren(), not `children`. Phaser Group.children is a Map, so
  // Array.from() yields [key, value] pairs with no .body and the probe found
  // zero trunks out of 149 -- which first surfaced as a VACUOUS PASS and only
  // became visible once the check was made to fail when its probe fails.
  const all = s.trunks.getChildren();
  const trunk = all.find((t) => t.body && typeof t.x === 'number');
  if (!trunk) return { ok: false, why: `no trunk body among ${all.length} trunks` };
  const tx = trunk.x, ty = trunk.y;
  s.player.setPosition(tx - 40, ty);
  s.player.setVelocity(200, 0);
  await new Promise((r) => setTimeout(r, 1200));
  s.player.setVelocity(0, 0);
  return { ok: true, stoppedBefore: tx, x: Math.round(s.player.x) };
});
// No vacuous pass: if the probe could not find a tree, this FAILS rather than
// reporting a guarantee it never checked.
check('collision still live after streaming',
  collide.ok && collide.x < collide.stoppedBefore,
  collide.ok ? `stopped at x=${collide.x}, tree at ${collide.stoppedBefore}` : 'PROBE FAILED: ' + collide.why);

// A new seed must reshuffle the world entirely.
const reshuffle = await page.evaluate(() => {
  const s = window.__scene;
  const before = JSON.stringify(s.chunks.get('0,0'));
  const orig = s.seasonSeed;
  s.seasonSeed = '0xdeadbeefdeadbeef';
  s.epochByKey = {};
  s.chunks.clear();
  s._lastChunk = null;
  s.refreshChunks(true);
  const after = JSON.stringify(s.chunks.get('0,0'));
  s.seasonSeed = orig;
  return { differ: before !== after };
});
check('a new season seed reshuffles chunk 0,0', reshuffle.differ);

check('no console or page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'clean');

await browser.close();
console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nENDLESS FOREST PASSED');
process.exit(fails ? 1 : 0);