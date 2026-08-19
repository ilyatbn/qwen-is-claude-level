import Phaser from 'phaser';
import { PLAYER_COLOURS } from '../assets/placeholders';
import { playerTextureKey } from '../assets/manifest';
import { C2S, PROTOCOL_VERSION, type LobbyPlayer } from '../protocol';
import { storeIndex, storedIndex } from '../logic/preferences';

/** Skin count (docs/07 §4: "6 skins"). */
const SKIN_COUNT = 6;
/** Weapon skins (docs/07 §4 + T5.3 step 2: "v1: 0/1"). */
const WEAPON_SKIN_COUNT = 2;

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
  private weaponSkin = 0;
  private ready = false;
  private listText?: Phaser.GameObjects.Text;
  private countdownText?: Phaser.GameObjects.Text;
  private readonly swatches: Phaser.GameObjects.GameObject[] = [];
  private readonly weaponSwatches: Phaser.GameObjects.Rectangle[] = [];

  constructor() {
    super({ key: 'LobbyScene' });
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#14141a');
    // docs/07 §4: skin persisted in localStorage.
    this.skin = storedIndex(window.localStorage, 'skin', SKIN_COUNT);
    this.weaponSkin = storedIndex(window.localStorage, 'weapon_skin', WEAPON_SKIN_COUNT);
    this.nameText = window.localStorage.getItem('name') ?? this.nameText;

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
      // The skin texture if one exists, the placeholder colour otherwise —
      // the picker shows what the player will actually look like.
      const key = playerTextureKey(i);
      const swatch = this.textures.exists(key)
        ? this.add.image(90 + i * 40, 104, key).setDisplaySize(30, 30)
        : this.add.rectangle(90 + i * 40, 104, 30, 30, PLAYER_COLOURS[i] ?? 0xffffff);
      swatch.setInteractive({ useHandCursor: true }).on('pointerdown', () => this.selectSkin(i));
      this.swatches.push(swatch);
    }

    // docs/07 §4: weapon skin, cosmetic only, same localStorage pattern.
    this.add.text(24, 132, 'weapon:', { font: '14px monospace', color: '#c8c8d0' });
    for (let i = 0; i < WEAPON_SKIN_COUNT; i += 1) {
      const swatch = this.add
        .rectangle(90 + i * 40, 140, 30, 14, i === 0 ? 0x9aa0a6 : 0xc59b3c)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this.selectWeaponSkin(i));
      this.weaponSwatches.push(swatch);
    }
    this.highlightSkin();

    this.add
      .text(24, 168, '[ ready ]', { font: '16px monospace', color: '#4ad04a' })
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.toggleReady());

    this.listText = this.add.text(24, 208, '', { font: '13px monospace', color: '#a0a0aa' });
    this.countdownText = this.add.text(24, 320, '', {
      font: '18px monospace',
      color: '#ffcc44',
    });
  }

  private promptName(): void {
    const entered = window.prompt('name (1-12 characters)', this.nameText);
    if (entered !== null && entered.trim().length > 0) {
      this.nameText = entered.trim().slice(0, 12);
      window.localStorage.setItem('name', this.nameText);
      this.events.emit('lobby-action', { type: C2S.JOIN_ROOM, name: this.nameText });
    }
  }

  private selectSkin(index: number): void {
    this.skin = index;
    // docs/07 §4: persisted, so a refresh restores the choice.
    storeIndex(window.localStorage, 'skin', index, SKIN_COUNT);
    this.highlightSkin();
    this.emitSkin();
  }

  private selectWeaponSkin(index: number): void {
    this.weaponSkin = index;
    storeIndex(window.localStorage, 'weapon_skin', index, WEAPON_SKIN_COUNT);
    this.highlightSkin();
    this.emitSkin();
  }

  /**
   * Both skins ride on `select_skin` — docs/06 §1 defines no separate message
   * for the weapon skin, and the field is optional so the documented payload
   * stays valid (DEVIATIONS.md D52).
   */
  private emitSkin(): void {
    this.events.emit('lobby-action', {
      type: C2S.SELECT_SKIN,
      skin: this.skin,
      weapon_skin: this.weaponSkin,
    });
  }

  /** The choice restored from localStorage, for the initial `select_skin`. */
  get selection(): { skin: number; weaponSkin: number; name: string } {
    return { skin: this.skin, weaponSkin: this.weaponSkin, name: this.nameText };
  }

  private highlightSkin(): void {
    const stroke = (
      object: Phaser.GameObjects.GameObject,
      selected: boolean,
    ): void => {
      const target = object as Phaser.GameObjects.Rectangle;
      if (typeof target.setStrokeStyle === 'function') {
        target.setStrokeStyle(selected ? 3 : 1, selected ? 0xffffff : 0x555560);
      } else {
        (object as Phaser.GameObjects.Image).setAlpha(selected ? 1 : 0.55);
      }
    };
    for (const [i, swatch] of this.swatches.entries()) {
      stroke(swatch, i === this.skin);
    }
    for (const [i, swatch] of this.weaponSwatches.entries()) {
      stroke(swatch, i === this.weaponSkin);
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
        .map(
          (p) =>
            `${p.ready ? '[x]' : '[ ]'} ${p.id}: ${p.name}  ` +
            `skin ${p.skin} / weapon ${p.weapon_skin}`,
        )
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
