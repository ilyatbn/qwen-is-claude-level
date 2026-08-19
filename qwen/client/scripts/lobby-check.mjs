/**
 * Live check of the lobby events T5.3 wired up (docs/06 §2, docs/07 §4).
 *
 * Two real clients: B must SEE A's skin change, which is the T5.3 acceptance
 * ("other players see your skin in lobby list") and the reason lobby_state has
 * to be broadcast rather than merely stored.
 */
import { io } from 'socket.io-client';

const url = 'ws://localhost:3001/game';
const a = io(url, { transports: ['websocket'] });
// B is created disconnected so it can join strictly AFTER A, which is what
// makes "A is told about B" a meaningful assertion.
const b = io(url, { transports: ['websocket'], autoConnect: false });

const seenByB = { lobbyStates: [], playerJoined: [], playerLeft: [] };
const seenByA = { playerJoined: [] };
let aId = null;
const failures = [];

a.on('connect', () => a.emit('join_room', { name: 'alice' }));
a.on('joined', (d) => {
  aId = d.id;
  // B joins only after A is in, so B's player_joined for A cannot race.
  b.connect();
  setTimeout(() => a.emit('select_skin', { skin: 3, weapon_skin: 1 }), 600);
});

b.on('connect', () => b.emit('join_room', { name: 'bob' }));
b.on('lobby_state', (d) => seenByB.lobbyStates.push(d));
b.on('player_joined', (d) => seenByB.playerJoined.push(d));
a.on('player_left', (d) => seenByB.playerLeft.push(d));
a.on('player_joined', (d) => seenByA.playerJoined.push(d));

setTimeout(() => {
  const last = seenByB.lobbyStates.at(-1);
  console.log(`lobby_state seen by B: ${seenByB.lobbyStates.length}`);
  if (last === undefined) {
    failures.push('B never received lobby_state');
  } else {
    console.log(`  roster: ${JSON.stringify(last.players)}`);
    console.log(`  ready:  ${JSON.stringify(last.ready)}  countdown: ${last.countdown_in_s}`);
    const alice = last.players.find((p) => p.id === aId);
    if (alice === undefined) failures.push(`A (id ${aId}) missing from B's roster`);
    else {
      if (alice.skin !== 3) failures.push(`A's skin is ${alice.skin}, expected 3`);
      if (alice.weapon_skin !== 1) {
        failures.push(`A's weapon_skin is ${alice.weapon_skin}, expected 1`);
      }
      if (alice.name !== 'alice') failures.push(`A's name is ${alice.name}`);
    }
    if (!Array.isArray(last.ready) || last.ready.length !== 6) {
      failures.push('ready is not a 6-element array (docs/06 §2)');
    }
  }
  // B is announced to A; A is not told about its own join, and B — which
  // joined last — should hear about nobody.
  console.log(`player_joined seen by A: ${JSON.stringify(seenByA.playerJoined)}`);
  console.log(`player_joined seen by B: ${JSON.stringify(seenByB.playerJoined)}`);
  if (seenByA.playerJoined.length !== 1) {
    failures.push(`A saw ${seenByA.playerJoined.length} player_joined, expected 1 (B)`);
  } else if (seenByA.playerJoined[0]?.name !== 'bob') {
    failures.push(`A's player_joined was ${JSON.stringify(seenByA.playerJoined[0])}`);
  }
  if (seenByB.playerJoined.length !== 0) {
    failures.push('B was told about a join that happened before it connected');
  }
  if (last !== undefined && last.players.length !== 2) {
    failures.push(`roster has ${last.players.length} players, expected 2`);
  }
  b.close();
  setTimeout(() => {
    console.log(`player_left seen by A: ${JSON.stringify(seenByB.playerLeft)}`);
    if (seenByB.playerLeft.length === 0) failures.push('A never received player_left for B');
    for (const f of failures) console.log(`FAIL: ${f}`);
    console.log(failures.length === 0
      ? 'PASS: lobby roster, skin broadcast and leave notification all live'
      : `FAIL: ${failures.length} problem(s)`);
    a.close();
    process.exit(failures.length === 0 ? 0 : 1);
  }, 800);
}, 3000);
