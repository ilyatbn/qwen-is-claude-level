/**
 * Checks the WIRE, not the structs: every server -> client event that arrives
 * during a live round has its key set compared against docs/06 §2.
 *
 * tick.rs used to hand-build these payloads with serde_json::json!, which
 * bypassed the typed structs the protocol pins guard (DEVIATIONS.md D46).
 * The unit tests in tick.rs now cover event_payload directly; this covers the
 * step after it — what socket.io actually delivers.
 *
 * Run against a server started with WIPGAME_SEED=4242 so effects fire at a
 * known schedule. Two clients so the lobby, ready and round flow are real.
 */
import { io } from 'socket.io-client';

/** docs/06 §2, verbatim. Sorted key sets. */
const SHAPES = {
  // protocol_version is required by docs/06 §7 but absent from §2's row —
  // the field is deliberate, see DEVIATIONS.md D16.
  joined: ['id', 'map', 'players', 'protocol_version', 'room', 'scale', 'seed'],
  player_joined: ['id', 'name', 'skin'],
  player_left: ['id'],
  lobby_state: ['countdown_in_s', 'players', 'ready'],
  round_started: ['map', 'scale', 'seed', 'spawn'],
  tile_destroyed: ['item_uncovered', 'tiles', 'version'],
  item_spawned: ['crate', 'item', 'x', 'y'],
  item_picked: ['item', 'player'],
  crate_dropped: ['x'],
  projectile_fired: ['angle', 'id', 'kind', 'owner', 'x', 'y'],
  explosion: ['radius', 'x', 'y'],
  kill: ['killer', 'victim', 'weapon'],
  respawned: ['player', 'x', 'y'],
  effect_started: ['data', 'kind'],
  effect_ended: ['kind'],
  round_ended: ['scores'],
  pong: [],
  error: ['code', 'msg'],
};
/** Snapshot is §4, not a flat key list — checked separately. */
const SNAPSHOT_KEYS = ['day_phase', 'effect', 'fog', 'items', 'map_version', 'players',
  'projectiles', 'round_time_s', 'tick'];

const seen = new Map();
const failures = [];
let effectData = null;

const check = (name, payload) => {
  seen.set(name, (seen.get(name) ?? 0) + 1);
  const expected = name === 'snapshot' ? SNAPSHOT_KEYS : SHAPES[name];
  if (expected === undefined) { failures.push(`${name}: not in docs/06 §2`); return; }
  const got = Object.keys(payload ?? {}).sort();
  if (got.join(',') !== [...expected].sort().join(','))
    failures.push(`${name}: keys ${JSON.stringify(got)} != docs/06 §2 ${JSON.stringify(expected)}`);
  // docs/06 §5: effect_started.data is the per-kind payload. `{}` is what the
  // hand-built version shipped for every kind.
  if (name === 'effect_started') effectData = { kind: payload.kind, data: payload.data };
};

const spy = (s, tag) => {
  s.onAny((name, payload) => check(name, payload));
  s.on('connect', () => s.emit('join_room', { name: tag }));
  s.on('joined', () => s.emit('ready', {}));
};

const a = io('ws://localhost:3001/game', { transports: ['websocket'] });
const b = io('ws://localhost:3001/game', { transports: ['websocket'] });
spy(a, 'evt-a');
spy(b, 'evt-b');

setTimeout(() => {
  for (const [name, n] of [...seen].sort()) console.log(`  ${name} x${n}`);
  // Events this scenario genuinely exercises. Absence here is a defect.
  const required = ['joined', 'lobby_state', 'player_joined', 'round_started', 'snapshot',
    'effect_started', 'tile_destroyed', 'item_spawned'];
  for (const name of required)
    if (!seen.has(name)) failures.push(`${name} never arrived — the check proved nothing about it`);
  // The rest split two ways, and the distinction matters: an event this
  // scenario did not trigger (idle clients never shoot) is an observation
  // limit, while an event with no emit site at all is a defect. Which is
  // which is decided statically by scripts/wire-coverage.sh, not here.
  const notSent = [];
  const unexercised = Object.keys(SHAPES).filter(
    (n) => !seen.has(n) && !required.includes(n) && !notSent.includes(n));
  if (notSent.length > 0) {
    console.log(`  not emitted by the server at all (see scripts/wire-coverage.sh): ${notSent.join(', ')}`);
  }
  console.log(`  not triggered by this scenario: ${unexercised.join(', ')}`);
  if (effectData) {
    const empty = Object.keys(effectData.data ?? {}).length === 0;
    console.log(`  effect_started.data (${effectData.kind}): ${JSON.stringify(effectData.data)}`);
    if (empty && effectData.kind !== 'heavy_fog')
      failures.push(`effect_started.data is empty for ${effectData.kind} (docs/06 §5)`);
  }
  for (const f of failures) console.log(`FAIL: ${f}`);
  console.log(failures.length === 0
    ? `PASS: ${seen.size} event types on the wire match docs/06 §2`
    : `FAIL: ${failures.length} wire mismatch(es)`);
  a.close(); b.close();
  process.exit(failures.length === 0 ? 0 : 1);
}, 45000);
