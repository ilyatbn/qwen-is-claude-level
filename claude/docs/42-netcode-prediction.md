# 42 — Prediction, reconciliation and interpolation

The server is 30–150 ms away. Waiting for it before moving would make the game feel
broken. This document is how the client hides that latency without ever being
allowed to lie about the outcome.

Standard client-side prediction with server reconciliation, plus entity
interpolation for everyone else. What is unusual here is that the prediction runs
the **exact same compiled physics code** as the server, via WASM — so the only
source of divergence is missing information, never mismatched maths.

Numbers in `02-constants.md`.

---

## 1. Your own player: predict

Every frame:

1. Sample the keyboard and mouse into an `Input` with the next `seq`.
2. Push it into a local ring buffer of pending inputs.
3. Send it (with the previous 2, for redundancy) to the server.
4. **Apply it immediately** to the local player state by calling the same
   `apply_input` from `game-core` that the server will call.

The player sees their own movement respond in one frame, at zero latency.

The local prediction runs against the client's own copy of the terrain mask — which
is bit-identical to the server's (`11-map-destruction.md` §6) — so predicted
collisions match real collisions exactly, even after the ground has been blown up.
This is the payoff for shipping the mask instead of approximating terrain on the
client.

## 2. Reconciliation

Each snapshot carries `last_input_seq`: the highest input sequence the server had
processed when it built that snapshot.

```
on snapshot:
    drop pending inputs with seq <= snapshot.last_input_seq
    error = distance(local.pos, snapshot.my_pos)
    if error > RECONCILE_EPSILON_PX (2.0):
        local.state = snapshot.my_state          // accept the server's truth
        for input in pending:                    // replay what it hasn't seen
            apply_input(&mut local.state, input, dt)
```

Because `apply_input` is the same code, replaying `n` pending inputs lands on
exactly the state the server will reach when it processes them. A correction is
usually invisible.

The 2-px epsilon is a filter against float noise, not against real error. If
corrections above the epsilon happen constantly, something is genuinely wrong —
count them and expose the rate in the debug HUD.

**Snapping vs smoothing.** On a correction, snap the *simulation* state
immediately but smooth the *rendered* position toward it over ~100 ms. The
simulation must never lag behind the truth, and the eye must never see a teleport.
Errors above 64 px (a big knockback, a respawn) snap visually too — smoothing a
teleport looks worse than the teleport.

## 3. What the client does not predict

Prediction is only safe when the client has all the inputs. It does not, for:

| Not predicted | Why |
|---|---|
| Damage and health | Depends on other players' actions |
| Death and respawn | Same |
| Knockback | The client cannot know an explosion is coming |
| Item pickup | Contested; the server arbitrates ties |
| Weather hazards | Server-rolled, and they carve terrain |
| Other players' movement | See §4 |
| Firing (the projectile) | See §5 |

For all of these the client waits for the server and reacts. The rule: **predict
only what your own input fully determines.**

## 4. Other players: interpolate

Remote players are rendered `INTERP_DELAY_MS` (100) **in the past**, between the two
snapshots that bracket `now - 100 ms`.

```
render_time = now - INTERP_DELAY_MS
find snapshots a, b with a.time <= render_time <= b.time
t = (render_time - a.time) / (b.time - a.time)
pos = lerp(a.pos, b.pos, t)
aim = slerp_short(a.aim, b.aim, t)        // 22-aiming-crosshair.md §5
```

100 ms is two snapshot intervals at 20 Hz, so one dropped snapshot still leaves a
bracketing pair and interpolation continues smoothly.

If no future snapshot exists (a real stall), **extrapolate** using the snapshot's
velocity for at most 250 ms, then freeze the player in place. Extrapolating longer
produces players sliding confidently through walls, which is worse than a
momentarily frozen figure.

Remote players are never run through `apply_input` — there are no remote inputs to
run. Interpolation of transmitted positions is both cheaper and more accurate.

## 5. Firing feels instant, but is not predicted

Firing is deliberately *not* predicted: a predicted projectile that the server
rejects (no ammo, cooldown, dead) has to be un-spawned, which looks worse than a
short delay.

Instead the client fakes the *feel* immediately and waits for the truth:

- on LMB, play the muzzle flash, recoil animation and sound at once;
- the actual projectile appears when `projectile_spawn` arrives, spawned at the
  event's position and velocity and then simulated locally by `game-core` until a
  `projectile_despawn` or `explosion` arrives.

At 60 ms RTT the flash and the rocket are ~4 frames apart, which reads as the rocket
"leaving the tube". Ammo counts update from the authoritative `inventory` event.

## 6. Terrain

Carve events are applied to the local mask in `seq` order (`40-net-protocol.md` §3).
The client never carves speculatively — a predicted crater in the wrong place would
corrupt collision for the local player, and every subsequent prediction with it.

A carve arriving out of order is buffered until its predecessor arrives; if the
predecessor does not arrive within 2 s, request `resync_map`.

## 7. Clock sync

A simple offset estimate, no NTP:

- `welcome` carries the server `tick` and `round_time`.
- Every snapshot carries `tick`; the client tracks
  `offset = server_time_estimate - local_time` with an exponentially-weighted mean
  and rejects samples more than 3σ out.
- RTT is measured from socket.io's own ping/pong.

The client's tick estimate is only used for ordering events and for the interpolation
clock. Nothing gameplay-critical depends on it, which is why this can stay simple.

## 8. Debug HUD

Toggled with `F3`. Without these numbers, netcode bugs are guesswork:

- RTT, jitter, packet loss estimate;
- snapshots/s received, inputs/s sent;
- pending-input buffer depth;
- reconciliation rate (corrections/s) and mean/max correction distance;
- interpolation buffer depth per remote player, and extrapolation time if active;
- local vs server position for the local player, drawn as two ghosts;
- mask checksum status (matched / mismatched / resyncing);
- current tick, server tick estimate, offset.

## 9. Testing

Pure logic is extracted from the Phaser scenes and tested with `vitest`:

- The pending-input buffer drops exactly the acknowledged prefix on each snapshot.
- Replaying `n` pending inputs from a corrected state matches simulating those `n`
  inputs from the original state (the core reconciliation identity).
- Interpolation picks the correct bracketing pair, including when snapshots arrive
  out of order.
- With a snapshot missing, interpolation still produces a smooth path.
- Extrapolation stops after 250 ms and holds position.
- Aim interpolation takes the short way around the circle.
- The clock offset estimator converges and rejects outliers.
- Out-of-order carves are buffered and applied in `seq` order.

Rust-side, in `game-core`: `apply_input` determinism (`20-player-movement.md` §8) is
the foundation the whole scheme rests on — if that test fails, none of this works.

## 10. Future work

- Lag compensation for hitscan (`31-weapons-combat.md` §8).
- Adaptive `INTERP_DELAY_MS` based on measured jitter, instead of a fixed 100 ms.
- Delta-compressed snapshots keyed on the last acknowledged tick.
- Input redundancy scaled to measured loss rather than fixed at 3.
