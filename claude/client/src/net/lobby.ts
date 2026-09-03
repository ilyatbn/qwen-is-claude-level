/**
 * The lobby half of the protocol (`docs/71-amendments-v3.md` §B9).
 *
 * Everything here is Phaser-free (§A8) so it is testable: the scene layer in
 * T10.04 imports this, never the other way round.
 */

/** The map sizes a player can ask for. */
export type Scale = 'small' | 'medium' | 'large'

export const SCALES: readonly Scale[] = ['small', 'medium', 'large'] as const

/**
 * The alphabet join codes are drawn from.
 *
 * No `I`, `1`, `O` or `0` — people read these aloud. Note it **does** contain
 * `L`, which is why the server does not fold `L`→`1`: doing so made roughly one
 * code in six unreachable.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CODE_LEN = 6

export type CodeCheck =
  | { ok: true; code: string }
  | { ok: false; reason: 'empty' | 'length' | 'characters'; bad?: string }

/**
 * Normalise and validate what the player typed.
 *
 * Upper-cases and strips spacing — a code copied from chat arrives with all
 * sorts of whitespace — but **never substitutes characters**. Every confusable
 * character is already absent from the alphabet, so a code containing one was
 * misread, and guessing would send the player into a stranger's game.
 */
export function checkCode(raw: string): CodeCheck {
  const code = raw.replace(/\s+/g, '').toUpperCase()
  if (code.length === 0) return { ok: false, reason: 'empty' }
  if (code.length !== CODE_LEN) return { ok: false, reason: 'length' }
  const bad = [...code].find((c) => !CODE_ALPHABET.includes(c))
  if (bad !== undefined) return { ok: false, reason: 'characters', bad }
  return { ok: true, code }
}

/** Human-readable, because "invalid" tells the player nothing actionable. */
export function codeError(c: Extract<CodeCheck, { ok: false }>): string {
  switch (c.reason) {
    case 'empty':
      return 'Enter a game code.'
    case 'length':
      return `A game code is ${CODE_LEN} characters.`
    case 'characters':
      return `"${c.bad}" is not in a game code — they never contain I, O, 0 or 1.`
  }
}

/** Reasons the server can refuse, mapped to something a person can act on. */
export function joinErrorMessage(reason: string): string {
  switch (reason) {
    case 'unknown_code':
      return 'No game with that code. It may have finished.'
    case 'full':
      return 'That game is full.'
    case 'server_full':
      return 'The server is at capacity. Try again in a moment.'
    case 'bad_name':
      return 'Pick a name with at least one character.'
    case 'no_room':
      return 'That game is no longer running.'
    // §E4. Distinct from `full` on purpose: a full lobby will have room later
    // and a started match will not, so the two say different things to the
    // player. Without this case the browser reads "Could not join
    // (in_progress)." — the wire's enum name, shown to a human.
    case 'in_progress':
      return 'That game has already started. Try another, or host one.'
    default:
      return `Could not join (${reason}).`
  }
}

export type LobbyState =
  | { kind: 'idle' }
  | { kind: 'creating'; scale: Scale }
  | { kind: 'joining'; code: string }
  | { kind: 'matching'; scale: Scale }
  | { kind: 'seated'; roomId: number; code?: string }
  | { kind: 'error'; message: string }

export interface Identity {
  name: string
  skinId: number
  tombstoneSkinId: number
}

export interface IdentityPayload {
  name: string
  skin_id: number
  tombstone_skin_id: number
}

/** The payload every lobby verb carries, so the server has one seating path. */
export function identityPayload(id: Identity): IdentityPayload {
  return {
    name: id.name,
    skin_id: id.skinId,
    tombstone_skin_id: id.tombstoneSkinId,
  }
}

export function createRoomPayload(id: Identity, scale: Scale, isPrivate: boolean) {
  return { ...identityPayload(id), scale, private: isPrivate }
}

export function joinRoomPayload(id: Identity, code: string) {
  return { ...identityPayload(id), code }
}

export function quickMatchPayload(id: Identity, scale: Scale) {
  return { ...identityPayload(id), scale }
}

/**
 * The lobby's state machine, as a reducer.
 *
 * Pure so it can be tested without a socket — the transitions are where the
 * bugs live (a `join_error` that leaves the UI spinning forever, a `welcome`
 * that arrives after the player has backed out).
 */
/** One seat, as `lobby_state` reports it (`docs/74` §E6). */
export interface LobbySeat {
  seat: number
  name: string
  skinId: number
  ready: boolean
  bot: boolean
}

/**
 * The lobby a client is sitting in (§E6).
 *
 * Optional fields are **absent, not null**: a public lobby has no `code`, and a
 * private one has no `startsIn` because it has no timeout. `undefined` is the
 * one spelling of that.
 */
/** §F7's starting-kit values, in the order the panel steps through them. */
export const START_KITS = ['none', 'basic', 'all'] as const
export type StartKit = (typeof START_KITS)[number]

export interface LobbyStateMsg {
  private: boolean
  capacity: number
  scale: Scale
  /** §F7. Always sent, so a seat that is not the host still sees the settings. */
  bots: boolean
  startKit: StartKit
  roundSeconds: number
  players: LobbySeat[]
  code?: string
  settingsOwner?: number
  startsIn?: number
}

const isScale = (v: unknown): v is Scale => SCALES.includes(v as Scale)
const isKit = (v: unknown): v is StartKit => START_KITS.includes(v as StartKit)

/**
 * Decode `lobby_state`, defensively.
 *
 * Every field is checked rather than cast: this is the message a client trusts
 * to render who is in the room, and the same hostile-input rule the code parser
 * already follows applies to it.
 */
export function parseLobbyState(p: Record<string, unknown>): LobbyStateMsg {
  const rawScale = p['scale']
  const rawKit = p['start_kit']
  const out: LobbyStateMsg = {
    private: p['private'] === true,
    capacity: typeof p['capacity'] === 'number' ? p['capacity'] : 0,
    scale: isScale(rawScale) ? rawScale : 'small',
    // §F7. The fallbacks match the server's defaults, so a message from an older
    // server reads as "bots on, no kit" rather than as something no room can be.
    // `roundSeconds` has no such default — 0 is visibly wrong, and a plausible
    // 240 here would hide a server that stopped sending the field.
    bots: p['bots'] !== false,
    startKit: isKit(rawKit) ? rawKit : 'none',
    roundSeconds: typeof p['round_seconds'] === 'number' ? p['round_seconds'] : 0,
    players: Array.isArray(p['players'])
      ? (p['players'] as unknown[]).filter(isRecord).map((q) => ({
          seat: typeof q['seat'] === 'number' ? q['seat'] : -1,
          name: typeof q['name'] === 'string' ? q['name'] : '',
          skinId: typeof q['skin_id'] === 'number' ? q['skin_id'] : 0,
          ready: q['ready'] === true,
          bot: q['bot'] === true,
        }))
      : [],
  }
  if (typeof p['code'] === 'string') out.code = p['code']
  if (typeof p['settings_owner'] === 'number') out.settingsOwner = p['settings_owner']
  if (typeof p['starts_in'] === 'number') out.startsIn = p['starts_in']
  return out
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export type LobbyEvent =
  | { type: 'create'; scale: Scale }
  | { type: 'join'; code: string }
  | { type: 'match'; scale: Scale }
  | { type: 'room_created'; roomId: number; code?: string }
  | { type: 'lobby_state'; state: LobbyStateMsg }
  | { type: 'welcome'; roomId?: number }
  | { type: 'join_error'; reason: string }
  | { type: 'cancel' }

export function lobbyReducer(s: LobbyState, e: LobbyEvent): LobbyState {
  switch (e.type) {
    case 'create':
      return { kind: 'creating', scale: e.scale }
    case 'join':
      return { kind: 'joining', code: e.code }
    case 'match':
      return { kind: 'matching', scale: e.scale }
    case 'room_created':
      return { kind: 'seated', roomId: e.roomId, ...(e.code ? { code: e.code } : {}) }
    case 'lobby_state':
      // §E6: `room_list` said this and had no subscriber. `lobby_state` is the
      // message that replaces it, and it confirms the seat before the map
      // arrives — so the player stops seeing a spinner as soon as they have one.
      return s.kind === 'seated' ? s : { kind: 'seated', roomId: -1 }
    case 'welcome':
      if (s.kind === 'seated') return s
      return { kind: 'seated', roomId: e.roomId ?? -1 }
    case 'join_error':
      return { kind: 'error', message: joinErrorMessage(e.reason) }
    case 'cancel':
      // Deliberately returns to idle from *any* state, including `error`: `Esc`
      // always goes back one step (§B3), and a UI you cannot leave is worse
      // than one that occasionally forgets a message.
      return { kind: 'idle' }
  }
}

/**
 * One roster line, ready to render (§E6).
 *
 * Pure, so the roster can be asserted without a browser — the DOM half is
 * `MenuScene`'s and is covered by `scripts/checks/lobby.mjs`.
 */
export interface RosterRow {
  seat: number
  label: string
  ready: boolean
  bot: boolean
  you: boolean
}

/**
 * The roster as it should appear, padded to `capacity` with empty seats.
 *
 * **Bots are labelled as bots.** A roster that hides them lies about who you are
 * playing: four "players" and one human is a different game from five humans,
 * and the player is entitled to know which one they are in.
 *
 * Empty seats are rendered rather than omitted, because "3 of 5" is the number
 * a player is waiting on and a list of three names does not say it.
 */
export function rosterRows(s: LobbyStateMsg, mySeat: number | undefined): RosterRow[] {
  const rows: RosterRow[] = s.players.map((p) => ({
    seat: p.seat,
    label: p.bot ? `${p.name} (bot)` : p.name,
    ready: p.ready,
    bot: p.bot,
    you: p.seat === mySeat,
  }))
  for (let i = rows.length; i < s.capacity; i += 1) {
    rows.push({ seat: -1, label: 'empty', ready: false, bot: false, you: false })
  }
  return rows
}

/**
 * What the lobby's status line says, and it is three different sentences.
 *
 * A private lobby has no timeout (§E3) and a public one has no ready gate (§E2),
 * so a single "waiting…" would be wrong in both. `startsIn` is absent for
 * private lobbies precisely so this cannot show a countdown that will never
 * fire.
 */
export function lobbyStatus(s: LobbyStateMsg): string {
  const humans = s.players.filter((p) => !p.bot).length
  if (s.private) {
    const notReady = s.players.filter((p) => !p.bot && !p.ready).length
    return notReady === 0
      ? 'Everyone is ready — starting…'
      : `Waiting for ${notReady} of ${humans} to be ready.`
  }
  if (s.startsIn !== undefined) {
    return `Starting in ${Math.max(0, Math.ceil(s.startsIn))}s, or when the lobby fills.`
  }
  return 'Waiting for players…'
}

/** May this seat change the settings? (§E3) */
export function ownsSettings(s: LobbyStateMsg, mySeat: number | undefined): boolean {
  return mySeat !== undefined && s.settingsOwner === mySeat
}
