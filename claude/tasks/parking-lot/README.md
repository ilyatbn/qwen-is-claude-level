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
| `T21.18` the shader effect queue | parked by the owner 2026-09-14 with 2/5 landed — clouds (`66f3514`) and laser beams (`5471424`); smoke, fire and explosions not started. The laser commit's gate was 56/58 (`terrain-render`, `boots-visible`) and has no journal entry |

**These are not listed in `tasks/TASKS.md`'s build order.** The tracker's link
guard only walks `M<n>/T…` paths, so nothing here is checked by it; that is the
cost of parking and the reason this README lists them by hand.

To un-park: move the file back into `tasks/M21/` and add its line to `TASKS.md`.
