import Phaser from 'phaser';
import { C2S, type ScoreEntry } from '../protocol';

/**
 * RoundEndScene — score table with Restart and Quit (T4.10 step 3).
 *
 * Emits `round-end-action`; the socket layer sends `restart` / `quit`.
 */
export class RoundEndScene extends Phaser.Scene {
  private scores: ScoreEntry[] = [];

  constructor() {
    super({ key: 'RoundEndScene' });
  }

  init(data: { scores?: ScoreEntry[] }): void {
    this.scores = data.scores ?? [];
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#14141a');
    this.add.text(24, 24, 'round over', { font: '20px monospace', color: '#ffffff' });

    // Highest score first; the table is the round's whole result.
    const ranked = [...this.scores].sort((a, b) => b.score - a.score);
    const rows = ranked
      .map(
        (s, place) =>
          `${place + 1}. ${s.name.padEnd(12)} ${String(s.score).padStart(3)} pts   ` +
          `${s.kills}k / ${s.deaths}d`,
      )
      .join('\n');
    this.add.text(24, 64, rows || '(no players)', {
      font: '14px monospace',
      color: '#c8c8d0',
    });

    this.add
      .text(24, 240, '[ restart (new map) ]', { font: '16px monospace', color: '#4ad04a' })
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () =>
        this.events.emit('round-end-action', { type: C2S.RESTART }),
      );

    this.add
      .text(24, 272, '[ quit ]', { font: '16px monospace', color: '#d04a4a' })
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.events.emit('round-end-action', { type: C2S.QUIT }));
  }
}
