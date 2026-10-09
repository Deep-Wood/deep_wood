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
      const kick = () => {
        resumeAudio();
        if (!isMuted()) startAmbient();
        window.removeEventListener('pointerdown', kick);
      };
      window.addEventListener('pointerdown', kick);
    }
    // A wallet sync that ran while the scene was unpublished skipped it, so
    // re-run it now that the chain's tool/gems/balance can be applied.
    window.__syncBalance?.();
  };
  if (s.sys.settings.status >= Phaser.Scenes.RUNNING) publish();
  else s.events.once(Phaser.Scenes.Events.CREATE, publish);
});
