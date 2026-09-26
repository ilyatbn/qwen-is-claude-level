// T23.04 control: the scene's background (e_style.js::bgQuad) alone, through the post chain the
// game's world renderer has today — half-float 4x MSAA target -> RenderPass -> OutputPass (ACES at
// P.exposure) — i.e. kit.js::post without its bloom and grade passes (T23.08 adds those).
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { W, H } from './world.js'
import { makeRenderer, orthoCam } from './kit.js'
import * as S from './e_style.js'
export function skyOnly(P) {
  document.body.style.cssText = 'margin:0;position:relative;width:1280px;height:720px;overflow:hidden;background:#000'
  const r = makeRenderer(); r.toneMappingExposure = P.exposure
  const scene = new THREE.Scene(); scene.add(S.bgQuad(P.bg))
  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4 })
  const comp = new EffectComposer(r, rt)
  comp.addPass(new RenderPass(scene, orthoCam()))
  comp.addPass(new OutputPass())
  comp.render()
}
