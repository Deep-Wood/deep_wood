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

window.addEventListener('resize', () => game.scale.refresh());

// Expose the scene for the headless smoke test / probe. Read-only handles
// only -- nothing in the game reads these.
game.events.once('ready', () => {
  const s = game.scene.getScene('forest');
  if (s) window.__scene = s;
});
