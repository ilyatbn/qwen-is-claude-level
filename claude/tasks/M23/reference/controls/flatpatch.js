// b12 scratch: client/src/look/actors/flat.ts's flattening, as a prototype patch on CanvasRenderingContext2D —
// so the mockup renders on the owner's D3D12 GPU with the same paths the lab draws there.
const P = CanvasRenderingContext2D.prototype, O = {}, TAU = Math.PI * 2, TOL = 0.05
for (const k of ['beginPath', 'closePath', 'moveTo', 'lineTo', 'rect', 'quadraticCurveTo', 'arc', 'ellipse', 'roundRect', 'stroke']) O[k] = P[k]
const st = new WeakMap(); const S = g => { let s = st.get(g); if (!s) st.set(g, s = { cur: null, start: null, circles: [], other: false }); return s }
function sweep(a0, a1, ccw) { if (!ccw && a1 - a0 >= TAU) return TAU; if (ccw && a0 - a1 >= TAU) return -TAU; let d = (a1 - a0) % TAU; if (!ccw && d < 0) d += TAU; if (ccw && d > 0) d -= TAU; return d }
function segs(a, r) { if (r <= TOL) return 1; return Math.max(1, Math.min(512, Math.ceil(Math.abs(a) / (2 * Math.acos(1 - TOL / r))))) }
const ppu = g => { const m = g.getTransform(); return Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d)) }
P.beginPath = function () { O.beginPath.call(this); Object.assign(S(this), { cur: null, start: null, circles: [], other: false }) }
P.closePath = function () { O.closePath.call(this); const s = S(this); s.cur = s.start }
P.moveTo = function (x, y) { const s = S(this); s.other = true; O.moveTo.call(this, x, y); s.cur = s.start = [x, y] }
P.lineTo = function (x, y) { const s = S(this); if (!s.cur) return this.moveTo(x, y); s.other = true; O.lineTo.call(this, x, y); s.cur = [x, y] }
P.rect = function (x, y, w, h) { const s = S(this); s.other = true; O.rect.call(this, x, y, w, h); s.cur = s.start = [x, y] }
P.quadraticCurveTo = function (cx, cy, x, y) { const s = S(this); if (!s.cur) this.moveTo(cx, cy); s.other = true; O.quadraticCurveTo.call(this, cx, cy, x, y); s.cur = [x, y] }
P.ellipse = function (x, y, rx, ry, rot, a0, a1, ccw = false) { const s = S(this); const sw = sweep(a0, a1, ccw), n = segs(sw, Math.max(rx, ry) * ppu(this)), cr = Math.cos(rot), sr = Math.sin(rot)
  for (let k = 0; k <= n; k++) { const a = a0 + sw * k / n, ex = rx * Math.cos(a), ey = ry * Math.sin(a), px = x + ex * cr - ey * sr, py = y + ex * sr + ey * cr; if (k === 0 && !s.cur) this.moveTo(px, py); else this.lineTo(px, py) } }
P.arc = function (x, y, r, a0, a1, ccw = false) { const s = S(this); if (Math.abs(sweep(a0, a1, ccw)) === TAU && !s.cur) { O.arc.call(this, x, y, r, a0, a1, ccw); s.circles.push([x, y, r, a0, a1, ccw]); s.cur = s.start = [x + r * Math.cos(a1), y + r * Math.sin(a1)]; return } s.other = true; this.ellipse(x, y, r, r, 0, a0, a1, ccw) }
P.roundRect = function (x, y, w, h, r) { const q = Math.PI / 2; this.moveTo(x + r, y); this.lineTo(x + w - r, y); this.ellipse(x + w - r, y + r, r, r, 0, -q, 0); this.lineTo(x + w, y + h - r); this.ellipse(x + w - r, y + h - r, r, r, 0, 0, q); this.lineTo(x + r, y + h); this.ellipse(x + r, y + h - r, r, r, 0, q, 2 * q); this.lineTo(x, y + r); this.ellipse(x + r, y + r, r, r, 0, 2 * q, 3 * q); this.closePath(); this.moveTo(x, y) }
P.stroke = function () { const s = S(this); if (s.circles.length && !s.other) { const cs = s.circles; this.beginPath(); for (const [x, y, r, a0, a1, ccw] of cs) { S(this).cur = null; this.ellipse(x, y, r, r, 0, a0, a1, ccw) } } O.stroke.call(this) }
