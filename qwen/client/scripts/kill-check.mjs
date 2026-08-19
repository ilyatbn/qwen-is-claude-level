/**
 * Waits for a real `kill` on the wire — the kill feed's only source (T5.4).
 *
 * Two idle clients ready up and let the weather do the work: toxic rain, lava
 * and meteors damage players who never move (docs/02), so a kill with
 * `killer: null` arrives without needing a bot that can aim.
 */
import { io } from 'socket.io-client';

const url = 'ws://localhost:3001/game';
const WINDOW_MS = Number(process.argv[2] ?? 150000);
const clients = ['killa', 'killb'].map((name, i) => {
  const s = io(url, { transports: ['websocket'] });
  s.on('connect', () => s.emit('join_room', { name }));
  s.on('joined', () => s.emit('ready', {}));
  if (i === 0) {
    s.on('round_started', () => console.log('round started, waiting for a kill...'));
  }
  return s;
});

const kills = [];
const respawns = [];
clients[0].on('kill', (d) => {
  kills.push(d);
  console.log(`kill: ${JSON.stringify(d)}`);
});
clients[0].on('respawned', (d) => respawns.push(d));

const done = (code) => {
  for (const s of clients) s.close();
  process.exit(code);
};

setTimeout(() => {
  const failures = [];
  console.log(`kills: ${kills.length}, respawns: ${respawns.length}`);
  if (kills.length === 0) {
    failures.push('no kill arrived in the window — the kill feed has no source');
  }
  for (const k of kills) {
    const keys = Object.keys(k).sort().join(',');
    if (keys !== 'killer,victim,weapon') failures.push(`kill keys ${keys} != docs/06 §2`);
    if (typeof k.victim !== 'number') failures.push('victim is not a number');
    if (k.killer !== null && typeof k.killer !== 'number') failures.push('killer is not u8|null');
    if (typeof k.weapon !== 'string' || k.weapon.length === 0) failures.push('weapon is empty');
  }
  // docs/03 §6: a weather kill credits nobody.
  const weather = kills.filter((k) => k.killer === null);
  console.log(`weather kills (killer null): ${weather.length}`);
  for (const f of failures) console.log(`FAIL: ${f}`);
  console.log(failures.length === 0 ? 'PASS: kill events reach the client' : 'FAIL');
  done(failures.length === 0 ? 0 : 1);
}, WINDOW_MS);
