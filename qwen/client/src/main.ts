/**
 * Phaser bootstrap + scene list (docs/00 §1).
 */
import Phaser from 'phaser';
import { io, type Socket } from 'socket.io-client';
import { BootScene } from './scenes/BootScene';
import { GameScene } from './scenes/GameScene';
import { LobbyScene } from './scenes/LobbyScene';
import { RoundEndScene } from './scenes/RoundEndScene';
import { C2S, NAMESPACE, PROTOCOL_VERSION, S2C } from './protocol';

/** docs/00 §6: the client connects to the Rust server on :3001. */
const SERVER_URL = `ws://localhost:3001${NAMESPACE}`;

/** T0.3: ping cadence. */
const PING_INTERVAL_MS = 2000;

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  width: window.innerWidth,
  height: window.innerHeight,
  backgroundColor: '#101014',
  scene: [BootScene, LobbyScene, GameScene, RoundEndScene],
  pixelArt: true,
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
};

console.log(`wipgame client, protocol v${PROTOCOL_VERSION}`);

export const game = new Phaser.Game(config);

/** Connect to the `/game` namespace and ping it every 2 s (T0.3). */
export function connect(url: string = SERVER_URL): Socket {
  const socket = io(url, { transports: ['websocket'] });

  socket.on('connect', () => {
    console.log(`[net] connected id=${socket.id ?? '?'}`);
  });

  socket.on('disconnect', (reason: string) => {
    console.log(`[net] disconnected: ${reason}`);
  });

  socket.on('connect_error', (err: Error) => {
    console.warn(`[net] connect error: ${err.message}`);
  });

  socket.on(S2C.PONG, () => {
    console.log('[net] pong');
  });

  window.setInterval(() => {
    if (socket.connected) {
      socket.emit(C2S.PING, {});
    }
  }, PING_INTERVAL_MS);

  return socket;
}

export const socket = connect();
