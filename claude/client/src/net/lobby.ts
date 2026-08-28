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
export interface LobbyStateMsg {
  private: boolean
  capacity: number
  scale: Scale
  players: LobbySeat[]
  code?: string
  settingsOwner?: number
  startsIn?: number
}

const isScale = (v: unknown): v is Scale => SCALES.includes(v as Scale)

/**
 * Decode `lobby_state`, defensively.
 *
 * Every field is checked rather than cast: this is the message a client trusts
 * to render who is in the room, and the same hostile-input rule the code parser
 * already follows applies to it.
 */
export function parseLobbyState(p: Record<string, unknown>): LobbyStateMsg {
  const rawScale = p['scale']
  const out: LobbyStateMsg = {
    private: p['private'] === true,
    capacity: typeof p['capacity'] === 'number' ? p['capacity'] : 0,
    scale: isScale(rawScale) ? rawScale : 'small',
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

function isRecord(v: unknown): v is Record<string, unknown> {
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
