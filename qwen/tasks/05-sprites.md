# Phase 5 — Assets, skins, ops

State after this phase: real Kenney sprites replace placeholders via the
manifest, skin selection works, HUD/kill feed polished, server runs in
Docker with the debug log toggle.

Read `docs/07-sprites.md` in full before starting this file.

---

## T5.1 — Fetch Kenney packs + manifest loader [ ]

**Goal**: assets downloaded, processed, manifest.json live, BootScene
loads real textures (with placeholder fallback).
**Read**: `docs/07-sprites.md` §1, §2, §3.
**Files**: `assets/**` (new), `client/src/scenes/BootScene.ts`,
  `client/src/assets/manifest.json`, `client/src/entities/Terrain.ts`
  (texture keys unchanged — only the texture sources change)
**Steps**:
1. `mkdir -p assets/kenney assets/processed/{tiles,players,weapons,items,decor,ui}`.
2. Download the 3 packs from docs/07 §3 URLs with curl -L; unzip into
   `assets/kenney/<name>/`; copy each pack's LICENSE.txt.
3. Copy/trim needed sprites into `assets/processed/` (tile variants ×3 per
   kind, 6 player skins, 4 weapon icons, 4 item icons, 3 decor, 2 UI).
   If trimming tools are unavailable, use whole sheets + frame rects in
   the manifest (loader supports `{ file, frame: [x,y,w,h] }`).
4. Write `manifest.json` per docs/07 §2 (version 1, all sections).
5. BootScene: fetch manifest, load every entry, register under the SAME
   texture keys placeholders used (GRASS/DIRT/STONE/ROCK/player_0..5/...).
   Missing file → warn + keep placeholder texture for that key.
6. Terrain + PlayerSprite automatically pick up real textures (no logic
   change).
**Acceptance**: game boots with real Kenney tiles; delete one file from
  processed/ → game still boots (placeholder fallback for that key).
**Test**: `cd client && npm test && npm run build` (manual boot check in
  Acceptance)

---

## T5.2 — Map texture variants by seed [ ]

**Goal**: each round looks different via (seed+x+y) % 3 variant picking.
**Read**: `docs/07-sprites.md` §2, `docs/01-map.md` §7.
**Files**: `client/src/entities/Terrain.ts`
**Steps**:
1. Tile sprite texture = `TILES[kind][(seed + x + y) % 3]` (keys from
   manifest arrays).
2. `tile_destroyed` redraws use the same formula (consistent look).
3. Dev check: `?seed=1` vs `?seed=2` show visibly different tile patterns.
**Acceptance**: same seed → identical texture layout across two page
  loads (deterministic).
**Test**: `cd client && npm run build` (manual check in Acceptance)

---

## T5.3 — Skin system [ ]

**Goal**: player picks 1 of 6 skins in lobby; persisted; server stores.
**Read**: `docs/07-sprites.md` §4, `docs/06-protocol.md` §1 (select_skin),
  §2 (joined/lobby_state).
**Files**: `client/src/scenes/LobbyScene.ts` (skin picker UI),
  `server/server/src/rooms.rs` (store skin per player id, include in
  lobby_state + snapshot name/skin already present),
  `client/src/entities/PlayerSprite.ts` (texture by skin id)
**Steps**:
1. Lobby: 6-skin grid; click → `select_skin { skin }` +
   `localStorage["skin"]`.
2. Server: skin per player id (default 0), sent in `joined`/
   `lobby_state`; weapon_skin u8 field added to lobby_state (v1: 0/1,
   cosmetic only, stored + broadcast).
3. PlayerSprite: texture `player_<skin>` (fallback to id color if missing).
**Acceptance**: refresh page → same skin restored from localStorage;
  other players see your skin in lobby list.
**Test**: `cd server && cargo test -p server && cd ../client && npm run build`

---

## T5.4 — HUD polish + kill feed [ ]

**Goal**: readable HUD, kill feed, round timer, day/night indicator.
**Read**: `docs/07-sprites.md` §5, `docs/06-protocol.md` §2 (kill,
  round_ended), §4 (snapshot fields).
**Files**: `client/src/hud/Hud.ts`, `client/src/scenes/GameScene.ts`
**Steps**:
1. Top-center: round timer (mm:ss, from round_time_s), day/night icon
   (sun/moon by day_phase).
2. Kill feed (top-right, last 5, fade after 4 s): "P1 ☠ P2 (rocket)",
   "P2 ☠ weather (lava)".
3. Health bar + shield + jetpack (T3.9) restyled with UI textures from
   manifest (fallback to rects).
4. Score popup on kill (+1 / −1 floating text).
**Acceptance**: all HUD elements visible and non-blocking (mouse aim works
  over HUD areas? HUD is pointer-events none except inventory panel).
**Test**: `cd client && npm run build` (manual check in Acceptance)

---

## T5.5 — Docker + debug log toggle [ ]

**Goal**: `docker compose up` runs the server; log level toggable at
runtime.
**Read**: `docs/05-server.md` §5, §6, §7.
**Files**: `Dockerfile`, `docker-compose.yml`, `server/server/src/main.rs`
  (env parsing if not done), `.dockerignore`
**Steps**:
1. Dockerfile: multi-stage per docs/05 §6 (rust:slim build →
   debian:bookworm-slim runtime, EXPOSE 3001, non-root user).
2. docker-compose.yml per docs/05 §6 (game service, port 3001,
   RUST_LOG=info, commented redis placeholder).
3. `.dockerignore`: target/, client/node_modules, assets/kenney (raw
   zips not needed in image — client is served by Vite in dev; for
   production the client is a static build, note it in README).
4. Verify runtime `set_log_level { level: "debug" }` changes output live
   (send via a quick socket client or the game).
5. Update README "How to run" with docker commands.
**Acceptance**: `docker compose up --build` → server on 3001, game
  playable from a browser (client via `npm run dev` pointed at
  localhost:3001); sending set_log_level flips log level without restart.
**Test**: `docker compose up --build -d && sleep 8 && curl -s
  http://localhost:3001/socket.io/?EIO=4&transport=polling | head -c 200`
  (expect socket.io handshake JSON)
