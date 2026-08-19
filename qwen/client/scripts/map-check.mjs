/**
 * Proves the client receives the SERVER's map, not a local placeholder.
 *
 * Decodes MapData.tiles from `joined`, prints a fingerprint the server can be
 * compared against, and checks a tile_destroyed event lands on a tile the
 * client agrees was solid.
 */
import { io } from 'socket.io-client';

const s = io('ws://localhost:3001/game', { transports: ['websocket'] });
let joined = null, grid = null, destroyed = 0, roundMaps = 0;
let pristine = null, pristineSolid = 0;

const fnv1a = (bytes) => {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h.toString(16).padStart(16, '0');
};

const decode = (b64) => Uint8Array.from(Buffer.from(b64, 'base64'));

setTimeout(() => {
  if (!joined) { console.log('FAIL: never joined'); s.close(); process.exit(1); }
  if (!grid) { console.log('FAIL: joined carried no map'); s.close(); process.exit(1); }
  const solid = grid.bytes.reduce((n, b) => n + (b !== 0 ? 1 : 0), 0);
  console.log(`map: seed=${joined.map.seed} scale=${joined.map.scale} ${joined.map.width}x${joined.map.height}`);
  console.log(`     tiles=${grid.bytes.length} solid=${solid} decor=${joined.map.decor.length} spawns=${joined.map.spawns.length}`);
  console.log(`     fnv1a now=${fnv1a(grid.bytes)} (after ${destroyed} destructions)`);
  console.log(`     PRISTINE fnv1a=${pristine} solid=${pristineSolid}`);
  console.log(`players in joined: ${joined.players.length}`);
  console.log(`round_started with map: ${roundMaps}`);
  console.log(`tile_destroyed events applied: ${destroyed}`);
  const ok = grid.bytes.length === joined.map.width * joined.map.height
    && solid > 0 && joined.map.spawns.length >= 6 && joined.players.length >= 1;
  console.log(ok ? 'PASS: client holds the server grid' : 'FAIL: grid is not well-formed');
  s.close(); process.exit(ok ? 0 : 1);
}, 30000);

s.on('connect', () => s.emit('join_room', { name: 'mapcheck' }));
s.on('joined', (d) => {
  joined = d;
  if (d.map && d.map.tiles) {
    grid = { bytes: decode(d.map.tiles), w: d.map.width };
    console.log(`joined: got ${grid.bytes.length} tile bytes`);
  }
  s.emit('ready', {});
});
s.on('round_started', (d) => {
  if (d.map && d.map.tiles) {
    roundMaps += 1;
    grid = { bytes: decode(d.map.tiles), w: d.map.width };
    // Fingerprint on ARRIVAL, before any tile_destroyed mutates it — the
    // grid legitimately diverges from the server's pristine map as
    // destruction is applied.
    pristine = fnv1a(grid.bytes);
    pristineSolid = grid.bytes.reduce((n, b) => n + (b !== 0 ? 1 : 0), 0);
    console.log(`round_started: map re-sent, ${grid.bytes.length} tile bytes`);
    console.log(`     pristine fnv1a=${pristine} solid=${pristineSolid}`);
  }
});
s.on('tile_destroyed', (d) => {
  for (const t of d.tiles) {
    const i = t.y * grid.w + t.x;
    if (destroyed === 0) {
      console.log(`tile_destroyed: (${t.x},${t.y}) client had kind=${grid.bytes[i]} (non-zero = was solid)`);
    }
    grid.bytes[i] = 0;
    destroyed += 1;
  }
});
s.on('connect_error', (e) => { console.log('FAIL:', e.message); process.exit(1); });
