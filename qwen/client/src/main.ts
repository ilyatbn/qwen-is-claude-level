/**
 * Phaser bootstrap + scene list (docs/00 §1).
 */
import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { PROTOCOL_VERSION } from './protocol';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  width: window.innerWidth,
  height: window.innerHeight,
  backgroundColor: '#101014',
  scene: [BootScene],
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
};

console.log(`wipgame client, protocol v${PROTOCOL_VERSION}`);

export const game = new Phaser.Game(config);
