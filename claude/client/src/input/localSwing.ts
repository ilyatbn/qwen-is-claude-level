/**
 * T23.09D: **your own swing plays on the frame you fire**, predicted — not on the raw click (a refused use swung too:
 * T23.14D's review) and not on the server's `melee` echo (a round trip after the click: T23.14D's fix). The client does
 * not run `fire` (server-authoritative), so the prediction is the checks the server makes that the client can see: the
 * player is alive, not riding a platform (a rider fires the platform), holds a melee or thrown weapon with something
 * in the stack, and that weapon's cooldown (the registry's, `FireProfile.cooldown`) has passed since the last use this
 * predicted. Remotes keep the server's events. A use the server still refuses (a clock skew within one cooldown) swings
 * anyway — the price of no round trip, and the same shape as every predicted action.
 */
export interface SwingUse {
  /** Seconds, any monotonic clock the caller keeps (the scene's wall clock). */
  now: number
  alive: boolean
  mounted: boolean
  /** The selected stack's registry key and count, or null. */
  key: string | null
  count: number
  /** Whether `key` swings (melee) or is thrown — the look's `WEAPONS[key].melee / thrown`. */
  swings: boolean
  /** The weapon's cooldown, s (registry); null: none known — a use is then never predicted refused by it. */
  cooldown: number | null
}

export class LocalSwing {
  private lastAt = -Infinity
  private lastKey: string | null = null

  /** A fire request is being sent now: does it swing the local figure? (Records the use when it does.) */
  use(u: SwingUse): boolean {
    if (!u.alive || u.mounted || !u.key || u.count <= 0 || !u.swings) return false
    const cd = u.cooldown ?? 0
    // Switching weapons does not reset the server's clock (it is per player, `fire_ready_at`), so neither does this.
    if (u.now - this.lastAt < cd) return false
    this.lastAt = u.now
    this.lastKey = u.key
    return true
  }

  /** A new life or round: nothing is cooling down. */
  reset(): void {
    this.lastAt = -Infinity
    this.lastKey = null
  }

  /** Dev: the key last swung. */
  get last(): string | null {
    return this.lastKey
  }
}
