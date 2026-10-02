#!/usr/bin/env node
/**
 * Serve the intro's live preview on a fixed port (M99, T99.03) and leave it running:
 *
 *   node promo/intro-sound.mjs                 # build/intro.wav, once
 *   node promo/preview.mjs [port=8737]         # then open http://127.0.0.1:8737/intro/index.html?play=1
 *
 * Open it in a headed, GPU-backed Chrome (GALLIUM_DRIVER=d3d12 --ignore-gpu-blocklist on WSLg).
 */
import { serve } from './serve.mjs'

const port = Number(process.argv[2] ?? 8737)
const { url } = await serve(port)
console.log(`${url}/intro/index.html?play=1`)
