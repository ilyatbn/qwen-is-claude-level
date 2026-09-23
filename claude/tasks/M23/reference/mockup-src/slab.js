// True-3D terrain derived from the same 2D mask: a slab whose front face IS the mask
// (collision contract unchanged), with a rounded rim that recedes to depth -T. The
// camera is fixed and side-on but looks slightly down, so the rim reads as a top surface.
import * as THREE from 'three'
import { W, H } from './world.js'

export function slabDepthAt(sdv, B, T) { const t = Math.max(0, Math.min(1, sdv / B)); return -T * (1 - Math.sin(t * Math.PI / 2)) }
export function sdvForDepth(z, B, T) { return B * Math.asin(Math.max(0, Math.min(1, 1 + z / T))) * 2 / Math.PI }

export function slabTextures(world, { backTint = 1 } = {}) {
  const { solid, back, dIn, dOut, albedo } = world
  const a = new Uint8Array(W * H * 4), b = new Uint8Array(W * H * 4), n = new Uint8Array(W * H * 4)
  const lum = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) lum[i] = (albedo[i * 4] * 0.3 + albedo[i * 4 + 1] * 0.5 + albedo[i * 4 + 2] * 0.2) / 255
  for (let i = 0; i < W * H; i++) {
    const sd = dIn[i] - dOut[i]
    const cov = Math.max(0, Math.min(1, sd + 0.5))
    const solidish = albedo[i * 4 + 3] === 255 || cov > 0
    // bleed colour outward a couple px so the alpha edge never samples black
    a[i * 4] = albedo[i * 4]; a[i * 4 + 1] = albedo[i * 4 + 1]; a[i * 4 + 2] = albedo[i * 4 + 2]
    a[i * 4 + 3] = solid[i] ? 255 : 0
    if (!solid[i] && dOut[i] <= 4) { // dilate: copy the nearest solid texel's colour outward
      const x0 = i % W, y0 = (i / W) | 0; let best = 1e9, bj = -1
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const xx = x0 + dx, yy = y0 + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const j = yy * W + xx; if (solid[j] && dx * dx + dy * dy < best) { best = dx * dx + dy * dy; bj = j } }
      if (bj >= 0) { a[i * 4] = albedo[bj * 4]; a[i * 4 + 1] = albedo[bj * 4 + 1]; a[i * 4 + 2] = albedo[bj * 4 + 2] }
    }
    if (back[i] || solid[i]) { b[i * 4] = albedo[i * 4] * backTint; b[i * 4 + 1] = albedo[i * 4 + 1] * backTint; b[i * 4 + 2] = albedo[i * 4 + 2] * backTint; b[i * 4 + 3] = back[i] ? 255 : 0 }
    const x = i % W, y = (i / W) | 0
    const R = world.relief, hgt = j => lum[j] * 0.25 + R[j] * 3.5
    const gx = (hgt(Math.min(i + 1, W * H - 1)) - hgt(Math.max(i - 1, 0))), gy = (hgt(Math.min(i + W, W * H - 1)) - hgt(Math.max(i - W, 0)))
    const l = Math.hypot(gx, gy, 1)
    n[i * 4] = (-gx / l * 0.5 + 0.5) * 255; n[i * 4 + 1] = (gy / l * 0.5 + 0.5) * 255; n[i * 4 + 2] = (1 / l * 0.5 + 0.5) * 255; n[i * 4 + 3] = 255
  }
  const mk = (data, srgb) => { const t = new THREE.DataTexture(data, W, H); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true; return t }
  return { front: mk(a, true), back: mk(b, true), normal: mk(n, false) }
}

export function slabMesh(world, tex, { step = 2, B = 12, T = 90 } = {}) {
  const { dIn, dOut, solid } = world
  const nx = Math.floor(W / step) + 1, ny = Math.floor(H / step) + 1
  const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2), col = new Float32Array(nx * ny * 3)
  const sdAt = (x, y) => { x = Math.min(W - 1, Math.max(0, Math.round(x))); y = Math.min(H - 1, Math.max(0, Math.round(y))); const i = y * W + x; return dIn[i] - dOut[i] }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = i * step, y = j * step, k = j * nx + i
    const s = sdAt(x, y)
    const ci = Math.min(H - 1, y) * W + Math.min(W - 1, x)
    const inside = Math.max(0, Math.min(1, (s - B) / 6))
    pos[k * 3] = x; pos[k * 3 + 1] = H - y; pos[k * 3 + 2] = slabDepthAt(s, B, T) + world.relief[ci] * 8 * inside
    const dd = Math.max(0, Math.min(1, (dIn[ci] - 12) / 60)); const ao = 1 - 0.45 * dd * dd * (3 - 2 * dd)
    col[k * 3] = ao * 1.02; col[k * 3 + 1] = ao; col[k * 3 + 2] = ao * 0.98
    uv[k * 2] = x / W; uv[k * 2 + 1] = y / H
  }
  const idx = []
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const k = j * nx + i
    // keep cells that touch solid (with a margin so the rim slope exists)
    const cx = i * step + step / 2, cy = j * step + step / 2
    if (sdAt(cx, cy) < -step * 1.5) continue
    idx.push(k, k + nx, k + 1, k + 1, k + nx, k + nx + 1)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); geo.setIndex(idx)
  geo.computeVertexNormals()
  const mat = new THREE.MeshStandardMaterial({ map: tex.front, normalMap: tex.normal, normalScale: new THREE.Vector2(0.8, -0.8), roughness: 0.88, metalness: 0, vertexColors: true, alphaTest: 0.5, alphaToCoverage: true, side: THREE.FrontSide })
  const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true
  return m
}

export function backdropMesh(tex, z) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ map: tex.back, normalMap: tex.normal, roughness: 0.95, alphaTest: 0.5 }))
  // PlaneGeometry uv v=1 at top; our textures have row 0 = mask top at v=0 → flip
  const uv = m.geometry.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i))
  m.position.set(W / 2, H / 2, z); m.receiveShadow = true; return m
}

/** Instanced 3D grass across the receding top rim of up-facing surfaces */
export function grass(world, { B = 12, T = 90, color = [0x5a8a34, 0x9cc850], density = 5, scorch = [] } = {}) {
  const { solid, dIn } = world
  const spots = []
  let s = 1234; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  for (let x = 1; x < W - 1; x++) for (let y = 1; y < H; y++) {
    const i = y * W + x
    if (!solid[i] || solid[i - W]) continue
    // up-facing only
    const gy = dIn[Math.min(i + 3 * W, W * H - 1)] - dIn[i]
    if (gy < 1.2) continue
    if (scorch.some(c => Math.hypot(x - c.x, y - c.y) < c.r)) continue
    for (let k = 0; k < density; k++) spots.push([x + rnd() - 0.5, y, -rnd() * T * 0.97])
  }
  const geo = new THREE.ConeGeometry(0.9, 1, 3); geo.translate(0, 0.5, 0)
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, side: THREE.DoubleSide })
  const im = new THREE.InstancedMesh(geo, mat, spots.length)
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), c0 = new THREE.Color(color[0]), c1 = new THREE.Color(color[1]), c = new THREE.Color()
  spots.forEach(([x, y, z], k) => {
    const yy = y + sdvForDepth(z, B, T)
    const h = 4 + rnd() * rnd() * 14
    e.set((rnd() - 0.5) * 0.5, rnd() * 3, (rnd() - 0.5) * 0.7); q.setFromEuler(e)
    m4.compose(new THREE.Vector3(x, H - yy - 0.5, z), q, new THREE.Vector3(1, h, 1)); im.setMatrixAt(k, m4)
    c.copy(c0).lerp(c1, rnd()); im.setColorAt(k, c)
  })
  im.castShadow = false; im.receiveShadow = true
  return im
}
