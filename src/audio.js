/**
 * Procedural audio for DeepWood. Everything is synthesized with the Web Audio
 * API -- no audio files, no loading, no codec support issues.
 *
 * Layers:
 *   - Ambient: gusting wind (NOT a constant shhh -- it swells and dies),
 *     rustling leaves, and a bird chorus (songbirds, warbles, two-note
 *     calls, distant crows, owls).
 *   - Footstep: leaf crunch + heel thud, fired ON the walk-cycle contact
 *     frames so it matches the sprite's feet.
 *   - Pick: metallic clang + rock impact on each dig strike.
 *   - Reveal: chime when a gem is found.
 *
 * A single master gain node feeds the toggle. Muting is one gain write, not
 * a teardown of the whole graph.
 */

let ctx = null;
let master = null;
let ambientRunning = false;
let muted = false;
let ambientTimers = [];

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
  return !!(ctx && ctx.state === 'running');
}

/** Current mute state. */
export function isMuted() {
  return muted;
}

/** Toggle mute. Returns the new state. */
export function toggleMute() {
  muted = !muted;
  if (master && ctx) {
    master.gain.setTargetAtTime(muted ? 0 : 0.5, ctx.currentTime, 0.05);
  }
  return muted;
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
// Ambient forest bed
// ---------------------------------------------------------------------------

/**
 * Start the ambient soundscape. The wind GUSTS: each of two voices swells
 * from near-silence to a soft peak over 3-6s, holds, then dies over 4-9s --
 * so the forest breathes rather than hissing constantly. Leaves rustle in
 * the same rhythm, quieter. Birds call on their own clocks.
 */
export function startAmbient() {
  const c = ensureCtx();
  if (!c || ambientRunning) return;
  ambientRunning = true;

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
    src.connect(lp).connect(g).connect(master);
    src.start();
    src.__keep = true;

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
  leafSrc.connect(leafHP).connect(leafG).connect(master);
  leafSrc.start();
  const leafCycle = () => {
    if (!ctx || !ambientRunning) return;
    const t = ctx.currentTime;
    leafG.gain.setTargetAtTime(0.003 + Math.random() * 0.008, t, 1.8);
    leafG.gain.setTargetAtTime(0.0004, t + 3, 2.5);
    ambientTimers.push(setTimeout(leafCycle, 6000 + Math.random() * 8000));
  };
  ambientTimers.push(setTimeout(leafCycle, 2500));

  // Birds: the original single songbird chirp. The expanded chorus
  // (warble/twoNote/crow/distant/owl) was reverted -- the synthesized calls
  // read as odd electronic tones, not birds.
  const chorus = () => {
    if (!ctx || !ambientRunning) return;
    if (!muted) birdCall('chirp');
    ambientTimers.push(setTimeout(chorus, 3000 + Math.random() * 8000));
  };
  ambientTimers.push(setTimeout(chorus, 1200));
}

/**
 * The bird call: the ORIGINAL songbird chirp the user liked -- two quick
 * sine syllables with an up-down sweep. Panned to a random side, distant =
 * quieter. The expanded chorus types (warble/twoNote/crow/distant/owl) were
 * removed -- they read as odd electronic tones, not birds.
 */
function birdCall() {
  const t = ctx.currentTime + Math.random() * 0.25;
  const pan = ctx.createStereoPanner();
  pan.pan.value = (Math.random() * 2 - 1) * 0.75;
  const dist = 0.25 + Math.random() * 0.55;
  const out = ctx.createGain();
  out.gain.value = 1 - dist * 0.75;
  pan.connect(out).connect(master);

  const osc = ctx.createOscillator();
  const g = osc.frequency;
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
}

// ---------------------------------------------------------------------------
// Footstep
// ---------------------------------------------------------------------------

/**
 * Play a single footstep. Leaf crunch + heel thud, alternating L/R pan.
 * Called ON the walk-cycle contact frames (0 and 2 of each direction row)
 * so the sound lands exactly when a foot strikes the ground.
 */
let stepSide = 0;
export function playFootstep() {
  const c = ensureCtx();
  if (!c || muted) return;
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
  src.connect(bp).connect(g).connect(pan).connect(master);
  src.start(t);

  // Low thump (heel)
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(85, t);
  osc.frequency.exponentialRampToValueAtTime(45, t + 0.07);
  const og = c.createGain();
  og.gain.setValueAtTime(0.1, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
  osc.connect(og).connect(master);
  osc.start(t);
  osc.stop(t + 0.08);
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
