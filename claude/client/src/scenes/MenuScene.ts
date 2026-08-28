/**
 * The Start Game menu and lobby (`docs/71-amendments-v3.md` §B3).
 *
 * The screen itself is DOM (§A35: a `scrollFactor(0)` Phaser object is still
 * scaled by camera zoom, so screen-space UI does not belong in the world). The
 * navigation lives in `ui/menu.ts`, which is Phaser-free and tested.
 */
import Phaser from 'phaser'
// The exported, tested one (`results-math.test.ts`). A third copy of an escaper
// is D-49's pattern on a security function, where divergence is a vulnerability
// rather than a wrong number.
import { escapeHtml } from '../ui/results-math'
import {
  DEFAULT_MODEL,
  loadScale,
  menuReducer,
  saveScale,
  type MenuAction,
  type MenuModel,
  stepIndex,
} from '../ui/menu'
import {
  checkCode,
  codeError,
  joinErrorMessage,
  lobbyStatus,
  ownsSettings,
  parseLobbyState,
  rosterRows,
  isRecord,
  type Identity,
  type LobbyStateMsg,
  type Scale,
} from '../net/lobby'
import { Connection, type LobbyIntent, type Welcome } from '../net/connection'

const SCALES: Scale[] = ['small', 'medium', 'large']


export class MenuScene extends Phaser.Scene {
  private model: MenuModel = { ...DEFAULT_MODEL }
  private root: HTMLElement | null = null
  /** The one socket. Owned here from `enterLobby` until `toGame` hands it on. */
  private conn: Connection | null = null
  private lobby: LobbyStateMsg | null = null
  private welcome: Welcome | null = null
  private mySeat: number | undefined = undefined
  private pendingMapInit = ''
  private lastLobbyState: Record<string, unknown> | null = null
  constructor() {
    super('Menu')
  }

  create(): void {
    this.model = { ...DEFAULT_MODEL, scale: loadScale(localStorage) }
    this.buildDom()
    this.render()

    // Esc always goes back one step, from anywhere (§B3).
    this.input.keyboard?.on('keydown-ESC', () => this.dispatch({ type: 'back' }))
    // §E7: the stepper works from the keyboard. Routed by screen rather than
    // bound to the buttons, so it steps the model on the private screen and the
    // live lobby setting in the lobby — the two places a size can change.
    this.input.keyboard?.on('keydown-LEFT', () => this.stepEither(-1))
    this.input.keyboard?.on('keydown-RIGHT', () => this.stepEither(1))

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.root?.remove()
      this.root = null
      // Whatever is still ours is closed. `toGame` clears `conn` first, so
      // handing the socket over does not close it on the way out.
      this.conn?.close()
      this.conn = null
    })
    this.exposeDebugHandle()
  }

  /**
   * Open the socket **here** and sit in the lobby with it (§E1/§E6).
   *
   * This used to hand an intent to `GameScene` and start it in the same frame,
   * so the `matching` and `lobby` screens below were built and torn down before
   * they ever rendered — the lobby a player actually saw was a DOM panel in
   * `GameScene`, drawn on top of a world they were already standing in. That is
   * the defect this task exists to fix.
   *
   * The old doc here warned that "two sockets mean two seats, and a `join` after
   * a `quick_match` is a double join". Still true, and still respected: there is
   * exactly one socket and it is **handed over** rather than reopened.
   * `GameScene` adopts this `Connection` instead of constructing its own, and
   * `map_init` is what moves the player across.
   */
  private enterLobby(intent: Record<string, unknown>): void {
    const id = this.identity()
    const conn = new Connection()
    this.conn = conn

    // Buffered, not dropped. `map_init` arrives while this scene owns the
    // socket, and `GameScene` registers its handler after it starts — so
    // without holding the payload the first map would be lost and the client
    // would sit in a lobby whose match had begun.
    conn.on('map_init', (p) => {
      this.pendingMapInit = typeof p === 'string' ? p : ''
      this.toGame()
    })
    conn.on('lobby_state', (raw) => {
      if (isRecord(raw)) {
        this.lobby = parseLobbyState(raw)
        // Kept raw for the handover: `GameScene` seeds its scoreboard from this
        // message (§E6, since `welcome` stopped carrying a roster), and by the
        // time that scene exists the lobby is over and no more will arrive.
        // Without replaying the last one every player renders as `p1`.
        this.lastLobbyState = raw
        this.render()
      }
    })
    // §E6: the refusal `join_error` cannot carry, because that handler is
    // registered during the connect handshake and drops anything arriving after
    // it settles — which is every possible `set_scale`. Until now nothing on the
    // client listened for this at all, so a refused change was silently ignored.
    conn.on('lobby_error', (raw) => {
      const reason = isRecord(raw) && typeof raw['reason'] === 'string' ? raw['reason'] : 'refused'
      this.dispatch({ type: 'error', message: joinErrorMessage(reason) })
    })

    conn
      .connect(undefined, id.name, id.skinId, {
        ...intent,
        tombstoneSkinId: id.tombstoneSkinId,
      } as unknown as LobbyIntent)
      .then((w) => {
        this.welcome = w
        this.mySeat = w.playerId
        this.dispatch({ type: 'go', screen: 'lobby' })
      })
      .catch((e) => {
        this.conn = null
        conn.close()
        this.dispatch({ type: 'error', message: String(e) })
      })
  }

  /** Hand the live socket to `GameScene` and replay the map it already has. */
  private toGame(): void {
    const conn = this.conn
    if (!conn) return
    // Cleared first: `SHUTDOWN` closes whatever this scene still owns, and the
    // connection is `GameScene`'s from here.
    this.conn = null
    this.registry.set('liveConn', conn)
    this.registry.set('liveWelcome', this.welcome)
    this.registry.set('pendingMapInit', this.pendingMapInit)
    this.registry.set('pendingLobbyState', this.lastLobbyState)
    this.scene.start('Game')
  }

  /**
   * Leave the lobby, and mean it.
   *
   * `leave_room` **and** closing the socket. Telling the server and keeping the
   * connection open would leave a seat the player has left; closing without
   * telling it relies on a disconnect the server notices some milliseconds
   * later. A lobby you have left must not still count you.
   */
  private leaveLobby(): void {
    const conn = this.conn
    if (!conn) return
    conn.sendRaw('leave_room', {})
    conn.close()
    this.conn = null
    this.lobby = null
    this.welcome = null
    this.mySeat = undefined
  }


  private identity(): Identity {
    return {
      name: localStorage.getItem('deepcut.name') || 'Player',
      skinId: Number(localStorage.getItem('deepcut.skin') ?? 0),
      tombstoneSkinId: Number(localStorage.getItem('deepcut.stone') ?? 0),
    }
  }

  private dispatch(a: MenuAction): void {
    this.model = menuReducer(this.model, a)
    if (a.type === 'setScale') saveScale(localStorage, this.model.scale)
    this.render()
  }

  private buildDom(): void {
    const el = document.createElement('div')
    el.className = 'menu-screen'
    document.body.appendChild(el)
    this.root = el
  }

  private render(): void {
    const el = this.root
    if (!el) return
    const m = this.model
    // Escaped like the other three interpolations: `m.error` carries
    // `joinErrorMessage`, whose default branch echoes a server-supplied reason.
    // Every reason is a fixed literal today, so this is not exploitable — it is
    // the one interpolation here carrying network-derived text, and it goes live
    // the first time a reason echoes anything a player typed.
    const err = m.error ? `<p class="error" role="alert">${escapeHtml(m.error)}</p>` : ''

    if (m.screen === 'menu') {
      // §E7. Quick Game takes no options — quick match **randomises** its
      // settings, so showing a stepper here would be a control that silently
      // does nothing. Map size belongs to the private lobby, where a host can
      // actually change it, and that stepper is the one in `stepScale`.
      el.innerHTML = `
        <div class="actions">
          <button id="quick" autofocus>Quick Game</button>
          <button id="private">Private Game</button>
          <button id="skins">Skins</button>
        </div>
        ${err}`
      el.querySelector('#quick')?.addEventListener('click', () => this.quickMatch())
      el.querySelector('#private')?.addEventListener('click', () =>
        this.dispatch({ type: 'go', screen: 'private' }),
      )
      el.querySelector('#skins')?.addEventListener('click', () => this.scene.start('Skins'))
      return
    }

    if (m.screen === 'private') {
      // Host or join — the two things a private game can be (§E7). Hosting
      // carries the map size, because the host owns the settings (§E3), and it
      // is the same stepper the lobby shows: one control, built once.
      el.innerHTML = `
        <h2>Private game</h2>
        <div class="settings-row">
          <span class="setting-name">Map size</span>
          <button id="scale-prev" aria-label="Smaller map">‹</button>
          <span class="setting-value" id="scale-value">${m.scale.toUpperCase()}</span>
          <button id="scale-next" aria-label="Larger map">›</button>
        </div>
        <div class="actions">
          <button id="host">Host</button>
          <button id="join">Join</button>
          <button id="back">Back</button>
        </div>
        ${err}`
      el.querySelector('#scale-prev')?.addEventListener('click', () => this.stepMenuScale(-1))
      el.querySelector('#scale-next')?.addEventListener('click', () => this.stepMenuScale(1))
      el.querySelector('#host')?.addEventListener('click', () => this.createRoom())
      el.querySelector('#join')?.addEventListener('click', () =>
        this.dispatch({ type: 'go', screen: 'join' }),
      )
      el.querySelector('#back')?.addEventListener('click', () => this.dispatch({ type: 'back' }))
      return
    }

    if (m.screen === 'join') {
      el.innerHTML = `
        <h2>Join private game</h2>
        <p class="hint">Six characters. Codes never contain I, O, 0 or 1.</p>
        <input id="code" maxlength="6" autocomplete="off" spellcheck="false"
               value="${m.code}" aria-label="Game code" autofocus>
        <div class="actions">
          <button id="go">Join</button>
          <button id="back">Back</button>
        </div>
        ${err}`
      const input = el.querySelector<HTMLInputElement>('#code')
      input?.addEventListener('input', () => {
        // Normalise as they type, so the field never shows something the server
        // would reject for a reason the player cannot see.
        const before = input.selectionStart
        this.model = menuReducer(this.model, { type: 'typeCode', code: input.value })
        input.value = this.model.code
        input.setSelectionRange(before, before)
      })
      input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.joinByCode()
      })
      el.querySelector('#go')?.addEventListener('click', () => this.joinByCode())
      el.querySelector('#back')?.addEventListener('click', () =>
        this.dispatch({ type: 'back' }),
      )
      input?.focus()
      return
    }

    if (m.screen === 'matching') {
      el.innerHTML = `<h2>Finding a game…</h2><div class="actions"><button id="back">Back</button></div>${err}`
      el.querySelector('#back')?.addEventListener('click', () => this.dispatch({ type: 'back' }))
      return
    }

    if (m.screen === 'lobby') {
      const L = this.lobby
      if (!L) {
        el.innerHTML = `<h2>Joining…</h2><div class="actions"><button id="back">Leave</button></div>${err}`
        el.querySelector('#back')?.addEventListener('click', () => this.dispatch({ type: 'back' }))
        return
      }

      const rows = rosterRows(L, this.mySeat)
        .map((r) => {
          const cls = ['seat', r.ready ? 'ready' : '', r.you ? 'you' : '', r.bot ? 'bot' : '']
            .filter(Boolean)
            .join(' ')
          const tick = r.seat >= 0 && r.ready ? ' ✓' : ''
          return `<li class="${cls}">${escapeHtml(r.label)}${tick}</li>`
        })
        .join('')

      const code = L.code
        ? `<p class="code-label">Game code</p><p class="code" id="host-code">${escapeHtml(L.code)}</p>
           <button id="copy">Copy</button>`
        : ''

      // Only the owner may touch it (§E3), and the wire says who that is by
      // seat id — which is why the field is a seat id rather than a bool.
      const owner = ownsSettings(L, this.mySeat)
      const stepper = L.private
        ? `<div class="settings-row">
             <span class="setting-name">Map size</span>
             <button id="scale-prev" ${owner ? '' : 'disabled'}>‹</button>
             <span class="setting-value" id="scale-value">${L.scale.toUpperCase()}</span>
             <button id="scale-next" ${owner ? '' : 'disabled'}>›</button>
           </div>`
        : ''

      const me = L.players.find((p) => p.seat === this.mySeat)
      const ready = L.private
        ? `<button id="ready" class="${me?.ready ? 'on' : ''}">${
            me?.ready ? 'Not ready' : 'Ready'
          }</button>`
        : ''

      el.innerHTML = `
        <h2>${L.private ? 'Private game' : 'Quick game'}</h2>
        ${code}
        <ul class="roster" id="roster">${rows}</ul>
        <p class="status" id="lobby-status">${escapeHtml(lobbyStatus(L))}</p>
        ${stepper}
        <div class="actions">${ready}<button id="back">Leave</button></div>
        ${err}`

      el.querySelector('#copy')?.addEventListener('click', () => {
        void navigator.clipboard?.writeText(L.code ?? '')
      })
      el.querySelector('#ready')?.addEventListener('click', () => {
        this.conn?.sendReady(!me?.ready)
      })
      el.querySelector('#scale-prev')?.addEventListener('click', () => this.stepScale(-1))
      el.querySelector('#scale-next')?.addEventListener('click', () => this.stepScale(1))
      el.querySelector('#back')?.addEventListener('click', () => {
        this.leaveLobby()
        this.dispatch({ type: 'back' })
      })
    }
  }

  /** Whichever stepper the current screen owns. */
  private stepEither(delta: number): void {
    if (this.model.screen === 'private') this.stepMenuScale(delta)
    else if (this.model.screen === 'lobby') this.stepScale(delta)
  }

  /**
   * The menu's own stepper, before a lobby exists.
   *
   * Same wrap, same order, same `SCALES` as `stepScale` — the difference is only
   * where the answer goes: here into the model that `createRoom` will send, and
   * there over the wire to a room that already exists. Both call `stepIndex` so
   * "what is the next size" has one answer.
   */
  private stepMenuScale(delta: number): void {
    const next = SCALES[stepIndex(SCALES.indexOf(this.model.scale), delta, SCALES.length)]
    if (next) this.dispatch({ type: 'setScale', scale: next })
  }

  /**
   * Move the map size one step, wrapping.
   *
   * The same stepper T17.08 puts on the main menu — built once, here, because a
   * second copy would be a second answer to "what is the next size".
   */
  private stepScale(delta: number): void {
    const L = this.lobby
    if (!L || !ownsSettings(L, this.mySeat)) return
    const next = SCALES[stepIndex(SCALES.indexOf(L.scale), delta, SCALES.length)]
    if (next) this.conn?.sendSetScale(next)
  }

  private quickMatch(): void {
    this.dispatch({ type: 'go', screen: 'matching' })
    this.enterLobby({ kind: 'quick', scale: this.model.scale })
  }

  private createRoom(): void {
    this.dispatch({ type: 'go', screen: 'create' })
    this.enterLobby({ kind: 'create', scale: this.model.scale })
  }

  private joinByCode(): void {
    const c = checkCode(this.model.code)
    if (!c.ok) {
      // Named locally rather than round-tripping to the server: the player is
      // told which character is wrong, immediately.
      this.dispatch({ type: 'error', message: codeError(c) })
      return
    }
    this.enterLobby({ kind: 'code', code: c.code })
  }

  private exposeDebugHandle(): void {
    const self = this
    ;(window as unknown as { __menu: unknown }).__menu = {
      debug: () => ({ ...self.model }),
      dispatch: (a: MenuAction) => self.dispatch(a),
      /**
       * The code as the player can actually see it, read from the DOM.
       *
       * **The real one since T17.07.** `GameScene` had a twin reading a banner
       * it no longer draws; this is now the only surface a host sees a code on.
       */
      visibleCode: () =>
        self.root?.querySelector('#host-code')?.textContent?.trim() ?? '',
      /** The roster as rendered, for a check that asserts who is on screen. */
      roster: () =>
        [...(self.root?.querySelectorAll('#roster li') ?? [])].map(
          (li) => li.textContent?.trim() ?? '',
        ),
      /** Start now with bots — the manual form of §E2's timeout. */
      startWithBots: () => self.conn?.sendRaw('start_with_bots', {}),
      /** Ready, for a check driving the §E3 gate. */
      ready: (on: boolean) => self.conn?.sendReady(on),
    }
  }
}
