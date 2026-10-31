// Bundle and run from the repo root:
//   node_modules/.bin/esbuild tools/sphere_test.ts --bundle --platform=node --format=esm --outfile=tools/sphere_test.mjs && node tools/sphere_test.mjs
//
// The sphere alone, headless: the geodesic's counts and topology, three hours
// of construction stepped a second at a time, the same three hours by the
// fast forward, the turning structure's positions, and a full cycle.
import { DysonSphere, type ReadyFace, type Target } from '../src/sphere'

// The one Node global this file touches; tools/ sits outside the tsconfig
// program and the repo has no @types/node, so declare it rather than install.
declare const process: { exitCode: number | undefined }

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) failures++
}
const fmt = (s: DysonSphere) => {
  const c = s.counts()
  return `completion ${(s.completion() * 100).toFixed(2)}% | nodes ${c.nodesDone}/${c.nodes} frames ${c.framesDone}/${c.frames} faces ${c.facesDone}/${c.faces} cells ${c.cells} | ${s.powerMW().toFixed(1)} MW`
}

const RADII = [215, 272, 330]
const sphere = new DysonSphere(RADII, 2, 5)
console.log(`axis [${sphere.axis.map((v) => v.toFixed(3)).join(', ')}], spin ${sphere.spin.toExponential(3)} rad/s, one turn in ${(2 * Math.PI / sphere.spin).toFixed(0)} s`)

// Topology, per layer.
for (let l = 0; l < sphere.layers.length; l++) {
  const L = sphere.layers[l]
  const V = L.nodes.length / 3
  const E = L.edges.length / 2
  const F = L.faces.length / 3
  check(`layer ${l} (R ${L.R}) has 42 nodes, 120 edges, 80 faces`, V === 42 && E === 120 && F === 80, `${V} / ${E} / ${F}`)
  const faceCount = new Map<string, number>()
  for (let f = 0; f < F; f++) {
    for (let e = 0; e < 3; e++) {
      const a = L.faces[f * 3 + e]
      const b = L.faces[f * 3 + ((e + 1) % 3)]
      const key = `${Math.min(a, b)},${Math.max(a, b)}`
      faceCount.set(key, (faceCount.get(key) ?? 0) + 1)
    }
  }
  let twoFaced = 0
  for (let e = 0; e < E; e++) {
    const a = L.edges[e * 2]
    const b = L.edges[e * 2 + 1]
    if (faceCount.get(`${Math.min(a, b)},${Math.max(a, b)}`) === 2) twoFaced++
  }
  check(`layer ${l} every edge belongs to exactly two faces`, twoFaced === E && faceCount.size === E, `${twoFaced}/${E} edges two faced, ${faceCount.size} distinct face edges`)
  let worst = 0
  for (let i = 0; i < V; i++) worst = Math.max(worst, Math.abs(Math.hypot(L.nodes[i * 3], L.nodes[i * 3 + 1], L.nodes[i * 3 + 2]) - 1))
  check(`layer ${l} every node is a unit vector`, worst < 1e-5, `worst |len - 1| ${worst.toExponential(2)}`)
  let degreeOk = true
  const deg = new Uint8Array(V)
  for (let e = 0; e < E; e++) {
    deg[L.edges[e * 2]]++
    deg[L.edges[e * 2 + 1]]++
  }
  let fives = 0
  for (let i = 0; i < V; i++) {
    if (deg[i] === 5) fives++
    else if (deg[i] !== 6) degreeOk = false
  }
  check(`layer ${l} twelve nodes of degree 5, the rest 6`, degreeOk && fives === 12, `${fives} of degree 5`)
}

// Three hours of construction, a second at a time, with the rockets landing
// as soon as they are asked for and the sails spread over the ready faces.
const ROCKET_RATE = 0.25
const SAIL_RATE = 13
const HOURS = 3
const DT = 1
const ready: ReadyFace[] = []
for (let k = 0; k < 40; k++) ready.push({ layer: 0, face: 0, cx: 0, cy: 0, cz: 0 })
let rocketBudget = 0
let sailBudget = 0
let fired = 0
let absorbed = 0
let lost = 0
let nullTargets = 0
let maxReady = 0
const seenTargets = new Set<string>()
const t0 = Date.now()
const steps = Math.round((HOURS * 3600) / DT)
console.log(`\nstepped run: ${HOURS} h at dt ${DT}, ${ROCKET_RATE} rockets/s and ${SAIL_RATE} sails/s`)
for (let step = 1; step <= steps; step++) {
  const t = step * DT
  rocketBudget += ROCKET_RATE * DT
  while (rocketBudget >= 1) {
    rocketBudget -= 1
    const tg = sphere.nextTarget()
    if (!tg) {
      nullTargets++
      continue
    }
    seenTargets.add(`${tg.layer}:${tg.kind}:${tg.index}`)
    sphere.deliverRocket(tg)
    fired++
  }
  sailBudget += SAIL_RATE * DT
  const k = Math.floor(sailBudget)
  sailBudget -= k
  const n = sphere.readyFaces(t, 40, ready)
  if (n > maxReady) maxReady = n
  if (n > 0) {
    for (let i = 0; i < k; i++) sphere.absorb(ready[i % n].layer, ready[i % n].face)
    absorbed += k
  } else lost += k
  if (t % 1800 === 0) console.log(`  t=${(t / 60).toFixed(0).padStart(3)} min  ${fmt(sphere)}`)
}
const steppedMs = Date.now() - t0
console.log(`  ${fired} rockets fired to ${seenTargets.size} distinct targets, ${absorbed} sails absorbed, ${lost} sails with no face to take them, up to ${maxReady} faces ready at once, ${nullTargets} empty targets, ${sphere.wasted} wasted rockets, ${steppedMs} ms`)
check('stepped run fired every rocket the budget allowed', fired === Math.floor(ROCKET_RATE * HOURS * 3600) && nullTargets === 0, `${fired} fired`)
check('stepped run wasted no rockets', sphere.wasted === 0, `${sphere.wasted}`)
const stepped = sphere.counts()
check('stepped run finished every node of the first layer before any of the second', stepped.nodesDone >= 42 && sphere.layers[1].nodeProg.every((v) => v === 0), `${stepped.nodesDone} nodes done`)
check('stepped run completed a face only where its three frames stand', (() => {
  for (let l = 0; l < sphere.layers.length; l++) {
    const L = sphere.layers[l]
    const edgeOf = new Map<string, number>()
    for (let e = 0; e < L.edges.length / 2; e++) edgeOf.set(`${L.edges[e * 2]},${L.edges[e * 2 + 1]}`, e)
    for (let f = 0; f < L.faces.length / 3; f++) {
      if (L.faceFill[f] <= 0) continue
      for (let k = 0; k < 3; k++) {
        const a = L.faces[f * 3 + k]
        const b = L.faces[f * 3 + ((k + 1) % 3)]
        const e = edgeOf.get(`${Math.min(a, b)},${Math.max(a, b)}`)
        if (e === undefined || L.edgeProg[e] < 1) return false
      }
    }
  }
  return true
})())

// The same three hours by the fast forward.
const fresh = new DysonSphere(RADII, 2, 5)
const t1 = Date.now()
fresh.advance(HOURS * 3600, ROCKET_RATE, SAIL_RATE)
const advMs = Date.now() - t1
console.log(`\nadvance(${HOURS * 3600}, ${ROCKET_RATE}, ${SAIL_RATE}) in ${advMs} ms:\n  ${fmt(fresh)}`)
const ff = fresh.counts()
const dCompletion = (fresh.completion() - sphere.completion()) * 100
console.log(`  difference, advance minus stepped: completion ${dCompletion.toFixed(2)} points, nodes ${ff.nodesDone - stepped.nodesDone}, frames ${ff.framesDone - stepped.framesDone}, faces ${ff.facesDone - stepped.facesDone}, cells ${ff.cells - stepped.cells}, power ${(fresh.powerMW() - sphere.powerMW()).toFixed(1)} MW`)
console.log(`  (advance lands rockets 90 s after they are made, so it is ${Math.round(ROCKET_RATE * 90)} rockets behind the stepped run by design)`)
check('advance lands close to the stepped run', Math.abs(dCompletion) < 2 && ff.nodesDone === stepped.nodesDone && Math.abs(ff.framesDone - stepped.framesDone) <= 6 && Math.abs(ff.facesDone - stepped.facesDone) <= 6, `completion differs by ${dCompletion.toFixed(2)} points`)

// readyFaces offers the least loaded faces first.
{
  const s = new DysonSphere(RADII, 2, 5)
  s.advance(30000, ROCKET_RATE, 0)
  const list: ReadyFace[] = []
  const n = s.readyFaces(0, 240, list)
  let ok = n >= 3
  if (ok) {
    for (let k = 1; k < n; k++) s.setInbound(list[k].layer, list[k].face, 3)
    const one: ReadyFace[] = []
    const got = s.readyFaces(0, 1, one)
    ok = got === 1 && one[0].layer === list[0].layer && one[0].face === list[0].face
    let r = 0
    for (let k = 0; k < n; k++) r = Math.max(r, Math.abs(Math.hypot(list[k].cx, list[k].cy, list[k].cz) - RADII[list[k].layer]))
    check('ready face centroids sit just inside their layer radius', r < RADII[2] * 0.08 && Number.isFinite(r), `${n} faces ready after 30000 s, centroid radius within ${r.toFixed(1)} of R`)
  }
  check('readyFaces offers the face with the fewest inbound sails first', ok, `${n} ready faces`)
}

// structurePos over a full rotation for every node and edge of every layer.
{
  const out = new Float64Array(3)
  const first = new Float64Array(3)
  const tg: Target = { layer: 0, kind: 0, index: 0 }
  const period = (2 * Math.PI) / sphere.spin
  const samples = 48
  let finite = true
  let worstNode = 0
  let worstEdgeLo = Infinity
  let worstEdgeHi = 0
  let worstReturn = 0
  let moved = 0
  for (let l = 0; l < sphere.layers.length; l++) {
    const L = sphere.layers[l]
    for (let kind = 0 as 0 | 1; kind <= 1; kind++) {
      const count = kind === 0 ? L.nodes.length / 3 : L.edges.length / 2
      for (let i = 0; i < count; i++) {
        tg.layer = l
        tg.kind = kind
        tg.index = i
        for (let k = 0; k <= samples; k++) {
          sphere.structurePos(tg, (k / samples) * period, out)
          if (!Number.isFinite(out[0]) || !Number.isFinite(out[1]) || !Number.isFinite(out[2])) finite = false
          const r = Math.hypot(out[0], out[1], out[2])
          if (kind === 0) worstNode = Math.max(worstNode, Math.abs(r - L.R))
          else {
            worstEdgeLo = Math.min(worstEdgeLo, r / L.R)
            worstEdgeHi = Math.max(worstEdgeHi, r / L.R)
          }
          if (k === 0) first.set(out)
          else if (k === samples / 2) moved = Math.max(moved, Math.hypot(out[0] - first[0], out[1] - first[1], out[2] - first[2]))
          else if (k === samples) worstReturn = Math.max(worstReturn, Math.hypot(out[0] - first[0], out[1] - first[1], out[2] - first[2]))
        }
      }
    }
  }
  check('structurePos is finite for every node and edge over a full rotation', finite)
  check('node radius within 0.5 of the layer radius over a full rotation', worstNode < 0.5, `worst ${worstNode.toExponential(2)}`)
  check('edge midpoints sit just inside the layer radius', worstEdgeLo > 0.9 && worstEdgeHi <= 1 + 1e-6, `radius / R in ${worstEdgeLo.toFixed(4)}..${worstEdgeHi.toFixed(4)}`)
  check('a full turn brings every point back where it started', worstReturn < 1e-6, `worst ${worstReturn.toExponential(2)}`)
  check('the structure actually turns', moved > 10, `a point moves up to ${moved.toFixed(1)} units over half a turn`)
}

// A full cycle at page-like rates finishes the sphere, and cheaply.
{
  const s = new DysonSphere(RADII, 2, 5)
  const CYCLE_S = 24 * 3600 * 1.8
  const t2 = Date.now()
  s.advance(CYCLE_S, ROCKET_RATE, SAIL_RATE)
  const ms = Date.now() - t2
  console.log(`\nadvance over a full ${(CYCLE_S / 3600).toFixed(1)} h cycle in ${ms} ms:\n  ${fmt(s)}`)
  const c = s.counts()
  check('a full cycle completes every node, frame and face', s.completion() === 1 && c.nodesDone === c.nodes && c.framesDone === c.frames && c.facesDone === c.faces)
  check('a complete sphere makes 11160 MW', Math.abs(s.powerMW() - 11160) < 1e-6, `${s.powerMW().toFixed(1)} MW`)
  check('a complete sphere has no next target', s.nextTarget() === null)
  check('a full cycle fast forward is cheap', ms < 500, `${ms} ms`)
  // Rockets that arrive at a finished node are counted, not applied.
  const before = s.counts().cells
  s.deliverRocket({ layer: 0, kind: 0, index: 0 })
  s.absorb(0, 0)
  check('extra rockets and sails after completion are wasted, not applied', s.wasted === 1 && s.counts().cells === before && s.completion() === 1)
}

// Two spheres with the same seed make the same decisions.
{
  const a = new DysonSphere(RADII, 2, 5)
  const b = new DysonSphere(RADII, 2, 5)
  let same = a.axis.every((v, i) => v === b.axis[i])
  for (let k = 0; k < 300 && same; k++) {
    const ta = a.nextTarget()
    const tb = b.nextTarget()
    same = !!ta && !!tb && ta.layer === tb.layer && ta.kind === tb.kind && ta.index === tb.index
    if (ta) a.deliverRocket(ta)
    if (tb) b.deliverRocket(tb)
  }
  check('the build order is deterministic for a seed', same)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
