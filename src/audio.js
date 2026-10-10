/**
 * Procedural audio for DeepWood. Everything is synthesized with the Web Audio
 * API -- no audio files, no loading, no codec support issues (music excepted,
 * which arrives as a real file wired into its own bus).
 *
 * THREE CATEGORY BUSES, each with its own on/off switch (the pill toggles):
 *   sfx   - dig strikes + footsteps + gem reveal chime
 *   amb   - wind gusts + leaves + approved bird chorus
 *   music - background music (file attached later via attachMusic())
 *
 * master -> [sfx, amb, music] -> destination. Muting one category is one
 * gain write on its bus; the other two keep playing. Choices persist in
 * localStorage (dw-sound-prefs) and survive reloads.
 *
 * Bird call types are the user-approved samples from the audio review:
 * chirp (1), warble (2), twoNote (3), distant twitter (6). Crow and owl
 * were rejected. Wind is a gusting cycle (sample 9) -- never a constant shhh.
 */

let ctx = null;
let master = null;
const buses = {};          // name -> { gain, enabled }
let ambientRunning = false;
let ambientTimers = [];
let musicEl = null;        // <audio> element for the music file
let musicSrcNode = null;   // MediaElementAudioSourceNode, created once
let _prefs = null;

/** Category defaults; persisted to localStorage as dw-sound-prefs. */
const BUS_DEFAULTS = { sfx: true, amb: true, music: true };

function loadPrefs() {
  try {
    const raw = localStorage.getItem('dw-sound-prefs');
    if (raw) return { ...BUS_DEFAULTS, ...JSON.parse(raw) };
  } catch (_) { /* corrupted prefs fall back to defaults */ }
  return { ...BUS_DEFAULTS };
}
function savePrefs() {
  try { localStorage.setItem('dw-sound-prefs', JSON.stringify(_prefs)); } catch (_) {}
}
function prefs() {
  if (!_prefs) _prefs = loadPrefs();
  return _prefs;
}

/** Lazily create the AudioContext + the three buses. Call from a gesture. */
function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
  for (const name of Object.keys(BUS_DEFAULTS)) {
    const gain = ctx.createGain();
    gain.gain.value = prefs()[name] ? 1 : 0;
    gain.connect(master);
    buses[name] = { gain, enabled: prefs()[name] };
  }
  return ctx;
}

/** Resume the context if the browser suspended it (autoplay policy). */
export function resumeAudio() {
  const c = ensureCtx();
  if (c && c.state === 'suspended') c.resume();
}

/** True once the context exists and is running. */
export function audioReady() {
  return !!(ctx && ctx.state === 'running');
}

/** Read a category switch. Works before the context exists (reads prefs). */
export function busEnabled(name) {
  return buses[name] ? buses[name].enabled : (prefs()[name] ?? true);
}

/** Flip a category switch. Persists and ramps the bus gain. */
export function setBusEnabled(name, on) {
  on = !!on;
  prefs()[name] = on;
  savePrefs();
  const b = buses[name];
  if (b) {
    b.enabled = on;
    if (ctx) b.gain.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.04);
  }
  // Music is an element: pause/resume it with the switch so it does not
  // silently chew CPU while muted.
  if (name === 'music' && musicEl) {
    if (on) musicEl.play().catch(() => {});
    else musicEl.pause();
  }
}

/** True if any category is on -- drives the main sound button's icon. */
export function anyBusOn() {
  return Object.keys(BUS_DEFAULTS).some((n) => busEnabled(n));
}

/** One shared white-noise buffer, reused by every noise voice. */
let _noiseBuf = null;
function noiseBuf() {
  if (_noiseBuf) return _noiseBuf;
  const len = Math.floor(ctx.sampleRate * 2);
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  _noiseBuf = b;
  return b;
}

// ---------------------------------------------------------------------------
// AMBIENT bus: gusting wind, leaves, approved bird chorus
// ---------------------------------------------------------------------------

/**
 * Start the ambient soundscape (idempotent). The wind GUSTS: each of two
 * voices swells from near-silence to a soft peak over 3-6s, then dies over
 * 4-9s -- the forest breathes rather than hissing. Leaves rustle in the
 * same rhythm, quieter. Birds call on their own clock.
 */
export function startAmbient() {
  const c = ensureCtx();
  if (!c || ambientRunning) return;
  ambientRunning = true;
  const amb = buses.amb.gain;

  // Two wind voices, crossfaded by their own gust clocks.
  for (let v = 0; v < 2; v++) {
    const src = c.createBufferSource();
    src.buffer = noiseBuf();
    src.loop = true;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 300 + v * 140;
    lp.Q.value = 0.4;
    const g = c.createGain();
    g.gain.value = 0; // starts SILENT; only gusts bring it up
    src.connect(lp).connect(g).connect(amb);
    src.start();

    const gustCycle = () => {
      if (!ctx || !ambientRunning) return;
      const t = ctx.currentTime;
      const peak = 0.015 + Math.random() * 0.045; // soft peaks only
      const rise = 3 + Math.random() * 3;
      const fall = 4 + Math.random() * 5;
      g.gain.setTargetAtTime(peak, t, rise / 3);
      g.gain.setTargetAtTime(0.0015, t + rise, fall / 3);
      ambientTimers.push(setTimeout(gustCycle, (rise + fall + 1 + Math.random() * 5) * 1000));
    };
    ambientTimers.push(setTimeout(gustCycle, v === 0 ? 500 : 6000));
  }

  // Leaves: quiet highpass rustle, gusting in the wind's rhythm.
  const leafSrc = c.createBufferSource();
  leafSrc.buffer = noiseBuf();
  leafSrc.loop = true;
  const leafHP = c.createBiquadFilter();
  leafHP.type = 'highpass';
  leafHP.frequency.value = 2600;
  const leafG = c.createGain();
  leafG.gain.value = 0;
  leafSrc.connect(leafHP).connect(leafG).connect(amb);
  leafSrc.start();
  const leafCycle = () => {
    if (!ctx || !ambientRunning) return;
    const t = ctx.currentTime;
    leafG.gain.setTargetAtTime(0.003 + Math.random() * 0.008, t, 1.8);
    leafG.gain.setTargetAtTime(0.0004, t + 3, 2.5);
    ambientTimers.push(setTimeout(leafCycle, 6000 + Math.random() * 8000));
  };
  ambientTimers.push(setTimeout(leafCycle, 2500));

  // Birds: approved call types only -- chirp (1), warble (2), twoNote (3),
  // distant twitter (6). Crow and owl were rejected in the review.
  const CHORUS = ['chirp', 'chirp', 'warble', 'twoNote', 'distant'];
  const chorus = () => {
    if (!ctx || !ambientRunning) return;
    if (buses.amb.enabled) birdCall(CHORUS[(Math.random() * CHORUS.length) | 0]);
    ambientTimers.push(setTimeout(chorus, 3000 + Math.random() * 8000));
  };
  ambientTimers.push(setTimeout(chorus, 1200));
}

/**
 * The bird call. Approved types only (from the audio review samples):
 *   chirp   -- sample 1, two quick sine syllables, up-down sweep
 *   warble  -- sample 2, fast up-down wobble (wren-like)
 *   twoNote -- sample 3, low-then-high call
 *   distant -- sample 6, far-off descending twitter, very quiet
 * Crow and owl were rejected by the user. Panned to a random side,
 * distant = quieter.
 */
function birdCall(type) {
  const t = ctx.currentTime + Math.random() * 0.25;
  const pan = ctx.createStereoPanner();
  pan.pan.value = (Math.random() * 2 - 1) * 0.75;
  const dist = 0.25 + Math.random() * 0.55;
  const out = ctx.createGain();
  out.gain.value = 1 - dist * 0.75;
  pan.connect(out).connect(buses.amb.gain);

  const osc = ctx.createOscillator();
  const g = osc.frequency;

  if (type === 'chirp') {
    osc.type = 'sine';
    const f0 = 2300 + Math.random() * 1700;
    g.setValueAtTime(f0, t);
    g.exponentialRampToValueAtTime(f0 * 1.4, t + 0.05);
    g.exponentialRampToValueAtTime(f0 * 0.85, t + 0.1);
    osc.connect(pan);
    osc.start(t); osc.stop(t + 0.12);
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.setValueAtTime(f0 * 1.12, t + 0.15);
    o2.frequency.exponentialRampToValueAtTime(f0 * 0.8, t + 0.25);
    o2.connect(pan);
    o2.start(t + 0.15); o2.stop(t + 0.27);
  } else if (type === 'warble') {
    osc.type = 'triangle';
    const f0 = 1700 + Math.random() * 1300;
    g.setValueAtTime(f0, t);
    for (let i = 0; i < 6; i++) {
      g.exponentialRampToValueAtTime(f0 * (i % 2 ? 1.35 : 0.72), t + 0.045 * (i + 1));
    }
    osc.connect(pan);
    osc.start(t); osc.stop(t + 0.3);
  } else if (type === 'twoNote') {
    osc.type = 'sine';
    g.setValueAtTime(880, t);
    g.setValueAtTime(880, t + 0.1);
    g.setValueAtTime(1320, t + 0.15);
    g.setValueAtTime(1320, t + 0.28);
    osc.connect(pan);
    osc.start(t); osc.stop(t + 0.3);
  } else if (type === 'distant') {
    osc.type = 'sine';
    const f0 = 2600 + Math.random() * 1400;
    for (let i = 0; i < 3; i++) {
      const ts = t + i * 0.09;
      g.setValueAtTime(f0 * (1 - i * 0.12), ts);
    }
    osc.connect(pan);
    osc.start(t); osc.stop(t + 0.32);
  }
}

// ---------------------------------------------------------------------------
// SFX bus: footsteps, pick strikes, gem reveal
// ---------------------------------------------------------------------------

/**
 * Play a single footstep. Leaf crunch + heel thud, alternating L/R pan.
 * Called ON the walk-cycle contact frames (0 and 2 of each direction row)
 * so the sound lands exactly when a foot strikes the ground.
 */
let stepSide = 0;
export function playFootstep() {
  const c = ensureCtx();
  if (!c || !buses.sfx.enabled) return;
  const t = c.currentTime;
  stepSide = 1 - stepSide;

  // Noise burst (leaf crunch)
  const len = Math.floor(c.sampleRate * 0.09);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.6);
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 650 + Math.random() * 450;
  bp.Q.value = 0.9;
  const g = c.createGain();
  g.gain.setValueAtTime(0.15, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  const pan = c.createStereoPanner();
  pan.pan.value = stepSide * 0.3 - 0.15;
  src.connect(bp).connect(g).connect(pan).connect(buses.sfx.gain);
  src.start(t);

  // Low thump (heel)
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(85, t);
  osc.frequency.exponentialRampToValueAtTime(45, t + 0.07);
  const og = c.createGain();
  og.gain.setValueAtTime(0.1, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
  osc.connect(og).connect(buses.sfx.gain);
  osc.start(t);
  osc.stop(t + 0.08);
}

/**
 * Play a pickaxe strike. Metallic ping + rock impact noise.
 * `power` (0..1) scales intensity -- later strikes hit harder.
 */
export function playPick(power = 0.5) {
  const c = ensureCtx();
  if (!c || !buses.sfx.enabled) return;
  const t = c.currentTime;
  const vol = 0.1 + power * 0.15;

  // Metallic ping (square wave with fast decay)
  const osc = c.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(1200 + power * 400, t);
  osc.frequency.exponentialRampToValueAtTime(200, t + 0.1);
  const og = ctx.createGain();
  og.gain.setValueAtTime(vol * 0.6, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  osc.connect(og).connect(buses.sfx.gain);
  osc.start(t);
  osc.stop(t + 0.15);

  // Rock impact (noise burst)
  const len = Math.floor(c.sampleRate * 0.12);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2000 + power * 1000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  src.connect(lp).connect(g).connect(buses.sfx.gain);
  src.start(t);
}

/**
 * Play a short chime when a gem is revealed. Higher rarity = brighter tone.
 */
export function playReveal(rarity = 0) {
  const c = ensureCtx();
  if (!c || !buses.sfx.enabled) return;
  const t = c.currentTime;
  const baseFreq = 400 + rarity * 200;

  for (let i = 0; i < 3; i++) {
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = baseFreq * (1 + i * 0.5);
    const g = ctx.createGain();
    const start = t + i * 0.06;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(0.08 - i * 0.02, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, start + 0.3);
    osc.connect(g).connect(buses.sfx.gain);
    osc.start(start);
    osc.stop(start + 0.35);
  }
}

// ---------------------------------------------------------------------------
// MUSIC bus: background music (file arrives separately)
// ---------------------------------------------------------------------------

/**
 * Wire an <audio> element as the background music. Called once the music
 * file lands in the build; until then the bus + toggle exist and remember
 * the user's choice, but nothing plays.
 */
export function attachMusic(el) {
  const c = ensureCtx();
  if (!c || !el) return;
  musicEl = el;
  if (!musicSrcNode) {
    musicSrcNode = c.createMediaElementSource(musicEl);
    musicSrcNode.connect(buses.music.gain);
    musicEl.loop = true;
    musicEl.volume = 0.4;
  }
  if (buses.music.enabled) musicEl.play().catch(() => {});
}
