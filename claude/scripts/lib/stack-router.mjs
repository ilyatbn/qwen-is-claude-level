/**
 * `scripts/lib/stack-router.mjs`
 *
 * One vite for every standalone check, many game-servers.
 *
 * vite proxies `/socket.io` to ONE port (`VITE_SERVER_PORT`, read once at config
 * time), and the client calls `io()` against its own origin
 * (`net/connection.ts::connect(undefined, …)`), so there is no URL to vary per
 * check without a client change. This router is that one port. Each check's
 * browser context carries a cookie `e2e_server=<port>`; the browser sends it on
 * the polling requests and on the WebSocket upgrade (same origin), vite's proxy
 * passes request headers through, and this forwards to that port.
 *
 * A request with no cookie, or a cookie naming a non-numeric port, gets a 502
 * that says so — a context opened without `stack.newContext` fails loudly
 * rather than being routed to some other check's server.
 */
import { createServer, request } from 'node:http'
import { connect } from 'node:net'

export const ROUTE_COOKIE = 'e2e_server'

/** The port a request's cookie names, or null. */
export function routedPort(headers) {
  const raw = headers.cookie ?? ''
  for (const part of raw.split(';')) {
    const [k, v] = part.trim().split('=')
    if (k === ROUTE_COOKIE && /^\d{1,5}$/.test(v ?? '')) return Number(v)
  }
  return null
}

/**
 * Start the router on `port` (127.0.0.1). Returns `{ close }`.
 * @param {number} port
 */
export async function startRouter(port) {
  /** Both ends of every upgraded connection, so `close` can end them. */
  const spliced = new Set()
  const server = createServer((req, res) => {
    const target = routedPort(req.headers)
    if (!target) {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`stack-router: no ${ROUTE_COOKIE} cookie — open contexts with stack.newContext`)
      return
    }
    const up = request(
      { host: '127.0.0.1', port: target, method: req.method, path: req.url, headers: req.headers },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers)
        upRes.pipe(res)
      },
    )
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`stack-router: :${target} ${e.message}`)
    })
    req.pipe(up)
  })

  // WebSocket: replay the upgrade request to the target and splice the sockets.
  server.on('upgrade', (req, socket, head) => {
    const target = routedPort(req.headers)
    if (!target) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      return
    }
    const up = connect(target, '127.0.0.1', () => {
      spliced.add(socket).add(up)
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
      }
      up.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head?.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    const drop = () => {
      socket.destroy()
      up.destroy()
      spliced.delete(socket)
      spliced.delete(up)
    }
    up.on('error', drop)
    socket.on('error', drop)
    up.on('close', drop)
    socket.on('close', drop)
  })

  await new Promise((res, rej) => {
    server.once('error', rej)
    server.listen(port, '127.0.0.1', res)
  })
  // `server.close()` only stops accepting and then waits for every connection to
  // end — and a keep-alive request or a spliced WebSocket never ends by itself.
  // Found by this module's own test, which passed every assertion and then hung
  // in teardown: the suite's shutdown would have hung the same way.
  return {
    // The bound port, not the argument: `startRouter(0)` asked for any port and
    // returned 0, which would have pointed vite's proxy at nothing.
    port: server.address().port,
    close: () =>
      new Promise((res) => {
        server.close(() => res())
        server.closeAllConnections()
        for (const s of spliced) s.destroy()
        spliced.clear()
      }),
  }
}

/*
 * PLAN for harness.mjs::startStack, env-gated so a check run by hand is unchanged:
 *
 *   E2E_SHARED_VITE_URL   the suite's vite (proxy target = the router)
 *   E2E_SHARED_BROWSER_WS the suite's `chromium.launchServer().wsEndpoint()`
 *
 * - both set: spawn only the game-server (as today, OS port, arm's env); skip
 *   vite; `browser = await chromium.connect(ws)`; `close()` closes this check's
 *   contexts, disconnects (never kills the shared browser), kills its server.
 * - `stack.browser` is a wrapper: `newContext(o)` = real.newContext(o) then
 *   `ctx.addCookies([{ name: ROUTE_COOKIE, value: String(port), url: viteUrl }])`,
 *   so lobby / m10-checkpoint / rematch, which call stack.browser.newContext
 *   directly, are routed without edits. `close()` on the wrapper = disconnect.
 * - unset: today's path, byte for byte.
 *
 * e2e.mjs:
 * - start the router on freePort(); spawn the shared vite with
 *   VITE_SERVER_PORT=<router port>; `chromium.launchServer(sameArgs)` and
 *   `chromium.connect(ws)` for the in-page checks; export both env vars to
 *   standalone children, except checks marked `ownStack: true`.
 * - ownStack (keep their own vite/browser, reason at the entry):
 *   no-dev-surface (serves the built artifact, not the dev server),
 *   lobby-start (its own server/vite/browser, not startStack),
 *   m5-weather (its own vite+browser, no harness), runner-outcome (no browser).
 * - leak guard: the shared browser server and router are the suite's own and
 *   closed before sampling, as vite is today.
 *
 * Measure: fog-visible, toxic-rain-game, fire-visible alone before/after, then
 * the whole suite at the default --jobs.
 */
