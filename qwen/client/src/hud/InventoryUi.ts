import Phaser from 'phaser';
import type { SlotView } from '../logic/inventoryModel';

/** Panel geometry, px. */
const SLOT_SIZE = 56;
const SLOT_GAP = 6;

/**
 * The 6-slot inventory panel (T3.9 step 1).
 *
 * Right-click or Tab toggles it; clicking a slot emits `use-slot`. The game
 * keeps running — docs/04 §5 and T3.9 step 1 both say real-time, no pause.
 *
 * Purely presentational: slot contents come from `logic/inventoryModel.ts`,
 * which is Vitest-tested.
 */
export class InventoryUi {
  private readonly scene: Phaser.Scene;
  private readonly container: Phaser.GameObjects.Container;
  private readonly cells: {
    box: Phaser.GameObjects.Rectangle;
    label: Phaser.GameObjects.Text;
  }[] = [];
  private open = false;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.container = scene.add.container(0, 0).setScrollFactor(0).setDepth(900);

    const width = 6 * SLOT_SIZE + 5 * SLOT_GAP;
    const backdrop = scene.add
      .rectangle(0, 0, width + 16, SLOT_SIZE + 16, 0x000000, 0.7)
      .setOrigin(0, 0);
    this.container.add(backdrop);

    for (let i = 0; i < 6; i += 1) {
      const x = 8 + i * (SLOT_SIZE + SLOT_GAP);
      const box = scene.add
        .rectangle(x, 8, SLOT_SIZE, SLOT_SIZE, 0x222228)
        .setOrigin(0, 0)
        .setStrokeStyle(2, 0x555560)
        .setInteractive({ useHandCursor: true });
      // Clicking a slot is the same as pressing its number key (docs/04 §5).
      box.on('pointerdown', () => this.scene.events.emit('use-slot', i));

      const label = scene.add
        .text(x + 4, 12, '', { font: '10px monospace', color: '#e0e0e0' })
        .setOrigin(0, 0);

      this.container.add([box, label]);
      this.cells.push({ box, label });
    }

    this.container.setVisible(false);
  }

  toggle(): void {
    this.open = !this.open;
    this.container.setVisible(this.open);
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Position the panel along the bottom of the viewport. */
  layout(viewWidth: number, viewHeight: number): void {
    const width = 6 * SLOT_SIZE + 5 * SLOT_GAP + 16;
    this.container.setPosition((viewWidth - width) / 2, viewHeight - SLOT_SIZE - 40);
  }

  /** Redraw from the model (T3.9 steps 1–2). */
  update(slots: SlotView[]): void {
    for (const [i, cell] of this.cells.entries()) {
      const slot = slots[i];
      if (!slot) {
        continue;
      }
      cell.box.setStrokeStyle(2, slot.selected ? 0xffcc44 : 0x555560);
      cell.box.setFillStyle(slot.empty ? 0x18181c : 0x222228);
      const ammo = slot.ammo === null ? '' : `\n x${slot.ammo}`;
      cell.label.setText(slot.empty ? `${i + 1}.` : `${i + 1}. ${slot.name}${ammo}`);
    }
  }

  destroy(): void {
    this.container.destroy(true);
  }
}
