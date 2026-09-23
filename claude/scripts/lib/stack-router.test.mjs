// node --test scripts/lib/stack-router.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { startRouter, routedPort, ROUTE_COOKIE } from './stack-router.mjs'

const listen = (srv) =>
  new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv.address().port)))

/** A backend that names itself on HTTP and on a WebSocket-style upgrade. */
async function backend(name) {
  const srv = createServer((req, res) => {
    res.end(`${name} ${req.method} ${req.url}`)
  })
  // An upgraded socket leaves the HTTP server's bookkeeping, so
  // `closeAllConnections()` does not end it and `close()` waits on it forever —
  // measured: this fixture, not the router, was what hung teardown.
  const upgraded = new Set()
  srv.on('upgrade', (req, socket) => {
    upgraded.add(socket)
    socket.on('close', () => upgraded.delete(socket))
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (b) => socket.write(`${name} echo ${b}`))
  })
  const port = await listen(srv)
  return {
    port,
    close: () =>
      new Promise((r) => {
        srv.close(() => r())
        srv.closeAllConnections()
        for (const s of upgraded) s.destroy()
      }),
  }
}

const a = await backend('A')
const b = await backend('B')
const routerSrv = createServer()
const routerPort = await listen(routerSrv)
await new Promise((r) => routerSrv.close(r))
const router = await startRouter(routerPort)
after(async () => {
  await router.close()
  await a.close()
  await b.close()
})

const get = async (cookie) => {
  const r = await fetch(`http://127.0.0.1:${routerPort}/socket.io/?EIO=4&transport=polling`, {
    headers: cookie ? { cookie } : {},
  })
  return { status: r.status, body: await r.text() }
}

/** Raw upgrade through the router; returns everything read after sending "ping". */
const upgrade = (cookie) =>
  new Promise((res, rej) => {
    const s = connect(routerPort, '127.0.0.1', () => {
      s.write(
        'GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: x\r\n' +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          (cookie ? `Cookie: ${cookie}\r\n` : '') +
          '\r\n',
      )
    })
    let got = ''
    s.on('data', (d) => {
      got += d
      if (got.includes('101') && !got.includes('echo')) s.write('ping')
      if (got.includes('echo') || got.includes('502')) {
        s.destroy()
        res(got)
      }
    })
    s.on('error', rej)
    setTimeout(() => {
      s.destroy()
      res(got)
    }, 2000)
  })

test('the cookie parse takes the named cookie and nothing else', () => {
  assert.equal(routedPort({ cookie: `x=1; ${ROUTE_COOKIE}=4242; y=2` }), 4242)
  assert.equal(routedPort({ cookie: 'x=1' }), null)
  assert.equal(routedPort({ cookie: `${ROUTE_COOKIE}=../etc` }), null)
  assert.equal(routedPort({}), null)
})

test('HTTP goes to the backend the cookie names — and not the other one', async () => {
  const ra = await get(`${ROUTE_COOKIE}=${a.port}`)
  const rb = await get(`other=1; ${ROUTE_COOKIE}=${b.port}`)
  assert.equal(ra.status, 200)
  assert.match(ra.body, /^A GET \/socket\.io\/\?EIO=4/)
  assert.match(rb.body, /^B GET /)
})

test('a request with no cookie is refused loudly, not routed somewhere', async () => {
  const r = await get(null)
  assert.equal(r.status, 502)
  assert.match(r.body, /no e2e_server cookie/)
})

test('a WebSocket upgrade is spliced to the named backend, both directions', async () => {
  const ga = await upgrade(`${ROUTE_COOKIE}=${a.port}`)
  const gb = await upgrade(`${ROUTE_COOKIE}=${b.port}`)
  assert.match(ga, /101 Switching Protocols/)
  assert.match(ga, /A echo ping/)
  assert.match(gb, /B echo ping/)
})

test('an upgrade with no cookie is refused', async () => {
  assert.match(await upgrade(null), /502/)
})
