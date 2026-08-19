/**
 * Drives two real clients into a fight so the combat events can be observed on
 * the wire: projectile_fired, explosion, item_picked and — the kill feed's
 * only source (T5.4) — kill.
 *
 * Idle clients produce none of these: nobody starts with a weapon (docs/04 §5
 * gives no spawn loadout), so a bot has to walk over an item to arm itself.
 * Each bot walks toward the other, jumps to clear terrain, aims from the
 * snapshot positions and holds fire.
 */
import { io } from 'socket.io-client';

const url = 'ws://localhost:3001/game';
const WINDOW_MS = Number(process.argv[2] ?? 240000);
const seen = { kill: [], projectile_fired: 0, explosion: 0, item_picked: [], respawned: 0 };

const bots = ['red', 'blue'].map((name) => {
  const s = io(url, { transports: ['websocket'] });
  const bot = { socket: s, name, id: null, tick: 0, self: null, other: null };
  s.on('connect', () => s.emit('join_room', { name }));
  s.on('joined', (d) => {
    bot.id = d.id;
    s.emit('ready', {});
  });
  s.on('snapshot', (snap) => {
    bot.self = snap.players.find((p) => p.id === bot.id) ?? null;
    bot.other = snap.players.find((p) => p.id !== bot.id && p.alive) ?? null;
    bot.tick = snap.tick;
  });
  return bot;
});

// One aggregate listener, on the first bot only, so counts are not doubled.
const a = bots[0].socket;
a.on('kill', (d) => { seen.kill.push(d); console.log(`kill: ${JSON.stringify(d)}`); });
a.on('projectile_fired', () => { seen.projectile_fired += 1; });
a.on('explosion', () => { seen.explosion += 1; });
a.on('item_picked', (d) => { seen.item_picked.push(d); });
a.on('respawned', () => { seen.respawned += 1; });

// 20 Hz, the input rate docs/05 §3 expects.
const loop = setInterval(() => {
  for (const bot of bots) {
    if (bot.self === null || bot.id === null) continue;
    const target = bot.other;
    // Armed = holding something with ammo. Chasing a moving target and hitting
    // it is a coin flip; firing a rocket at your own feet is not, and a
    // self-kill exercises the same path plus docs/03 §6's "self-kills score
    // nobody" rule. So: hunt for a weapon, then use it on yourself.
    const armed = (bot.self.ammo?.[bot.self.selected] ?? 0) > 0;
    const dx = target === null ? 1 : target.x - bot.self.x;
    const dy = target === null ? 0 : target.y - bot.self.y;
    bot.socket.emit('input', {
      tick: bot.tick,
      // Keep walking while unarmed so items get walked over (pickup is
      // proximity-based, D41).
      left: !armed && dx < -4,
      right: !armed && dx > 4,
      up: false,
      down: false,
      // Jump often: spawns are on separate platforms and a bot that cannot
      // climb never reaches anything.
      jump: !armed && bot.tick % 20 < 3,
      // Screen y grows downward; protocol angles are CCW positive (docs/06),
      // so -PI/2 aims straight down at the ground the bot is standing on.
      aim: armed ? -Math.PI / 2 : Math.atan2(-dy, dx),
      fire: true,
      use_slot: null,
    });
  }
}, 50);

setTimeout(() => {
  clearInterval(loop);
  console.log(`projectile_fired: ${seen.projectile_fired}`);
  console.log(`explosion:        ${seen.explosion}`);
  console.log(`item_picked:      ${seen.item_picked.length} ${JSON.stringify(seen.item_picked.slice(0, 4))}`);
  console.log(`kill:             ${seen.kill.length}`);
  console.log(`respawned:        ${seen.respawned}`);
  const failures = [];
  if (seen.item_picked.length === 0) failures.push('no item was ever picked up');
  if (seen.projectile_fired === 0) failures.push('no projectile_fired reached the client');
  if (seen.kill.length === 0) failures.push('no kill reached the client');
  for (const k of seen.kill) {
    const keys = Object.keys(k).sort().join(',');
    if (keys !== 'killer,victim,weapon') failures.push(`kill keys ${keys} != docs/06 §2`);
  }
  for (const f of failures) console.log(`FAIL: ${f}`);
  console.log(failures.length === 0 ? 'PASS: combat events reach the client' : 'FAIL');
  for (const bot of bots) bot.socket.close();
  process.exit(failures.length === 0 ? 0 : 1);
}, WINDOW_MS);
