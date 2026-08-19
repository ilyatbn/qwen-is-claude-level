import Phaser from 'phaser';
import { Terrain } from '../entities/Terrain';
import { Hud } from '../hud/Hud';
import { InventoryUi } from '../hud/InventoryUi';
import { hudView, localPlayer } from '../logic/inventoryModel';
import { PlayerSprite } from '../entities/PlayerSprite';
import { aimAngle } from '../logic/aim';
import { computeFov } from '../logic/fov';
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
  private inventoryUi?: InventoryUi;
  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private debugCamera = false;
  /** Stand-in for the local player until snapshots arrive (T2.9). */
  private aimOrigin = { x: 0, y: 0 };
  /** Latest aim angle, in the protocol convention (docs/06 intro). */
  private aim = 0;
  private readonly interpolator = new SnapshotInterpolator();
  private readonly inputSender = new InputSender();
  private readonly sprites = new Map<number, PlayerSprite>();
  /** Assigned by the server in `joined` (docs/06 §2); 0 until then. */
  private localPlayerId = 0;
  /** True until server terrain arrives, so the placeholder is visible in logs. */
  private usingDevMap = false;
  private keys?: Record<string, Phaser.Input.Keyboard.Key>;
  /** Set by the socket layer when a snapshot arrives (T4.x). */
  private pendingSlot: number | null = null;
  private darkness?: Phaser.GameObjects.Graphics;
  /** Local player's FOV radius, from the snapshot (docs/03 §7). */
  private fovRadius = computeFov(0, false, 100, false);

  constructor() {
    super({ key: 'GameScene' });
  }

  create(): void {
    const options = parseDevOptions(window.location.search);
    this.debugCamera = options.dev;

    // The SERVER's map is authoritative (docs/06 §2: `joined` and
    // `round_started` both carry MapData). `applyMapData` replaces this the
    // moment one arrives. The dev map is only a placeholder so `?seed=` still
    // renders something with no server running — it is NOT what a connected
    // client draws.
    const map: MapData = buildDevMap(options.seed, options.scale);
    this.buildTerrain(map);
    this.usingDevMap = true;

    this.hud = new Hud(this);
    this.inventoryUi = new InventoryUi(this);
    this.darkness = this.add.graphics().setDepth(400);

    // T3.9 step 2: keys 1-6 map to slots. T3.9 step 1: right-click or Tab
    // toggles the panel; the game keeps running (docs/04 §5, real-time).
    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      const digit = Number.parseInt(event.key, 10);
      if (digit >= 1 && digit <= 6) {
        this.queueSlot(digit - 1);
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        this.inventoryUi?.toggle();
      }
    });
    this.input.mouse?.disableContextMenu();
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (pointer.rightButtonDown()) {
        this.inventoryUi?.toggle();
      }
    });
    // Clicking a slot in the panel is the same as pressing its number key.
    this.events.on('use-slot', (slot: number) => this.queueSlot(slot));
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
    this.drawDarkness();
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

  /**
   * Adopt the server's map (docs/06 §2, from `joined` or `round_started`).
   *
   * Until this is called the scene renders a local placeholder, which shares no
   * tiles with the server — so `tile_destroyed` events would land on the wrong
   * grid entirely.
   */
  applyMapData(map: MapData, localPlayerId?: number): void {
    if (localPlayerId !== undefined) {
      this.localPlayerId = localPlayerId;
    }
    this.buildTerrain(map);
    this.usingDevMap = false;
    console.log(
      `[map] server terrain: seed=${map.seed} scale=${map.scale} ` +
        `${map.width}x${map.height} tiles=${this.terrain?.grid.width ?? 0} cols`,
    );
  }

  /** Apply a `tile_destroyed` event (docs/06 §2). */
  applyTileDestroyed(tiles: readonly { x: number; y: number }[], version: number): void {
    if (this.usingDevMap) {
      // Destruction against a placeholder grid is meaningless; warn rather
      // than corrupt the render silently.
      console.warn('[map] tile_destroyed arrived before server terrain — ignoring');
      return;
    }
    this.terrain?.applyDestroyed(tiles, version);
  }

  /** Whether the scene is still on the offline placeholder. */
  get isUsingDevMap(): boolean {
    return this.usingDevMap;
  }

  /** Feed an arriving snapshot to the interpolator (T2.9 step 1). */
  applySnapshot(snapshot: Snapshot, receivedAt: number): void {
    this.interpolator.push(snapshot, receivedAt);
    // The server computes fov per player (docs/03 §7); the mask is for the
    // LOCAL player only (T2.10 step 4).
    const local = localPlayer(snapshot.players, this.localPlayerId);
    if (local) {
      this.fovRadius = local.fov;
      this.aimOrigin = { x: local.x, y: local.y };
      // T3.9 step 4: every HUD value comes from the latest snapshot.
      const view = hudView(local);
      this.hud?.drawBars(view);
      this.inventoryUi?.update(view.slots);
      this.inventoryUi?.layout(this.cameras.main.width, this.cameras.main.height);
    }
    for (const snap of snapshot.players) {
      const existing = this.sprites.get(snap.id);
      if (existing === undefined) {
        this.sprites.set(snap.id, new PlayerSprite(this, snap.id, snap.name, snap.skin));
      } else {
        // docs/06 §4 carries `skin` on every snapshot, so a lobby skin change
        // reaches the renderer without a dedicated event (T5.3 step 3).
        existing.setSkin(snap.skin);
      }
    }
  }

  /**
   * Night/fog mask: a dark overlay with a circular hole of radius `fov`
   * around the LOCAL player (T2.10 step 4, docs/07 §5 "alpha up to 0.85").
   *
   * Remote players are drawn normally underneath — v1 renders one mask, for
   * your own eyes, not per-player visibility.
   */
  private drawDarkness(): void {
    const g = this.darkness;
    if (!g) {
      return;
    }
    g.clear();
    const camera = this.cameras.main;
    // Fully lit at the base radius; darkness grows as fov shrinks.
    const alpha = Math.min(0.85, Math.max(0, 1 - this.fovRadius / 420) * 0.85);
    if (alpha <= 0.001) {
      return;
    }
    g.fillStyle(0x000000, alpha);
    g.fillRect(camera.scrollX, camera.scrollY, camera.width, camera.height);
    // Punch the FOV hole.
    g.setBlendMode(Phaser.BlendModes.ERASE);
    g.fillStyle(0x000000, 1);
    g.fillCircle(this.aimOrigin.x, this.aimOrigin.y, this.fovRadius);
    g.setBlendMode(Phaser.BlendModes.NORMAL);
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
