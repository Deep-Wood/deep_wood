/**
 * Camp card V10 sections: Descend (prestige) and Research (luck).
 *
 * Both are LIVE-number panels mounted into the existing Camp card's DOM
 * (camp.js owns the card's lifecycle; this module only fills two sections
 * on open). Every figure is read from the chain -- the multiplier, the
 * next study cost, the counts -- because every one of them is
 * owner-settable and a mirrored constant would lie after any retune.
 *
 * DESCEND is destructive and must read like it: the section shows exactly
 * what resets and what stays, the multiplier you have NOW, and the button
 * asks for a second explicit confirmation in place before it opens the
 * wallet. No accidental prestige.
 */

import { studyCost, DESCEND_RESETS, DESCEND_KEEPS } from './v10.js';

const RARITY_NAMES = ['Quartz', 'Amber', 'Sapphire', 'Ruby', 'Diamond'];

/**
 * @param {object} o
 * @param {() => Promise<{
 *   leq:bigint, prestigeCount:bigint, luckLevel:number, maxLuckLevel:number,
 *   nextStudyCost:bigint|null, prestigeBps:bigint,
 *   config:{minLeq:bigint, luckBpsPerLevel:bigint, researchSurvives:boolean}
 * }|null>} o.readPanel   live V10 panel read (v10.readV10Panels)
 * @param {() => Promise<{ok:boolean, reason?:string}>} o.onDescend
 * @param {() => Promise<{ok:boolean, reason?:string}>} o.onStudy
 * @param {() => void} o.onDone                      repaint after a confirmed write
 * @param {(msg:string, kind?:string) => void} [o.onStatus]
 */
export function createCampV10({ readPanel, onDescend, onStudy, onDone, onStatus }) {
  const rootDescend = document.getElementById('camp-descend');
  const rootResearch = document.getElementById('camp-research');
  const elMult = document.getElementById('descend-mult');
  const elLuck = document.getElementById('research-luck');
  if (!rootDescend || !rootResearch) return null;

  let busy = false;

  const fmt = (v) => BigInt(v).toLocaleString('en-US');
  const bpsToX = (bps) => `${(Number(bps) / 10000).toFixed(2)}\u00d7`;

  const renderDescend = (p) => {
    const atFloor = p.leq >= p.config.minLeq;
    elMult.textContent = `find weight ${bpsToX(p.prestigeBps)}`;
    const resets = DESCEND_RESETS.map((r) => `<li class="cv-lose">${r}</li>`).join('');
    const keeps = DESCEND_KEEPS.map((r) => `<li class="cv-keep">${r}</li>`).join('');
    rootDescend.innerHTML = `
      <div class="cv-copy">Descend wipes your run for a permanent find-weight multiplier.
        Lifetime leq <b>${fmt(p.leq)}</b> \u2192 <b>${bpsToX(p.prestigeBps)}</b> now.
        Descends done: <b>${fmt(p.prestigeCount)}</b>.</div>
      <div class="cv-lists">
        <ul class="cv-list">${resets}</ul>
        <ul class="cv-list">${keeps}</ul>
      </div>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cv-btn';
    btn.disabled = !atFloor || busy;
    btn.textContent = atFloor ? 'Descend\u2026' : `Needs lifetime leq ${fmt(p.config.minLeq)}`;
    btn.addEventListener('click', async () => {
      if (busy) return;
      // Second explicit confirmation IN PLACE: descend resets the run.
      if (!btn.dataset.confirm) {
        btn.dataset.confirm = '1';
        btn.textContent = 'Wipe satchel, tool and skill \u2014 confirm';
        btn.classList.add('cv-danger');
        setTimeout(() => {
          btn.dataset.confirm = '';
          btn.textContent = 'Descend\u2026';
          btn.classList.remove('cv-danger');
        }, 4000);
        return;
      }
      busy = true;
      btn.disabled = true;
      btn.textContent = 'Confirm in wallet\u2026';
      const res = await onDescend();
      busy = false;
      btn.dataset.confirm = '';
      btn.classList.remove('cv-danger');
      if (!res.ok) {
        onStatus?.(res.reason || 'Descend failed.', 'bad');
      } else {
        onStatus?.('Descended \u2014 find weight raised permanently.', 'ok');
        onDone?.();
      }
      refresh();
    });
    rootDescend.appendChild(btn);
  };

  const renderResearch = (p) => {
    const lvl = p.luckLevel;
    const capped = lvl >= p.maxLuckLevel;
    const cur = capped ? 'maxed' : `+${Number(p.config.luckBpsPerLevel) * lvl} bps`;
    elLuck.textContent = `luck ${cur}`;
    const costLine = capped
      ? `<div class="cv-copy">Luck research is maxed at level ${lvl}: +${Number(p.config.luckBpsPerLevel) * lvl} bps on every future roll.</div>`
      : `<div class="cv-copy">Each luck level adds <b>+${fmt(p.config.luckBpsPerLevel)} bps</b> to your find weight, permanently.
           Next level burns <b>${fmt(p.nextStudyCost)} Quartz</b>. Costs double per level.</div>`;
    rootResearch.innerHTML = costLine;
    if (!capped) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cv-btn';
      btn.disabled = busy;
      btn.textContent = `Study \u2014 ${fmt(p.nextStudyCost)} Quartz`;
      btn.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        btn.disabled = true;
        btn.textContent = 'Confirm in wallet\u2026';
        const res = await onStudy();
        busy = false;
        if (!res.ok) {
          onStatus?.(res.reason || 'Study failed.', 'bad');
        } else {
          onStatus?.('Studied \u2014 luck raised.', 'ok');
          onDone?.();
        }
        refresh();
      });
      rootResearch.appendChild(btn);
    }
  };

  const refresh = async () => {
    const p = await readPanel();
    if (!p) {
      rootDescend.innerHTML = '<div class="cv-copy">Live prestige numbers unavailable right now.</div>';
      rootResearch.innerHTML = '<div class="cv-copy">Live research numbers unavailable right now.</div>';
      return;
    }
    renderDescend(p);
    renderResearch(p);
  };

  return { refresh };
}
