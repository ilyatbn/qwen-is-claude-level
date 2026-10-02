/**
 * The intro's live preview (M99, T99.03): `index.html?play=1` plays `renderAt(t)` in real time
 * with the intro's sound (`build/intro.wav`, from `node promo/intro-sound.mjs`) locked to it.
 *
 * A control bar: play/pause, restart, a scrubber with the beats marked, the time. Keys: Space
 * play/pause, R restart, ←/→ one second, , and . one frame, H hides the bar. Without `?play`
 * this does nothing, so the frame-by-frame render is untouched.
 */
import { B, T } from './beats.js'

const params = new URLSearchParams(location.search)
if (params.has('play')) await start()

async function start() {
  while (!window.ready) await new Promise((r) => setTimeout(r, 50))
  const END = T.end
  // A 1920×1080 stage scaled to fit the window, so the caption sits where it does in the film.
  const stage = document.createElement('div')
  stage.style.cssText = 'position:fixed;left:0;top:0;width:1920px;height:1080px;transform-origin:0 0;overflow:hidden'
  document.body.prepend(stage)
  stage.append(document.querySelector('canvas'), document.getElementById('type'))
  document.getElementById('type').style.position = 'absolute'
  const fit = () => {
    const s = Math.min(innerWidth / 1920, innerHeight / 1080)
    stage.style.transform = `translate(${(innerWidth - 1920 * s) / 2}px, ${(innerHeight - 1080 * s) / 2}px) scale(${s})`
  }
  addEventListener('resize', fit)
  fit()

  const css = document.createElement('style')
  css.textContent = `
    #bar { position: fixed; left: 16px; right: 16px; bottom: 14px; padding: 52px 18px 12px; border-radius: 12px;
      background: rgba(8, 10, 20, .78); color: #dfe6ff; font: 13px/1.2 "Ubuntu Sans Mono", "DejaVu Sans Mono", monospace;
      display: grid; grid-template-columns: auto auto 1fr auto; gap: 14px; align-items: center; z-index: 9; user-select: none }
    #bar.hidden { display: none }
    #bar button { background: #26304e; color: #fff; border: 0; border-radius: 6px; padding: 7px 12px; font: inherit; cursor: pointer }
    #bar button:hover { background: #34406a }
    #track { position: relative; height: 22px }
    #track input { position: absolute; inset: 0; width: 100%; margin: 0; accent-color: #5dffb0 }
    .mk { position: absolute; bottom: 22px; transform: translateX(-1px); border-left: 1px solid rgba(160,190,255,.55);
      height: 26px; padding-left: 4px; white-space: nowrap; color: #a9b8e8; font-size: 12px; cursor: pointer }
    .mk.hi { height: 44px }
    .mk:hover { color: #fff }
    #time { min-width: 116px; text-align: right; font-variant-numeric: tabular-nums }
    #hint { position: fixed; right: 20px; top: 14px; color: rgba(255,255,255,.4); font: 12px monospace; z-index: 9 }`
  document.head.append(css)
  const bar = document.createElement('div')
  bar.id = 'bar'
  bar.innerHTML = `<button id="pp">❚❚ pause</button><button id="rs">⟲ restart</button>
    <div id="track"><input id="sc" type="range" min="0" max="${END}" step="0.001" value="0"></div><div id="time"></div>`
  document.body.append(bar)
  const hint = document.createElement('div')
  hint.id = 'hint'
  hint.textContent = 'space play/pause · R restart · ←/→ 1 s · , . one frame · H hide controls'
  document.body.append(hint)
  const track = bar.querySelector('#track')
  for (const [k, [bt, name]] of B.entries()) {
    const m = document.createElement('div')
    m.className = k % 2 ? 'mk hi' : 'mk'
    m.style.left = `${(bt / END) * 100}%`
    m.textContent = `${name} ${bt.toFixed(1)}`
    m.onclick = () => seek(bt)
    track.append(m)
  }
  const sc = bar.querySelector('#sc')
  const pp = bar.querySelector('#pp')
  const time = bar.querySelector('#time')

  // Fetched whole into a blob: the static server does not do Range requests, and a blob seeks.
  const audio = new Audio()
  try {
    const res = await fetch(`/build/intro.wav?v=${Date.now()}`)
    if (res.ok) audio.src = URL.createObjectURL(await res.blob())
  } catch {}
  let t = 0
  let playing = false
  let wall = 0 // performance.now() at which t would have been 0

  const show = () => {
    window.renderAt(t)
    sc.value = String(t)
    time.textContent = `${t.toFixed(2)} / ${END.toFixed(2)}`
    pp.textContent = playing ? '❚❚ pause' : '▶ play'
  }
  function seek(nt) {
    t = Math.max(0, Math.min(END, nt))
    wall = performance.now() - t * 1000
    try { audio.currentTime = t } catch {}
    show()
  }
  function play() {
    if (t >= END - 0.01) t = 0
    playing = true
    wall = performance.now() - t * 1000
    try { audio.currentTime = t } catch {}
    audio.play().catch(() => {})
    show()
  }
  function pause() {
    playing = false
    audio.pause()
    show()
  }
  pp.onclick = () => (playing ? pause() : play())
  bar.querySelector('#rs').onclick = () => { seek(0); play() }
  sc.oninput = () => { if (playing) pause(); seek(Number(sc.value)) }
  addEventListener('keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); playing ? pause() : play() }
    else if (e.key === 'h' || e.key === 'H') { bar.classList.toggle('hidden'); hint.style.display = bar.classList.contains('hidden') ? 'none' : '' }
    else if (e.key === 'r' || e.key === 'R') { seek(0); play() }
    else if (e.key === 'ArrowRight') seek(t + 1)
    else if (e.key === 'ArrowLeft') seek(t - 1)
    else if (e.key === '.') { pause(); seek(t + 1 / 60) }
    else if (e.key === ',') { pause(); seek(t - 1 / 60) }
  })
  const loop = () => {
    if (playing) {
      t = (performance.now() - wall) / 1000
      // Keep the sound locked to the picture: re-seek it if it drifts.
      if (!audio.paused && Math.abs(audio.currentTime - t) > 0.06) audio.currentTime = t
      if (t >= END) { t = END; pause() } else show()
    }
    requestAnimationFrame(loop)
  }
  seek(Number(params.get('t') ?? 0))
  if (params.get('play') !== 'paused') play()
  requestAnimationFrame(loop)
}
