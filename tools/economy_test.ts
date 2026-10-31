// Bundle and run from the repo root:
//   node_modules/.bin/esbuild tools/economy_test.ts --bundle --platform=node --format=esm --outfile=tools/economy_test.mjs && node tools/economy_test.mjs

// The factories alone, headless: eleven sites fed 3.6 ore a second each, a
// full day of sun, then a night with no sphere, then a night lit by 60 MW of
// sphere power, the fast forward the page uses at load, a starved site whose
// bench must not draw power it was never asked for, and the fast forward
// against the live chain under a day and night cycle. Prints the rates a
// human can judge against DESIGN.md and PASS or FAIL for each target.
import { Economy, ORES, STOCK_CAP, FINISHED_CAP, YIELD, RECIPES, POWER_MW, DAY_S } from '../src/economy'
import { mulberry32 } from '../src/swarm'

const N = 11
const DT = 0.1
const ORE_PER_S = 3.6
const PHASE_S = 600

const eco = new Economy(N, mulberry32(11))
const ones = new Float32Array(N).fill(1)
const zeros = new Float32Array(N)

console.log(`${eco.sites.length} sites, recipes: smelt ${RECIPES.smelt.ore} ore/${RECIPES.smelt.seconds}s, sail ${RECIPES.sail.seconds}s for ${YIELD.sail}, rocket ${RECIPES.rocket.seconds}s for ${YIELD.rocket}; stock cap ${STOCK_CAP}, finished cap ${FINISHED_CAP.sails}/${FINISHED_CAP.rockets}`)
let plants = 0
for (const s of eco.sites) {
  plants += s.rocketPlants
  const v = ORES.map((k) => `${k.slice(0, 2)} ${(s.veins[k] * 100).toFixed(0)}%`).join(' ')
  const sum = ORES.reduce((a, k) => a + s.veins[k], 0)
  console.log(`  site ${eco.sites.indexOf(s) + 1}: ${s.rocketPlants ? 'titanium ' : 'sail     '} ${v} (sum ${sum.toFixed(3)}) smelters ${s.smelters} assemblers ${s.assemblers} plants ${s.rocketPlants} panels ${s.panels} receivers ${s.receivers}`)
}
console.log(`rocket plants in all: ${plants}`)

function run(seconds: number, sun: ArrayLike<number>, sphereMW: number) {
  const steps = Math.round(seconds / DT)
  const t0 = performance.now()
  for (let st = 0; st < steps; st++) {
    for (let i = 0; i < N; i++) eco.deliverOre(i, ORE_PER_S * DT)
    eco.tick(DT, sun, sphereMW)
  }
  return (performance.now() - t0) / steps
}

function fmt(r: ReturnType<Economy['rates']>) {
  const sat = r.demandMW > 0 ? Math.min(1, r.supplyMW / r.demandMW) : 1
  return `${r.sailsPerSec.toFixed(2)} sails/s, ${r.rocketsPerSec.toFixed(3)} rockets/s, power ${r.supplyMW.toFixed(1)}/${r.demandMW.toFixed(1)} MW (${(sat * 100).toFixed(0)}% satisfied)`
}

function snapshot(label: string) {
  const sail = eco.sites.find((s) => s.rocketPlants === 0)!
  const ti = eco.sites.find((s) => s.rocketPlants > 0)!
  for (const [name, s] of [['sail site', sail], ['titanium site', ti]] as const) {
    const ore = ORES.map((k) => s.ore[k].toFixed(0)).join('/')
    const ing = ORES.map((k) => s.ingots[k].toFixed(1)).join('/')
    console.log(`    ${label} ${name}: ore ${ore} ingots ${ing} sails ${s.sails} rockets ${s.rockets} made ${s.made.sails}/${s.made.rockets} power solar ${s.power.solar.toFixed(2)} ray ${s.power.ray.toFixed(2)} demand ${s.power.demand.toFixed(2)} sat ${s.power.satisfaction.toFixed(2)}`)
  }
}

const msA = run(PHASE_S, ones, 0)
const day = eco.rates()
console.log(`\nafter ${PHASE_S} s of full sun, no sphere: ${fmt(day)}`)
snapshot('day')
run(PHASE_S, zeros, 0)
const nightDark = eco.rates()
console.log(`after ${PHASE_S} s of night, no sphere:     ${fmt(nightDark)}`)
snapshot('dark')
run(PHASE_S, zeros, 60)
const nightLit = eco.rates()
console.log(`after ${PHASE_S} s of night, 60 MW sphere:  ${fmt(nightLit)}`)
snapshot('lit')
console.log(`tick cost ${(msA * 1000).toFixed(1)} us per step for ${N} sites`)

// The fast forward the page runs at load.
const fresh = new Economy(N, mulberry32(11))
const t0 = performance.now()
fresh.advance(20000, ORE_PER_S, 30)
const msAdv = performance.now() - t0
const adv = fresh.rates()
let madeSails = 0
let madeRockets = 0
let dockSails = 0
let dockRockets = 0
for (const s of fresh.sites) {
  madeSails += s.made.sails
  madeRockets += s.made.rockets
  dockSails += s.sails
  dockRockets += s.rockets
}
console.log(`\nfresh economy after advance(20000, ${ORE_PER_S}, 30) in ${msAdv.toFixed(1)} ms: ${fmt(adv)}`)
console.log(`  made ${madeSails} sails and ${madeRockets} rockets in all (${(madeSails / 20000).toFixed(2)}/s and ${(madeRockets / 20000).toFixed(3)}/s over the 20000 s); on the docks ${dockSails} sails, ${dockRockets} rockets; time ${fresh.time}`)

// A starved site: hauled less ore than its bench can fold, under a dim sun
// with no sphere, so every ingot is eaten the tick it leaves the furnace. The
// bench must still be counted in demand, or it folds sails on power the
// panels never supplied. Checked as energy: what the machines drew, worked
// back from the ore smelted and the items made, against what the panels gave.
// Run at the page's frame and at a whole second step, which must agree.
const LEAN_ORE = 1.0
const LEAN_SUN = 0.1
const LEAN_S = 600
const dim = new Float32Array(N).fill(LEAN_SUN)
function starved(dt: number) {
  const lean = new Economy(N, mulberry32(11))
  const steps = Math.round(LEAN_S / dt)
  for (let st = 0; st < steps; st++) {
    for (let i = 0; i < N; i++) lean.deliverOre(i, LEAN_ORE * dt)
    lean.tick(dt, dim, 0)
  }
  let drawn = 0
  let supplied = 0
  let sails = 0
  for (const s of lean.sites) {
    let ingots = 0
    for (const k of ORES) ingots += s.ingots[k]
    const sailCycles = s.made.sails / YIELD.sail
    const rocketCycles = s.made.rockets / YIELD.rocket
    const smelted = ingots + sailCycles * (RECIPES.sail.iron + RECIPES.sail.copper + RECIPES.sail.silicon) + rocketCycles * (RECIPES.rocket.titanium + RECIPES.rocket.iron + RECIPES.rocket.silicon)
    drawn += (smelted / RECIPES.smelt.ore) * RECIPES.smelt.seconds * POWER_MW.smelter
    drawn += sailCycles * RECIPES.sail.seconds * POWER_MW.assembler
    drawn += rocketCycles * RECIPES.rocket.seconds * POWER_MW.rocketPlant
    supplied += s.panels * POWER_MW.panel * LEAN_SUN * LEAN_S
    sails += s.made.sails
  }
  const site = lean.sites.find((s) => s.rocketPlants === 0)!
  return { drawn, supplied, sailsPerSec: sails / LEAN_S, demand: site.power.demand, sat: site.power.satisfaction }
}
const leanFrame = starved(0.045)
const leanCoarse = starved(1)
// What the panels can pay for at a sail site that wants everything: the
// whole furnace line and the whole bench, run at supply over demand.
const leanSites = eco.sites.filter((s) => s.rocketPlants === 0)
const leanSite = leanSites[0]
const leanDemand = leanSite.smelters * POWER_MW.smelter + leanSite.assemblers * POWER_MW.assembler
const leanSat = Math.min(1, (leanSite.panels * POWER_MW.panel * LEAN_SUN) / leanDemand)
const leanBudgetSails = (leanSites.length * leanSite.assemblers * YIELD.sail * leanSat) / RECIPES.sail.seconds
console.log(`\nstarved: ${LEAN_ORE} ore/s hauled, sun ${LEAN_SUN}, no sphere, ${LEAN_S} s`)
console.log(`  at dt 0.045: drew ${leanFrame.drawn.toFixed(0)} MJ of ${leanFrame.supplied.toFixed(0)} MJ supplied, ${leanFrame.sailsPerSec.toFixed(2)} sails/s (budget ${leanBudgetSails.toFixed(2)}), sail site demand ${leanFrame.demand.toFixed(3)} MW sat ${leanFrame.sat.toFixed(3)}`)
console.log(`  at dt 1:     drew ${leanCoarse.drawn.toFixed(0)} MJ of ${leanCoarse.supplied.toFixed(0)} MJ supplied, ${leanCoarse.sailsPerSec.toFixed(2)} sails/s, sail site demand ${leanCoarse.demand.toFixed(3)} MW sat ${leanCoarse.sat.toFixed(3)}`)

// The fast forward against the live chain under a day and night cycle, the
// sun a clipped sine spread across the sites as the ground reports it, with
// no sphere and with a sphere too small to light the night. The live chain
// runs the whole span at the fine step, its docks drained as the belts and
// silos would, and reports what it made in all and its settled rate over the
// last four days; advance must land on both with its coarse steps, and must
// come in well under the full sun figure, since the nights are real.
const SPAN_S = 20000
const SETTLED_DAYS = 4
function dayNight(sphereMW: number) {
  const live = new Economy(N, mulberry32(11))
  const sun = new Float32Array(N)
  const steps = Math.round(SPAN_S / DT)
  const from = Math.round((SPAN_S - SETTLED_DAYS * DAY_S) / DT)
  let sails0 = 0
  let rockets0 = 0
  const made = () => live.sites.reduce((a, s) => [a[0] + s.made.sails, a[1] + s.made.rockets], [0, 0])
  for (let st = 0; st < steps; st++) {
    const t = st * DT
    for (let i = 0; i < N; i++) sun[i] = Math.max(0, Math.sin(2 * Math.PI * ((t + 0.5 * DT) / DAY_S + i / N)))
    for (let i = 0; i < N; i++) live.deliverOre(i, ORE_PER_S * DT)
    live.tick(DT, sun, sphereMW)
    for (const s of live.sites) {
      if (s.sails > 8) s.sails = 8
      if (s.rockets > 1) s.rockets = 1
    }
    if (st === from) [sails0, rockets0] = made()
  }
  const [sails1, rockets1] = made()
  const span = (steps - from) * DT
  return { sailsPerSec: (sails1 - sails0) / span, rocketsPerSec: (rockets1 - rockets0) / span, madeSails: sails1, madeRockets: rockets1 }
}
function fastForward(sphereMW: number) {
  const e = new Economy(N, mulberry32(11))
  const t0 = performance.now()
  e.advance(SPAN_S, ORE_PER_S, sphereMW)
  const ms = performance.now() - t0
  const r = e.rates()
  const made = e.sites.reduce((a, s) => [a[0] + s.made.sails, a[1] + s.made.rockets], [0, 0])
  return { sailsPerSec: r.sailsPerSec, rocketsPerSec: r.rocketsPerSec, madeSails: made[0], madeRockets: made[1], ms }
}
const tLive = performance.now()
const liveDark = dayNight(0)
const liveDim = dayNight(8)
const msLive = performance.now() - tLive
const advDark = fastForward(0)
const advDim = fastForward(8)
const dn = (label: string, live: ReturnType<typeof dayNight>, adv: ReturnType<typeof fastForward>) => {
  console.log(`${label}`)
  console.log(`  live:    settled ${live.sailsPerSec.toFixed(2)} sails/s ${live.rocketsPerSec.toFixed(3)} rockets/s, made ${live.madeSails} sails ${live.madeRockets} rockets in ${SPAN_S} s`)
  console.log(`  advance: ${adv.sailsPerSec.toFixed(2)} sails/s ${adv.rocketsPerSec.toFixed(3)} rockets/s, made ${adv.madeSails} sails ${adv.madeRockets} rockets in ${SPAN_S} s, ${adv.ms.toFixed(1)} ms`)
}
console.log(`\nday and night, the live chain at dt ${DT} for ${SPAN_S} s twice took ${msLive.toFixed(0)} ms`)
dn('no sphere:', liveDark, advDark)
dn('8 MW sphere:', liveDim, advDim)
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol * Math.abs(b)

// Bookkeeping: nothing NaN, nothing over its cap, takes work.
let nan = 0
let overCap = 0
const walk = (v: unknown) => {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) nan++
  } else if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) walk(x)
}
for (const e of [eco, fresh]) {
  for (const s of e.sites) {
    walk(s)
    for (const k of ORES) if (s.ore[k] > STOCK_CAP + 1e-9 || s.ingots[k] > STOCK_CAP + 1e-9) overCap++
    if (s.sails > FINISHED_CAP.sails + YIELD.sail || s.rockets > FINISHED_CAP.rockets + YIELD.rocket) overCap++
  }
  walk(e.rates())
}
const sailSite = eco.sites.findIndex((s) => s.rocketPlants === 0)
const tiSite = eco.sites.findIndex((s) => s.rocketPlants > 0)
const before = eco.sites[sailSite].sails
const took = eco.takeSail(sailSite) && eco.sites[sailSite].sails === before - 1
const tookRocket = eco.takeRocket(tiSite)
const refused = !eco.takeRocket(sailSite) && !eco.takeSail(99)
console.log(`non finite numbers: ${nan}; stocks over cap: ${overCap}; takeSail ${took ? 'ok' : 'BAD'}, takeRocket ${tookRocket ? 'ok' : 'BAD'}, refusals ${refused ? 'ok' : 'BAD'}`)

// Targets from DESIGN.md.
const checks: Array<[string, boolean]> = [
  [`full sun: 10 to 14 sails/s (got ${day.sailsPerSec.toFixed(2)})`, day.sailsPerSec >= 10 && day.sailsPerSec <= 14],
  [`full sun: 0.2 to 0.3 rockets/s (got ${day.rocketsPerSec.toFixed(3)})`, day.rocketsPerSec >= 0.2 && day.rocketsPerSec <= 0.3],
  [`night, no sphere: sails under a third of full (got ${nightDark.sailsPerSec.toFixed(2)} vs ${(day.sailsPerSec / 3).toFixed(2)})`, nightDark.sailsPerSec < day.sailsPerSec / 3],
  [`night, 60 MW: sails near full (got ${nightLit.sailsPerSec.toFixed(2)}, want at least ${(0.9 * day.sailsPerSec).toFixed(2)})`, nightLit.sailsPerSec >= 0.9 * day.sailsPerSec],
  [`night, 60 MW: rockets near full (got ${nightLit.rocketsPerSec.toFixed(3)}, want at least ${(0.9 * day.rocketsPerSec).toFixed(3)})`, nightLit.rocketsPerSec >= 0.9 * day.rocketsPerSec],
  [`advance matches the ticked rates within 5% (${adv.sailsPerSec.toFixed(2)} vs ${day.sailsPerSec.toFixed(2)}, ${adv.rocketsPerSec.toFixed(3)} vs ${day.rocketsPerSec.toFixed(3)})`, Math.abs(adv.sailsPerSec - day.sailsPerSec) <= 0.05 * day.sailsPerSec && Math.abs(adv.rocketsPerSec - day.rocketsPerSec) <= 0.05 * day.rocketsPerSec],
  [`advance totals match rate times time within 5% (${madeSails} vs ${Math.round(adv.sailsPerSec * 20000)}, ${madeRockets} vs ${Math.round(adv.rocketsPerSec * 20000)})`, Math.abs(madeSails - adv.sailsPerSec * 20000) <= 0.05 * adv.sailsPerSec * 20000 && Math.abs(madeRockets - adv.rocketsPerSec * 20000) <= 0.05 * adv.rocketsPerSec * 20000],
  [`advance is cheap (${msAdv.toFixed(1)} ms, want under 50)`, msAdv < 50],
  [`starved site: energy drawn never exceeds supply (${leanFrame.drawn.toFixed(0)} of ${leanFrame.supplied.toFixed(0)} MJ at dt 0.045, ${leanCoarse.drawn.toFixed(0)} of ${leanCoarse.supplied.toFixed(0)} MJ at dt 1)`, leanFrame.drawn <= leanFrame.supplied * 1.01 && leanCoarse.drawn <= leanCoarse.supplied * 1.01],
  [`starved site: the bench is counted in demand (${leanFrame.demand.toFixed(3)} MW, want ${leanDemand.toFixed(2)})`, near(leanFrame.demand, leanDemand, 0.02)],
  [`starved site: output is the power budget's and the same at both steps (${leanFrame.sailsPerSec.toFixed(2)} and ${leanCoarse.sailsPerSec.toFixed(2)} vs ${leanBudgetSails.toFixed(2)})`, near(leanFrame.sailsPerSec, leanBudgetSails, 0.03) && near(leanCoarse.sailsPerSec, leanBudgetSails, 0.03)],
  [`advance sees the night: no sphere gives under 60% of full sun (${advDark.sailsPerSec.toFixed(2)} vs ${day.sailsPerSec.toFixed(2)})`, advDark.sailsPerSec < 0.6 * day.sailsPerSec],
  [`advance rates match the settled live chain, no sphere (${advDark.sailsPerSec.toFixed(2)} vs ${liveDark.sailsPerSec.toFixed(2)}, ${advDark.rocketsPerSec.toFixed(3)} vs ${liveDark.rocketsPerSec.toFixed(3)})`, near(advDark.sailsPerSec, liveDark.sailsPerSec, 0.05) && near(advDark.rocketsPerSec, liveDark.rocketsPerSec, 0.05)],
  [`advance rates match the settled live chain, 8 MW (${advDim.sailsPerSec.toFixed(2)} vs ${liveDim.sailsPerSec.toFixed(2)}, ${advDim.rocketsPerSec.toFixed(3)} vs ${liveDim.rocketsPerSec.toFixed(3)})`, near(advDim.sailsPerSec, liveDim.sailsPerSec, 0.05) && near(advDim.rocketsPerSec, liveDim.rocketsPerSec, 0.05)],
  [`advance totals match the live chain over ${SPAN_S} s, no sphere (${advDark.madeSails} vs ${liveDark.madeSails}, ${advDark.madeRockets} vs ${liveDark.madeRockets})`, near(advDark.madeSails, liveDark.madeSails, 0.05) && near(advDark.madeRockets, liveDark.madeRockets, 0.05)],
  [`advance totals match the live chain over ${SPAN_S} s, 8 MW (${advDim.madeSails} vs ${liveDim.madeSails}, ${advDim.madeRockets} vs ${liveDim.madeRockets})`, near(advDim.madeSails, liveDim.madeSails, 0.05) && near(advDim.madeRockets, liveDim.madeRockets, 0.05)],
  [`advance under day and night is cheap (${advDark.ms.toFixed(1)} and ${advDim.ms.toFixed(1)} ms, want under 50)`, advDark.ms < 50 && advDim.ms < 50],
  [`state stays finite and under its caps, takes behave`, nan === 0 && overCap === 0 && took && tookRocket && refused],
]
let failed = 0
console.log('')
for (const [name, ok] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
}
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
// The repo has no node types, so reach the exit code through globalThis.
const proc = (globalThis as { process?: { exitCode?: number } }).process
if (failed > 0 && proc) proc.exitCode = 1
