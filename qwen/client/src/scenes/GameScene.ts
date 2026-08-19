import Phaser from 'phaser';
import { Terrain } from '../entities/Terrain';
import { Hud } from '../hud/Hud';
import { PlayerSprite } from '../entities/PlayerSprite';
import { aimAngle } from '../logic/aim';
import { InputSender, type RawInput } from '../logic/inputFrame';
import { SnapshotInterpolator } from '../logic/interpolation';
import type { Snapshot } from '../protocol';
import { buildDevMap, parseDevOptions } from '../devmap';
import { TerrainGrid } from '../logic/terrainGrid';
import type { MapData } from '../protocol';

/** Arrow-key pan speed for the `?dev=1` debug camera, px/s (T1.10 step 4). */
const DEBUG_PAN_SPEED = 600;

/**
 * GameScene — world, camera, terrain.
 *
 * T1.9/T1.10 scope: renders terrain from `MapData` and clamps the camera to the
 * map. Input, players, HUD and the live socket feed arrive in Phase 2+.
 */
export class GameScene extends Phaser.Scene {
  private terrain?: Terrain;
  private hud?: Hud;
  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private debugCamera = false;
  /** Stand-in for the local player until snapshots arrive (T2.9). */
  private aimOrigin = { x: 0, y: 0 };
  /** Latest aim angle, in the protocol convention (docs/06 intro). */
  private aim = 0;
  private readonly interpolator = new SnapshotInterpolator();
  private readonly inputSender = new InputSender();
  private readonly sprites = new Map<number, PlayerSprite>();
  private keys?: Record<string, Phaser.Input.Keyboard.Key>;
  /** Set by the socket layer when a snapshot arrives (T4.x). */
  private pendingSlot: number | null = null;

  constructor() {
    super({ key: 'GameScene' });
  }

  create(): void {
    const options = parseDevOptions(window.location.search);
    this.debugCamera = options.dev;

    // Until a server round supplies one (docs/06 §2 `round_started`), build a
    // dev map locally so any seed can be rendered offline.
    const map: MapData = buildDevMap(options.seed, options.scale);
    this.buildTerrain(map);

    this.hud = new Hud(this);
    this.keys = this.input.keyboard?.addKeys('W,A,S,D,SPACE') as
      | Record<string, Phaser.Input.Keyboard.Key>
      | undefined;
    this.aimOrigin = {
      x: (map.width * 16) / 2,
      y: (map.height * 16) / 2,
    };

    if (this.debugCamera) {
      this.cursors = this.input.keyboard?.createCursorKeys();
      this.addDebugOverlay(map);
    }
  }

  /** (Re)build terrain from a `MapData` payload and clamp the camera to it. */
  buildTerrain(map: MapData): void {
    this.terrain?.destroy();
    const grid = TerrainGrid.fromMapData(map);
    this.terrain = new Terrain(this, grid);

    // docs/01 §1: camera bounds are the map's pixel size. World coordinates
    // are map pixels, so no scroll-factor games.
    this.cameras.main.setBounds(0, 0, grid.pixelWidth, grid.pixelHeight);
    this.cameras.main.centerOn(grid.pixelWidth / 2, grid.pixelHeight / 2);
  }

  update(time: number, delta: number): void {
    this.updateAim();
    this.renderPlayers(time);
    this.sendInput(time);

    if (!this.debugCamera || !this.cursors) {
      return;
    }
    // Arrow keys pan the camera; setBounds keeps it clamped at the edges.
    const step = (DEBUG_PAN_SPEED * delta) / 1000;
    const camera = this.cameras.main;
    if (this.cursors.left.isDown) {
      camera.scrollX -= step;
    }
    if (this.cursors.right.isDown) {
      camera.scrollX += step;
    }
    if (this.cursors.up.isDown) {
      camera.scrollY -= step;
    }
    if (this.cursors.down.isDown) {
      camera.scrollY += step;
    }
  }

  /** Feed an arriving snapshot to the interpolator (T2.9 step 1). */
  applySnapshot(snapshot: Snapshot, receivedAt: number): void {
    this.interpolator.push(snapshot, receivedAt);
    for (const snap of snapshot.players) {
      if (!this.sprites.has(snap.id)) {
        this.sprites.set(snap.id, new PlayerSprite(this, snap.id, snap.name));
      }
    }
  }

  /** Draw every known player at its interpolated position (T2.9 step 1). */
  private renderPlayers(now: number): void {
    for (const [id, sprite] of this.sprites) {
      const state = this.interpolator.renderState(id, now);
      if (state) {
        sprite.update(state);
        sprite.setVisible(true);
      } else {
        sprite.setVisible(false);
      }
    }
  }

  /** Sample keys and emit an input frame on the 20 Hz cadence (T2.9 step 3). */
  private sendInput(now: number): void {
    const k = this.keys;
    const pointer = this.input.activePointer;
    const raw: RawInput = {
      left: k?.['A']?.isDown ?? false,
      right: k?.['D']?.isDown ?? false,
      up: k?.['W']?.isDown ?? false,
      down: k?.['S']?.isDown ?? false,
      jump: k?.['SPACE']?.isDown ?? false,
      fire: pointer.leftButtonDown(),
      aim: this.aim,
      slotPressed: this.pendingSlot,
    };
    const frame = this.inputSender.poll(now, raw);
    if (frame) {
      this.pendingSlot = null;
      this.events.emit('input-frame', frame);
    }
  }

  /** Queue a slot press for the next input frame (keys 1–6, T3.9 UI). */
  queueSlot(slot: number): void {
    this.pendingSlot = slot;
  }

  /** Mouse -> aim angle -> crosshair (T2.8 step 2). */
  private updateAim(): void {
    const pointer = this.input.activePointer;
    const world = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
    this.aim = aimAngle(this.aimOrigin.x, this.aimOrigin.y, world.x, world.y);
    this.hud?.drawCrosshair(this.aimOrigin.x, this.aimOrigin.y, this.aim);
  }

  /** Current aim angle, for the input frame sent in T2.9. */
  get aimAngle(): number {
    return this.aim;
  }

  private addDebugOverlay(map: MapData): void {
    const text = [
      `seed=${map.seed} scale=${map.scale}`,
      `${map.width}x${map.height} tiles`,
      `tiles drawn: ${this.terrain?.spriteCount ?? 0}`,
      'arrows: pan camera',
    ].join('\n');
    this.add
      .text(8, 8, text, {
        font: '12px monospace',
        color: '#e0e0e0',
        backgroundColor: '#000000a0',
        padding: { x: 6, y: 4 },
      })
      .setScrollFactor(0)
      .setDepth(1000);
  }
}
