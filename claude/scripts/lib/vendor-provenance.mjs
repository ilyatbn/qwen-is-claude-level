/**
 * The provenance check behind `docs/51` §8 and `docs/73` §D7, as pure functions
 * so the falsification can run in vitest rather than by hand-editing a README.
 *
 * §8 is unambiguous: every vendored pack is listed in `assets/vendor/README.md`
 * with its source, licence and fetch date. `assets/objects/manifest.json` is the
 * list of packs the shipped art actually derives from, so it is the side that
 * decides what must be recorded — a hardcoded pack list would go stale the first
 * time someone adds a pack and would never name what it missed.
 */

/**
 * The heading a `sprite_packs` row must sit under.
 *
 * The README holds two provenance domains in one namespace: the Kenney packs,
 * CC0 and fetched by script, and the owner-supplied `sprite_packs`. Scanning
 * every table in the file would let a Kenney row vouch for a same-named sprite
 * pack — Kenney ships rock packs — recording "CC0 by Kenney" as the licence for
 * art that is neither. Nothing collides today; the scoping is what stops it
 * from mattering when something does.
 */
export const SPRITE_PACK_SECTION = 'Sprite packs'

/**
 * The headings a provenance row may live under.
 *
 * Scoping exists to stop a Kenney row vouching for a same-named sprite pack —
 * two provenance domains in one namespace. It was never meant to say "sprite
 * packs are the only vendored art": a **font** is an asset and `docs/51` §8
 * applies to it identically, so `## Fonts` is a second place a row may sit.
 *
 * Adding a heading here is how a new class of vendored asset gets covered.
 */
export const PROVENANCE_SECTIONS = [SPRITE_PACK_SECTION, 'Fonts']

/**
 * Every pack the shipped object art derives from, sorted, de-duplicated.
 *
 * Reads the manifest rather than the vendor directory: `assets/vendor/` is
 * gitignored (§A29), so on a clone the directory is empty while the manifest and
 * the built atlas are still there. The manifest is what ships, so the manifest is
 * what has to be accounted for.
 */
export function packsInManifest(manifest, shippingManifest = null) {
  return [...packSources(manifest, shippingManifest).keys()].sort()
}

/**
 * `pack -> the file that says the shipped art uses it`.
 *
 * The file matters in the failure message: told only that `clouds` is
 * unrecorded, the next person opens `assets/objects/manifest.json` and does not
 * find it there, because clouds route to the sky and that manifest excludes
 * them by design. Naming the wrong file is worse than naming none.
 */
export function packSources(manifest, shippingManifest = null) {
  const sources = new Map()
  const objects = manifest?.objects ?? []
  const packs = objects.map((o) => o.pack).filter(Boolean)
  // Objects are not the only pipeline that eats a sprite pack: the cloud atlas
  // is built from `../sprite_packs/clouds` and lands in `assets/atlas/` with no
  // object manifest behind it. A build script that consumes a pack declares it
  // in `assets/manifest.json` under `vendorPacks`, so this check covers the art
  // that ships rather than only the art the check was first written for.
  // Both, when both — first-writer-wins would be *true* and still send someone
  // who deletes the pack from one file straight back here pointing at the other.
  const add = (pack, where) => sources.set(pack, [...(sources.get(pack) ?? []), where])
  for (const p of packs) if (!sources.has(p)) add(p, 'assets/objects/manifest.json')
  for (const p of shippingManifest?.vendorPacks ?? []) {
    if (p) add(p, "assets/manifest.json's vendorPacks")
  }
  return new Map([...sources].map(([p, where]) => [p, where.join(' and ')]))
}

/**
 * Every pack named in a leading `` `backtick` `` cell of a table row.
 *
 * Anchored to the first cell so that prose mentioning a pack by name cannot
 * satisfy the check — a sentence saying "the rocks pack is CC0" is not a
 * provenance entry, and a check that accepted one would pass on a README that
 * records nothing.
 */
export function packsInReadme(text) {
  const found = new Set()
  for (const [pack] of readmeRows(text)) found.add(pack)
  return found
}

/**
 * `[pack, [source, licence, fetched, …]]` for every table row naming a pack.
 *
 * Split out because a row is not a record. `| \`rocks\` | | | |` names the pack
 * and says nothing about it, and a check that stopped at the name would pass it
 * while printing "record its source, licence and fetch date" — testing the
 * intention and not the effect, which is the rule this project pays for most
 * often.
 */
export function readmeRows(text, sections = PROVENANCE_SECTIONS) {
  const rows = []
  const want = sections === null ? null : [].concat(sections)
  let inSection = want === null
  for (const line of String(text).split('\n')) {
    if (/^#{1,6}\s/.test(line)) {
      inSection = want === null || want.some((h) => line.includes(h))
      continue
    }
    if (!inSection) continue
    const m = /^\s*\|\s*`([^`]+)`\s*\|(.*)$/.exec(line)
    if (!m) continue
    const rest = m[2].replace(/\|\s*$/, '')
    rows.push([m[1], rest.split('|').map((c) => c.trim())])
  }
  return rows
}

/**
 * Packs whose row exists but leaves source, licence or fetch date blank.
 *
 * "Not recorded" is a legitimate value for the source of the sprite packs — the
 * owner supplied them and no URL is known (`docs/73` §D7). An *empty* cell is
 * not: it is indistinguishable from nobody having looked.
 */
export function incompleteProvenance(manifest, readmeText, shippingManifest = null) {
  const wanted = new Set(packsInManifest(manifest, shippingManifest))
  const bad = []
  for (const [pack, cells] of readmeRows(readmeText)) {
    if (!wanted.has(pack)) continue
    const [source, licence, fetched] = cells
    if (!source || !licence || !fetched) bad.push(pack)
  }
  return bad
}

/** Packs the shipped art uses that no README row accounts for, named. */
export function missingProvenance(manifest, readmeText, shippingManifest = null) {
  const recorded = packsInReadme(readmeText)
  return packsInManifest(manifest, shippingManifest).filter((p) => !recorded.has(p))
}
