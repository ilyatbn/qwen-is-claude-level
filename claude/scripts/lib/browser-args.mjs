/**
 * The Chromium every browser check runs, launched one way.
 *
 * `e2e.mjs` and `harness.mjs::startStack` each carried this list inline. Once
 * standalone checks share the suite's browser, a check run by hand and the same
 * check run in the suite must still get the same browser — so there is one list.
 */
import { join } from 'node:path'

/** Where the hand-extracted chromium libs live on this box. */
export const libDir = join(process.env.HOME ?? '', '.cache/pwlibs/root/usr/lib/x86_64-linux-gnu')

/** The browser binary playwright-core drives. */
export const chromePath = join(
  process.env.HOME ?? '',
  '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
)

export const BROWSER_ARGS = [
  '--no-sandbox',
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
  // The client steps its fixed timestep off `requestAnimationFrame`, and
  // Chromium throttles rAF in any page that is not the foreground one — to
  // roughly one frame a second, or none at all. With several contexts open only
  // one is foreground, so every other client barely simulates. This was the
  // whole of `two-clients`' long-running "fails under load" mystery: the box was
  // never the problem, backgrounding was (see `harness.mjs::startStack`).
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

/** `chromium.launch` / `chromium.launchServer` options for this box. */
export const launchOptions = () => ({
  executablePath: chromePath,
  env: { ...process.env, LD_LIBRARY_PATH: libDir },
  args: BROWSER_ARGS,
})
