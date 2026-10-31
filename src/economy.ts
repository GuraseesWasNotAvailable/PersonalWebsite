// The factories as numbers, with no renderer in sight.
//
// One SiteEconomy per factory site on Earth. Hauler bots hand ore to the dock
// (deliverOre) and it is split by the site's veins; smelters turn ore into
// ingots; assemblers fold iron, copper and silicon ingots into solar sails;
// rocket plants at the titanium sites build carrier rockets; and every machine
// runs at the site's power satisfaction, which is solar panels by day and ray
// receivers whenever the sphere has power to send. That last link is the loop
// the whole scene is about: the sphere keeps the factories running through
// the night, so the sphere builds itself faster the more of it there is.
//
// The chain is pooled rather than per machine. A site's three smelters are one
// furnace line, its two assemblers one bench, and work is a continuous rate,
// so the numbers come out the same at a 25 ms frame and at the few second
// steps the fast forward takes. Finished sails and rockets are whole items,
// because the belts and silos take them one at a time. Plain records and typed arrays,
// deterministic given the seed, nothing allocated in tick, never a NaN.

export type Ore = 'iron' | 'copper' | 'silicon' | 'titanium'
export const ORES: readonly Ore[] = ['iron', 'copper', 'silicon', 'titanium']

export type SiteEconomy = {
  veins: Record<Ore, number> // share of hauled ore of each kind, sums to 1
  ore: Record<Ore, number> // raw stock
  ingots: Record<Ore, number> // smelted stock
  sails: number // finished sails, waiting for the belts
  rockets: number // finished carrier rockets, waiting for the silo
  smelters: number
  assemblers: number
  rocketPlants: number // 0 at most sites; titanium rich sites have 1 or 2
  panels: number // solar panels
  receivers: number // ray receivers taking the sphere's power
  power: { supply: number; demand: number; satisfaction: number; solar: number; ray: number } // MW
  made: { sails: number; rockets: number } // running totals
}

export const RECIPES: {
  smelt: { seconds: 1; ore: 1 } // per smelter: 1 ore to 1 ingot each second
  sail: { seconds: 4; iron: 1; copper: 1; silicon: 1 } // per assembler
  rocket: { seconds: 12; titanium: 6; iron: 3; silicon: 2 } // per rocket plant
} = {
  smelt: { seconds: 1, ore: 1 },
  sail: { seconds: 4, iron: 1, copper: 1, silicon: 1 },
  rocket: { seconds: 12, titanium: 6, iron: 3, silicon: 2 },
}

export const POWER_MW: { smelter: 0.36; assembler: 0.27; rocketPlant: 0.9; panel: 0.36; receiverMax: 4 } = {
  smelter: 0.36,
  assembler: 0.27,
  rocketPlant: 0.9,
  panel: 0.36,
  receiverMax: 4,
}

// Per ore kind and per ingot kind, so stocks do not grow without bound. Big
// enough that a 10 s fast forward step never hits it mid step.
export const STOCK_CAP: number = 240

// Items one recipe cycle yields. Two assemblers folding one sail a cycle would
// give the eleven sites four sails a second against rails that fire thirteen,
// and the shells would take days to fill. Three a cycle puts the sites at
// twelve a second, which is what the sphere's face cells and the day long
// cycle are tuned to. Rockets are one a cycle, and three plants across the
// titanium sites give the quarter rocket a second the structure wants.
export const YIELD: { sail: 3; rocket: 1 } = { sail: 3, rocket: 1 }

// Finished goods the belts have not taken yet. When a site's rails cannot keep
// up, its assemblers idle at the cap instead of filling an endless warehouse,
// and their power demand drops with them.
export const FINISHED_CAP: { sails: number; rockets: number } = { sails: 3000, rockets: 240 }

// Time constant of the production rate average, seconds.
export const RATE_TAU = 15

// A full Earth day in simulation seconds, the period of the sun the fast
// forward drives its sites with.
export const DAY_S = 126

// The fast forward ticks the real chain at coarse steps through sixteen day
// and night cycles, averages the last four whole days, and extrapolates the
// rest in closed form from that average. Sixteen because the ingot stocks
// take up to ten days to reach their caps (the scarcest vein nets under a
// fifth of an ingot a second of running time, and a dark night runs nothing),
// and until they do the furnace line asks for full power, so the output of a
// site under a partly lit night is a fifth lower than it will settle at.
// Thirty six steps a day, so a day is a whole number of steps and the average
// covers whole days exactly, and so the dawn and dusk ramps are resolved:
// with a dark night the satisfaction is min(1, 4 sin) of the Sun's angle,
// already 1 a few degrees up, and twelve steps a day missed the ramps and
// overshot the live chain by a few percent. The whole run is a few ms.
const ADVANCE_STEPS_PER_DAY = 36
const ADVANCE_DT = DAY_S / ADVANCE_STEPS_PER_DAY
const ADVANCE_WARM_DAYS = 16
const ADVANCE_AVG_DAYS = 4
const ADVANCE_WARMUP_S = ADVANCE_WARM_DAYS * DAY_S
const ADVANCE_AVG_FROM_S = (ADVANCE_WARM_DAYS - ADVANCE_AVG_DAYS) * DAY_S
// What the belts and silos leave on the dock after a fast forward: a handful
// of sails ready to pack and a rocket standing by for the pad.
const WORKING_SAILS = 8
const WORKING_ROCKETS = 1

const BUILDINGS = { smelters: 3, assemblers: 2, panels: 12, receivers: 2 }

function stock(): Record<Ore, number> {
  return { iron: 0, copper: 0, silicon: 0, titanium: 0 }
}

export class Economy {
  readonly sites: SiteEconomy[]
  time = 0 // simulation seconds this economy has run, including fast forwards
  private readonly totalReceivers: number
  private sailRate = 0
  private rocketRate = 0
  private supplyMW = 0
  private demandMW = 0
  // Scratch and per site bookkeeping, allocated once so tick never does.
  private readonly wantK = new Float64Array(4)
  private readonly sailFrac: Float64Array
  private readonly rocketFrac: Float64Array
  private readonly prodSail: Float64Array // sails per second each site made in the last tick
  private readonly prodRocket: Float64Array
  // The fast forward's sun schedule and its whole day production tallies.
  private readonly warmSun: Float32Array
  private readonly daySail: Float64Array
  private readonly dayRocket: Float64Array

  constructor(siteCount: number, rand: () => number) {
    const n = Math.max(0, Math.floor(siteCount))
    // Which sites sit on titanium. Distinct picks from the seed, so the page
    // and the tests agree on the map; three of eleven, fewer for a small world.
    const order: number[] = []
    for (let i = 0; i < n; i++) order.push(i)
    const tiCount = Math.min(3, Math.floor(n / 3))
    for (let k = 0; k < tiCount; k++) {
      const j = k + Math.floor(rand() * (n - k))
      const t = order[k]
      order[k] = order[j]
      order[j] = t
    }
    const isTi = new Uint8Array(n)
    for (let k = 0; k < tiCount; k++) isTi[order[k]] = 1

    this.sites = []
    for (let i = 0; i < n; i++) {
      const ti = isTi[i] === 1
      const veins = stock()
      if (ti) {
        // Titanium rich, no copper, so these sites make rockets and no sails.
        veins.titanium = 0.5
        veins.iron = 0.2 + 0.1 * rand()
        veins.silicon = 1 - veins.titanium - veins.iron
      } else {
        // Every share stays above a fifth, so the scarcest ingot still arrives
        // faster than two assemblers can use it.
        veins.iron = 0.3 + 0.15 * rand()
        veins.copper = 0.22 + 0.13 * rand()
        veins.silicon = 1 - veins.iron - veins.copper
      }
      this.sites.push({
        veins,
        ore: stock(),
        ingots: stock(),
        sails: 0,
        rockets: 0,
        smelters: BUILDINGS.smelters,
        assemblers: BUILDINGS.assemblers,
        rocketPlants: ti ? 1 : 0,
        panels: BUILDINGS.panels,
        receivers: BUILDINGS.receivers,
        power: { supply: 0, demand: 0, satisfaction: 1, solar: 0, ray: 0 },
        made: { sails: 0, rockets: 0 },
      })
    }
    let receivers = 0
    for (const s of this.sites) receivers += s.receivers
    this.totalReceivers = receivers
    this.sailFrac = new Float64Array(n)
    this.rocketFrac = new Float64Array(n)
    this.prodSail = new Float64Array(n)
    this.prodRocket = new Float64Array(n)
    this.warmSun = new Float32Array(n)
    this.daySail = new Float64Array(n)
    this.dayRocket = new Float64Array(n)
  }

  // Haulers hand ore to the factory dock. Split by the site's veins; whatever
  // does not fit under the cap stays on the belt, which is the ground's
  // business (it checks the room before unloading).
  deliverOre(site: number, amount: number): void {
    if (!(amount > 0)) return
    const s = this.sites[site]
    if (!s) return
    for (let k = 0; k < 4; k++) {
      const o = ORES[k]
      const v = s.veins[o]
      if (v <= 0) continue
      let x = s.ore[o] + amount * v
      if (x > STOCK_CAP) x = STOCK_CAP
      s.ore[o] = x
    }
  }

  // One step. sun[i] is the Sun's elevation at site i in 0..1 (0 at night).
  // sphereMW is the whole sphere's output; each receiver draws up to
  // receiverMax of its fair share. Smelting and assembly run at
  // satisfaction = min(1, supply / demand), where supply is solar + ray and
  // demand is every building that has something to do.
  tick(dt: number, sun: ArrayLike<number>, sphereMW: number): void {
    if (!(dt > 0)) return
    const sites = this.sites
    const n = sites.length
    const share = sphereMW > 0 && this.totalReceivers > 0 ? Math.min(POWER_MW.receiverMax, sphereMW / this.totalReceivers) : 0
    const wantK = this.wantK
    let sailsMade = 0
    let rocketsMade = 0
    let supplySum = 0
    let demandSum = 0

    for (let i = 0; i < n; i++) {
      const s = sites[i]
      const ore = s.ore
      const ing = s.ingots
      const el = sun[i]
      const sunI = el > 0 ? (el < 1 ? el : 1) : 0
      const solar = s.panels * POWER_MW.panel * sunI
      const ray = s.receivers * share

      // What has something to do this step, at full power. The furnace line
      // wants every ore it holds that has ingot room; the bench wants as many
      // cycles as the scarcest ingot and the finished cap allow.
      const smeltCap = s.smelters * (RECIPES.smelt.ore / RECIPES.smelt.seconds) * dt
      let want = 0
      for (let k = 0; k < 4; k++) {
        const o = ORES[k]
        let w = ore[o]
        const room = STOCK_CAP - ing[o]
        if (room < w) w = room
        if (w < 0) w = 0
        wantK[k] = w
        want += w
      }
      // The bench and the plants take from the stock after this step's smelt,
      // so they are asked against the stock plus what the line would add at
      // full power. Asked against the stock alone, a site whose ingots are
      // eaten the moment they leave the furnace reports no bench demand and
      // then runs its bench on power it never had. wantK[k] is at most the
      // ingot room, so these never exceed STOCK_CAP.
      const fullF = want > smeltCap ? smeltCap / want : 1
      const fe = ing.iron + wantK[0] * fullF
      const cu = ing.copper + wantK[1] * fullF
      const si = ing.silicon + wantK[2] * fullF
      const ti = ing.titanium + wantK[3] * fullF
      const sailCap = (s.assemblers * dt) / RECIPES.sail.seconds
      let sailCan = Math.min(fe / RECIPES.sail.iron, cu / RECIPES.sail.copper, si / RECIPES.sail.silicon, (FINISHED_CAP.sails - s.sails) / YIELD.sail)
      if (sailCan < 0) sailCan = 0
      const rocketCap = (s.rocketPlants * dt) / RECIPES.rocket.seconds
      let rocketCan = Math.min(ti / RECIPES.rocket.titanium, fe / RECIPES.rocket.iron, si / RECIPES.rocket.silicon, (FINISHED_CAP.rockets - s.rockets) / YIELD.rocket)
      if (rocketCan < 0) rocketCan = 0

      const fS = smeltCap > 0 ? Math.min(1, want / smeltCap) : 0
      const fA = sailCap > 0 ? Math.min(1, sailCan / sailCap) : 0
      const fR = rocketCap > 0 ? Math.min(1, rocketCan / rocketCap) : 0
      const demand = s.smelters * POWER_MW.smelter * fS + s.assemblers * POWER_MW.assembler * fA + s.rocketPlants * POWER_MW.rocketPlant * fR
      const supply = solar + ray
      const sat = demand > 0 ? Math.min(1, supply / demand) : 1
      s.power.solar = solar
      s.power.ray = ray
      s.power.supply = supply
      s.power.demand = demand
      s.power.satisfaction = sat
      supplySum += supply
      demandSum += demand

      // Smelt, spreading the line's capacity over the kinds in proportion to
      // what each one has waiting. Ingot caps throttle the kinds the bench
      // is not using, so the line settles at exactly the consumption rate.
      const smelt = (want < smeltCap ? want : smeltCap) * sat
      if (smelt > 0) {
        const f = smelt / want
        for (let k = 0; k < 4; k++) {
          const o = ORES[k]
          const a = wantK[k] * f
          if (a <= 0) continue
          let left = ore[o] - a
          if (left < 0) left = 0
          ore[o] = left
          let got = ing[o] + a
          if (got > STOCK_CAP) got = STOCK_CAP
          ing[o] = got
        }
      }

      // Rockets first, since they are the scarce product and share iron and
      // silicon with the bench; then sails.
      let rc = rocketCap * sat
      if (rc > 0) {
        const can = Math.min(ing.titanium / RECIPES.rocket.titanium, ing.iron / RECIPES.rocket.iron, ing.silicon / RECIPES.rocket.silicon, (FINISHED_CAP.rockets - s.rockets) / YIELD.rocket)
        if (can < rc) rc = can
      }
      if (rc > 0) {
        ing.titanium = Math.max(0, ing.titanium - rc * RECIPES.rocket.titanium)
        ing.iron = Math.max(0, ing.iron - rc * RECIPES.rocket.iron)
        ing.silicon = Math.max(0, ing.silicon - rc * RECIPES.rocket.silicon)
        const made = rc * YIELD.rocket
        const acc = this.rocketFrac[i] + made
        const whole = Math.floor(acc)
        this.rocketFrac[i] = acc - whole
        s.rockets += whole
        s.made.rockets += whole
        rocketsMade += made
        this.prodRocket[i] = made / dt
      } else this.prodRocket[i] = 0

      let sc = sailCap * sat
      if (sc > 0) {
        const can = Math.min(ing.iron / RECIPES.sail.iron, ing.copper / RECIPES.sail.copper, ing.silicon / RECIPES.sail.silicon, (FINISHED_CAP.sails - s.sails) / YIELD.sail)
        if (can < sc) sc = can
      }
      if (sc > 0) {
        ing.iron = Math.max(0, ing.iron - sc * RECIPES.sail.iron)
        ing.copper = Math.max(0, ing.copper - sc * RECIPES.sail.copper)
        ing.silicon = Math.max(0, ing.silicon - sc * RECIPES.sail.silicon)
        const made = sc * YIELD.sail
        const acc = this.sailFrac[i] + made
        const whole = Math.floor(acc)
        this.sailFrac[i] = acc - whole
        s.sails += whole
        s.made.sails += whole
        sailsMade += made
        this.prodSail[i] = made / dt
      } else this.prodSail[i] = 0
    }

    // Production rates as an exponential moving average of the work done, so
    // the readout does not flicker with the sub item remainders.
    const alpha = 1 - Math.exp(-dt / RATE_TAU)
    this.sailRate += (sailsMade / dt - this.sailRate) * alpha
    this.rocketRate += (rocketsMade / dt - this.rocketRate) * alpha
    this.supplyMW = supplySum
    this.demandMW = demandSum
    this.time += dt
  }

  // Consume one finished sail for a belt package.
  takeSail(site: number): boolean {
    const s = this.sites[site]
    if (!s || s.sails < 1) return false
    s.sails -= 1
    return true
  }

  // Consume one finished rocket for a silo.
  takeRocket(site: number): boolean {
    const s = this.sites[site]
    if (!s || s.rockets < 1) return false
    s.rockets -= 1
    return true
  }

  // Recent production rates across all sites, in items per second, and the
  // power picture of the last tick. A fresh object each call; it is a query,
  // not a per step method.
  rates(): { sailsPerSec: number; rocketsPerSec: number; supplyMW: number; demandMW: number } {
    return { sailsPerSec: this.sailRate, rocketsPerSec: this.rocketRate, supplyMW: this.supplyMW, demandMW: this.demandMW }
  }

  // Fast forward: the state after `seconds` at a given hauled ore rate per
  // site, a day and night sun cycle spread across the sites, and a sphere
  // output of sphereMW. The real chain is ticked at coarse steps through
  // sixteen days (the stocks have settled by the tenth), the last four whole
  // days are averaged per site, and the remaining time is added in closed
  // form from that average. A flat mean sun would not do: half a day of panels covers
  // every machine, so a site under the mean never sees the night that the
  // live sites spend dark whenever the sphere cannot light it, and the fast
  // forward would put the build about twice as far along as the live engine.
  // The belts and silos are assumed to have taken the output all along, so
  // the docks end with a working handful rather than a day's pile. rates()
  // afterwards reports the day average, which is what the sphere's own fast
  // forward and the first readout should see.
  advance(seconds: number, oreRatePerSite: number, sphereMW: number): void {
    if (!(seconds > 0)) return
    const sites = this.sites
    const n = sites.length
    const sun = this.warmSun
    const daySail = this.daySail
    const dayRocket = this.dayRocket
    const warm = seconds < ADVANCE_WARMUP_S ? seconds : ADVANCE_WARMUP_S
    const steps = Math.max(1, Math.ceil(warm / ADVANCE_DT - 1e-9))
    const dt = warm / steps
    const haul = oreRatePerSite > 0 ? oreRatePerSite * dt : 0
    daySail.fill(0)
    dayRocket.fill(0)
    let avgFrom = -1
    for (let st = 0; st < steps; st++) {
      const t = st * dt
      // The Sun's elevation over the step at each site: a clipped sine, as the
      // ground reports it, with the sites spread round the planet so they do
      // not all see noon at once. Sampled at the step's middle.
      for (let i = 0; i < n; i++) sun[i] = Math.max(0, Math.sin(2 * Math.PI * ((t + 0.5 * dt) / DAY_S + i / n)))
      for (let i = 0; i < n; i++) this.deliverOre(i, haul)
      this.tick(dt, sun, sphereMW)
      for (let i = 0; i < n; i++) {
        const s = sites[i]
        if (s.sails > WORKING_SAILS) s.sails = WORKING_SAILS
        if (s.rockets > WORKING_ROCKETS) s.rockets = WORKING_ROCKETS
      }
      // Over the last whole days, with the stocks settled, tally the work of
      // every step, fractions and all, so the average is exact.
      if (t >= ADVANCE_AVG_FROM_S - 1e-9) {
        if (avgFrom < 0) avgFrom = t
        for (let i = 0; i < n; i++) {
          daySail[i] += this.prodSail[i] * dt
          dayRocket[i] += this.prodRocket[i] * dt
        }
      }
    }
    const span = avgFrom >= 0 ? warm - avgFrom : 0
    if (span > 0) {
      let sails = 0
      let rockets = 0
      for (let i = 0; i < n; i++) {
        sails += daySail[i] / span
        rockets += dayRocket[i] / span
      }
      this.sailRate = sails
      this.rocketRate = rockets
    }
    const rest = seconds - warm
    if (rest > 0) {
      for (let i = 0; i < n; i++) {
        const s = sites[i]
        const sailPerS = span > 0 ? daySail[i] / span : this.prodSail[i]
        const rocketPerS = span > 0 ? dayRocket[i] / span : this.prodRocket[i]
        s.made.sails += Math.floor(sailPerS * rest)
        s.made.rockets += Math.floor(rocketPerS * rest)
      }
      this.time += rest
    }
  }
}
