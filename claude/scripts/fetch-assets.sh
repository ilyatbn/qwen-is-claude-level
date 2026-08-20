#!/usr/bin/env bash
#
# Fetch the four Kenney CC0 packs into assets/vendor/kenney/<slug>/.
#
# `docs/51-assets.md` §3 describes this script; `docs/70-amendments-v2.md` §A29
# corrects where the download URL actually lives, which is the part that costs an
# afternoon if you rediscover it.
#
# Run once. `assets/vendor/` is gitignored (§A29) because particle-pack alone is
# 15 MB against §7's 12 MB committed budget — the built atlases under
# assets/atlas/ are what ship. This script is the reproducible path back to the
# raw art.
#
# The game runs with none of this. Every missing asset falls back to a
# procedurally generated one (`docs/51` §5), which is what has carried the
# project since M3 — so a failure here is an inconvenience, never a blocker.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
vendor="$root/assets/vendor/kenney"
force=0
[ "${1:-}" = "--force" ] && force=1

slugs=(platformer-characters particle-pack pixel-platformer ui-pack)

# ---------------------------------------------------------------------------

# Extract a pack's zip URL from its page.
#
# `docs/51` §3 says "the first .zip href". There is no .zip href in the page
# body: the visible Download button is `<a href='#inline-download' data-lity>`,
# which opens a donation modal, and the real URL is on the "Continue without
# donating" anchor inside it (§A29).
#
# The page uses SINGLE-QUOTED attributes. A pattern written for href="..."
# matches nothing and looks exactly like the site having restructured, which is
# the failure this comment exists to prevent someone re-deriving.
#
# The path carries a content hash and timestamp, so it must be scraped rather
# than constructed — every guessable pattern 404s.
# NOTE: no `head -1` in the pipeline. `head` closes the pipe as soon as it has
# its line, grep dies with SIGPIPE, and `set -o pipefail` then reports the whole
# extraction as failed even though it succeeded — which is exactly the "no .zip
# link found" false negative this script printed on its first run.
zip_url_for() {
  local slug="$1" html matches
  html="$(curl -fsSL --max-time 60 "https://kenney.nl/assets/$slug")" || return 1
  matches="$(printf '%s' "$html" \
    | grep -oE "id='donate-text'[^>]*href='[^']+\.zip'" \
    | grep -oE "https://[^']+\.zip")" || return 1
  printf '%s' "${matches%%$'\n'*}"
}

# `unzip` is not installed everywhere — it is absent on this box — and a missing
# tool reported as "the archive did not unzip (truncated?)" sends the reader
# looking at the network instead of at their PATH. Prefer unzip, fall back to
# python's zipfile, and say plainly when neither exists.
extract_zip() {
  local zip="$1" dest="$2"
  mkdir -p "$dest"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$zip" -d "$dest"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' \
      "$zip" "$dest"
  else
    echo "  neither 'unzip' nor 'python3' is available to extract the archive" >&2
    return 1
  fi
}

fail_with_manual_instructions() {
  local slug="$1" why="$2"
  cat >&2 <<MSG

  ---------------------------------------------------------------------------
  Could not fetch '$slug': $why

  Download it by hand from
      https://kenney.nl/assets/$slug
  and unzip it so that this path exists:
      $vendor/$slug/LICENSE.txt

  THE GAME STILL RUNS WITHOUT IT. Every missing sprite, texture and particle
  falls back to a procedurally generated placeholder (docs/51 §5). Art makes it
  look finished; it is not load-bearing.
  ---------------------------------------------------------------------------

MSG
  return 1
}

fetch_one() {
  local slug="$1" dest="$vendor/$slug"

  if [ -d "$dest" ] && [ "$force" -eq 0 ]; then
    echo "  $slug: already present, skipping (--force to re-download)"
    return 0
  fi

  local url
  if ! url="$(zip_url_for "$slug")" || [ -z "$url" ]; then
    fail_with_manual_instructions "$slug" "no .zip link found on the pack page"
    return 1
  fi

  # Stage in a temp dir so a truncated download or a bad unzip never leaves a
  # half-populated pack directory that the idempotence check would then skip.
  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN

  echo "  $slug: downloading"
  if ! curl -fsSL --max-time 600 -o "$tmp/pack.zip" "$url"; then
    fail_with_manual_instructions "$slug" "download failed"
    return 1
  fi
  if ! extract_zip "$tmp/pack.zip" "$tmp/x"; then
    fail_with_manual_instructions "$slug" "the archive could not be extracted"
    return 1
  fi

  # Some packs unzip into a single top-level directory, some straight into the
  # root. Normalise so `<slug>/LICENSE.txt` is always the path.
  local src="$tmp/x"
  if [ "$(find "$tmp/x" -maxdepth 1 -mindepth 1 | wc -l)" -eq 1 ] \
     && [ -d "$(find "$tmp/x" -maxdepth 1 -mindepth 1)" ]; then
    src="$(find "$tmp/x" -maxdepth 1 -mindepth 1)"
  fi

  # §8: every vendored pack keeps its licence. A pack whose structure changed
  # enough to move LICENSE.txt is exactly when you want to be told.
  if [ ! -f "$src/LICENSE.txt" ] && [ ! -f "$src/License.txt" ] \
     && [ ! -f "$src/license.txt" ]; then
    fail_with_manual_instructions "$slug" "no LICENSE.txt in the archive"
    return 1
  fi

  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  mv "$src" "$dest"
  # Normalise the licence filename so the verification below is one check.
  if [ -f "$dest/License.txt" ]; then mv "$dest/License.txt" "$dest/LICENSE.txt"; fi
  if [ -f "$dest/license.txt" ]; then mv "$dest/license.txt" "$dest/LICENSE.txt"; fi
  echo "  $slug: ok ($(du -sh "$dest" | cut -f1))"
}

# ---------------------------------------------------------------------------

echo "Fetching Kenney CC0 packs into $vendor"
mkdir -p "$vendor"

failed=()
for slug in "${slugs[@]}"; do
  fetch_one "$slug" || failed+=("$slug")
done

# The README is regenerated from what is actually on disk, so it cannot claim a
# pack that is not there (`docs/51` §8).
{
  echo "# Vendored assets"
  echo
  echo "Fetched by \`scripts/fetch-assets.sh\`. **Every pack here is CC0**"
  echo "(Creative Commons Zero) by [Kenney](https://kenney.nl) — no attribution"
  echo "is required. We keep each pack's LICENSE.txt and credit Kenney anyway,"
  echo "because it is the decent thing to do."
  echo
  echo "This directory is **gitignored** (\`docs/70-amendments-v2.md\` §A29):"
  echo "particle-pack alone is 15 MB against \`docs/51\` §7's 12 MB committed"
  echo "budget. The built atlases under \`assets/atlas/\` are what ship. Re-run"
  echo "the script to restore the raw art."
  echo
  echo "| pack | source | licence | fetched | size |"
  echo "|---|---|---|---|---|"
  for slug in "${slugs[@]}"; do
    if [ -d "$vendor/$slug" ]; then
      size="$(du -sh "$vendor/$slug" | cut -f1)"
      lic="CC0"
      [ -f "$vendor/$slug/LICENSE.txt" ] || lic="**MISSING**"
      echo "| \`$slug\` | https://kenney.nl/assets/$slug | $lic | $(date +%Y-%m-%d) | $size |"
    else
      echo "| \`$slug\` | https://kenney.nl/assets/$slug | — | not fetched | — |"
    fi
  done
} > "$root/assets/vendor/README.md"

if [ ${#failed[@]} -gt 0 ]; then
  echo
  echo "Failed: ${failed[*]}" >&2
  echo "The game still runs — see the message above for each." >&2
  exit 1
fi

echo
echo "Total: $(du -sh "$root/assets/vendor" | cut -f1)"
echo "Licences: $(find "$vendor" -maxdepth 2 -name 'LICENSE.txt' | wc -l)/4"
