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
  type Screen,
  stepIndex,
} from '../ui/menu'
import {
  checkCode,
  codeError,
  lobbyErrorMessage,
  lobbyStatus,
  parseLobbyState,
  rosterRows,
  isRecord,
  settingsControls,
  stepSetting,
  SCALES,
  type Identity,
  type LobbyStateMsg,
  type Scale,
  type SettingId,
  type StartKit,
  type TimerBounds,
} from '../net/lobby'
import { Connection, type LobbyIntent, type Welcome } from '../net/connection'
import { MAX_NAME, loadIdentity, nameOrNull, saveName, storedName } from '../ui/skins'
import { devSurface } from '../dev'
import { C } from '../core'


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
  /**
   * The join the nickname prompt interrupted, and the screen it came from.
   *
   * On the scene rather than in `MenuModel`, because `MenuModel` is the
   * Phaser-free half and a `LobbyIntent` is a wire payload. The screen is kept
   * with it so resuming does not have to know *which* verb was pressed —
   * `enterLobby` is one gate for all three, and reconstructing "was that quick
   * or create" would be a second copy of that knowledge.
   */
  private pendingEntry: { intent: Record<string, unknown>; screen: Screen } | null = null
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
    // §C17, same guard `GameScene` carries. This was unguarded from T17.07:
    // `__menu` shipped in the production bundle exposing `debug`, `dispatch`,
    // `ready`, `visibleCode` and `roster` — and `dispatch` drives menu actions.
    // Not an escalation, since the user owns their own client, but it is exactly
    // what T14.08 exists to stop.
    if (devSurface() && new URLSearchParams(location.search).get('e2e') === '1') {
      this.exposeDebugHandle()
    }
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
    // **The prompt stands here, once, in front of all three verbs** (T20.02).
    // `quickMatch`, `createRoom` and `joinByCode` all converge on this function,
    // so a gate in each of them would be three copies of one rule and the fourth
    // entry point would forget it.
    //
    // Asked only when nothing is stored: `storedName` is the same strip
    // `cleanName` uses, so the prompt cannot appear for a name the game would
    // have accepted, and cannot fail to appear for one it would have replaced
    // with `Player`.
    if (storedName(localStorage) === null) {
      this.pendingEntry = { intent, screen: this.model.screen }
      this.dispatch({ type: 'go', screen: 'name' })
      return
    }
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
      // **`lobbyErrorMessage`, not `joinErrorMessage`.** A refusal to move a
      // setting is not a refusal to join, and routing it through the join table
      // put the wire's sentence inside "Could not join (…)" — a host being told
      // they could not join the lobby they were sitting in (T20.01).
      this.dispatch({ type: 'error', message: lobbyErrorMessage(reason) })
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


  /**
   * Who this browser says it is, on all four lobby verbs.
   *
   * **One reader.** This used to spell the three `deepcut.*` keys out again and
   * read them raw, which meant a stored `"  "` reached the wire as a name the
   * server refuses and a stored `"banana"` reached it as `Number("banana")` —
   * `NaN`, which `JSON.stringify` sends as `null` and which this client then
   * hands to its own atlas. `loadIdentity` is `loadChoice` without the count the
   * menu has no atlas to supply; see its comment for why unbounded is the right
   * shape here rather than a second inline read.
   */
  private identity(): Identity {
    return loadIdentity(localStorage)
  }

  private dispatch(a: MenuAction): void {
    this.model = menuReducer(this.model, a)
    if (a.type === 'setScale') saveScale(localStorage, this.model.scale)
    // Leaving the prompt by any route — the button, `Esc`, or a navigation from
    // elsewhere — abandons the join it was standing in front of. Cleared here
    // rather than on the Back button, because `Esc` does not go through it.
    if (this.model.screen !== 'name') this.pendingEntry = null
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
    // `lobbyErrorMessage`, which passes a server-supplied sentence through, and
    // `joinErrorMessage` (via `reduce`), whose default branch echoes a reason.
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

    if (m.screen === 'name') {
      // §T20.02: asked once, on the first join or host, and never again.
      //
      // `escapeHtml` on an attribute value, not only on text: a stored name goes
      // straight back into `value="…"`, and `cleanName` strips `<>` and **not**
      // quotes — so without this a name containing `"` breaks out of the
      // attribute. The same interpolation exists in `SkinsScene`.
      const current = storedName(localStorage) ?? ''
      el.innerHTML = `
        <h2>Pick a nickname</h2>
        <p class="hint">Up to ${MAX_NAME} characters. You will only be asked once.</p>
        <input id="nickname" maxlength="${MAX_NAME}" autocomplete="off" spellcheck="false"
               value="${escapeHtml(current)}" aria-label="Nickname" autofocus>
        <div class="actions">
          <button id="go-name">Continue</button>
          <button id="back">Back</button>
        </div>
        ${err}`
      const input = el.querySelector<HTMLInputElement>('#nickname')
      const submit = (): void => {
        const typed = input?.value ?? ''
        // Refused locally rather than stored and then bounced by the server's
        // `bad_name`: an empty box is a question the player can still answer,
        // and `cleanName` would have quietly turned it into `Player`.
        if (nameOrNull(typed) === null) {
          this.dispatch({ type: 'error', message: 'Pick a nickname with at least one character.' })
          return
        }
        this.confirmName(typed)
      }
      input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit()
      })
      el.querySelector('#go-name')?.addEventListener('click', () => submit())
      el.querySelector('#back')?.addEventListener('click', () => this.dispatch({ type: 'back' }))
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
          const cls = [
            'seat',
            r.ready ? 'ready' : '',
            r.you ? 'you' : '',
            r.bot ? 'bot' : '',
            r.host ? 'host' : '',
          ]
            .filter(Boolean)
            .join(' ')
          const tick = r.seat >= 0 && r.ready ? ' ✓' : ''
          // **In the text, not only in the class.** A promoted player otherwise
          // gets working arrows and no idea why, and the demoted one gets dead
          // arrows with no explanation (T20.03). It is also what makes the
          // marker assertable: `__menu.roster()` reads `textContent`, so a
          // CSS-only crown would be invisible to the browser check that has to
          // prove it moved.
          const host = r.host ? ' (host)' : ''
          return `<li class="${cls}">${escapeHtml(r.label)}${host}${tick}</li>`
        })
        .join('')

      const code = L.code
        ? `<p class="code-label">Game code</p><p class="code" id="host-code">${escapeHtml(L.code)}</p>
           <button id="copy">Copy</button>`
        : ''

      // Only the owner may touch it (§E3), and the wire says who that is by
      // seat id — which is why the field is a seat id rather than a bool.
      // §F7: **a public lobby shows no panel at all.** Not a disabled one —
      // every control on it would be refused by the server, and a row a player
      // can see and never move is worse than no row.
      const controls = L.private ? settingsControls(L, this.mySeat, this.timerBounds()) : []
      const stepper = controls
        .map(
          (c) => `<div class="settings-row">
             <span class="setting-name">${escapeHtml(c.name)}</span>
             <button id="${c.id}-prev" ${c.prevDisabled ? 'disabled' : ''}>‹</button>
             <span class="setting-value" id="${c.id}-value">${escapeHtml(c.value)}</span>
             <button id="${c.id}-next" ${c.nextDisabled ? 'disabled' : ''}>›</button>
           </div>`,
        )
        .join('')

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
      for (const c of controls) {
        el.querySelector(`#${c.id}-prev`)?.addEventListener('click', () => this.step(c.id, -1))
        el.querySelector(`#${c.id}-next`)?.addEventListener('click', () => this.step(c.id, 1))
      }
      el.querySelector('#back')?.addEventListener('click', () => {
        this.leaveLobby()
        this.dispatch({ type: 'back' })
      })
    }
  }

  /** Whichever stepper the current screen owns. */
  private stepEither(delta: number): void {
    if (this.model.screen === 'private') this.stepMenuScale(delta)
    else if (this.model.screen === 'lobby') this.step('scale', delta)
  }

  /**
   * §F7's bounds, from `game-core` (§A19).
   *
   * `Core.init()` runs before any scene (`main.ts`), so these are available the
   * moment a lobby can exist. A panel carrying its own 240/600/60 would keep
   * offering the old range after any of them was tuned.
   */
  private timerBounds(): TimerBounds {
    const c = C()
    return { min: c.ROUND_SECONDS_MIN, max: c.ROUND_SECONDS_MAX, step: c.ROUND_SECONDS_STEP }
  }

  /**
   * The menu's own stepper, before a lobby exists.
   *
   * Same wrap, same order, same `SCALES` as the lobby's `scale` row — the
   * difference is only where the answer goes: here into the model that
   * `createRoom` will send, and there over the wire to a room that already
   * exists. Both go through `stepIndex` so "what is the next size" has one
   * answer, and both read the one `SCALES` in `net/lobby` — this file used to
   * declare a second copy of that list.
   */
  private stepMenuScale(delta: number): void {
    const next = SCALES[stepIndex(SCALES.indexOf(this.model.scale), delta, SCALES.length)]
    if (next) this.dispatch({ type: 'setScale', scale: next })
  }

  /**
   * Move one setting one step, over the wire.
   *
   * **Nothing is applied locally.** The room answers with `lobby_state` and the
   * panel redraws from that, so a guest sees the host's change and a refusal
   * leaves the screen showing what the room actually holds. The Notes are
   * explicit that these do not come from `localStorage` the way the main
   * menu's map size does: a stale local timer overriding a lobby the player
   * just joined is the bug that avoids.
   *
   * `stepSetting` owns both the host gate and the timer's bounds, and
   * `settingsControls` disables exactly what it refuses — so a disabled arrow
   * and a refused step cannot disagree.
   */
  private step(id: SettingId, delta: number): void {
    const L = this.lobby
    if (!L) return
    const next = stepSetting(L, this.mySeat, id, delta, this.timerBounds())
    if (next === undefined) return
    switch (id) {
      case 'scale':
        this.conn?.sendSetScale(next as Scale)
        break
      case 'bots':
        this.conn?.sendSetBots(next as boolean)
        break
      case 'kit':
        this.conn?.sendSetStartKit(next as StartKit)
        break
      case 'timer':
        this.conn?.sendSetRoundSeconds(next as number)
        break
    }
  }

  private quickMatch(): void {
    this.dispatch({ type: 'go', screen: 'matching' })
    this.enterLobby({ kind: 'quick', scale: this.model.scale })
  }

  private createRoom(): void {
    this.dispatch({ type: 'go', screen: 'create' })
    this.enterLobby({ kind: 'create', scale: this.model.scale })
  }

  /**
   * Take the name and resume the join it interrupted.
   *
   * The screen is restored first so the player lands where they would have been
   * — `matching` for a quick game, `create` for a host — rather than watching the
   * prompt until `welcome` arrives.
   */
  private confirmName(raw: string): void {
    const p = this.pendingEntry
    saveName(localStorage, raw)
    this.pendingEntry = null
    if (!p) {
      this.dispatch({ type: 'back' })
      return
    }
    this.dispatch({ type: 'go', screen: p.screen })
    this.enterLobby(p.intent)
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
    // **Guarded again here, and not redundantly.** A class method is reachable
    // from the prototype, so the bundler keeps it however the call site is
    // guarded; what it does delete is a block behind a `false` literal, and
    // that is what takes the word `__menu` out of the artifact — which is
    // what `no-dev-surface` greps for.
    // T17.07 shipped `__menu` the same way, exposing `dispatch`, which drives menu
    // actions. One fix covers both tasks.
    if (!devSurface()) return
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
      /**
       * §F7's panel **as rendered**, value and arrow state, read from the DOM.
       *
       * Deliberately not from `this.model`: `debug()` returns the local
       * `MenuModel`, which has never held any of these — for a guest it holds
       * nothing at all — so a check reading settings from it would be
       * meaningless on exactly the half that matters. This reads what a player
       * can see, the way `visibleCode` and `roster` do.
       *
       * An empty object means no panel, which is the answer a public lobby
       * must give.
       */
      settings: () => {
        const out: Record<string, { value: string; prevDisabled: boolean; nextDisabled: boolean }> =
          {}
        for (const id of ['scale', 'bots', 'kit', 'timer'] as const) {
          const value = self.root?.querySelector(`#${id}-value`)
          if (!value) continue
          out[id] = {
            value: value.textContent?.trim() ?? '',
            prevDisabled: !!self.root?.querySelector(`#${id}-prev`)?.hasAttribute('disabled'),
            nextDisabled: !!self.root?.querySelector(`#${id}-next`)?.hasAttribute('disabled'),
          }
        }
        return out
      },
      /** Press one of the panel's arrows, as a click would. */
      step: (id: SettingId, delta: number) => self.step(id, delta),
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
