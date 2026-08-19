import Phaser from 'phaser';
import { PLAYER_COLOURS } from './BootScene';
import { C2S, PROTOCOL_VERSION, type LobbyPlayer } from '../protocol';

/** Skin count (docs/07 §4: "6 skins"). */
const SKIN_COUNT = 6;

/**
 * LobbyScene — name, skin picker, ready button, player list, countdown
 * (T4.10 step 2).
 *
 * Emits `lobby-action` for the socket layer rather than owning a socket, so
 * the scene stays testable and the transport stays in one place.
 */
export class LobbyScene extends Phaser.Scene {
  private nameText = 'player';
  private skin = 0;
  private ready = false;
  private listText?: Phaser.GameObjects.Text;
  private countdownText?: Phaser.GameObjects.Text;
  private readonly swatches: Phaser.GameObjects.Rectangle[] = [];

  constructor() {
    super({ key: 'LobbyScene' });
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#14141a');
    // docs/07 §4: skin persisted in localStorage.
    const stored = Number.parseInt(window.localStorage.getItem('skin') ?? '', 10);
    this.skin = Number.isFinite(stored) && stored >= 0 && stored < SKIN_COUNT ? stored : 0;

    this.add.text(24, 24, 'WIP GAME — lobby', { font: '20px monospace', color: '#ffffff' });

    this.add
      .text(24, 64, `name: ${this.nameText}  (click to change)`, {
        font: '14px monospace',
        color: '#c8c8d0',
      })
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.promptName());

    this.add.text(24, 96, 'skin:', { font: '14px monospace', color: '#c8c8d0' });
    for (let i = 0; i < SKIN_COUNT; i += 1) {
      const swatch = this.add
        .rectangle(90 + i * 40, 104, 30, 30, PLAYER_COLOURS[i] ?? 0xffffff)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this.selectSkin(i));
      this.swatches.push(swatch);
    }
    this.highlightSkin();

    this.add
      .text(24, 148, '[ ready ]', { font: '16px monospace', color: '#4ad04a' })
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.toggleReady());

    this.listText = this.add.text(24, 192, '', { font: '13px monospace', color: '#a0a0aa' });
    this.countdownText = this.add.text(24, 320, '', {
      font: '18px monospace',
      color: '#ffcc44',
    });
  }

  private promptName(): void {
    const entered = window.prompt('name (1-12 characters)', this.nameText);
    if (entered !== null && entered.trim().length > 0) {
      this.nameText = entered.trim().slice(0, 12);
      this.events.emit('lobby-action', { type: C2S.JOIN_ROOM, name: this.nameText });
    }
  }

  private selectSkin(index: number): void {
    this.skin = index;
    window.localStorage.setItem('skin', String(index));
    this.highlightSkin();
    this.events.emit('lobby-action', { type: C2S.SELECT_SKIN, skin: index });
  }

  private highlightSkin(): void {
    for (const [i, swatch] of this.swatches.entries()) {
      swatch.setStrokeStyle(i === this.skin ? 3 : 1, i === this.skin ? 0xffffff : 0x555560);
    }
  }

  private toggleReady(): void {
    this.ready = !this.ready;
    this.events.emit('lobby-action', { type: C2S.READY, ready: this.ready });
  }

  /** Render `lobby_state` (docs/06 §2). */
  showLobby(players: LobbyPlayer[], countdownInS: number | null): void {
    this.listText?.setText(
      players
        .map((p) => `${p.ready ? '[x]' : '[ ]'} ${p.id}: ${p.name}  skin ${p.skin}`)
        .join('\n'),
    );
    this.countdownText?.setText(
      countdownInS === null ? '' : `starting in ${countdownInS.toFixed(1)} s`,
    );
  }

  /** docs/06 §7: warn on a protocol mismatch (deferred item 5, now done). */
  checkProtocolVersion(serverVersion: number): void {
    if (serverVersion !== PROTOCOL_VERSION) {
      const message =
        `protocol mismatch: client v${PROTOCOL_VERSION}, server v${serverVersion}. ` +
        'Reload, or the game will misbehave.';
      console.warn(message);
      this.add
        .text(24, 360, message, { font: '13px monospace', color: '#ff6666' })
        .setDepth(1000);
    }
  }
}
