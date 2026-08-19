# 22 — Aiming and the crosshair

The player aims with the mouse. A crosshair rides a ring around the player's body
at a fixed radius, showing the firing direction — the Worms convention, adapted to
free mouse aim rather than up/down keys.

---

## 1. The model

Aim is **one angle**, nothing more. Not a target point, not a distance.

```
dx    = mouse_world_x - player_center_x
dy    = mouse_world_y - player_center_y
angle = atan2(dy, dx)          // radians, 0 = right, +y = down (screen convention)
```

If the mouse is within `AIM_DEADZONE` (8 px) of the player's centre, the previous
angle is kept. Without that, the crosshair spins wildly whenever the cursor passes
over the player.

The crosshair is drawn at:
```
crosshair = player_center + (cos(angle), sin(angle)) * AIM_RADIUS      // 48 px
```
so it traces a circle around the player. The ring itself is drawn faintly at all
times, which is the visual cue that aim is angular, not positional.

**Weapons fire along the angle from the player centre**, not toward the mouse. The
mouse's distance from the player is irrelevant — moving the cursor further away
does not increase range or power. This keeps aiming honest at every zoom level and
means the server only needs one number.

## 2. Wire format

The angle is quantised to a `u16`:

```
wire  = ((angle / TAU) * 65536) as u16      // wrapping, so no clamping needed
angle = (wire as f32 / 65536.0) * TAU
```

Resolution is 2π/65536 ≈ 0.0055° — about 0.06 px of error at 640 px range, which is
far below anything a player can perceive or exploit. Two bytes, in both the input
packet and the snapshot.

Because it wraps naturally, there is no special handling at the ±π boundary, which
is the usual source of aim-interpolation bugs.

## 3. Where the angle is used

| Consumer | Use |
|---|---|
| `31-weapons-combat.md` | Projectile launch direction; hitscan ray direction |
| `14-daynight-visibility.md` | Flashlight cone direction — you light what you aim at |
| `50-sprites-skins.md` | Which of the 8 body-facing frames to draw; weapon sprite rotation |
| Client render | Crosshair position, aim ring, trajectory preview |

## 4. Facing

Body facing is derived from the aim angle, not from movement keys: `cos(angle) < 0`
means facing left. Movement and facing are therefore independent — you can walk
right while aiming and shooting left, which matters constantly in a deathmatch.

The sprite uses 8 aim-direction frames (`50-sprites-skins.md`), picked by
`round(angle / (TAU/8))`.

## 5. Remote players

Every snapshot carries each player's aim. Remote crosshairs are **not** drawn — you
see the enemy's body facing and weapon orientation, which is enough to read their
intent without giving away their exact aim.

Remote aim is interpolated the short way around the circle:
```
delta = wrap_to_pi(target - current)
current += delta * t
```
Naive linear interpolation of the raw `u16` makes a player's weapon spin a full
turn whenever the angle crosses the wrap point.

## 6. Trajectory preview

For arcing weapons (bazooka, grenade), the client draws a short dotted arc from the
muzzle showing the first ~0.4 s of flight, simulated with the same gravity and wind
constants the server uses.

It is a **preview, not a guarantee** — it stops well before any impact and does not
show the full path. Enough to make aiming learnable, not enough to make it trivial.
Hidden for hitscan weapons.

## 7. Input details

- Aim is sampled every frame on the client and sent with every input packet at the
  sim rate. It does not need its own message.
- The mouse position must be converted through the camera to **world** coordinates
  before computing the angle — using screen coordinates silently breaks aim as soon
  as the camera scrolls.
- Right mouse button is the inventory toggle (`30-items-inventory.md`), so the
  browser context menu must be suppressed on the game canvas.
- Pointer lock is **not** used in v1: the crosshair is world-anchored, and pointer
  lock would fight the inventory UI.

## 8. Testing

Pure maths, so all of it is unit testable:

- `quantise(dequantise(x)) == x` for all 65536 values.
- `dequantise(quantise(θ))` is within 0.0001 rad of θ for a sweep of angles.
- Angles wrap: quantising 2π and 0 give the same word.
- The deadzone holds the previous angle when the mouse is within 8 px.
- Crosshair position is exactly `AIM_RADIUS` from the player centre, for a sweep of
  angles.
- Shortest-arc interpolation from 350° to 10° passes through 0°, not through 180°.
- Facing flips at exactly ±π/2.

## 9. Future work

- Charge-up power for arcing weapons (hold to charge, as in Worms). The wire format
  needs one extra byte; the aim model is unchanged.
- Aim assist / snapping for gamepad support.
- Per-weapon `AIM_RADIUS` so heavier weapons visibly hold the crosshair further out.
