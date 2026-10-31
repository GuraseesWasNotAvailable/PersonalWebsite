// Bundle and run from the repo root:
//   node_modules/.bin/esbuild tools/rockets_test.ts --bundle --platform=node --format=esm --outfile=tools/rockets_test.mjs && node tools/rockets_test.mjs
//
// Carrier rockets alone, headless. A launch point rides Earth's orbit and
// fires a rocket every four seconds at whatever the sphere asks for next,
// twenty minutes of that at the page's step. Then one rocket is fired from
// the night side at a node hidden behind the star, to show the turn round
// and the detour. Prints what a human can judge: flight times, how close
// anything came to the star, and what the sphere has to show for it.
import { GM } from '../src/swarm'
import { DysonSphere, type Target } from '../src/sphere'
import { Rockets, KEEP_OUT, ROCKET_SPEED, ROCKET_THRUST } from '../src/rockets'

// The one Node global this file touches; tools/ sits outside the tsconfig
// program and the repo has no @types/node, so declare it rather than install.
declare const process: { exitCode: number | undefined }

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) failures++
}
const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] : NaN)

console.log(`rockets cruise at ${ROCKET_SPEED}, thrust ${ROCKET_THRUST}, keep out ${KEEP_OUT} round the star`)

// Twenty minutes of launches from a point on Earth's orbit.
{
  const sphere = new DysonSphere([215, 272, 330], 2, 5)
  const rockets = new Rockets(400)
  const R0 = 910
  const vc = Math.sqrt(GM / R0)
  const omega = vc / R0
  const dt = 0.05
  const T = 1200
  const EVERY = 4
  const steps = Math.round(T / dt)
  const launchStep = Math.round(EVERY / dt)
  const launchedAt = new Float64Array(rockets.N)
  const wasAlive = new Uint8Array(rockets.N)
  const flights: number[] = []
  let minR = Infinity
  let maxSpeed = 0
  let nonFinite = 0
  let refused = 0
  let noTarget = 0
  let maxFlying = 0
  const pos = [0, 0, 0]
  const vel = [0, 0, 0]
  let t = 0
  const t0 = Date.now()
  for (let step = 0; step < steps; step++) {
    if (step % launchStep === 0) {
      // The launch point on its circular orbit, counter clockwise seen from
      // +y, with the silo's 18 units per second pointed at the star.
      const th = omega * t
      const c = Math.cos(th)
      const s = Math.sin(th)
      pos[0] = R0 * c
      pos[1] = 0
      pos[2] = R0 * s
      vel[0] = -vc * s - 18 * c
      vel[1] = 0
      vel[2] = vc * c - 18 * s
      const tg = sphere.nextTarget()
      if (!tg) noTarget++
      else {
        for (let i = 0; i < rockets.N; i++) wasAlive[i] = rockets.alive[i]
        if (rockets.launch(pos, vel, tg)) {
          for (let i = 0; i < rockets.N; i++) if (rockets.alive[i] && !wasAlive[i]) launchedAt[i] = t
        } else {
          refused++
          sphere.cancelRocket(tg)
        }
      }
    }
    for (let i = 0; i < rockets.N; i++) wasAlive[i] = rockets.alive[i]
    t += dt
    rockets.step(dt, sphere, t)
    const flying = rockets.count()
    if (flying > maxFlying) maxFlying = flying
    for (let i = 0; i < rockets.N; i++) {
      if (wasAlive[i] && !rockets.alive[i]) flights.push(t - launchedAt[i])
      if (!rockets.alive[i]) continue
      const o = i * 3
      const r = Math.hypot(rockets.pos[o], rockets.pos[o + 1], rockets.pos[o + 2])
      const v = Math.hypot(rockets.vel[o], rockets.vel[o + 1], rockets.vel[o + 2])
      if (!Number.isFinite(r) || !Number.isFinite(v)) nonFinite++
      if (r < minR) minR = r
      if (v > maxSpeed) maxSpeed = v
    }
    if (step > 0 && step % Math.round(240 / dt) === 0) {
      const c = sphere.counts()
      console.log(`  t=${Math.round(t).toString().padStart(4)}s launched ${rockets.launched} arrived ${rockets.arrived} flying ${rockets.count()} | nodes ${c.nodesDone}/${c.nodes} frames ${c.framesDone}/${c.frames} | closest to star so far ${minR.toFixed(1)}`)
    }
  }
  const ms = Date.now() - t0
  flights.sort((a, b) => a - b)
  const c = sphere.counts()
  console.log(`\n${steps} steps in ${ms} ms (${((ms / steps) * 1000).toFixed(1)} us/step)`)
  console.log(`launched ${rockets.launched}, arrived ${rockets.arrived}, still in flight ${rockets.count()}, at most ${maxFlying} in the air at once, ${refused} launches refused, ${noTarget} with no target, ${rockets.timedOut} timed out`)
  console.log(`flight time p10/p50/p90 = ${pct(flights, 0.1).toFixed(1)} / ${pct(flights, 0.5).toFixed(1)} / ${pct(flights, 0.9).toFixed(1)} s, min ${flights[0]?.toFixed(1)} max ${flights[flights.length - 1]?.toFixed(1)}`)
  console.log(`closest any rocket came to the star: ${minR.toFixed(1)} (must stay above 40); top speed seen ${maxSpeed.toFixed(1)}; non finite samples ${nonFinite}`)
  console.log(`sphere: ${JSON.stringify(c)}, completion ${(sphere.completion() * 100).toFixed(2)}%, wasted rockets ${sphere.wasted}`)
  check('every fourth second launched a rocket', rockets.launched === Math.ceil(T / EVERY) && refused === 0 && noTarget === 0, `${rockets.launched} launched`)
  check('arrived plus flying accounts for every launch', rockets.arrived + rockets.count() === rockets.launched && flights.length === rockets.arrived && rockets.lost === 0, `${rockets.lost} lost`)
  check('flight times all between 60 and 130 s', flights.length > 0 && flights[0] >= 60 && flights[flights.length - 1] <= 130, `${flights[0]?.toFixed(1)} to ${flights[flights.length - 1]?.toFixed(1)} s`)
  check('no rocket came within 40 of the star', minR > 40, `${minR.toFixed(1)}`)
  check('no NaN or Infinity in flight', nonFinite === 0)
  check('no rocket needed the flight timeout', rockets.timedOut === 0)
  check('every landed rocket counts on the sphere', c.nodesDone * sphere.NODE_COST + sphere.layers[0].nodeProg.reduce((s, v) => s + (v < 1 ? Math.round(v * sphere.NODE_COST) : 0), 0) === rockets.arrived && sphere.wasted === 0, `${rockets.arrived} landed, ${c.nodesDone} nodes done`)
}

// One rocket from the night side at a node hidden behind the star.
{
  const sphere = new DysonSphere([215, 272, 330], 2, 5)
  const rockets = new Rockets(4)
  const launch = [910, 0, 0]
  const vc = Math.sqrt(GM / 910)
  // Of the inner layer's nodes at t = 0, the one whose straight line from
  // the launch point passes nearest the origin.
  const out = new Float64Array(3)
  const tg: Target = { layer: 0, kind: 0, index: 0 }
  let best = 0
  let bestMiss = Infinity
  let bestDist = 0
  for (let i = 0; i < sphere.layers[0].nodes.length / 3; i++) {
    tg.index = i
    sphere.structurePos(tg, 0, out)
    const dx = out[0] - launch[0]
    const dy = out[1] - launch[1]
    const dz = out[2] - launch[2]
    const d = Math.hypot(dx, dy, dz)
    const s = -(launch[0] * dx + launch[1] * dy + launch[2] * dz) / d
    const miss = Math.hypot(launch[0] + (s / d) * dx, launch[1] + (s / d) * dy, launch[2] + (s / d) * dz)
    if (s > 0 && s < d && miss < bestMiss) {
      bestMiss = miss
      best = i
      bestDist = d
    }
  }
  tg.index = best
  console.log(`\nnight side launch at node ${best} of the inner shell, ${bestDist.toFixed(0)} away, whose straight line would pass ${bestMiss.toFixed(1)} from the star`)
  // The silo fires straight up: here that means straight away from the star.
  const ok = rockets.launch(launch, [18, 0, -vc], tg)
  const dt = 0.05
  let t = 0
  let minR = Infinity
  let maxR = 0
  let turned = -1
  while (rockets.count() > 0 && t < 400) {
    t += dt
    rockets.step(dt, sphere, t)
    if (!rockets.alive[0]) break
    const r = Math.hypot(rockets.pos[0], rockets.pos[1], rockets.pos[2])
    if (r < minR) minR = r
    if (r > maxR) maxR = r
    // The moment the rocket stops climbing away from the star.
    const vr = (rockets.pos[0] * rockets.vel[0] + rockets.pos[1] * rockets.vel[1] + rockets.pos[2] * rockets.vel[2]) / r
    if (turned < 0 && vr < 0) turned = t
  }
  const landed = rockets.arrived === 1
  console.log(`  launched ${ok}, turned round after ${turned.toFixed(1)} s having climbed to ${maxR.toFixed(1)}, landed ${landed} after ${t.toFixed(1)} s, closest to the star ${minR.toFixed(1)}`)
  console.log(`  node progress now ${sphere.layers[0].nodeProg[best].toFixed(4)} (one rocket of ${sphere.NODE_COST})`)
  check('the night side rocket landed', landed && ok, `${t.toFixed(1)} s`)
  check('it went round the star, not through it', minR > KEEP_OUT - 25, `closest ${minR.toFixed(1)}, keep out ${KEEP_OUT}`)
  check('the detour still lands inside 200 s', t < 200, `${t.toFixed(1)} s`)
  check('the landing counted once on its node', Math.abs(sphere.layers[0].nodeProg[best] - 1 / sphere.NODE_COST) < 1e-6)
}

// Malformed launches are refused rather than flown at the origin.
{
  const rockets = new Rockets(2)
  const good: Target = { layer: 0, kind: 0, index: 1 }
  const r1 = rockets.launch([910, 0, 0], [0, 0, 9], { layer: -1, kind: 0, index: 1 })
  const r2 = rockets.launch([910, 0, 0], [0, 0, 9], { layer: 0, kind: 0, index: 100000 })
  const r3 = rockets.launch([NaN, 0, 0], [0, 0, 9], good)
  const afterBad = rockets.count()
  const r4 = rockets.launch([910, 0, 0], [0, 0, 9], good)
  const r5 = rockets.launch([910, 0, 0], [0, 0, 9], good)
  const r6 = rockets.launch([910, 0, 0], [0, 0, 9], good)
  check('bad layer, bad index and NaN position are refused', !r1 && !r2 && !r3 && afterBad === 0)
  check('a full pool refuses the next launch', r4 && r5 && !r6 && rockets.count() === 2)
  check('the target code packs as the HUD decodes it', rockets.target[0] === 1 && rockets.target[1] === 1)
}

// Targets that fit the packing but are not on the sphere: a node past the
// 42 the mesh has, an edge past its 120, a fourth layer of three. Given the
// sphere, the silo refuses them. Without it, the first step drops them where
// they stand: nothing flies at the star, nothing is booked as a landing, and
// the sphere's books do not move.
{
  const sphere = new DysonSphere([215, 272, 330], 2, 5)
  const V = sphere.layers[0].nodes.length / 3
  const E = sphere.layers[0].edges.length / 2
  const offMesh: Target[] = [
    { layer: 0, kind: 0, index: V + 8 },
    { layer: 0, kind: 1, index: E + 80 },
    { layer: sphere.layers.length, kind: 0, index: 0 },
  ]
  const onMesh: Target[] = [
    { layer: 0, kind: 0, index: V - 1 },
    { layer: 0, kind: 1, index: E - 1 },
    { layer: sphere.layers.length - 1, kind: 0, index: 0 },
  ]
  console.log(`\noff mesh targets against a sphere of ${sphere.layers.length} layers, ${V} nodes and ${E} edges each`)
  const pad = new Rockets(8)
  const refused = offMesh.map((tg) => !pad.launch([910, 0, 0], [-18, 0, 8.9], tg, sphere))
  const accepted = onMesh.map((tg) => pad.launch([910, 0, 0], [-18, 0, 8.9], tg, sphere))
  console.log(`  with the sphere: off mesh refused ${JSON.stringify(refused)}, the last real node, edge and layer accepted ${JSON.stringify(accepted)}`)
  check('given the sphere, the silo refuses every off mesh target', refused.every((r) => r))
  check('given the sphere, the last real node, edge and layer are still accepted', accepted.every((a) => a) && pad.count() === 3 && pad.lost === 0)

  const blind = new Rockets(8)
  const launched = offMesh.map((tg) => blind.launch([910, 0, 0], [-18, 0, 8.9], tg))
  const before = JSON.stringify(sphere.counts())
  const flying = blind.count()
  blind.step(0.05, sphere, 0.05)
  let moved = 0
  for (let i = 0; i < 3; i++) if (blind.pos[i * 3] !== 910 || blind.pos[i * 3 + 1] !== 0 || blind.pos[i * 3 + 2] !== 0) moved++
  console.log(`  without it: launched ${JSON.stringify(launched)}, ${flying} in the pool, after one step ${blind.count()} flying, ${blind.lost} lost, ${blind.arrived} arrived, ${blind.timedOut} timed out, ${moved} moved, sphere wasted ${sphere.wasted}`)
  check('without the sphere the packing lets them through', launched.every((l) => l) && flying === 3)
  check('one step drops all three without flying them', blind.count() === 0 && blind.lost === 3 && moved === 0)
  check('a dropped rocket is not a landing', blind.arrived === 0 && blind.timedOut === 0 && sphere.wasted === 0 && JSON.stringify(sphere.counts()) === before)
  check('dropped slots go back to the pool', blind.launch([910, 0, 0], [-18, 0, 8.9], onMesh[0]) && blind.count() === 1 && blind.target.filter((c) => c >= 0).length === 1)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
