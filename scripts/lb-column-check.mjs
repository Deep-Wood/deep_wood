// Measure the leaderboard column against the LOCAL build (dist preview) so we
// validate the change before shipping. Serves dist/, opens the leaderboard,
// and measures panel geometry + grid lines at desktop and phone sizes.
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';

const ROOT = new URL('../dist/', import.meta.url);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  let p = new URL(req.url, 'http://x').pathname;
  if (p === '/' || p.endsWith('/')) p += 'index.html';
  try {
    const body = readFileSync(new URL('.' + p, ROOT));
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('nf');
  }
});
await new Promise((r) => server.listen(0, r));
const BASE = 'http://localhost:' + server.address().port + '/';

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });

async function probe(width, height, mobile) {
  const page = await browser.newPage();
  if (mobile) await page.emulate({ viewport: { width, height, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' });
  else await page.setViewport({ width, height });
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction('window.__scene', { timeout: 30000 }).catch(() => {});
  const opened = await page.evaluate(() => {
    const s = window.__scene;
    if (s && typeof s.toggleLeaderboard === 'function') { s.toggleLeaderboard(); return true; }
    return false;
  });
  let panel = null;
  let withDataRow = null;
  for (let i = 0; i < 60; i++) {
    panel = await page.evaluate(() => {
      const p = document.querySelector('.lb-panel');
      if (!p) return null;
      // Inject one synthetic data row so cell borders are measurable even
      // when the live board is empty. Done BEFORE measuring; removed after.
      const tb = p.querySelector('.lb-table tbody');
      if (tb && !tb.querySelector('.lb-rank-cell')) {
        const tr = document.createElement('tr');
        tr.className = 'lb-row';
        tr.innerHTML = '<td class="lb-rank-cell"><span class="lb-rank">1</span></td>'
          + '<td class="lb-addr">0x1234…abcd</td>'
          + '<td class="lb-roi">12x</td>'
          + '<td class="lb-best">0.05</td>';
        tb.appendChild(tr);
      }
      const r = p.getBoundingClientRect();
      const table = p.querySelector('.lb-table');
      const th = table ? table.querySelector('thead th:nth-child(2)') : null;
      const cs = th ? getComputedStyle(th) : null;
      const tdMid = table ? table.querySelector('tbody td:nth-child(2)') : null;
      const tdcs = tdMid ? getComputedStyle(tdMid) : null;
      const tdRoi = table ? table.querySelector('tbody td:nth-child(3)') : null;
      const roics = tdRoi ? getComputedStyle(tdRoi) : null;
      withDataRow = null;
      return {
        panel: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        screen: { w: innerWidth, h: innerHeight },
        widthPct: Math.round((r.width / innerWidth) * 100),
        heightPct: Math.round((r.height / innerHeight) * 100),
        rightDocked: Math.round(innerWidth - (r.x + r.width)) <= 1,
        vGridOnHeader: cs ? cs.borderRightWidth !== '0px' : null,
        vGridOnCell: tdcs ? tdcs.borderRightWidth !== '0px' : null,
        vGridOnRoiCell: roics ? roics.borderRightWidth !== '0px' : null,
        hGridOnCell: tdcs ? tdcs.borderBottomWidth !== '0px' : null,
        rows: table ? table.querySelectorAll('tbody tr').length : 0,
      };
    });
    if (panel) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const shot = `/tmp/lbcol-${width}.png`;
  if (panel) await page.screenshot({ path: shot });
  await page.close();
  return { opened, panel, shot };
}

const desktop = await probe(1280, 800, false);
const phone = await probe(390, 844, true);
console.log(JSON.stringify({ desktop, phone }, null, 1));
await browser.close();
server.close();
