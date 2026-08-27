# Vendored assets

Fetched by `scripts/fetch-assets.sh`. **Every pack here is CC0**
(Creative Commons Zero) by [Kenney](https://kenney.nl) — no attribution
is required. We keep each pack's LICENSE.txt and credit Kenney anyway,
because it is the decent thing to do.

This directory is **gitignored** (`docs/70-amendments-v2.md` §A29):
particle-pack alone is 15 MB against `docs/51` §7's 12 MB committed
budget. The built atlases under `assets/atlas/` are what ship. Re-run
the script to restore the raw art.

| pack | source | licence | fetched | size |
|---|---|---|---|---|
| `platformer-characters` | https://kenney.nl/assets/platformer-characters | CC0 | 2026-08-20 | 2.3M |
| `particle-pack` | https://kenney.nl/assets/particle-pack | CC0 | 2026-08-20 | 15M |
| `pixel-platformer` | https://kenney.nl/assets/pixel-platformer | CC0 | 2026-08-20 | 1.2M |
| `ui-pack` | https://kenney.nl/assets/ui-pack | CC0 | 2026-08-20 | 5.5M |
| `impact-sounds` | https://kenney.nl/assets/impact-sounds | CC0 | 2026-08-20 | 1.3M |
| `interface-sounds` | https://kenney.nl/assets/interface-sounds | CC0 | 2026-08-20 | 1.2M |
| `sci-fi-sounds` | https://kenney.nl/assets/sci-fi-sounds | CC0 | 2026-08-20 | 6.0M |
| `digital-audio` | https://kenney.nl/assets/digital-audio | CC0 | 2026-08-20 | 1.2M |

## Sprite packs (`../sprite_packs`, v5 objects)

These are **not** Kenney packs and they are not fetched by
`scripts/fetch-assets.sh`. They were supplied by the repository owner and live
in `../sprite_packs`, a sibling directory that `CLAUDE.md` names as a
coordinator-approved input. `scripts/build-object-masks.mjs` reads them and
emits `assets/objects/masks.bin`, `assets/objects/manifest.json` and
`assets/atlas/objects.png` — those four files are what ship. `clouds` is
listed here because it is part of the same delivery, but it goes to the sky
layer, not to the terrain (`docs/73` §D0).

| pack | source | licence | fetched | size |
|---|---|---|---|---|
| `rocks` | not recorded — supplied by the repository owner | royalty-free, unlimited use | 2026-08-23 | 2.6M |
| `crystals` | not recorded — supplied by the repository owner | royalty-free, unlimited use | 2026-08-21 | 2.0M |
| `bushes` | not recorded — supplied by the repository owner | royalty-free, unlimited use | 2026-08-21 | 17M |
| `ruins` | not recorded — supplied by the repository owner | royalty-free, unlimited use | 2026-08-21 | 22M |
| `clouds` | not recorded — supplied by the repository owner | royalty-free, unlimited use | 2026-08-21 | 2.7M |

**Licence, verbatim from the owner (2026-08-27):** *"all the sprite packs I've
added were royalty free and unlimited use."* Unlimited use covers the
redistribution `docs/51` §8 is concerned with, and `docs/73` §D7 required this
record before any of the art was committed.

**This licence class is not what `docs/51` §8 asks for.** §8's first line is
*"Only CC0 or explicitly-public-domain art enters this repo"*, and
royalty-free/unlimited-use is neither. It is the owner of the packs stating the
terms he acquired them under, for art he supplied himself, and unlimited use
covers the redistribution §8 exists to protect against — but the sentence and
the table disagree and an amendment is owed. Recorded here as well as in
`tasks/DECISIONS.md` so an auditor reading §8 against this table finds the
conflict already named rather than discovering it.

**Two gaps, recorded rather than papered over.** `docs/73` §D7 says it plainly:
*"`sprite_packs/` contains no licence, readme, or credit file of any kind — I
looked."* So:

- **The source URL is unknown.** It is written as unknown above rather than
  guessed at. §D7 asks for it and this record is short by it.
- **No pack carries a `LICENSE.txt`.** §8 asks for the file alongside the
  files, not only the claim. The owner's statement is what stands in for it.
  `scripts/verify-assets.mjs` deliberately does **not** fail on this, for two
  reasons. There is no file to place — the packs shipped without one, so the
  gate could never go green and would be bypassed by the next person. And
  `assets/vendor/` is gitignored (§A29), so a licence file "alongside its
  files" would live in a directory that does not exist on a clone: the check
  would pass here and fail, or vacuously pass, everywhere else.

**Fetch dates** are when each pack landed on this machine, not when it was
published. The packs' own files date from 2022–2023.

Neither gap is something a builder can close: only the owner knows where these
came from. Recorded here so the next person reads a known gap instead of
assuming the paperwork was done.
