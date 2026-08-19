/** Phase 4 live check: join, ready, and confirm snapshots arrive. */
import { io } from 'socket.io-client';
const URL = 'ws://localhost:3001/game';
const s = io(URL, { transports: ['websocket'] });
let snapshots = 0, joined = null, roundStarted = false;
const done = (code, msg) => { console.log(msg); s.close(); process.exit(code); };
setTimeout(() => done(snapshots > 0 ? 0 : 1,
  `snapshots=${snapshots} joined=${JSON.stringify(joined)} roundStarted=${roundStarted}`), 9000);
s.on('connect', () => { s.emit('join_room', { name: 'live' }); });
s.on('joined', (d) => { joined = d; console.log('joined:', JSON.stringify(d)); s.emit('ready', {}); });
s.on('round_started', (d) => { roundStarted = true; console.log('round_started:', JSON.stringify(d)); });
s.on('snapshot', (snap) => {
  snapshots += 1;
  if (snapshots === 1) console.log(`first snapshot: tick=${snap.tick} players=${snap.players.length} items=${snap.items.length}`);
});
s.on('connect_error', (e) => done(1, `connect_error: ${e.message}`));
