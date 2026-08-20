/**
 * The death overlay's pure half (`docs/71-amendments-v3.md` §B4).
 *
 * Phaser-free (§A8). The countdown is the part worth testing, and it is the part
 * where the obvious implementation is wrong: a local timer started when the
 * `death` event arrives drifts by that event's own latency, and then the number
 * on screen disagrees with the moment the player actually respawns.
 */

export interface DeathInfo {
  victim: number
  attacker: number | null
  cause: string
  /** Round time at which the server will respawn them. */
  respawnAt: number
}

/**
 * Seconds left, from the **server's** clock.
 *
 * `roundTime` comes from the snapshot header, so this recomputes against the
 * authority every time a snapshot lands rather than counting down locally.
 */
export function secondsLeft(info: DeathInfo, roundTime: number): number {
  return Math.max(0, info.respawnAt - roundTime)
}

/** What the countdown shows. One decimal: whole seconds feel frozen. */
export function countdownText(secs: number): string {
  return secs <= 0 ? 'Respawning…' : `${secs.toFixed(1)}s`
}

/**
 * "Killed by ana" / "Killed by the meteor shower" / "You killed yourself".
 *
 * Three different attribution paths (`docs/31` §6), and they read differently on
 * purpose: a self-kill that says "killed by you" is worse than saying nothing.
 */
export function causeText(
  info: DeathInfo,
  nameOf: (id: number) => string | undefined,
): string {
  if (info.attacker !== null && info.attacker !== info.victim) {
    return `Killed by ${nameOf(info.attacker) ?? `player ${info.attacker}`}`
  }
  if (info.attacker === info.victim && info.attacker !== null) {
    return 'You killed yourself'
  }
  return `Killed by ${weatherName(info.cause)}`
}

function weatherName(cause: string): string {
  switch (cause.toLowerCase()) {
    case 'toxicrain':
    case 'toxic':
      return 'the toxic rain'
    case 'meteorshower':
    case 'meteor':
      return 'the meteor shower'
    case 'lavaburst':
    case 'lava':
      return 'a lava vent'
    case 'selfinflicted':
      return 'your own weapon'
    default:
      return cause || 'the map'
  }
}

/**
 * Is the overlay up?
 *
 * Driven by the server's `alive` flag rather than by the countdown reaching
 * zero, so a respawn that lands early or late is still what closes it.
 */
export function shouldShow(dead: boolean, info: DeathInfo | null): info is DeathInfo {
  return dead && info !== null
}
