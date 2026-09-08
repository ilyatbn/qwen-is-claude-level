/**
 * Two claims nothing re-validated, asserted.  T20.17
 *
 * Both are the construct this repository already has six of — walk a source of
 * truth and assert a correspondence — applied to the two artifacts that had
 * none: the task tracker's links, and the set of tests the gate never runs.
 *
 * This runs in the **always-on** half of `scripts/check.sh`, before the browser
 * block, because it costs milliseconds and `--fast` must not skip it.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const notes = []

/**
 * Every `M<n>/T<n.nn>-....md` link in `TASKS.md` resolves.
 *
 * A commit once added a `TASKS.md` line linking `M20/T20.16-...md` and did not
 * create the file, and its message asserted it had. The tracker pointed at a
 * 404 for two commits, which is worse than the absence it replaced: a builder
 * scanning the list follows the link and gets nothing, having been told by the
 * pointer's existence that the work is specified.
 */
function taskLinksResolve() {
  const tasks = join(root, 'tasks/TASKS.md')
  const body = readFileSync(tasks, 'utf8')
  const links = [...body.matchAll(/\]\((M\d+\/T[\d.]+[^)]*\.md)\)/g)].map((m) => m[1])

  // The vacuity control. A regex that stopped matching would report "every link
  // resolves" about an empty set, which is the shape this whole check exists to
  // catch. 235 links today; the floor is deliberately far below that and still
  // far above anything a broken pattern would return.
  const FLOOR = 50
  if (links.length < FLOOR) {
    problems.push(
      `TASKS.md: only ${links.length} task links matched, under the floor of ${FLOOR} — ` +
        'the pattern is broken, so "they all resolve" is a claim about nothing',
    )
    return
  }

  const broken = links.filter((rel) => !existsSync(join(root, 'tasks', rel)))
  for (const rel of broken) {
    problems.push(`TASKS.md links tasks/${rel}, which does not exist`)
  }
  notes.push(`tasks: ${links.length} task links, ${links.length - broken.length} resolve`)
}

/**
 * Every `#[ignore]`d test is named in `scripts/ignored.sh`'s manifest, and the
 * manifest names nothing that is not ignored.
 *
 * The runner is the only thing that runs these, and a runner whose coverage
 * nobody checks is the same silence one layer up: a new `#[ignore]` added next
 * milestone would simply never be in it.
 *
 * **Anchored on the attribute's own syntax.** The unanchored pattern returns 14
 * here, and the fourteenth is a module doc comment containing the literal
 * `` `#[ignore]`d `` as prose about a test already counted at its attribute —
 * lines containing a string are not the things the string names.
 */
function everyIgnoredTestIsInTheRunner() {
  const found = new Map() // test name -> file
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) {
        if (entry !== 'target') walk(p)
      } else if (entry.endsWith('.rs')) {
        const lines = readFileSync(p, 'utf8').split('\n')
        lines.forEach((line, i) => {
          if (!/^\s*#\[ignore\b/.test(line)) return
          // The name is the `fn` this attribute is attached to, not the line
          // number: a line number is a claim with nothing re-validating it, and
          // this file is about exactly that.
          const rest = lines.slice(i + 1, i + 6).join('\n')
          const m = rest.match(/fn\s+(\w+)/)
          if (m) found.set(m[1], p.slice(root.length + 1))
          else problems.push(`${p.slice(root.length + 1)}:${i + 1}: #[ignore] with no fn under it`)
        })
      }
    }
  }
  walk(join(root, 'crates'))

  const runner = readFileSync(join(root, 'scripts/ignored.sh'), 'utf8')
  const manifest = [...runner.matchAll(/^ {2}"([a-z0-9_]+)\|/gm)].map((m) => m[1])

  if (found.size === 0 || manifest.length === 0) {
    problems.push(
      `ignored tests: found ${found.size} in crates/ and ${manifest.length} in the manifest — ` +
        'one of the two patterns stopped matching, so an equality between them proves nothing',
    )
    return
  }
  for (const [name, file] of found) {
    if (!manifest.includes(name)) {
      problems.push(`${file}: ${name} is #[ignore]d and not in scripts/ignored.sh's manifest`)
    }
  }
  for (const name of manifest) {
    if (!found.has(name)) {
      problems.push(`scripts/ignored.sh names ${name}, which is not #[ignore]d anywhere`)
    }
  }
  // Count at both ends, and assert the two numbers against each other.
  if (found.size !== manifest.length) {
    problems.push(`ignored tests: ${found.size} in crates/, ${manifest.length} in the manifest`)
  }
  notes.push(`ignored: ${found.size} tests in crates/, ${manifest.length} in the manifest`)
}

taskLinksResolve()
everyIgnoredTestIsInTheRunner()

for (const n of notes) console.log(`  ${n}`)
if (problems.length) {
  console.error('')
  for (const p of problems) console.error(`  ${p}`)
  console.error(`\nrepo guards: ${problems.length} problem(s)`)
  process.exit(1)
}
console.log('  repo guards: ok')
