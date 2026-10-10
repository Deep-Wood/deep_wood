import Phaser from 'phaser';
import { ForestScene } from './ForestScene.js';

const config = {
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#0d1a10',
  pixelArt: true,
  // Required for the headless smoke test to read back rendered pixels.
  preserveDrawingBuffer: true,
  // The ForestScene uses this.physics.add.sprite and this.physics.world.
  // Without arcade physics enabled the scene threw on
  // `this.physics.world.setBounds(...)` and rendered an empty canvas.
  physics: {
    default: 'arcade',
    arcade: { gravity: { y: 0 }, debug: false },
  },
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: '100%',
    height: '100%',
  },
  scene: [ForestScene],
};

const game = new Phaser.Game(config);

// First-run tutorial. DOM-only, so it can go up before/independent of the
// scene; a click on the card advances, skip dismisses the whole thing, and
// localStorage remembers the dismissal. Shown once the canvas exists so the
// forest is visible behind the dimmer.
import { maybeShowTutorial } from './tutorial.js';
import { isMuted, toggleMute, resumeAudio, startAmbient } from './audio.js';
game.events.once('ready', () => {
  maybeShowTutorial();
});

window.addEventListener('resize', () => game.scale.refresh());

// Expose the scene for the headless smoke test / probe. Read-only handles
// only -- nothing in the game reads these.
//
// Published only once the scene's create() has run. The game's 'ready' event
// fires at boot, before preload/create, and index.html's wallet sync calls
// window.__scene.refreshChainTool() -> updateHud() as soon as it can -- which
// touched HUD objects (durBar) that setupHud() had not built yet.
game.events.once('ready', () => {
  const s = game.scene.getScene('forest');
  if (!s) return;
  const publish = () => {
    window.__scene = s;
    // LEADERBOARD button in the header card opens the same panel as the L key.
    // Wired here, where the scene is guaranteed to exist.
    document.getElementById('leaderboard-btn')
      ?.addEventListener('click', () => s.toggleLeaderboard());
    // SOUND toggle: round 3D button, mirrors the leaderboard control. Starts
    // ambient audio on first interaction (browser autoplay policy requires a
    // gesture before AudioContext can run).
    const soundBtn = document.getElementById('sound-toggle');
    if (soundBtn) {
      const setIcon = (muted) => {
        const on = soundBtn.querySelector('.icon-sound-on');
        const off = soundBtn.querySelector('.icon-sound-off');
        if (on) on.style.display = muted ? 'none' : '';
        if (off) off.style.display = muted ? '' : 'none';
      };
      setIcon(isMuted());
      soundBtn.addEventListener('click', () => {
        resumeAudio();
        const nowMuted = toggleMute();
        setIcon(nowMuted);
        if (!nowMuted) startAmbient();
      });
      // Start ambient on ANY first interaction with the page, not just the
      // toggle. The toggle is the explicit control; this is the implicit one.
      // MUST be a CAPTURE listener: the #hud shield stopPropagation()s every
      // pointerdown inside the HUD, so a bubble-phase listener on window never
      // fires for any HUD tap (SETTLE, Sound, d-pad, etc). Capture runs
      // BEFORE the shield, so ambient starts on the first tap anywhere.
      const kick = () => {
        resumeAudio();
        if (!isMuted()) startAmbient();
        window.removeEventListener('pointerdown', kick, true);
      };
      window.addEventListener('pointerdown', kick, true);
    }

    // SOUND button position: it must sit in the SAME column as settle
    // (far-right) and exactly one row-gap (18px) below it. Settle's own top is
    // computed at runtime by aligning to the sell button (see ForestScene
    // syncActionDom), so a hardcoded CSS top cannot track it. Instead measure
    // the live settle wrapper and place sound relative to it -- same
    // two-pass measurement settle itself uses.
    const placeSound = () => {
      const sound = document.querySelector('.sound-toggle-wrap');
      const settleWrap = document.querySelector('.settle-right');
      const settleBtn = document.getElementById('belt-settle');
      const hud = document.getElementById('hud');
      if (!sound || !settleWrap || !settleBtn || !hud) return;
      const hudRect = hud.getBoundingClientRect();
      const settleRect = settleWrap.getBoundingClientRect();
      const settleBtnRect = settleBtn.getBoundingClientRect();
      const gap = 18; // matches .rail-action-icon margin-top:18px row rhythm
      sound.style.top = Math.round(settleRect.bottom - hudRect.top + gap) + 'px';
      // Align the ICON columns, not the wrappers: settle's label ('settle
      // hunt') is wider than its 44px icon, so its wrapper stretch makes the
      // icon sit 15px inside the far-right edge. Aligning wrappers would push
      // the sound icon 15px right of settle's icon -- the misaligned column
      // the user reported. Align icon-right to icon-right instead.
      sound.style.right = Math.round(hudRect.right - settleBtnRect.right) + 'px';
    };
    // Settle is (re)created by syncActionDom, so re-run after each render.
    // The scene emits 'ready' once, but syncActionDom runs on every HUD sync.
    // NOTE: uses the OUTER `s` (the scene) -- do not shadow it here; a local
    // `const s = window.__scene` inside publish() would throw TDZ and kill
    // the whole boot path (this exact bug shipped once already).
    const origSync = s.syncActionDom?.bind(s);
    if (origSync) s.syncActionDom = () => { origSync(); placeSound(); };
    // Initial placement + a settle re-check once fonts/layout settle.
    placeSound();
    setTimeout(placeSound, 500);
    setTimeout(placeSound, 2000);
    // A wallet sync that ran while the scene was unpublished skipped it, so
    // re-run it now that the chain's tool/gems/balance can be applied.
    window.__syncBalance?.();
  };
  if (s.sys.settings.status >= Phaser.Scenes.RUNNING) publish();
  else s.events.once(Phaser.Scenes.Events.CREATE, publish);
});
