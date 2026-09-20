# Defects found while specifying M22, none of them M22's

Five forward sweeps and one harsh review read most of this codebase between 2026-09-19 and
2026-09-20 without writing any of it. These are the things they found **in shipped code and
shipped comments** that no M22 task should fix, because fixing them inside a feature task is
how a bisect stops working.

**Each one is a claim with the command that produced it.** None is a crash; all of them are
the same shape — *a claim reported through something other than the thing it claims*.

---

## 1. `ITEM_SPAWN_INTERVAL`'s tuning was measured on the wrong map size

`constants.rs::ITEM_SPAWN_INTERVAL`'s doc comment says:

> *"Measured over 8 seeds × 150 s at all three scales (§A19: `DEFAULT_MAP_SCALE` is Large, so
> tuning on Small would set the number where it does not matter)"*

But `constants.rs::DEFAULT_MAP_SCALE` is **`MapScale::Medium`**. The parenthesis is not a
stale aside — it is the stated **reason** the table was tuned where it was, so the whole table
under it rests on a premise that is no longer true. Medium gives 14 initial items, not Large's
20, which is a ~30 % difference in the quantity the tuning was about.

**Worth the owner's attention specifically**, because `CLAUDE.md` already records that
**nothing in this repository detects `ITEM_SPAWN_INTERVAL` changing** — a suite pinned to a
constant cannot see the constant move. This is the same constant, and its basis has moved
underneath it without anything reporting that either.

## 2. `a_draw_is_always_possible` names a panic that cannot happen

`effects/scheduler.rs::a_draw_is_always_possible`'s doc comment calls an all-zero weights table
*"the panic this rules out"*. `rng.rs::pick_weighted` does not panic there:

```rust
let total: u32 = weights.iter().map(|&w| w as u32).sum();
if total == 0 { return 0; }
```

It returns index 0, which is `KINDS[0]` = `ToxicRain` — a kind that is currently **switched
off**. So the real failure mode is not a crash but a **silently wrong hazard**, and it is
unguarded. Reading the comment retires a live bug, which is exactly the trap `CLAUDE.md`
records: *confirm a comment's invariant at the code that maintains it.*

## 3. `two_live_kinds_alternate` stops asserting when a third kind is enabled

```rust
if live.len() != 2 { return; }
```

Silently green, no signal. It is doing its job today (two live kinds) and will quietly stop the
moment anyone enables a third — which is what M22 does.

## 4. `ordnance-state.ts::LOOK.flame`'s comment inverts its own measurement

It says *"`fire-shader` measured 85–108 of 192 burn-circle points **unpainted**"*. The check
that produced the number prints *"damage-circle points **painted**"*. One of the two is
backwards, and it is the comment. (The same number is also quoted as a bare `108` in three
places, where the measured value is a range.)

## 5. `deathOverlay-math.ts::weatherName` has four arms the server cannot reach

Arms for `'toxicrain'`, `'meteorshower'`, `'lavaburst'` and `'selfinflicted'`, while
`events.rs::cause_name` emits only `"player" | "self" | "weather" | "void"` and **there is no
`by` field on the wire at all** — `grep -rn '"by"' --include=*.rs crates/` returns nothing,
while `GameScene.ts` reads `p['by'] ?? cause`. So a weather death reads *"Killed by weather"*
and four branches are dead. There is also **no `'heavyfog'` arm**, for a hazard that ships.

This is the count-the-thing-at-both-ends failure already in the tree, at the exact end
`T22.12` is about to extend — which is why `R20` exists.

## 6. `ordnanceFx-math.ts::hazardKind` falls through to `'other'` silently

A hazard kind the client does not know becomes a neutral disc with no warning. Its doc comment
says the fallthrough is deliberate *so that an unexpected kind is a bug rather than a
renderer* — but nothing reports it, so it is a renderer.

## 7. `carve_circle`'s doc sentence is half-stale

*"Bedrock and the side walls are never touched."* **`BEDROCK_H` is `0`** (§C15 removed it), so
`Map::circle`'s `carveable_bottom = h - BEDROCK_H` is inert and only the `WALL_W` half of that
sentence is true.

## 8. `game-wasm/src/lib.rs::shield_active` passes a hardcoded `now`

`p.stats.shield_active(0.0)`. Inert today because `shield_active` does `let _ = now;` — a
landmine the moment the predicate wants a clock, which `tick_stats`' own comment says the next
status effect will.

## 9. `GravityMode::ALL`'s doc claims a link to a list it is not pinned to

*"the list the lobby's stepper walks"* — the stepper is `GRAVITIES` in
`client/src/net/lobby.ts`, and nothing in Rust walks `ALL` in production. The TypeScript side
is honest about it (*"pinned to each other by nothing but this comment"*); the Rust side is
not. Landed in `af76376`; being reworded in its follow-up.

## 10. `title` asserted a control deleted five days earlier

Has its own task, **`T22.00`**, because unlike everything above it **fails the gate**.

---

## The shape they share

Nine of these ten are a **comment or a name that asserts something the code beside it does not
do** — a panic that cannot happen, a measurement quoted inverted, a list that is not pinned,
a scale that changed underneath a tuning note, a fallthrough documented as a tripwire that
trips nothing. None would be caught by any test, because each is a claim *about* the code
rather than a behaviour *of* it.

`CLAUDE.md` already carries the rule — *a comment claiming an invariant is an intention too* —
and these are ten measured instances of it in one reading of the tree.
