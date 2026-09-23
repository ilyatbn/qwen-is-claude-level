# M23 reference pictures — the goal, and the thing every M23 check compares against

Owner, 2026-09-23: *"make the 4 pictures your goal. it should look exactly the same."* and *"keep the photos as
assets in the m23 folder as reference to always be used and compared to."*

- `F1-night-combat.png` — standard map, night. **Primary target.**
- `F2-volcanic-night.png` — same scene, volcanic palette (themes are out for now — `M23-art.md` R5).
- `F3-space.png` — space mode.
- `F4-cast-sheet.png` — the cast at 3×.
- `F5-moonlit-day.png`, `F6-weapon-sheet.png`, `F7-pose-sheet.png` — the moonlit day, the remodelled arsenal and the
  figure's poses, made by the coordinator from the owner's words; owner to confirm.
- `F0-today-same-scene.png` — today's look, same composition: the must-fail control.
- All seven were re-rendered together on 2026-09-23 from the `mockup-src/` in this folder, so the code reproduces
  every picture exactly (F1/F3 lost a faint stray god-ray line the owner-approved render had; nothing else moved).
- `controls/` — single-knob variants made by T23.02 (exposure ±10 %, bloom off, rim off, fog off, F2 palette).
- `mockup-src/` — **the reference implementation** that rendered every picture here (three.js 0.170, headless
  Chromium + swiftshader). Numbers in these files are the spec. Do not edit them to make a check pass; if the game
  should differ from a picture, change the picture here first, in its own commit, and say why.

Re-render: copy `mockup-src/` to a scratch dir, `npm i`, then
`LD_LIBRARY_PATH=$HOME/.cache/pwlibs/root/usr/lib/x86_64-linux-gnu nice -n 19 node render.mjs F1`.
