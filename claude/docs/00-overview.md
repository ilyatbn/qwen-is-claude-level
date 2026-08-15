# 00 — Overview

## The game

Up to six players drop onto a randomly generated, fully destructible 2D map and
fight a free-for-all deathmatch for four minutes. The map looks and behaves like
the maps in the old Worms games: an organic solid silhouette against open sky,
carved into arbitrary shapes by every explosion.

- **Kill an opponent:** +1 point.
- **Die (including to your own rocket, or to the weather):** −1 point.
- **Round ends after 4 minutes.** Scoreboard appears, players vote to restart on a
  fresh map or quit.

All six players act simultaneously. There are no turns.

## What makes a round interesting

Three systems fight for the player's attention at once:

1. **The map is disappearing.** Every weapon digs. Cover is temporary, floors fall
   away, and holes reveal items buried in the rock.
2. **A day/night cycle runs every minute.** At night you can barely see, unless you
   found a flashlight — which narrows your view to a cone but lets you see far.
3. **Weather turns hostile at random.** Toxic rain, meteor showers, lava bursts and
   heavy fog arrive every 30–45 seconds with a short telegraph.

## Round flow

```
  Lobby ──▶ Warmup (10s) ──▶ Playing (240s) ──▶ Ended (20s vote) ──┐
              │                                                     │
              │  map generated from seed                            │
              │  items placed, players spawned                      │
              └──────────────◀── new seed, scores reset ────────────┘
```

## Scope: v1 vs later

| In v1 | Deliberately later |
|---|---|
| Deathmatch only | Team modes, last-man-standing, CTF |
| One room, capacity 6 | Lobby browser, matchmaking, multiple concurrent rooms |
| 3 weapons + medkit + shield + flashlight | The full Worms-scale arsenal |
| 3 map scales, 3 visual themes | Hand-authored maps, map voting |
| In-memory state | Postgres/Redis persistence, accounts, stats |
| Skins swappable from a local registry | Unlockables, a shop, cosmetics economy |
| Carved terrain floats in place | Terrain collapse / falling debris physics |
| Client hides players outside your view | Server-side visibility culling (anti-cheat) |

The "later" column is not vapour — the architecture leaves room for each item, and
each doc's *Future work* section says where the seam is.

## Traceability

Every requirement from the original brief maps to at least one doc and one
milestone. Use this table to check nothing was dropped.

| Requirement | Doc | Milestone |
|---|---|---|
| Phaser + socket.io + Rust backend | `01-architecture.md`, `40-net-protocol.md` | M0, M6 |
| Up to 6 players, 4-minute round, simultaneous | `41-server-loop-rooms.md` | M6 |
| Kill +1 / death −1, restart-or-quit vote | `21-player-stats.md`, `41-server-loop-rooms.md` | M6 |
| Map generated per round, random but always traversable | `10-map-generation.md` §2–§8 | M1 |
| Seeded and replayable | `10-map-generation.md` §1, `61-logging-debug.md` | M1, M8 |
| Fully destructible by weapons and weather | `11-map-destruction.md` | M1, M4, M5 |
| Three map scales | `02-constants.md`, `10-map-generation.md` §1 | M1 |
| Day/night, 1 minute per phase, poor night visibility | `14-daynight-visibility.md` | M5 |
| Flashlight must be found | `30-items-inventory.md`, `14-daynight-visibility.md` | M4, M5 |
| Random map effects (4 kinds) | `13-weather-effects.md` | M5 |
| Random ground spawn per player | `10-map-generation.md` §7, `21-player-stats.md` | M1, M6 |
| A/D movement | `20-player-movement.md` §3 | M2 |
| Jump with directional control, changeable mid-air | `20-player-movement.md` §4 | M2 |
| Jetpack: 5s fuel, 2s refill per 1s used, WASD flight | `20-player-movement.md` §5 | M2 |
| Mouse aim, crosshair on a ring around the player | `22-aiming-crosshair.md` | M2, M3 |
| Health 100 base, modified by items and damage | `21-player-stats.md` §1 | M4 |
| Dynamic movement speed | `21-player-stats.md` §3 | M4 |
| Optional shield from a shield generator | `21-player-stats.md` §2 | M4 |
| Dynamic field of view (fog, night, health) | `14-daynight-visibility.md` §3 | M5 |
| Real-time stat/position sync to other players | `40-net-protocol.md`, `42-netcode-prediction.md` | M6 |
| Weapons with ammo, range, damage, impact radius | `31-weapons-combat.md` | M4 |
| Health item restores 50% | `30-items-inventory.md` | M4 |
| Shield generator: reduced damage 20s | `21-player-stats.md` §2 | M4 |
| Inventory opened with right-click | `30-items-inventory.md` §3 | M4 |
| Items at round start, over time, from crates, buried | `32-item-spawning.md` | M4 |
| Buried items revealed by destruction | `11-map-destruction.md` §5, `32-item-spawning.md` §5 | M4 |
| Server knows the map from the seed | `10-map-generation.md` §1, `41-server-loop-rooms.md` | M6 |
| Server holds positions, health, shield, inventory | `41-server-loop-rooms.md` | M6 |
| Server owns rounds, score, time, cycle, effects | `41-server-loop-rooms.md` | M5, M6 |
| Docker for server and future databases | `62-docker-deploy.md` | M0, M8 |
| Toggleable debug logs for AI-assisted debugging | `61-logging-debug.md` | M0, M8 |
| Swappable player and weapon skins | `50-sprites-skins.md` | M7 |
| Preloaded map sprites, multiple terrain textures | `12-map-render.md`, `50-sprites-skins.md` | M3, M7 |
| Free assets from Kenney, properly structured | `51-assets.md` | M7 |

## Reading order for a human

`01-architecture.md` → `02-constants.md` → `10-map-generation.md` → the rest as needed.

## Future work

- Additional modes (teams, last-man-standing) hang off the round state machine in
  `41-server-loop-rooms.md`; the score rule is the only piece that is mode-specific.
- Spectators are a snapshot subscriber with no input channel — cheap to add at M6.
