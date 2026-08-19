import Phaser from 'phaser';

/**
 * BootScene — T0.2: fills the screen with a dark color and logs "client ready".
 *
 * T1.9 extends this to register placeholder tile textures (docs/07 §5) and
 * T5.1 to load the real manifest.
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#101014');
    console.log('client ready');
  }
}
