/**
 * Procedural audio for DeepWood. Everything is synthesized with the Web Audio
 * API -- no audio files, no loading, no codec support issues.
 *
 * Three sound layers:
 *   - Ambient:  forest bed (wind + leaves + distant birds), loops forever
 *   - Footstep:  soft thud + leaf crunch, triggered while walking
 *   - Pick:      metallic clang + rock impact, triggered on each dig strike
 *
 * A single master gain node feeds the toggle. Muting is one gain write, not
 * a teardown of the whole graph.
 */

let ctx = null;
let master = null;
let ambientNodes = [];
let muted = false;

/** Lazily create the AudioContext. Must be called from a user gesture. */
function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.5;
  master.connect(ctx.destination);
  return ctx;
}

/** Resume the context if the browser suspended it (autoplay policy). */
export function resumeAudio() {
  const c = ensureCtx();
  if (c && c.state === 'suspended') c.resume();
}

/** True once the context exists and is running. */
export function audioReady() {
  return ctx && ctx.state === 'running';
}

/** Current mute state. */
export function isMuted() {
  return muted;
}

/** Toggle mute. Returns the new state. */
export function toggleMute() {
  muted = !muted;
  if (master) {
    master.gain.setTargetAtTime(muted ? 0 : 0.5, ctx.currentTime, 0.05);
  }
  return muted;
}

// ---------------------------------------------------------------------------
// Ambient forest bed
// ---------------------------------------------------------------------------

/**
 * Start the ambient forest soundscape. Layers:
 *   1. Brown noise through a slowly-modulated lowpass = wind
 *   2. High-frequency noise through a bandpass = leaves rustling
 *   3. Occasional bird chirps (scheduled oscillator sweeps)
 *
 * Returns a stop function. Idempotent: calling twice is a no-op.
 */
export function startAmbient() {
  const c = ensureCtx();
  if (!c || ambientNodes.length) return () => {};

  const now = c.currentTime;

  // --- Layer 1: wind (brown noise -> lowpass) ---
  const windLen = c.sampleRate * 4;
  const windBuf = c.createBuffer(1, windLen, c.sampleRate);
  const windData = windBuf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < windLen; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    windData[i] = last * 3.5;
  }
  const windSrc = c.createBufferSource();
  windSrc.buffer = windBuf;
  windSrc.loop = true;
  const windLP = c.createBiquadFilter();
  windLP.type = 'lowpass';
  windLP.frequency.value = 400;
  windLP.Q.value = 0.5;
  const windGain = c.createGain();
  windGain.gain.value = 0.12;
  windSrc.connect(windLP).connect(windGain).connect(master);
  windSrc.start(now);

  // Slow LFO on the wind filter cutoff = gusts
  const windLFO = c.createOscillator();
  windLFO.frequency.value = 0.07;
  const windLFOGain = c.createGain();
  windLFOGain.gain.value = 200;
  windLFO.connect(windLFOGain).connect(windLP.frequency);
  windLFO.start(now);

  // --- Layer 2: leaves (white noise -> highpass, quiet) ---
  const leafLen = c.sampleRate * 2;
  const leafBuf = c.createBuffer(1, leafLen, c.sampleRate);
  const leafData = leafBuf.getChannelData(0);
  for (let i = 0; i < leafLen; i++) leafData[i] = Math.random() * 2 - 1;
  const leafSrc = c.createBufferSource();
  leafSrc.buffer = leafBuf;
  leafSrc.loop = true;
  const leafHP = c.createBiquadFilter();
  leafHP.type = 'highpass';
  leafHP.frequency.value = 3000;
  const leafGain = c.createGain();
  leafGain.gain.value = 0.015;
  leafSrc.connect(leafHP).connect(leafGain).connect(master);
  leafSrc.start(now);

  // --- Layer 3: birds (scheduled chirps) ---
  let birdTimer = null;
  function scheduleBird() {
    if (!ctx) return;
    const delay = 3000 + Math.random() * 8000;
    birdTimer = setTimeout(() => {
      if (!ctx || muted) { scheduleBird(); return; }
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      const f0 = 2000 + Math.random() * 2000;
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f0 * 1.5, t + 0.08);
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.8, t + 0.15);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.04, t + 0.02);
      g.gain.linearRampToValueAtTime(0, t + 0.2);
      osc.connect(g).connect(master);
      osc.start(t);
      osc.stop(t + 0.25);
      scheduleBird();
    }, delay);
  }
  scheduleBird();

  ambientNodes = [windSrc, windLFO, leafSrc];

  return () => {
    if (birdTimer) clearTimeout(birdTimer);
    for (const n of ambientNodes) {
      try { n.stop(); } catch (_) {}
    }
    ambientNodes = [];
  };
}

// ---------------------------------------------------------------------------
// Footstep
// ---------------------------------------------------------------------------

/**
 * Play a single footstep. Short filtered noise burst + low thump.
 * Alternates slightly left/right for a natural stereo feel.
 */
let stepSide = 0;
export function playFootstep() {
  const c = ensureCtx();
  if (!c || muted) return;
  const t = c.currentTime;
  stepSide = 1 - stepSide;

  // Noise burst (leaf crunch)
  const len = c.sampleRate * 0.08;
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 800 + Math.random() * 400;
  bp.Q.value = 1.2;
  const g = c.createGain();
  g.gain.setValueAtTime(0.15, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
  const pan = c.createStereoPanner();
  pan.pan.value = stepSide * 0.3 - 0.15;
  src.connect(bp).connect(g).connect(pan).connect(master);
  src.start(t);

  // Low thump
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(80, t);
  osc.frequency.exponentialRampToValueAtTime(40, t + 0.06);
  const og = c.createGain();
  og.gain.setValueAtTime(0.12, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
  osc.connect(og).connect(master);
  osc.start(t);
  osc.stop(t + 0.07);
}

// ---------------------------------------------------------------------------
// Pick strike
// ---------------------------------------------------------------------------

/**
 * Play a pickaxe strike. Metallic ping + rock impact noise.
 * `power` (0..1) scales intensity -- later strikes hit harder.
 */
export function playPick(power = 0.5) {
  const c = ensureCtx();
  if (!c || muted) return;
  const t = c.currentTime;
  const vol = 0.1 + power * 0.15;

  // Metallic ping (square wave with fast decay)
  const osc = c.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(1200 + power * 400, t);
  osc.frequency.exponentialRampToValueAtTime(200, t + 0.1);
  const og = c.createGain();
  og.gain.setValueAtTime(vol * 0.6, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  osc.connect(og).connect(master);
  osc.start(t);
  osc.stop(t + 0.15);

  // Rock impact (noise burst)
  const len = c.sampleRate * 0.12;
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
  const src = c.createBufferSource();
  src.buffer = buf;
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2000 + power * 1000;
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  src.connect(lp).connect(g).connect(master);
  src.start(t);
}

// ---------------------------------------------------------------------------
// Gem reveal chime
// ---------------------------------------------------------------------------

/**
 * Play a short chime when a gem is revealed. Higher rarity = brighter tone.
 */
export function playReveal(rarity = 0) {
  const c = ensureCtx();
  if (!c || muted) return;
  const t = c.currentTime;
  const baseFreq = 400 + rarity * 200;

  for (let i = 0; i < 3; i++) {
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = baseFreq * (1 + i * 0.5);
    const g = c.createGain();
    const start = t + i * 0.06;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(0.08 - i * 0.02, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, start + 0.3);
    osc.connect(g).connect(master);
    osc.start(start);
    osc.stop(start + 0.35);
  }
}
