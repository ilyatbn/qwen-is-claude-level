/**
 * A static server for the trailer's pages (M99): `promo/` at the root, three.js from the
 * client's node_modules at `/three/`, and the game's display face at `/fonts/`. ES modules will
 * not load over file://, so the intro and the cards are served.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { promoDir, root } from './lib.mjs'

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.json': 'application/json',
}
const MOUNTS = [
  ['/three/', join(root, 'client/node_modules/three')],
  ['/fonts/', join(root, 'assets/fonts')],
  ['/', promoDir],
]

export function serve(port = 0) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    for (const [prefix, dir] of MOUNTS) {
      if (!path.startsWith(prefix)) continue
      const file = normalize(join(dir, path.slice(prefix.length)))
      if (!file.startsWith(dir)) break
      try {
        const body = await readFile(file)
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
        res.end(body)
        return
      } catch {
        break
      }
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}` })))
}
