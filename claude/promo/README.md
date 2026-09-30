# SHRED — trailer toolkit (M99)

Everything that makes `build/SHRED-trailer.mp4`. `build/` and `node_modules/` are not committed.
Task files: `tasks/M99/`.

```sh
npm --prefix promo install                       # ffmpeg-static
cargo build -p game-server --release
DEV_BOT_FRENZY=1 DEV_LOADOUT=1 BOT_COUNT=5 BOT_SKILL=1 ./target/release/game-server &   # setsid it; kill the group after
npm --prefix client run dev &                    # :5173 assumed by capture-match.mjs (pass a URL otherwise)

node promo/capture-match.mjs take1 150 1.8       # footage (opens a Chrome window: the GPU needs a headed browser on WSLg)
node promo/capture-match.mjs take2 230 2.3
node promo/capture-match.mjs take3 240 1.5
node promo/render-page.mjs intro/index.html intro 14.4   # the 3D prequel, frame by frame
node promo/music.mjs                             # the score
node promo/edit.mjs                              # print the cut
node promo/assemble.mjs                          # composite + encode -> build/SHRED-trailer.mp4
node promo/assemble.mjs 20,43.3,55               # or just stills, to check
```

`timeline.mjs` is the one clock: change a section there and the music, the cut and the titles all move with it.
The score is synthesised (no samples, nothing licensed). The prequel and the compositor are pure functions of `t`,
so a re-render is the same film.
