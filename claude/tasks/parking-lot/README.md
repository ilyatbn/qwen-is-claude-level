# Parking lot

Features that are **specified but not being built**. Parked by the coordinator,
not abandoned: each file is intact, so picking one up later costs nothing.

| parked | why |
|---|---|
| `T21.04` day/night setting | revisit with the UI redesign — half of it is client-side and the redesign will move that half anyway. **No longer blocks anything**: M22 was going to copy its settings pattern, and copies T20.07's directly instead |
| `T21.10` match recording and a viewer | large, and its own file says split it into three before starting |
| `T21.41` rewrite toxic rain | switched off by the owner 2026-09-15 ("not working properly"), T21.39; the rewrite waits for his description of what it should be |
| `T21.42` the two lobby socket tests | disabled by the owner 2026-09-15 ("ignore these two tests for now"); each failed once under load at the test client's first emit, 5/5 alone — find the cause before re-enabling |
| `M23` alien invasion — the first team match | asked for 2026-09-15 and parked on arrival: a whole milestone (teams, a match mode, the heart, aliens, balance), split into nine tasks in its one file; four questions for the owner before it starts |

**These are not listed in `tasks/TASKS.md`'s build order.** The tracker's link
guard only walks `M<n>/T…` paths, so nothing here is checked by it; that is the
cost of parking and the reason this README lists them by hand.

To un-park: move the file back into `tasks/M21/` and add its line to `TASKS.md`.

## Un-parked

- **`T21.05`–`T21.08` (the gravity chain and spacesuits) became M22 on 2026-09-18.** The owner
  asked for them as their own milestone and added a space brief on top — a backdrop, thrusters,
  solar flares and radiation. They are superseded rather than moved: `tasks/M22/` carries the
  re-checked versions, each naming the file it came from, and
  `git log --diff-filter=D -- tasks/parking-lot` finds the originals.
- **`M22` alien invasion was renumbered `M23`** in the same commit, because the owner asked for
  the space work to be M22 and this folder already held that number. Nothing depended on the old
  one — it was not in `TASKS.md` and no task cited it.

