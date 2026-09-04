import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { C, Core } from '../core'
import {
  CODE_ALPHABET,
  CODE_LEN,
  checkCode,
  codeError,
  createRoomPayload,
  identityPayload,
  joinErrorMessage,
  lobbyErrorMessage,
  rosterRows,
  lobbyStatus,
  ownsSettings,
  joinRoomPayload,
  lobbyReducer,
  parseLobbyState,
  quickMatchPayload,
  SCALES,
  settingsControls,
  START_KITS,
  stepSetting,
  minutesLabel,
  type Identity,
  type LobbyState,
  type LobbyStateMsg,
  type TimerBounds,
} from './lobby'

const me: Identity = { name: 'ana', skinId: 2, tombstoneSkinId: 7 }

describe('join codes', () => {
  it('accepts a well-formed code and upper-cases it', () => {
    expect(checkCode('abc23z')).toEqual({ ok: true, code: 'ABC23Z' })
    expect(checkCode('  ABC 23Z  ')).toEqual({ ok: true, code: 'ABC23Z' })
  })

  /**
   * The server's regression, mirrored: the alphabet contains `L`, so folding it
   * to `1` made about one code in six unreachable. A client that "helpfully"
   * folded would reintroduce it from the other side.
   */
  it('never substitutes characters, and L is a real code character', () => {
    expect(CODE_ALPHABET).toContain('L')
    expect(checkCode('abcdlz')).toEqual({ ok: true, code: 'ABCDLZ' })
  })

  it('rejects the characters the alphabet deliberately excludes', () => {
    for (const c of ['I', 'O', '0', '1']) {
      expect(CODE_ALPHABET).not.toContain(c)
      const r = checkCode(`ABCD${c}Z`)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.reason).toBe('characters')
        expect(r.bad).toBe(c)
        // The message must name the character, or the player cannot tell which
        // one to change.
        expect(codeError(r)).toContain(c)
      }
    }
  })

  it('distinguishes empty from wrong-length from bad characters', () => {
    const empty = checkCode('   ')
    const short = checkCode('ABC')
    const long = checkCode('ABCDEFG')
    expect(empty.ok).toBe(false)
    expect(short.ok).toBe(false)
    expect(long.ok).toBe(false)
    if (!empty.ok) expect(empty.reason).toBe('empty')
    if (!short.ok) expect(short.reason).toBe('length')
    if (!long.ok) expect(long.reason).toBe('length')
    // Three different reasons produce three different messages — the point of
    // having reasons at all.
    const msgs = new Set(
      [empty, short, long].map((r) => (r.ok ? '' : codeError(r))),
    )
    expect(msgs.size).toBe(2) // short and long share a message; empty differs
  })

  it('survives hostile input without throwing', () => {
    for (const bad of ['', ' '.repeat(1000), 'A'.repeat(10_000), '../../etc', '\x00', '\u{1D56C}\u{1D56D}']) {
      expect(() => checkCode(bad)).not.toThrow()
      expect(checkCode(bad).ok).toBe(false)
    }
  })

  it('every code the server can generate passes the client check', () => {
    // The two halves must agree on the alphabet, or a player can be handed a
    // code their own client refuses to type back in.
    let sawL = false
    for (let n = 0; n < 500; n++) {
      let code = ''
      for (let i = 0; i < CODE_LEN; i++) {
        code += CODE_ALPHABET[(n * 31 + i * 7 + n * n) % CODE_ALPHABET.length]
      }
      sawL ||= code.includes('L')
      expect(checkCode(code)).toEqual({ ok: true, code })
    }
    // The control: without an L in the sample this proves nothing about the bug
    // it exists to catch.
    expect(sawL).toBe(true)
  })
})

describe('join errors', () => {
  it('maps every server reason to something actionable', () => {
    for (const r of ['unknown_code', 'full', 'server_full', 'bad_name', 'no_room', 'in_progress']) {
      const m = joinErrorMessage(r)
      expect(m.length).toBeGreaterThan(0)
      // **The default branch is the thing to exclude, not the word.**
      // `not.toBe(r)` passed for it — `Could not join (full).` is not *equal*
      // to `full` — so a reason with no case of its own showed the player a
      // wire enum while this test stayed green. And plain `not.toContain(r)` is
      // too strong the other way: "That game is full." legitimately contains
      // "full". What identifies the fallback is its parenthesised token.
      expect(m).not.toContain(`(${r})`)
    }
  })

  it('an unknown reason still says something rather than nothing', () => {
    expect(joinErrorMessage('meteor')).toContain('meteor')
  })
})

describe('lobby errors', () => {
  // Every reason the server emits on `lobby_error`, copied from
  // `session.rs` (`set_scale`/`set_bots`/`set_start_kit`/`set_round_seconds`)
  // and `room.rs` (`check_settings_change`, `set_round_seconds`).
  const REASONS = [
    'only the host can change the settings',
    'settings can only be changed in a private game',
    'the match has already started',
    'the round length is out of range',
    'the round length must be a whole number of seconds',
    'the round length is not a whole number of steps',
    'unknown map size',
    'unknown starting kit',
    'bots must be true or false',
    'the round length must be a number',
    'the room is gone',
  ]

  it('never tells a seated player they could not join', () => {
    for (const r of REASONS) {
      const m = lobbyErrorMessage(r)
      // The reported bug, verbatim: `Could not join (only the host can change
      // the settings).` to a host sitting in their own lobby.
      expect(m).not.toContain('Could not join')
      expect(m).not.toContain(`(${r})`)
      expect(m.length).toBeGreaterThan(0)
    }
  })

  it('carries the server sentence rather than a second copy of it', () => {
    // Pass-through is the design: the reason *is* the message, capitalised and
    // stopped. A table here would be a client-side copy of the server's wording.
    expect(lobbyErrorMessage('only the host can change the settings')).toBe(
      'Only the host can change the settings.',
    )
    expect(lobbyErrorMessage('the round length is out of range')).toBe(
      'The round length is out of range.',
    )
  })

  it('the one reason that is a state and not a sentence gets its own words', () => {
    expect(lobbyErrorMessage('not seated')).not.toContain('Not seated')
    expect(lobbyErrorMessage('not seated').length).toBeGreaterThan(0)
  })

  it('an empty reason still says something', () => {
    expect(lobbyErrorMessage('').length).toBeGreaterThan(0)
  })

  // **The control.** These two functions must stay different: if
  // `lobbyErrorMessage` were `joinErrorMessage` under a new name, every
  // assertion above would still pass except this one.
  it('is not joinErrorMessage under another name', () => {
    const r = 'only the host can change the settings'
    expect(joinErrorMessage(r)).toContain('Could not join')
    expect(lobbyErrorMessage(r)).not.toBe(joinErrorMessage(r))
    // And the join table is untouched: a wire enum still reads as English.
    expect(joinErrorMessage('in_progress')).not.toContain('in_progress')
  })
})

describe('payloads', () => {
  it('every verb carries the same identity, so the server has one seating path', () => {
    const base = identityPayload(me)
    expect(base).toEqual({ name: 'ana', skin_id: 2, tombstone_skin_id: 7 })
    expect(createRoomPayload(me, 'small', true)).toMatchObject(base)
    expect(joinRoomPayload(me, 'ABC234')).toMatchObject(base)
    expect(quickMatchPayload(me, 'large')).toMatchObject(base)
  })

  it('carries the tombstone skin, which is new in v3', () => {
    expect(quickMatchPayload(me, 'small').tombstone_skin_id).toBe(7)
  })
})

const emptyLobby = {
  private: false,
  capacity: 5,
  scale: 'small' as const,
  // §F7 fields. Values only: nothing here asserts on them, so they are not
  // pinned to `ROUND_SECONDS` — a fixture that quoted it would be a second copy
  // of a tunable in a test that does not read it.
  bots: true,
  startKit: 'none' as const,
  roundSeconds: 0,
  players: [],
}

describe('the lobby state machine', () => {
  const idle: LobbyState = { kind: 'idle' }

  it('creating a room ends seated with a code', () => {
    let s = lobbyReducer(idle, { type: 'create', scale: 'small' })
    expect(s.kind).toBe('creating')
    s = lobbyReducer(s, { type: 'room_created', roomId: 3, code: 'ABC234' })
    expect(s).toEqual({ kind: 'seated', roomId: 3, code: 'ABC234' })
  })

  it('a refused join ends in an error, not a spinner', () => {
    let s = lobbyReducer(idle, { type: 'join', code: 'ZZZZZZ' })
    expect(s.kind).toBe('joining')
    s = lobbyReducer(s, { type: 'join_error', reason: 'unknown_code' })
    expect(s.kind).toBe('error')
    if (s.kind === 'error') expect(s.message).toMatch(/code/i)
  })

  it('quick match seats on lobby_state, before the map arrives', () => {
    // §E6: this was `room_list`, which had no subscriber in the app at all.
    let s = lobbyReducer(idle, { type: 'match', scale: 'medium' })
    s = lobbyReducer(s, { type: 'lobby_state', state: emptyLobby })
    expect(s.kind).toBe('seated')
    // A later `welcome` must not undo the seat or lose the room id.
    s = lobbyReducer(s, { type: 'welcome', roomId: 9 })
    expect(s.kind).toBe('seated')
  })

  it('a welcome that arrives without a prior lobby_state still seats', () => {
    const s = lobbyReducer(idle, { type: 'welcome', roomId: 4 })
    expect(s).toEqual({ kind: 'seated', roomId: 4 })
  })

  it('cancel returns to idle from every state, including error', () => {
    const states: LobbyState[] = [
      { kind: 'idle' },
      { kind: 'creating', scale: 'small' },
      { kind: 'joining', code: 'ABC234' },
      { kind: 'matching', scale: 'large' },
      { kind: 'seated', roomId: 1 },
      { kind: 'error', message: 'nope' },
    ]
    for (const s of states) {
      expect(lobbyReducer(s, { type: 'cancel' })).toEqual({ kind: 'idle' })
    }
  })

  it('never gets stuck: every state has a way back to idle', () => {
    // The control for the test above — it would pass trivially if `cancel` were
    // the only event, so check the machine actually moves under the others too.
    const s = lobbyReducer({ kind: 'idle' }, { type: 'create', scale: 'small' })
    expect(s).not.toEqual({ kind: 'idle' })
  })
})

describe('lobby_state (§E6)', () => {
  const raw = {
    private: true,
    capacity: 5,
    scale: 'large',
    code: 'ABC234',
    settings_owner: 3,
    starts_in: 7.25,
    players: [
      { seat: 3, name: 'ana', skin_id: 2, ready: true, bot: false },
      { seat: 4, name: 'Bot 1', skin_id: 0, ready: true, bot: true },
    ],
  }

  it('reads every field §E6 names', () => {
    const s = parseLobbyState(raw)
    expect(s.private).toBe(true)
    expect(s.capacity).toBe(5)
    expect(s.scale).toBe('large')
    expect(s.code).toBe('ABC234')
    expect(s.settingsOwner).toBe(3)
    expect(s.startsIn).toBeCloseTo(7.25)
    expect(s.players).toHaveLength(2)
    expect(s.players[0]).toEqual({ seat: 3, name: 'ana', skinId: 2, ready: true, bot: false })
    expect(s.players[1]!.bot).toBe(true)
  })

  it('leaves absent fields undefined rather than inventing them', () => {
    // A public lobby: no code, no owner yet, no timeout. `undefined` is the one
    // spelling of absence — the server omits these rather than sending null.
    const s = parseLobbyState({ private: false, capacity: 5, scale: 'small', players: [] })
    expect(s.code).toBeUndefined()
    expect(s.settingsOwner).toBeUndefined()
    expect(s.startsIn).toBeUndefined()
    // The control: the same parser does read them when they are there.
    expect(parseLobbyState(raw).code).toBe('ABC234')
  })

  it('reads §F7 settings, and falls back rather than inventing a value', () => {
    // Present: the three keys the server always sends.
    const s = parseLobbyState({
      ...raw,
      bots: false,
      start_kit: 'all',
      round_seconds: 300,
    })
    expect(s.bots).toBe(false)
    expect(s.startKit).toBe('all')
    expect(s.roundSeconds).toBe(300)

    // The control: the same parser reads the other value too, so `false` above
    // is not a parser that returns `false` for everything.
    expect(parseLobbyState({ ...raw, bots: true, start_kit: 'basic' }).bots).toBe(true)
    expect(parseLobbyState({ ...raw, start_kit: 'basic' }).startKit).toBe('basic')

    // Absent or junk: the server's defaults, never a value off the wire.
    const bare = parseLobbyState(raw)
    expect(bare.bots).toBe(true)
    expect(bare.startKit).toBe('none')
    expect(bare.roundSeconds).toBe(0)
    expect(parseLobbyState({ ...raw, start_kit: 'everything' }).startKit).toBe('none')
    // Junk for `bots`. This pins behaviour rather than discriminating: the type
    // check and the `!== false` it replaced agree on every input, so no
    // assertion here can tell them apart. What it does rule out is junk ever
    // reading as `false` — a bots-off lobby conjured from a malformed payload.
    for (const junk of ['false', 0, null, undefined, {}]) {
      expect(parseLobbyState({ ...raw, bots: junk }).bots).toBe(true)
    }
    expect(parseLobbyState({ ...raw, round_seconds: '300' }).roundSeconds).toBe(0)
  })

  it('survives a hostile payload without throwing', () => {
    for (const bad of [{}, { players: 'not an array' }, { players: [null, 7, {}] }]) {
      const s = parseLobbyState(bad as Record<string, unknown>)
      expect(Array.isArray(s.players)).toBe(true)
      // An unknown scale falls back rather than reaching the renderer as junk.
      expect(SCALES).toContain(s.scale)
    }
  })

  it('names every seat, so nobody renders as p1', () => {
    // §E6 moved the roster off `welcome`; this is the field the scoreboard
    // reads. A blank name is what the `p1, p2, p3` bug looked like.
    const s = parseLobbyState(raw)
    expect(s.players.every((p: { name: string }) => p.name.length > 0)).toBe(true)
  })
})

describe('the roster (§E6)', () => {
  const base = {
    private: false,
    capacity: 5,
    scale: 'small' as const,
    bots: true,
    startKit: 'none' as const,
    roundSeconds: 0,
    players: [
      { seat: 0, name: 'ana', skinId: 0, ready: true, bot: false },
      { seat: 1, name: 'Bot 1', skinId: 0, ready: true, bot: true },
    ],
  }

  it('labels bots as bots', () => {
    const rows = rosterRows(base, 0)
    expect(rows.map((r) => r.label).slice(0, 2)).toEqual(['ana', 'Bot 1 (bot)'])
    // The control: the flag and the label agree, so a roster that dropped the
    // suffix could not pass by keeping the flag.
    expect(rows.map((r) => r.bot).slice(0, 2)).toEqual([false, true])
  })

  it('pads to capacity so "3 of 5" is visible', () => {
    const rows = rosterRows(base, 0)
    expect(rows).toHaveLength(5)
    expect(rows.slice(2).every((r) => r.label === 'empty')).toBe(true)
  })

  it('marks which row is you, and only that one', () => {
    const rows = rosterRows(base, 1)
    expect(rows.filter((r) => r.you).map((r) => r.seat)).toEqual([1])
    // Nobody is "you" when the seat is unknown — an undefined seat must not
    // match an empty row's -1.
    expect(rosterRows(base, undefined).some((r) => r.you)).toBe(false)
  })

  it('says something different for a private lobby than a public one', () => {
    const pub = lobbyStatus({ ...base, startsIn: 4 })
    expect(pub).toContain('4s')
    const priv = lobbyStatus({
      ...base,
      private: true,
      players: [
        { seat: 0, name: 'ana', skinId: 0, ready: true, bot: false },
        { seat: 1, name: 'bo', skinId: 0, ready: false, bot: false },
      ],
    })
    // A private lobby has no timeout, so a countdown would be a lie.
    expect(priv).not.toContain('s,')
    expect(priv).toContain('1 of 2')
  })

  it('only the settings owner owns the settings', () => {
    const s = { ...base, settingsOwner: 0 }
    expect(ownsSettings(s, 0)).toBe(true)
    expect(ownsSettings(s, 1)).toBe(false)
    // Absent owner: nobody, rather than everybody.
    expect(ownsSettings(base, 0)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §F7 — the private lobby's settings panel
// ---------------------------------------------------------------------------

/**
 * Pinned to the shipped constants (§A19), never to literals — and loading the
 * core here is itself an assertion: these three cross from `constants.rs`
 * through `constants_json` to the `Constants` interface, and a panel that drew
 * its own 240/600/60 would keep offering the old range after any of them moved.
 */
let bounds: TimerBounds = { min: 0, max: 0, step: 0 }

beforeAll(async () => {
  const url = new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url)
  await Core.init(readFileSync(fileURLToPath(url)))
  const c = C()
  bounds = { min: c.ROUND_SECONDS_MIN, max: c.ROUND_SECONDS_MAX, step: c.ROUND_SECONDS_STEP }
})

const HOST = 3
const GUEST = 4

function lobby(over: Partial<LobbyStateMsg> = {}): LobbyStateMsg {
  return {
    private: true,
    capacity: 5,
    scale: 'small',
    bots: true,
    startKit: 'none',
    // **`bounds.min + step`, not a literal and not the bound itself.** A
    // fixture sitting on `min` has its own `prev` arrow legitimately disabled,
    // which would make "the host's arrows are all enabled" fail for a reason
    // that has nothing to do with the host gate.
    roundSeconds: bounds.min + bounds.step,
    settingsOwner: HOST,
    players: [
      { seat: HOST, name: 'ana', skinId: 0, ready: false, bot: false },
      { seat: GUEST, name: 'bo', skinId: 0, ready: false, bot: false },
    ],
    ...over,
  }
}

describe('the private settings panel (§F7)', () => {
  it('reads its bounds from the core, and they are a usable range', () => {
    // The control for every `bounds`-driven assertion below: if the three
    // constants never crossed, these are all zero and every step "clamps"
    // trivially.
    expect(bounds.step).toBeGreaterThan(0)
    expect(bounds.max).toBeGreaterThan(bounds.min)
    expect((bounds.max - bounds.min) % bounds.step).toBe(0)
  })

  it('wraps the three enum settings in both directions', () => {
    const s = lobby()
    // Map size wraps, as it always did.
    expect(stepSetting(s, HOST, 'scale', 1, bounds)).toBe(SCALES[1])
    expect(stepSetting(s, HOST, 'scale', -1, bounds)).toBe(SCALES[SCALES.length - 1])
    // Bots has two values, so either direction toggles.
    expect(stepSetting(s, HOST, 'bots', 1, bounds)).toBe(false)
    expect(stepSetting(s, HOST, 'bots', -1, bounds)).toBe(false)
    expect(stepSetting(lobby({ bots: false }), HOST, 'bots', 1, bounds)).toBe(true)
    // The kit walks the documented order and wraps at the end.
    expect(stepSetting(s, HOST, 'kit', 1, bounds)).toBe(START_KITS[1])
    expect(stepSetting(s, HOST, 'kit', -1, bounds)).toBe(START_KITS[START_KITS.length - 1])
  })

  it('clamps the timer instead of wrapping, and refuses a step at the bound', () => {
    const atMin = lobby({ roundSeconds: bounds.min })
    const atMax = lobby({ roundSeconds: bounds.max })
    // It moves by exactly one step, in both directions.
    expect(stepSetting(atMin, HOST, 'timer', 1, bounds)).toBe(bounds.min + bounds.step)
    expect(stepSetting(atMax, HOST, 'timer', -1, bounds)).toBe(bounds.max - bounds.step)
    // And it stops. **Not wrapping** is the whole difference from the three
    // above: `undefined` means "nothing to send", not "not allowed".
    expect(stepSetting(atMin, HOST, 'timer', -1, bounds)).toBeUndefined()
    expect(stepSetting(atMax, HOST, 'timer', 1, bounds)).toBeUndefined()
    // Every reachable value stays inside the range and on the step.
    let v = bounds.min
    for (let i = 0; i < 100; i += 1) {
      const next = stepSetting(lobby({ roundSeconds: v }), HOST, 'timer', 1, bounds)
      if (next === undefined) break
      v = next as number
      expect(v).toBeGreaterThanOrEqual(bounds.min)
      expect(v).toBeLessThanOrEqual(bounds.max)
      expect((v - bounds.min) % bounds.step).toBe(0)
    }
    expect(v).toBe(bounds.max)
  })

  it('gates all four settings on the host, not just the map size', () => {
    // The task file calls this `canChangeSettings`; the function is
    // `ownsSettings`, and the gate lives in `stepSetting` so all four share it.
    const s = lobby()
    for (const id of ['scale', 'bots', 'kit', 'timer'] as const) {
      expect(stepSetting(s, GUEST, id, 1, bounds)).toBeUndefined()
      expect(stepSetting(s, undefined, id, 1, bounds)).toBeUndefined()
      // The control: the same call as the host is allowed. Without it "the
      // guest is refused" passes for a stepper that refuses everybody.
      expect(stepSetting(s, HOST, id, 1, bounds)).not.toBeUndefined()
    }
    expect(ownsSettings(s, HOST)).toBe(true)
    expect(ownsSettings(s, GUEST)).toBe(false)
  })

  it('disables exactly what it refuses, so a screen cannot disagree with the wire', () => {
    const guest = settingsControls(lobby(), GUEST, bounds)
    expect(guest).toHaveLength(4)
    for (const c of guest) {
      expect([c.id, c.prevDisabled, c.nextDisabled]).toEqual([c.id, true, true])
    }
    // The control frame: the same lobby, seen by the host. Its timer sits one
    // step above `min`, so neither arrow is at a bound.
    const host = settingsControls(lobby(), HOST, bounds)
    for (const c of host) {
      expect([c.id, c.prevDisabled, c.nextDisabled]).toEqual([c.id, false, false])
    }
    // And the timer's arrows end disabled at each bound, for the host too.
    const low = settingsControls(lobby({ roundSeconds: bounds.min }), HOST, bounds)
    const high = settingsControls(lobby({ roundSeconds: bounds.max }), HOST, bounds)
    expect(low.find((c) => c.id === 'timer')?.prevDisabled).toBe(true)
    expect(low.find((c) => c.id === 'timer')?.nextDisabled).toBe(false)
    expect(high.find((c) => c.id === 'timer')?.nextDisabled).toBe(true)
    expect(high.find((c) => c.id === 'timer')?.prevDisabled).toBe(false)
  })

  it('never disables an arrow the wire would allow, or enables one it would refuse', () => {
    // **The failure mode this rules out looks exactly like a working panel.** A
    // screen that disables one set while the server refuses a different set
    // renders fine, steps fine, and is wrong only in the gap — an arrow that
    // looks live and does nothing, or one that looks dead and would have
    // worked. Asserted as an equivalence over the whole matrix rather than as
    // "they agree on these three cases".
    let live = 0
    let dead = 0
    for (const seat of [HOST, GUEST, undefined]) {
      for (let sec = bounds.min; sec <= bounds.max; sec += bounds.step) {
        for (const bots of [true, false]) {
          for (const startKit of START_KITS) {
            const s = lobby({ roundSeconds: sec, bots, startKit })
            for (const c of settingsControls(s, seat, bounds)) {
              const prev = stepSetting(s, seat, c.id, -1, bounds) === undefined
              const next = stepSetting(s, seat, c.id, 1, bounds) === undefined
              expect([c.id, c.prevDisabled, c.nextDisabled]).toEqual([c.id, prev, next])
              prev ? (dead += 1) : (live += 1)
              next ? (dead += 1) : (live += 1)
            }
          }
        }
      }
    }
    // The control: the matrix contains both answers. An equivalence over a
    // matrix that is all-disabled or all-enabled is satisfied by a panel that
    // ignores its arguments.
    expect(live).toBeGreaterThan(0)
    expect(dead).toBeGreaterThan(0)
  })

  it('renders each setting in the words §F7 uses, and the timer in minutes', () => {
    const rows = (s: LobbyStateMsg) =>
      Object.fromEntries(settingsControls(s, HOST, bounds).map((c) => [c.id, c.value]))
    expect(rows(lobby()).bots).toBe('Enabled')
    expect(rows(lobby({ bots: false })).bots).toBe('Disabled')
    expect(rows(lobby({ startKit: 'none' })).kit).toBe('None')
    expect(rows(lobby({ startKit: 'basic' })).kit).toBe('Basic')
    expect(rows(lobby({ startKit: 'all' })).kit).toBe('All')
    // Minutes on screen, seconds on the wire — one conversion, at the edge.
    expect(rows(lobby({ roundSeconds: bounds.min })).timer).toBe(
      `${Math.round(bounds.min / 60)} min`,
    )
    expect(minutesLabel(bounds.max)).toBe(`${Math.round(bounds.max / 60)} min`)
    expect(minutesLabel(bounds.min)).not.toBe(minutesLabel(bounds.max))
  })

  it('takes the three settings off lobby_state, and survives a server sending none', () => {
    // All three, changed together.
    const full = parseLobbyState({
      private: true,
      capacity: 5,
      scale: 'large',
      bots: false,
      start_kit: 'all',
      round_seconds: bounds.max,
      players: [],
    })
    expect([full.bots, full.startKit, full.roundSeconds]).toEqual([false, 'all', bounds.max])

    // An older server that carries none of them: the panel still renders, at
    // the server's own defaults, rather than throwing or showing blanks.
    const bare = parseLobbyState({ private: true, capacity: 5, scale: 'small', players: [] })
    const rows = settingsControls({ ...bare, settingsOwner: HOST }, HOST, bounds)
    expect(rows.map((c) => c.id)).toEqual(['scale', 'bots', 'kit', 'timer'])
    expect(rows.find((c) => c.id === 'bots')?.value).toBe('Enabled')
    expect(rows.find((c) => c.id === 'kit')?.value).toBe('None')
  })
})
