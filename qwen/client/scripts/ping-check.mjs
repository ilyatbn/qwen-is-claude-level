/**
 * Headless replacement for T0.3's manual browser check.
 *
 * Connects a real socket.io client to the `/game` namespace, sends `ping`,
 * and asserts `pong` comes back. Exits 0 on success, 1 on failure.
 */
import { io } from 'socket.io-client';

const URL = process.env.WIPGAME_URL ?? 'ws://localhost:3001/game';
const TIMEOUT_MS = 8000;

const socket = io(URL, { transports: ['websocket'] });

const timer = setTimeout(() => {
  console.error(`FAIL: no pong within ${TIMEOUT_MS} ms`);
  socket.close();
  process.exit(1);
}, TIMEOUT_MS);

socket.on('connect', () => {
  console.log(`connected id=${socket.id}`);
  socket.emit('ping', {});
  console.log('-> ping');
});

socket.on('pong', () => {
  console.log('<- pong');
  clearTimeout(timer);
  socket.close();
  console.log('PASS: ping/pong round-trip over namespace /game');
  process.exit(0);
});

socket.on('connect_error', (err) => {
  console.error(`FAIL: connect_error: ${err.message}`);
  clearTimeout(timer);
  process.exit(1);
});
