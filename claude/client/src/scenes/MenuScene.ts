/**
 * The Start Game menu and lobby (`docs/71-amendments-v3.md` §B3).
 *
 * The screen itself is DOM (§A35: a `scrollFactor(0)` Phaser object is still
 * scaled by camera zoom, so screen-space UI does not belong in the world). The
 * navigation lives in `ui/menu.ts`, which is Phaser-free and tested.
 */
import Phaser from 'phaser'
import {
  DEFAULT_MODEL,
  describeRoom,
  loadScale,
  menuReducer,
  saveScale,
  scaleBlurb,
  type MenuAction,
  type MenuModel,
} from '../ui/menu'
import {
  checkCode,
  codeError,
  createRoomPayload,
  joinErrorMessage,
  joinRoomPayload,
  quickMatchPayload,
  type Identity,
  type Scale,
} from '../net/lobby'

const SCALES: Scale[] = ['small', 'medium', 'large']

export class MenuScene extends Phaser.Scene {
  private model: MenuModel = { ...DEFAULT_MODEL }
  private root: HTMLElement | null = null
  private socket: {
    emit(ev: string, payload?: unknown): void
    on(ev: string, cb: (p: unknown) => void): void
  } | null = null

  constructor() {
    super('Menu')
  }

  create(): void {
    this.model = { ...DEFAULT_MODEL, scale: loadScale(localStorage) }
    this.buildDom()
    this.render()

    // Esc always goes back one step, from anywhere (§B3).
    this.input.keyboard?.on('keydown-ESC', () => this.dispatch({ type: 'back' }))

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.root?.remove()
      this.root = null
    })
    this.exposeDebugHandle()
  }

  /** Injected by the app so the menu is testable without a live socket. */
  setSocket(s: NonNullable<MenuScene['socket']>): void {
    this.socket = s
    s.on('room_created', (p) => {
      const code = (p as { code?: string }).code
      this.dispatch(code ? { type: 'hosted', code } : { type: 'go', screen: 'lobby' })
    })
    s.on('room_list', (p) => {
      const r = p as { players?: number; capacity?: number; bots?: number }
      this.roomInfo = describeRoom(r.players ?? 0, r.capacity ?? 6, r.bots ?? 0)
      this.dispatch({ type: 'go', screen: 'lobby' })
    })
    s.on('join_error', (p) => {
      const reason = (p as { reason?: string }).reason ?? 'unknown'
      this.dispatch({ type: 'error', message: joinErrorMessage(reason) })
    })
    s.on('welcome', () => this.scene.start('Game'))
  }

  private roomInfo = ''

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
    const err = m.error ? `<p class="error" role="alert">${m.error}</p>` : ''

    if (m.screen === 'menu') {
      el.innerHTML = `
        <h2>Start Game</h2>
        <fieldset class="scales">
          <legend>Map size</legend>
          ${SCALES.map(
            (s) =>
              `<button data-scale="${s}" class="${m.scale === s ? 'on' : ''}">${scaleBlurb(s)}</button>`,
          ).join('')}
        </fieldset>
        <div class="actions">
          <button id="quick">Quick match</button>
          <button id="create">Create private game</button>
          <button id="join">Join private game</button>
          <button id="skins">Skins</button>
        </div>
        ${err}`
      for (const s of SCALES) {
        el.querySelector(`[data-scale="${s}"]`)?.addEventListener('click', () =>
          this.dispatch({ type: 'setScale', scale: s }),
        )
      }
      el.querySelector('#quick')?.addEventListener('click', () => this.quickMatch())
      el.querySelector('#create')?.addEventListener('click', () => this.createRoom())
      el.querySelector('#join')?.addEventListener('click', () =>
        this.dispatch({ type: 'go', screen: 'join' }),
      )
      el.querySelector('#skins')?.addEventListener('click', () => this.scene.start('Skins'))
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
      const code = m.hostCode
        ? `<p class="code-label">Game code</p><p class="code" id="host-code">${m.hostCode}</p>
           <button id="copy">Copy</button>`
        : ''
      el.innerHTML = `
        <h2>Waiting to start</h2>
        ${code}
        <p class="room-info">${this.roomInfo}</p>
        <div class="actions"><button id="back">Leave</button></div>
        ${err}`
      el.querySelector('#copy')?.addEventListener('click', () => {
        void navigator.clipboard?.writeText(m.hostCode ?? '')
      })
      el.querySelector('#back')?.addEventListener('click', () => {
        this.socket?.emit('leave_room')
        this.dispatch({ type: 'back' })
      })
    }
  }

  private quickMatch(): void {
    this.dispatch({ type: 'go', screen: 'matching' })
    this.socket?.emit('quick_match', quickMatchPayload(this.identity(), this.model.scale))
  }

  private createRoom(): void {
    this.dispatch({ type: 'go', screen: 'create' })
    this.socket?.emit(
      'create_room',
      createRoomPayload(this.identity(), this.model.scale, true),
    )
  }

  private joinByCode(): void {
    const c = checkCode(this.model.code)
    if (!c.ok) {
      // Named locally rather than round-tripping to the server: the player gets
      // told which character is wrong, immediately.
      this.dispatch({ type: 'error', message: codeError(c) })
      return
    }
    this.socket?.emit('join_room', joinRoomPayload(this.identity(), c.code))
  }

  private exposeDebugHandle(): void {
    const self = this
    ;(window as unknown as { __menu: unknown }).__menu = {
      debug: () => ({ ...self.model, roomInfo: self.roomInfo }),
      dispatch: (a: MenuAction) => self.dispatch(a),
      /** The code as the player can actually see it, read from the DOM. */
      visibleCode: () =>
        self.root?.querySelector('#host-code')?.textContent?.trim() ?? '',
    }
  }
}
