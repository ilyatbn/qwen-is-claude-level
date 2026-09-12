# Shaders for fog, clouds, fire and rain — research

**Status: research only. Nothing here is implemented, and I do not recommend
implementing all of it.** Written against the tree at `f256b80`.

Every measurement below was taken from the code, not recalled. Where I could not
measure something without running the game, I say so rather than estimating.

---

## 1. The single most important fact

**This project uses no shaders at all today.** `grep -riE "pipeline|shader|glsl|
fragmentShader|PostFX"` over `client/src` returns one hit, and it is the word
"pipeline" in a comment in `birds.ts` about art pipelines.

That is not an oversight to correct. It is a property worth pricing before
changing, because of the next fact.

### The renderer is `Phaser.AUTO`

`client/src/main.ts` sets `type: Phaser.AUTO`, which selects WebGL where available
and **falls back to Canvas** where it is not. Every custom pipeline and every
shader is WebGL-only: under Canvas they do not run, and Phaser does not emulate
them.

So a shader rewrite forces one of three choices, and the choice must be made
deliberately rather than discovered:

1. **Keep both paths** — a shader version and the current version, selected at
   runtime. Double the code for each effect, and the two will drift; this repo has
   a rule about that and has paid for it.
2. **Drop the Canvas fallback** — switch to `Phaser.WEBGL` and accept that a
   machine without WebGL gets nothing. Honest, simple, and a product decision
   rather than a technical one.
3. **Shader-ise only what degrades gracefully** — effects where "no shader" means
   "slightly plainer", not "invisible".

**Option 3 is the one I would take**, and §5 says which effects qualify.

### The precedent that any shader proposal must beat

`render/lightmap.ts` deliberately uses a **2D canvas instead of a
`RenderTexture`**, and its header records the measurements:

> the rendered hole did not match and did not track: r=100 rendered ≈103 px,
> r=300 rendered ≈156, r=450 rendered ≈232 — it stopped growing near the eraser
> texture's native size and sat off-centre.

That is the closest thing in this codebase to a GPU-composited effect, and it was
removed *because it was measurably wrong*, not because it was slow. Anything
proposing to move the lightmap onto a shader has to produce numbers against that
list, not an argument.

---

## 2. What each effect costs today

| effect | where | per-frame work |
|---|---|---|
| rain | `weather.ts` | up to **260** drops, one `lineBetween` each, into one `Graphics`; plus a full-screen `fillRect` vignette |
| fog | `weather.ts`, `lightmap.ts` | one full-screen `fillRect` at `FOG_SCREEN_ALPHA` (0.8); separately a **half-resolution 2D canvas** filled and `destination-out`-erased per light, then uploaded and scaled |
| clouds | `parallax.ts` | a **fixed pool** of `Image`s, repositioned and re-tinted — never recreated; ridge is a `TileSprite` baked once per seed |
| fire | `ordnance.ts` | per live flame: a flicker lookup and primitive draws; flames also feed `lights()` into the lightmap |

Two things stand out.

**Clouds and the ridge are already the right shape.** `parallax.ts`'s header states
the claim precisely — one bake per seed, a fixed sprite pool, `setTint` guarded so
it only fires when the colour moves. A shader would replace something that is
already O(1) per frame. **I would not touch clouds.**

**Rain is the one with real per-frame cost.** 260 `lineBetween` calls into a
`Graphics` means 260 path segments rebuilt every frame, and `drops.slice(0, n)`
allocates a fresh array each frame on top. That is the clearest candidate.

---

## 3. What a shader would actually buy, per effect

### Rain — the strongest case

A fragment shader over one full-screen quad can draw an arbitrary number of
streaks for the cost of one draw call, by hashing screen position into a falling
streak field. Density becomes a uniform; the current `visibleDrops` slice becomes
a number, not an array.

- **Wins**: 260 path segments → 1 quad; no per-frame allocation; density and fall
  angle become free to vary; depth layering becomes trivial.
- **Costs — and this is the correction that matters.** I first wrote "smallest
  blast radius", then checked. `RainField`'s drop objects are **pinned by eight
  unit tests** (`weather-math.test.ts`) covering a fixed pool, ramping, wrapping,
  the density-vs-intensity distinction, and seeded determinism
  (`a.drops).toEqual(b.drops)` plus a different-seed inequality). `rainDrops` is
  also exposed through `debug()` in **both** scenes and read by browser checks as
  the "other end" of the rain count.

  So a shader must **not** delete the field. The right shape is: `RainField`
  remains the model — still seeded, still deterministic, still tested exactly as
  now — and only the **draw** changes, from 260 `lineBetween` calls to one quad
  with the field's state as uniforms. The win shrinks from "no objects" to "one
  draw call instead of 260", which is still the real cost, and the determinism
  tests survive untouched.

  Separately: the simulation's toxic drops are a **different thing**
  (`Delivery::Bullet` projectiles that damage) and must not be conflated with the
  cosmetic sheet.
- **Degrades**: to the current code, cleanly — the model is unchanged, so the
  fallback is the existing draw loop. Good option-3 candidate.

### Fog — a real visual win, and the riskiest

Today fog is a flat 80 % alpha rectangle. A shader could give it depth — animated
noise, thicker at distance, parting near a light source.

- **Wins**: the biggest *visual* upgrade of the four. A flat wash is the least
  convincing effect in the game.
- **Costs**: fog interacts with the **lightmap**, which is the one subsystem with
  documented history of GPU compositing going wrong here. `fogVeilAlpha` is also
  read by gameplay-adjacent code (`FLASHLIGHT_FOG_VEIL_MULT`), and several browser
  checks assert fog by sampling pixels — `fog-visible`, `night-combat`,
  `weather-visible`. Every one of those thresholds would need re-measuring.
- **Verdict**: highest reward, highest blast radius. **Do it second, alone, with
  its own task.**

### Fire — moderate

Flames are already atlas particles plus primitives, and they feed the lightmap.
A shader could add heat-haze refraction and better additive blending.

- **Wins**: mostly aesthetic. Heat haze is the one thing genuinely impossible today.
- **Costs**: flames are *simulation* objects (`FLAME_DPS`, `FLAME_SCORCH_R`) — the
  renderer must keep drawing where the damage is. A shader that looks better but
  drifts from the damage circle is worse than what exists; `ordnance.ts` already
  notes it draws flames slightly larger than `FLAME_RADIUS` on purpose.
- **Verdict**: do this last, if at all.

### Clouds — no

Already a fixed pool with a per-seed bake. A shader replaces O(1) with O(1) and
loses the 120-frame art atlas. **Recommend against.**

---

## 4. How it would be done in Phaser 3.90

Two mechanisms, and they are not interchangeable:

- **`PostFXPipeline`** — runs over an already-rendered object or camera. Right for
  fog and heat haze: they modify *what has been drawn*.
- **`PreFXPipeline` / a custom `SpriteFXPipeline`** — right for rain: a quad the
  effect draws into from nothing.

Both are registered on the game config's `pipeline` map and attached with
`setPostPipeline` / `setPipeline`. Neither exists in this codebase yet, so the
first task to land one pays the setup cost: a pipeline registry, a place for GLSL
that the build can see, and a decision about whether shader source is inlined in TS
or loaded as an asset (`assets/manifest.json` has no concept of a shader today).

**Checked**: `client/vite.config.ts` has **no** `glsl` or shader handling
(`grep -cE "glsl|shader"` → 0). So file-based shaders would need a plugin or a
`?raw` import convention; inlining GLSL as template literals in TS sidesteps it
entirely, and is what I would try first.

---

## 5. Recommendation

0. **Profile first.** One `perf.mjs`-style frame-time sample with rain on and off.
   The ordering below is reasoning, not measurement, and 260 line segments may not
   be the bottleneck it looks like. This step is cheap and could invalidate the
   rest of this list.
1. **Rain first** — *if* the profile supports it. It establishes the pipeline
   plumbing every later effect reuses, and its model stays intact so the change is
   confined to the draw.
2. **Fog second, as its own task.** Biggest visual payoff, but it touches the
   lightmap and at least three pixel checks. Not to be bundled with anything.
3. **Fire third, optional.** Heat haze only. Keep the draw aligned to the damage.
4. **Clouds: no.** Already correct.

And before any of it: **decide the Canvas-fallback question explicitly.** That is a
product call, not an implementation detail, and every effect's design depends on
the answer.

## 6. What I have not verified

Stated plainly so nobody treats this as more than it is:

- No FPS profile was taken. The claim "rain is the expensive one" rests on reading
  the draw loop (260 segments + a per-frame `slice`), **not** on a measurement.
  `scripts/checks/perf.mjs` samples frame times and would be the instrument. **This
  is the biggest gap in this document** — the whole ordering rests on it, and it is
  reasoning rather than evidence.
- Phaser 3.90's pipeline API is stated from its documented shape, not from a
  compiling example in this tree.
- Whether a full-screen rain quad actually beats 260 short `Graphics` segments on
  *this* hardware is unmeasured. 260 is not a large number; the win may be smaller
  than it sounds, and the honest first step is to profile before writing GLSL.

**Two claims that were in an earlier draft of this file and turned out to be
wrong** are corrected above rather than quietly removed: that rain had the
smallest blast radius (it has eight unit tests and two debug consumers pinned to
its drop objects), and that Vite's `.glsl` handling was unknown (it has none).
