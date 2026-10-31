// Bundle and run from the repo root:
//   npx esbuild tools/engine_test.ts --bundle --platform=node --format=esm --outfile=tools/engine_test.mjs && node tools/engine_test.mjs
//
// The whole engine together, headless: Earth on its orbit, the ground sim
// hauling ore to the economy, the economy making sails and rockets, rails
// firing sails into the swarm, silos firing rockets at the sphere, faces
// pulling sails in. Fast forwards a few hours first, as the page does, then
// steps live and prints what a visitor would see change.
import { Swarm, GM } from '../src/swarm'
import { Surface } from '../src/surface'
import { Economy } from '../src/economy'
import { DysonSphere, type Target } from '../src/sphere'
import { Rockets } from '../src/rockets'
import { mulberry32 } from '../src/swarm'

const lanes = [
  { r: 190, tilt: [0.9, 0.3] as [number, number], n: 2200 },
  { r: 245, tilt: [-0.5, 0.9] as [number, number], n: 2400 },
  { r: 300, tilt: [0.25, -1.1] as [number, number], n: 2600 },
]
const R = 16
const start = [910, 0, 0]
const vc = Math.sqrt(GM / 910)
const sw = new Swarm(lanes, start, [0, 0, -vc], R, 7)
const tilt = 0.4
const Q = [Math.cos(tilt), -Math.sin(tilt), 0, Math.sin(tilt), Math.cos(tilt), 0, 0, 0, 1]
const ground = new Surface(R, sw, Q, 11)
const economy = new Economy(ground.sites.length, mulberry32(11))
const sphere = new DysonSphere([215, 272, 330], 2, 5)
const rockets = new Rockets(400)
ground.attach(economy, sphere, rockets)

const FAST_FORWARD_S = Number(process.argv[2] ?? 4 * 3600)
economy.advance(FAST_FORWARD_S, 3.6, 30)
const r0 = economy.rates()
sphere.advance(FAST_FORWARD_S, r0.rocketsPerSec, r0.sailsPerSec)
console.log(`after fast forward of ${(FAST_FORWARD_S / 3600).toFixed(1)} h: economy ${r0.sailsPerSec.toFixed(2)} sails/s ${r0.rocketsPerSec.toFixed(3)} rockets/s; sphere ${(sphere.completion() * 100).toFixed(1)}% ${JSON.stringify(sphere.counts())} ${sphere.powerMW().toFixed(0)} MW`)

// The page's absorption scheduler, copied.
const tgt: Target = { layer: 0, kind: 0, index: 0 }
const cpos = new Float64Array(3)
const centroidOf = (key: number, out: Float32Array, o: number) => {
  const layer = Math.floor(key / 100000)
  const face = key % 100000
  const L = sphere.layers[layer]
  out[o] = out[o + 1] = out[o + 2] = 0
  for (let k = 0; k < 3; k++) {
    tgt.layer = layer
    tgt.kind = 0
    tgt.index = L.faces[face * 3 + k]
    sphere.structurePos(tgt, sw.time, cpos)
    out[o] += cpos[0] / 3
    out[o + 1] += cpos[1] / 3
    out[o + 2] += cpos[2] / 3
  }
}
const onAbsorbed = (_i: number, key: number) => {
  sphere.absorb(Math.floor(key / 100000), key % 100000)
  sphere.setInbound(Math.floor(key / 100000), key % 100000, -1)
}
const ready: Array<{ layer: number; face: number; cx: number; cy: number; cz: number }> = []
for (let k = 0; k < 16; k++) ready.push({ layer: 0, face: 0, cx: 0, cy: 0, cz: 0 })
let absorbClock = 0
const absorbTick = (dt: number) => {
  absorbClock -= dt
  if (absorbClock > 0) return
  absorbClock = 0.5
  const n = sphere.readyFaces(sw.time, 16, ready)
  for (let k = 0; k < n; k++) {
    const f = ready[k]
    const want = 10 - sphere.layers[f.layer].inbound[f.face]
    if (want <= 0) continue
    const sent = sw.pickForFace(f.layer * 100000 + f.face, f.cx, f.cy, f.cz, want)
    if (sent > 0) sphere.setInbound(f.layer, f.face, sent)
  }
}

const dt = 1 / 40
const T = Number(process.argv[3] ?? 600)
const steps = Math.round(T / dt)
let minRocketR = Infinity
let bad = 0
const t0 = Date.now()
const c0 = sphere.counts()
const launched0 = sw.launched
for (let s = 0; s < steps; s++) {
  sw.step(dt / 2, centroidOf, onAbsorbed)
  sw.step(dt / 2, centroidOf, onAbsorbed)
  ground.step(dt, sw)
  economy.tick(dt, ground.sunElev, sphere.powerMW())
  rockets.step(dt, sphere, sw.time)
  absorbTick(dt)
  for (let r = 0; r < rockets.N; r++) {
    if (!rockets.alive[r]) continue
    const d = Math.hypot(rockets.pos[r * 3], rockets.pos[r * 3 + 1], rockets.pos[r * 3 + 2])
    if (!Number.isFinite(d)) bad++
    if (d < minRocketR) minRocketR = d
  }
  if (s % Math.round(120 / dt) === 0) {
    const c = sw.counts()
    const g = ground.counts()
    const e = economy.rates()
    const sc = sphere.counts()
    const sat = e.demandMW > 0 ? Math.min(1, e.supplyMW / e.demandMW) : 1
    const sun = Array.from(ground.sunElev).map((x) => x.toFixed(1)).join(',')
    console.log(
      `t=${Math.round(sw.time)}s orbit=${c.orbit} transit=${c.transit} absorbing=${c.absorbing} absorbed=${c.absorbed} launched=${c.launched} | rockets fired ${g.rocketsFired} flying ${rockets.count()} | sphere ${(sphere.completion() * 100).toFixed(2)}% nodes ${sc.nodesDone}/${sc.nodes} frames ${sc.framesDone}/${sc.frames} cells ${sc.cells} ${sphere.powerMW().toFixed(0)} MW | factories ${(sat * 100).toFixed(0)}% power (${e.supplyMW.toFixed(0)}/${e.demandMW.toFixed(0)} MW) ${e.sailsPerSec.toFixed(2)} sails/s ${e.rocketsPerSec.toFixed(3)} rockets/s | sun ${sun}`,
    )
  }
}
const ms = Date.now() - t0
const c1 = sphere.counts()
console.log(`\n${steps} steps in ${ms} ms (${(ms / steps).toFixed(2)} ms/step, whole engine)`)
console.log(`live run: sails launched ${sw.launched - launched0} (${((sw.launched - launched0) / T).toFixed(1)}/s), absorbed ${sw.absorbed}, rockets fired ${ground.counts().rocketsFired}, nodes +${c1.nodesDone - c0.nodesDone}, frames +${c1.framesDone - c0.framesDone}, cells +${c1.cells - c0.cells}`)
console.log(`closest a rocket came to the Sun: ${minRocketR.toFixed(1)} (must stay above 40); non finite rocket positions: ${bad}`)
let mismatches = 0
for (let p = 0; p < ground.nPackages; p++) {
  if (!ground.pkAlive[p]) continue
  const i = ground.pkSail[p]
  if (i < 0 || sw.state[i] !== 4 || ground.pkOf[i] !== p) mismatches++
}
console.log(`package/sail bookkeeping mismatches: ${mismatches}`)
