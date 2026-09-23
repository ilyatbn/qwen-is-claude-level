import { createRequire } from 'module'
import http from 'http'
import fs from 'fs'
import path from 'path'
const require = createRequire('/home/ilya/code/qwen-is-claude-level/claude/client/package.json')
const { chromium } = require('playwright-core')
const ROOT = path.dirname(new URL(import.meta.url).pathname)
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png' }
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]))
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' })
  fs.createReadStream(p).pipe(res)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const variants = process.argv.slice(2)
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  for (const v of variants) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
    page.on('console', m => console.log(`[${v}]`, m.text()))
    page.on('pageerror', e => console.log(`[${v}] PAGEERROR`, e.message))
    const t0 = Date.now()
    const [kind, img, rect] = v.split(':')
    if (kind === 'crop') await page.goto(`http://127.0.0.1:${port}/src/crop.html?img=${img}&r=${rect}`)
    else await page.goto(`http://127.0.0.1:${port}/src/scene.html?v=${v}`)
    await page.waitForFunction('window.__done === true', null, { timeout: 180000 })
    await page.screenshot({ path: path.join(ROOT, 'out', kind === 'crop' ? `crop_${img}.png` : `${v}.png`) })
    console.log(`${v} rendered in ${Date.now() - t0} ms`)
    await page.close()
  }
} finally { await browser.close(); server.close() }
