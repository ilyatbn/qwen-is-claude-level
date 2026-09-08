/**
 * Hold to empty the clip (§F3).
 *
 * The pure half of automatic fire: a clock, and nothing Phaser. Kept free of the
 * scene for the reason `localInput-math.ts` is — the rules worth testing here are
 * the ones about *time*, and a rule about time tested through a render loop is
 * tested at whatever frame rate the machine felt like.
 *
 * ## What this does and does not own
 *
 * It owns **repeats only**. The first shot of a press still comes from
 * `pointerdown` in the scene, unchanged, and that is deliberate: a click that is
 * pressed and released between two frames never appears as a held pointer at
 * all, so a clock that owned the first shot would silently eat fast clicks. The
 * event guarantees the click; the clock adds what holding it means.
 *
 * ## It is a cadence, not a permission
 *
 * The server's `fire_ready_at` is the authority and does not move (§F3). If this
 * clock and the server ever disagree, the server refuses the shot and that is the
 * correct outcome — not something to compensate for here. What this exists to
 * avoid is the opposite failure: sending a request every frame and letting the
 * server say no sixty times a second for a ten-shots-a-second weapon.
 */

/**
 * The longest frame anything paced by the render loop will act on, in seconds.
 *
 * The scene's fixed-timestep accumulator has always clamped to this: a tab that
 * was backgrounded for ten seconds must not be simulated ten seconds forward in
 * one frame. The repeat clock needs the **same** ceiling for the same reason and
 * did not have it — fed the raw delta, a refocusing tab produced ~100
 * `sendFire()` calls in a single frame, which is the refused-request flood §F3
 * exists to prevent, arriving by a different route than the one already fixed.
 *
 * It lives **here** rather than in `GameScene` so the sharing is real. The scene
 * cannot be loaded by vitest — there is no canvas — so a copy declared there is
 * a copy no test can reach, and a test that then declares its own third copy is
 * self-consistent whatever the scene does. One exported constant, imported by
 * the scene and by the test, is the only version of "these cannot drift" that is
 * actually checkable.
 */
export const MAX_FRAME_DT = 0.25

/** What the clock needs to know about the selected weapon. */
export interface AutoFireWeapon {
  /** Does holding the button keep it firing? From the registry, never a local table. */
  auto: boolean
  /** Seconds between shots. The weapon's own `cooldown`, from the registry. */
  cooldown: number
}

export interface RepeatInput {
  /** Seconds since the last frame. */
  dt: number
  /** Is the **left** button held right now? Sampled, not evented. */
  held: boolean
  /** The selected weapon, or null when nothing is selected. */
  weapon: AutoFireWeapon | null
  /** Does the selected stack still have something in it? */
  hasAmmo: boolean
}

export class RepeatFire {
  /** Seconds since the last shot this press produced. */
  private since = 0
  /** Was the button held on the previous frame? The rising edge is the press. */
  private wasHeld = false

  /**
   * Advance the clock and say how many repeat shots to send this frame.
   *
   * Returns a count rather than firing, so the caller owns the side effect and
   * the rule stays testable. It is almost always 0 or 1 — it can exceed 1 only
   * if a frame took longer than the weapon's cooldown, and in that case the
   * shots are genuinely owed: dropping them would make a laggy client fire
   * slower than a smooth one at the same weapon.
   */
  update({ dt, held, weapon, hasAmmo }: RepeatInput): number {
    // A press starts the clock. Nothing is fired here — `pointerdown` already
    // sent that shot.
    if (held && !this.wasHeld) {
      this.since = 0
      this.wasHeld = true
      return 0
    }
    if (!held) {
      // Note what is *not* here: a `this.since = 0`.
      //
      // There was one, and it was unobservable — the rising edge above zeroes the
      // clock on every press, and `since` cannot grow while the button is up
      // because this returns before the accumulate below. A falsification proved
      // it: deleting the line left all twelve tests green, which is the
      // signature of code that reads as load-bearing and is not. Removed rather
      // than left with a comment, because the next reader would have to redo
      // that reasoning to find out.
      //
      // The press is where the cadence resets, and that **is** load-bearing:
      // without it a player could bank most of a cooldown by tapping and
      // out-shoot the weapon's own rate.
      this.wasHeld = false
      return 0
    }

    this.since += dt

    // Blocked: held, but there is nothing to repeat — no weapon, a non-automatic
    // one, or an empty stack.
    //
    // **The clock keeps running, but it is clamped to a single cooldown**, and
    // the clamp is the whole fix. The comment here used to say the running clock
    // "costs nothing"; it cost 29 shots in one frame. `since` grew for as long
    // as the button was held while blocked, and the drain loop below then paid
    // every banked cooldown out in the frame the block lifted — a burst larger
    // than the 60 msg/s flood §F3 exists to prevent, and reachable by holding
    // fire on a spent SMG and walking over ammo.
    //
    // Clamping rather than zeroing keeps what the running clock was for: a
    // player who switches to an automatic mid-hold gets their first repeat
    // promptly instead of waiting a full extra cooldown.
    const blocked = !weapon || !weapon.auto || !hasAmmo || !(weapon.cooldown > 0)
    if (blocked) {
      // A weapon we know the cadence of clamps to its own cooldown. With nothing
      // selected there is no cadence to preserve, so there is nothing to bank.
      this.since = Math.min(this.since, weapon?.cooldown ?? 0)
      return 0
    }
    // Narrowing for TypeScript: `blocked` already proved both of these.
    if (!weapon || !(weapon.cooldown > 0)) return 0

    // **A frame cannot owe more shots than its own elapsed time allows**, plus
    // the one cooldown that may have been banked before it. Derived from `dt`
    // rather than a fixed cap, so a genuine long frame still pays out what the
    // wall clock earned — a laggy client must not fire slower than a smooth one
    // — while no frame can ever discharge an unbounded bank.
    const owed = Math.floor(this.since / weapon.cooldown)
    const allowedByElapsed = Math.floor(dt / weapon.cooldown) + 1
    const shots = Math.min(owed, allowedByElapsed)
    this.since -= shots * weapon.cooldown
    // Belt and braces: whatever the arithmetic leaves behind, never carry more
    // than one cooldown into the next frame.
    this.since = Math.min(this.since, weapon.cooldown)
    return shots
  }

  /** Forget the press. For a scene tearing down, or a player who just died. */
  reset(): void {
    this.since = 0
    this.wasHeld = false
  }
}
