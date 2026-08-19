/**
 * Phaser bootstrap + scene list (docs/00 §1).
 */
import Phaser from 'phaser';
import { io, type Socket } from 'socket.io-client';
import { BootScene } from './scenes/BootScene';
import { GameScene } from './scenes/GameScene';
import { LobbyScene } from './scenes/LobbyScene';
import { RoundEndScene } from './scenes/RoundEndScene';
import {
  C2S,
  NAMESPACE,
  PROTOCOL_VERSION,
  S2C,
  type InputFrame,
  type Joined,
  type Kill,
  type LobbyState,
  type PlayerJoined,
  type PlayerLeft,
  type RoundStarted,
  type Snapshot,
  type TileDestroyedMsg,
} from './protocol';

/** docs/00 §6: the client connects to the Rust server on :3001. */
const SERVER_URL = `ws://localhost:3001${NAMESPACE}`;

/** T0.3: ping cadence. */
const PING_INTERVAL_MS = 2000;

/** What LobbyScene emits on `lobby-action`; `type` is the wire event name. */
interface LobbyAction {
  type: string;
  [field: string]: unknown;
}

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

  // docs/06 §2: the server's map is authoritative. Route it into GameScene so
  // the client renders the terrain the server actually simulates rather than
  // the offline placeholder.
  const gameScene = (): GameScene | undefined =>
    game.scene.getScene('GameScene') as GameScene | undefined;
  const lobbyScene = (): LobbyScene | undefined =>
    game.scene.getScene('LobbyScene') as LobbyScene | undefined;
  const roundEndScene = (): RoundEndScene | undefined =>
    game.scene.getScene('RoundEndScene') as RoundEndScene | undefined;

  // The scenes own no socket (they stay testable that way), so their actions
  // are local events this layer forwards.
  //
  // These MUST be registered only once the scenes exist. `getScene()` reads
  // SceneManager's `keys` map, which `bootQueue` fills on the game's READY
  // event -- long after this module body runs. Registering eagerly left
  // `lobbyScene()` null, the optional chain silently skipped the listener, and
  // the ready button never reached the server: nobody was ever marked ready,
  // so the countdown never started. Same class as D48.
  const wireScenes = (): void => {
    const forward = (action: LobbyAction): void => {
      const { type, ...payload } = action;
      socket.emit(type, payload);
    };
    // name, skin and ready (docs/06 §1).
    lobbyScene()?.events.on('lobby-action', forward);
    // restart / quit had no listener at all.
    roundEndScene()?.events.on('round-end-action', forward);
    // The 20 Hz input frame -- WASD, jump, aim, fire, slots. GameScene emitted
    // it and nothing ever listened, so `input` was never sent at all.
    gameScene()?.events.on('input-frame', (frame: InputFrame) => {
      socket.emit(C2S.INPUT, frame);
    });
  };
  if (lobbyScene()) {
    wireScenes();
  } else {
    game.events.once(Phaser.Core.Events.READY, wireScenes);
  }

  socket.on('connect', () => {
    // docs/05 §2's flow starts with join_room, and nothing sent it: the client
    // connected and then sat idle, with no room, no map and no snapshots,
    // until the player happened to click the name field. The stored name is
    // used so a refresh rejoins as the same player (docs/07 §4's pattern).
    const name = window.localStorage.getItem('name') ?? 'player';
    socket.emit(C2S.JOIN_ROOM, { name });
  });

  socket.on(S2C.JOINED, (payload: Joined) => {
    console.log(`[net] joined as ${payload.id} in room ${payload.room}`);
    gameScene()?.applyMapData(payload.map, payload.id);
    lobbyScene()?.checkProtocolVersion(payload.protocol_version);
    // Send the persisted choice on join: the server defaults every player to
    // skin 0, so a restored localStorage value must be told to it (docs/07 §4:
    // "refresh page -> same skin restored").
    const selection = lobbyScene()?.selection;
    if (selection !== undefined) {
      socket.emit(C2S.SELECT_SKIN, {
        skin: selection.skin,
        weapon_skin: selection.weaponSkin,
      });
    }
    if (payload.protocol_version !== PROTOCOL_VERSION) {
      console.warn(
        `[net] protocol mismatch: client v${PROTOCOL_VERSION}, ` +
          `server v${payload.protocol_version}`,
      );
    }
  });

  socket.on(S2C.LOBBY_STATE, (payload: LobbyState) => {
    lobbyScene()?.showLobby(payload.players, payload.countdown_in_s);
  });

  socket.on(S2C.PLAYER_JOINED, (payload: PlayerJoined) => {
    console.log(`[net] P${payload.id} (${payload.name}) joined`);
  });

  socket.on(S2C.PLAYER_LEFT, (payload: PlayerLeft) => {
    console.log(`[net] P${payload.id} left`);
  });

  socket.on(S2C.ROUND_STARTED, (payload: RoundStarted) => {
    console.log(`[net] round_started seed=${payload.seed}`);
    gameScene()?.applyMapData(payload.map);
    // The lobby overlay is only meaningful before the round.
    game.scene.stop('LobbyScene');
  });

  socket.on(S2C.TILE_DESTROYED, (payload: TileDestroyedMsg) => {
    gameScene()?.applyTileDestroyed(payload.tiles, payload.version);
  });

  // T5.4 step 2: the kill feed's only source (docs/06 §2).
  socket.on(S2C.KILL, (payload: Kill) => {
    gameScene()?.applyKill(payload);
  });

  socket.on(S2C.SNAPSHOT, (snap: Snapshot) => {
    gameScene()?.applySnapshot(snap, performance.now());
  });

  window.setInterval(() => {
    if (socket.connected) {
      socket.emit(C2S.PING, {});
    }
  }, PING_INTERVAL_MS);

  return socket;
}

export const socket = connect();
