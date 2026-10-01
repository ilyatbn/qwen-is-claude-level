/**
 * T23.28: **one reset for everything a round leaves behind.**
 *
 * Reported from `make watch`: *"when games restart all the tombstones and items leftover are still on the map and you
 * cannot interact with them."* A restart keeps the scene (and the socket) and changes the world under it, and the
 * client's per-round state lived in a dozen holders — the mirror's items and graves, the interpolator's frames, the
 * ordnance layer's mines, the scene's clocks — each cleared ad hoc, or not at all. Ids are reused by the next world, so
 * a stale entry can even alias a new one.
 *
 * Every holder registers its own reset here, once, where it is built; `GameScene`'s `new_round` handler runs them all.
 * A new holder that forgets to register is the bug this replaces, so `names` is on the debug handle: a check can see
 * which holders a restart reset.
 */
export class RoundReset {
  private readonly holders: { name: string; reset: () => void }[] = []
  /** How many times `run` has been called (a restart the client heard), for the debug handle. */
  runs = 0

  /** Register `reset` under `name`. A name registered twice is a holder built twice — refused, loudly. */
  register(name: string, reset: () => void): void {
    if (this.holders.some((h) => h.name === name)) throw new Error(`RoundReset: '${name}' registered twice`)
    this.holders.push({ name, reset })
  }

  /** Reset every holder, in registration order. Returns the names reset. */
  run(): string[] {
    this.runs += 1
    for (const h of this.holders) h.reset()
    return this.names
  }

  get names(): string[] {
    return this.holders.map((h) => h.name)
  }
}
