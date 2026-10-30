// Bundle and run from the repo root:
//   npx esbuild tools/ground_test.ts --bundle --platform=node --format=esm --outfile=tools/ground_test.mjs && node tools/ground_test.mjs

// Run the ground and the swarm together, headless, and report whether the
// factories feed the rails, the rails fire in their windows, and the fired
// sails reach their lanes.
import { Swarm, TRANSIT, ORBIT, GM } from '../src/swarm.ts'
import { Surface, MIN_ELEV } from '../src/surface.ts'

const lanes = [
  { r: 190, tilt: [0.9, 0.3] as [number, number], n: 1800 },
  { r: 245, tilt: [-0.5, 0.9] as [number, number], n: 2000 },
  { r: 300, tilt: [0.25, -1.1] as [number, number], n: 2200 },
]
const R = 16
// Earth on a circular orbit at 914 with Earth's real pole frame.
const start = [820, -140, 380]
const r0 = Math.hypot(start[0], start[1], start[2])
const vc = Math.sqrt(GM / r0)
const h = [start[2], 0, -start[0]]
const hl = Math.hypot(h[0], h[1], h[2])
const sw = new Swarm(lanes, start, [(h[0] / hl) * vc, 0, (h[2] / hl) * vc], R, 7)
const tilt = 0.4
const Q = [Math.cos(tilt), -Math.sin(tilt), 0, Math.sin(tilt), Math.cos(tilt), 0, 0, 0, 1]
const ground = new Surface(R, sw, Q, 11)
console.log(`sites placed: ${ground.sites.length}, rails: ${ground.guns.length}, bots: ${ground.nBots}`)
for (const s of ground.sites) {
  const lat = (Math.asin(s.center[1]) * 180) / Math.PI
  console.log(`  site ${s.index + 1} lat ${lat.toFixed(0)}`)
}

const dt = 1 / 40
const T = 360
const transitTimes: number[] = []
let minR = Infinity
let minPlanet = Infinity
const wasTransit = new Uint8Array(sw.N)
let windowSum = 0
let firingSum = 0
let stalledSum = 0
let samples = 0
let launchedAt60 = 0
let maxBelt = 0
let maxRack = 0
const t0 = Date.now()
const steps = Math.round(T / dt)
for (let step = 0; step < steps; step++) {
  sw.step(dt / 2)
  sw.step(dt / 2)
  ground.step(dt, sw)
  for (let i = 0; i < sw.N; i++) {
    const st = sw.state[i]
    if (st === TRANSIT) {
      const r = Math.hypot(sw.pos[i * 3], sw.pos[i * 3 + 1], sw.pos[i * 3 + 2])
      if (r < minR) minR = r
      const d = Math.hypot(sw.pos[i * 3] - sw.planetPos[0], sw.pos[i * 3 + 1] - sw.planetPos[1], sw.pos[i * 3 + 2] - sw.planetPos[2])
      if (sw.age[i] > 0.5 && d < minPlanet) minPlanet = d
      wasTransit[i] = 1
    } else if (st === ORBIT && wasTransit[i]) {
      transitTimes.push(sw.age[i])
      wasTransit[i] = 0
    }
  }
  if (step % 8 === 0) {
    const c = ground.counts()
    windowSum += c.inWindow
    firingSum += c.firing
    stalledSum += ground.sites.filter((s) => s.stalled).length
    samples++
    for (const g of ground.guns) {
      maxBelt = Math.max(maxBelt, g.onBelt.length)
      maxRack = Math.max(maxRack, g.magazine.length)
    }
  }
  if (Math.abs(sw.time - 60) < dt / 2) launchedAt60 = sw.launched
  if (step % Math.round(60 / dt) === 0) {
    const c = sw.counts()
    const gc = ground.counts()
    const stalled = ground.sites.filter((s) => s.stalled).map((s) => `${s.index + 1}:${s.stallReason}`)
    console.log(
      `t=${Math.round(sw.time)}s orbit=${c.orbit} transit=${c.transit} ground=${c.ground} launched=${c.launched} | rails in window ${gc.inWindow}/${gc.guns} firing ${gc.firing} racked ${gc.racked} on belts ${gc.onBelts} | ore ${ground.sites.map((s) => s.ore.toFixed(0)).join(',')} | stalled ${stalled.join(' ') || 'none'}`,
    )
  }
}
const ms = Date.now() - t0
transitTimes.sort((a, b) => a - b)
const q = (p: number) => transitTimes[Math.floor(p * (transitTimes.length - 1))]?.toFixed(1)
console.log(`\n${steps} steps in ${ms} ms (${(ms / steps).toFixed(2)} ms/step incl. ground)`)
console.log(`launched: ${sw.launched} in ${T}s = ${(sw.launched / T).toFixed(1)}/s (first minute ${launchedAt60})`)
console.log(`captured: ${transitTimes.length}, transit time p10/p50/p90 = ${q(0.1)} / ${q(0.5)} / ${q(0.9)} s`)
console.log(`closest approach to the star in transit: ${minR.toFixed(1)} (star radius 8); closest to the planet after 0.5 s: ${minPlanet.toFixed(1)} (planet radius ${R})`)
console.log(`rails in window on average ${(windowSum / samples).toFixed(1)}/${ground.guns.length} (min elev ${((MIN_ELEV * 180) / Math.PI).toFixed(0)} deg), mid-shot ${(firingSum / samples).toFixed(1)}, sites stalled ${(stalledSum / samples).toFixed(1)}/${ground.sites.length}`)
console.log(`max packages on one belt ${maxBelt}, max racked at one rail ${maxRack}`)
for (let li = 0; li < lanes.length; li++) {
  const L = sw.lanes[li]
  let n = 0,
    dr = 0,
    dn = 0
  for (let i = 0; i < sw.N; i++) {
    if (sw.lane[i] !== li || sw.state[i] !== ORBIT) continue
    const p = [sw.pos[i * 3], sw.pos[i * 3 + 1], sw.pos[i * 3 + 2]]
    const rn = p[0] * L.n[0] + p[1] * L.n[1] + p[2] * L.n[2]
    n++
    dr += Math.abs(Math.hypot(p[0], p[1], p[2]) - L.R)
    dn += Math.abs(rn)
  }
  console.log(`lane ${li} R=${L.R}: ${n} in orbit, mean |dR|=${(dr / n).toFixed(2)} |plane|=${(dn / n).toFixed(2)}`)
}
const pr = Math.hypot(sw.planetPos[0], sw.planetPos[1], sw.planetPos[2])
console.log(`planet r=${pr.toFixed(1)} (start 914.4), period ~${(2 * Math.PI * Math.sqrt(pr ** 3 / GM)).toFixed(0)} s`)
// Sanity: every live package maps back to a reserved sail and vice versa.
let bad = 0
for (let p = 0; p < ground.nPackages; p++) {
  if (!ground.pkAlive[p]) continue
  const s = ground.pkSail[p]
  if (s < 0 || sw.state[s] !== 4 || ground.pkOf[s] !== p) bad++
}
console.log(`package/sail bookkeeping mismatches: ${bad}`)
