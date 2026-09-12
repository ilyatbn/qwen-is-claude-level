# Shaders — making the game look better

**Research only. Nothing here is built.**

The goal is **looks**, not speed. An earlier draft of this file ordered the work
by frame cost, which was the wrong question: the game runs fine and looks plain.
This version ranks by *how much better it would look*, and says where a shader
would change nothing worth having.

---

## The one rule that constrains everything

**A shader can only change how something is drawn. It must never change what the
game does.**

Several effects in this game look cosmetic and are not:

| looks like decoration | actually is |
|---|---|
| falling toxic rain | real projectiles that hit you, hurt you, and eat the ground |
| flames | a damage area with a radius you can stand in |
| smoke cloud | a vision blocker — it decides what players can see |
| the lava vent's glow | a hazard that burns |

So for each effect there are two layers, and only one of them may become a
shader: **the picture**, never **the thing that touches the player**.

### Rain specifically — safe, and here is why

You asked about this, and it checks out. There are **two separate rains**:

- the drops that **hurt you** are real projectiles (`WEAPON_TOXIC_DROP`) — they
  fall, land, damage and carve;
- the rain you **see** is a separate cosmetic sheet of 260 streaks with no
  gameplay effect at all.

A shader would replace only the second. The damaging drops stay exactly as they
are and keep being drawn as projectiles on top. **Rain is safe to do.**

---

## Ranked by how much better it would look

### 1. Fog — the biggest win by a distance

Today fog is **one flat grey rectangle at 80 % opacity over the whole screen**.
That is the single least convincing thing in the game: it does not move, it has
no depth, and it looks identical everywhere.

A shader gives it drifting volume, thickness that varies across the screen, and
light bleeding through near a torch. Same idea, completely different feeling.

**Care needed**: fog interacts with the light/darkness layer, and a few automated
screenshots measure fog brightness. Those would need re-checking.

### 2. Smoke grenades — you were right to name them

A smoke cloud is currently a **flat grey circle**. It is a vision blocker, so it
matters tactically, and it looks like a placeholder.

A shader gives it billowing, a soft eaten edge, and slow curl as it disperses.
**The vision-blocking stays exactly where it is** — that is simulation, and only
the picture changes.

### 3. Fire and explosions

Flames are small coloured blobs. A shader gives heat-haze — the air wobbling
above a fire — which is genuinely impossible today, plus better glow falloff.

**Care needed**: flames *are* the damage area. The picture must keep matching
where the burning actually is, or players get hit by fire they cannot see.

### 4. Rain

The sheet of streaks reads as a field of identical ticks. A shader gives varied
speeds, depth layers, and drops that streak properly. Nice, not transformative.

### 5. Lava vents

Currently a glowing mouth plus flame sprites. A shader could give it a molten
shimmer. Small win, easy, low risk.

### 6. Clouds — **superseded**

This section said "leave alone: already real artwork that looks how it should".
The coordinator does not like them, which settles it — that judgement was mine
and it was about effort rather than looks. They are now **off by default and a
shader under High Quality**. Left here rather than deleted so the reversal is
visible.

---

## Others worth considering

Not asked for, but they are the other flat-looking things:

- **The shield bubble** — a plain circle. Could ripple, and flash on absorbing a
  hit. Cheap, and it makes a defensive item feel like one.
- **Water/void edges** — where the world ends. Currently a hard cut.
- **The terrain itself** — now seeded per map, but still flat mottling. A shader
  could add depth and wetness without touching the destructible shape, which is
  simulation and must not move.
- **Teleport gate portal** — the blue fill is a flat disc. A swirl would sell it.
- **Player hit flash** — currently a colour flash. Could be a proper impact pulse.

---

## Decisions taken (coordinator, this session)

1. **It is a toggle, not a fallback question.** A **High Quality** switch in the
   options menu. Off, the game draws as it does today; on, the shader versions
   run. That settles the old-machine problem without dropping anything, and it
   means every effect below is additive rather than a replacement.

2. **The clouds go.** They are not liked. Off by default, and rewritten as a
   shader for High Quality rather than kept as sprites. (This reverses the
   earlier recommendation to leave them alone, which was mine and was about
   effort, not looks.)

3. **The pattern is: simulation stays, drawing changes.** Where something both
   acts and appears, the acting half is untouched and only the picture becomes a
   shader. That applies to fire, smoke, rain and explosions — and it is the rule
   that keeps this safe to do at all.

4. **Lasers turn out to be the easiest case, not the hardest.** They are not
   projectiles: `Delivery::Hitscan` resolves instantly and the client draws a
   fading line. There is nothing to make invisible — the shader simply replaces
   the line. Same for any future beam weapon.

## Build order

Each of these is its own task, and each must be finished before the next starts.

| # | what | why here |
|---|---|---|
| 1 | **Options menu + High Quality toggle** | everything else hangs off it; the escape menu already has a disabled "Options — coming soon" button to fill in |
| 2 | **Shader plumbing + fog** | the first effect pays for the setup, and fog is the ugliest thing on screen |
| 3 | **Clouds** | off by default, shader when High Quality |
| 4 | **Smoke grenades** | same technique as fog, smaller target |
| 5 | **Laser beams** | easiest, because there is no projectile to reconcile |
| 6 | **Fire, then explosions** | last, because their pictures must keep matching where the damage is |

## What I have not checked

- Whether the build tool can load shader files. Writing them inline in code
  avoids the question and is what I would try first.
- Nothing here has been prototyped, so "it would look better" is judgement about
  a technique, not something I have seen running in this game.
- Whether the toggle should also exist on the title screen rather than only
  mid-match. Worth deciding when the options menu is built.
