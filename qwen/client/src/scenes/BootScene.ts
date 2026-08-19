import Phaser from 'phaser';
import manifestJson from '../assets/manifest.json';
import {
  loadEntries,
  manifestProblem,
  allTextureKeys,
  type AssetManifest,
  type LoadEntry,
} from '../assets/manifest';
import { PLACEHOLDER_SPECS, placeholderFor } from '../assets/placeholders';

// Re-exported so existing importers keep working; the definitions moved to
// assets/placeholders.ts, next to the rest of the placeholder data.
export { PLACEHOLDER_TILE_COLOURS, PLAYER_COLOURS } from '../assets/placeholders';

/**
 * Annotated, not cast. A cast here would let the manifest drift away from the
 * type and still compile — the hole the Phase 0 drift guard was fixed for.
 */
const MANIFEST: AssetManifest = manifestJson;

/**
 * BootScene — resolve every texture key, then start GameScene.
 *
 * Order matters: placeholders are registered FIRST, so every key already has a
 * texture before a single file is requested. A load that succeeds overwrites
 * its placeholder; a load that fails leaves it standing (docs/07 §2: "the game
 * never breaks on a missing asset"). With an empty `assets/` tree — which is
 * the shipped state, see DEVIATIONS.md D11 — every load fails and the game
 * boots exactly as it did before T5.1.
 */
export class BootScene extends Phaser.Scene {
  private readonly failed: string[] = [];
  /** Frame-rect entries awaiting their sheet, keyed by sheet texture key. */
  private readonly pendingFrames = new Map<string, LoadEntry[]>();

  constructor() {
    super({ key: 'BootScene' });
  }

  preload(): void {
    this.registerPlaceholders();

    const problem = manifestProblem(MANIFEST);
    if (problem !== null) {
      console.warn(`[assets] manifest unusable (${problem}) — placeholders only`);
      return;
    }

    const entries = loadEntries(MANIFEST);
    for (const item of entries) {
      this.queue(item);
    }
    // Phaser reports a failed file, not a failed key, so the key is recovered
    // from the file's own load key.
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
      this.failed.push(file.key);
    });
    console.log(`[assets] manifest v${MANIFEST.version}: ${entries.length} textures queued`);
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#101014');
    this.cutFrames();
    if (this.failed.length > 0) {
      // One line, not one per file: an empty asset tree would otherwise print
      // 30 identical warnings on every boot.
      console.warn(
        `[assets] ${this.failed.length} texture(s) missing, using placeholders: ` +
          `${this.failed.slice(0, 6).join(', ')}${this.failed.length > 6 ? ', …' : ''}`,
      );
    }
    console.log('client ready');
    this.scene.start('GameScene');
  }

  /** Load one manifest entry, honouring docs/07 §3's frame-rect form. */
  private queue(item: LoadEntry): void {
    if (item.frame === undefined) {
      this.load.image(item.key, item.file);
      return;
    }
    // A frame rect names a region of a shared sheet, so the sheet is loaded
    // once under its own key and the region is cut out after loading. Phaser's
    // spritesheet loader cannot express "one frame at an arbitrary offset".
    const sheetKey = BootScene.sheetKey(item.file);
    if (!this.pendingFrames.has(sheetKey)) {
      this.pendingFrames.set(sheetKey, []);
      this.load.image(sheetKey, item.file);
    }
    this.pendingFrames.get(sheetKey)?.push(item);
  }

  private static sheetKey(file: string): string {
    return `sheet:${file}`;
  }

  /**
   * Cut every frame rect out of its loaded sheet into a texture of its own, so
   * rendering code sees one key per asset either way (docs/07 §3: "the loader
   * supports both plain paths and frame objects").
   */
  private cutFrames(): void {
    for (const [sheetKey, items] of this.pendingFrames) {
      if (!this.textures.exists(sheetKey)) {
        // The sheet itself failed to load; every frame in it keeps its
        // placeholder, and FILE_LOAD_ERROR already recorded the failure.
        for (const item of items) {
          if (!this.failed.includes(item.key)) {
            this.failed.push(item.key);
          }
        }
        continue;
      }
      const source = this.textures.get(sheetKey).getSourceImage();
      for (const item of items) {
        if (item.frame === undefined) {
          continue;
        }
        const [x, y, width, height] = item.frame;
        this.textures.remove(item.key);
        const canvas = this.textures.createCanvas(item.key, width, height);
        if (canvas === null || canvas === undefined) {
          continue;
        }
        canvas.getContext().drawImage(
          source as CanvasImageSource, x, y, width, height, 0, 0, width, height,
        );
        canvas.refresh();
      }
      this.textures.remove(sheetKey);
    }
  }

  /**
   * Generate a texture for every key in {@link allTextureKeys}.
   *
   * Nothing here consults the manifest: these must exist even when the
   * manifest itself is unreadable.
   */
  private registerPlaceholders(): void {
    for (const key of allTextureKeys()) {
      if (this.textures.exists(key)) {
        continue;
      }
      const spec = placeholderFor(key);
      if (spec === undefined) {
        // Unreachable while placeholders.test.ts passes; a warning rather than
        // a throw, because a missing placeholder must not stop the boot.
        console.warn(`[assets] no placeholder for texture key ${key}`);
        continue;
      }
      const canvas = this.textures.createCanvas(key, spec.width, spec.height);
      if (canvas === null || canvas === undefined) {
        continue;
      }
      const ctx = canvas.getContext();
      ctx.fillStyle = `#${spec.colour.toString(16).padStart(6, '0')}`;
      if (spec.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(spec.width / 2, spec.height / 2, spec.width / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(0, 0, spec.width, spec.height);
      }
      if (spec.edge === true) {
        ctx.strokeStyle = 'rgba(0,0,0,0.18)';
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, spec.width - 1, spec.height - 1);
      }
      canvas.refresh();
    }
  }

  /** Texture keys that fell back to a placeholder, for tests and the overlay. */
  get missingTextures(): readonly string[] {
    return this.failed;
  }

  /** How many placeholder textures exist — used by the boot smoke check. */
  static get placeholderCount(): number {
    return PLACEHOLDER_SPECS.size;
  }
}
