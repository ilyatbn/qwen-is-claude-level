/**
 * T5.5 step 4: `set_log_level { level: "debug" }` changes the running server's
 * output without a restart (docs/05 §5, §7).
 *
 * Reads the server's log file directly, so the check is on what the server
 * actually wrote rather than on the handler returning without error.
 */
import { io } from 'socket.io-client';
import { readFileSync } from 'node:fs';

const logPath = process.argv[2];
if (logPath === undefined) {
  console.log('usage: node scripts/log-check.mjs <server log path>');
  process.exit(2);
}
const lines = () => readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
const debugLines = () => lines().filter((l) => l.includes('DEBUG')).length;

const s = io('ws://localhost:3001/game', { transports: ['websocket'] });
const failures = [];

s.on('connect', () => {
  s.emit('join_room', { name: 'logcheck' });
  // A ping logs at DEBUG ("[net] ping from id=..."), so there is something to
  // count either side of the switch.
  setTimeout(() => {
    const before = debugLines();
    s.emit('ping', {});
    setTimeout(() => {
      const stillBefore = debugLines();
      if (stillBefore > before) {
        failures.push(`server already logs DEBUG at RUST_LOG=info (${before} -> ${stillBefore})`);
      }
      console.log(`DEBUG lines at info level: ${stillBefore}`);
      s.emit('set_log_level', { level: 'debug' });
      setTimeout(() => {
        s.emit('ping', {});
        setTimeout(() => {
          const after = debugLines();
          console.log(`DEBUG lines after set_log_level: ${after}`);
          if (after <= stillBefore) {
            failures.push('set_log_level did not change the output');
          }
          const sample = lines().filter((l) => l.includes('DEBUG')).slice(-2);
          for (const line of sample) console.log(`  ${line.slice(0, 120)}`);
          for (const f of failures) console.log(`FAIL: ${f}`);
          console.log(failures.length === 0
            ? 'PASS: log level flipped at runtime, no restart'
            : 'FAIL');
          s.close();
          process.exit(failures.length === 0 ? 0 : 1);
        }, 800);
      }, 800);
    }, 800);
  }, 500);
});
