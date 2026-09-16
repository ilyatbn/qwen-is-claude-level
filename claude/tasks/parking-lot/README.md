# Parking lot

Features that are **specified but not being built**. Parked by the coordinator,
not abandoned: each file is intact, so picking one up later costs nothing.

| parked | why |
|---|---|
| `T21.04` day/night setting | revisit with the UI redesign — half of it is client-side and the redesign will move that half anyway |
| `T21.05` low gravity | start of the gravity chain |
| `T21.06` zero-g movement | needs T21.05 |
| `T21.07` zero-g map | needs T21.05 |
| `T21.08` spacesuits | needs T21.07, so it is dead while the chain is parked — parked with it rather than left looking startable |
| `T21.10` match recording and a viewer | large, and its own file says split it into three before starting |
| `T21.41` rewrite toxic rain | switched off by the owner 2026-09-15 ("not working properly"), T21.39; the rewrite waits for his description of what it should be |
| `T21.42` the two lobby socket tests | disabled by the owner 2026-09-15 ("ignore these two tests for now"); each failed once under load at the test client's first emit, 5/5 alone — find the cause before re-enabling |
| `M22` alien invasion — the first team match | asked for 2026-09-15 and parked on arrival: a whole milestone (teams, a match mode, the heart, aliens, balance), split into nine tasks in its one file; four questions for the owner before it starts |

**These are not listed in `tasks/TASKS.md`'s build order.** The tracker's link
guard only walks `M<n>/T…` paths, so nothing here is checked by it; that is the
cost of parking and the reason this README lists them by hand.

To un-park: move the file back into `tasks/M21/` and add its line to `TASKS.md`.
