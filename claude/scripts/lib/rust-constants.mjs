/**
 * Read `crates/game-core/src/constants.rs` from Node.
 *
 * `CLAUDE.md`: *"Every numeric tunable lives in `constants.rs` ... never hardcode
 * one in a test"*. The browser checks satisfy that by reading
 * `window.__game.constants()` out of WASM, but a build script has no browser and
 * no WASM, and copying `128` into `build-object-masks.mjs` would leave two
 * sources of truth that drift silently.
 *
 * So: parse the Rust. `pub const NAME: TY = EXPR;` where `EXPR` is arithmetic over
 * numbers and other constants — which covers every tunable in the file that a
 * build step or a test has reason to ask for.
 *
 * `get` **throws** on a name that is not there. A reader that returned
 * `undefined` would turn every assertion pinned to it into `undefined <=
 * undefined` — false forever, and green forever.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export const CONSTANTS_RS = join(root, 'crates/game-core/src/constants.rs')

const DECL = /^pub const ([A-Z][A-Z0-9_]*)\s*:\s*[A-Za-z0-9_]+\s*=\s*([^;]+);/gm

/** Strip the parts of a Rust literal that are not arithmetic. */
function normalise(expr) {
  return expr
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\bas\s+[iuf](?:8|16|32|64|size)\b/g, '')
    .replace(/([0-9])_([0-9])/g, '$1$2')
    .replace(/([0-9.])(?:[iuf](?:8|16|32|64|size))\b/g, '$1')
    .trim()
}

export function parseConstants(source) {
  const exprs = new Map()
  for (const m of source.matchAll(DECL)) exprs.set(m[1], normalise(m[2]))

  const values = new Map()
  const inFlight = new Set()

  const evaluate = (name) => {
    if (values.has(name)) return values.get(name)
    if (!exprs.has(name)) throw new Error(`constants.rs has no \`pub const ${name}\``)
    if (inFlight.has(name)) throw new Error(`constants.rs: ${name} is defined in terms of itself`)
    inFlight.add(name)
    const substituted = exprs
      .get(name)
      .replace(/[A-Z][A-Z0-9_]*/g, (id) => `(${evaluate(id)})`)
    inFlight.delete(name)
    if (!/^[-+*/().\s0-9e]+$/i.test(substituted)) {
      throw new Error(`constants.rs: ${name} = \`${exprs.get(name)}\` is not plain arithmetic`)
    }
    // eslint-disable-next-line no-new-func
    const value = Function(`"use strict";return (${substituted})`)()
    if (!Number.isFinite(value)) throw new Error(`constants.rs: ${name} evaluated to ${value}`)
    values.set(name, value)
    return value
  }

  return {
    names: () => [...exprs.keys()],
    has: (name) => exprs.has(name),
    get: evaluate,
  }
}

let cached = null

/** The workspace's own `constants.rs`, parsed once per process. */
export function constants() {
  if (!cached) cached = parseConstants(readFileSync(CONSTANTS_RS, 'utf8'))
  return cached
}
