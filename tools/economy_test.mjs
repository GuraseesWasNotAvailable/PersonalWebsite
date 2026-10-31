// src/economy.ts
var ORES = ["iron", "copper", "silicon", "titanium"];
var RECIPES = {
  smelt: { seconds: 1, ore: 1 },
  sail: { seconds: 4, iron: 1, copper: 1, silicon: 1 },
  rocket: { seconds: 12, titanium: 6, iron: 3, silicon: 2 }
};
var POWER_MW = {
  smelter: 0.36,
  assembler: 0.27,
  rocketPlant: 0.9,
  panel: 0.36,
  receiverMax: 4
};
var STOCK_CAP = 240;
var YIELD = { sail: 3, rocket: 1 };
var FINISHED_CAP = { sails: 3e3, rockets: 240 };
var RATE_TAU = 15;
var DAY_S = 126;
var ADVANCE_STEPS_PER_DAY = 36;
var ADVANCE_DT = DAY_S / ADVANCE_STEPS_PER_DAY;
var ADVANCE_WARM_DAYS = 16;
var ADVANCE_AVG_DAYS = 4;
var ADVANCE_WARMUP_S = ADVANCE_WARM_DAYS * DAY_S;
var ADVANCE_AVG_FROM_S = (ADVANCE_WARM_DAYS - ADVANCE_AVG_DAYS) * DAY_S;
var WORKING_SAILS = 8;
var WORKING_ROCKETS = 1;
var BUILDINGS = { smelters: 3, assemblers: 2, panels: 12, receivers: 2 };
function stock() {
  return { iron: 0, copper: 0, silicon: 0, titanium: 0 };
}
var Economy = class {
  sites;
  time = 0;
  // simulation seconds this economy has run, including fast forwards
  totalReceivers;
  sailRate = 0;
  rocketRate = 0;
  supplyMW = 0;
  demandMW = 0;
  // Scratch and per site bookkeeping, allocated once so tick never does.
  wantK = new Float64Array(4);
  sailFrac;
  rocketFrac;
  prodSail;
  // sails per second each site made in the last tick
  prodRocket;
  // The fast forward's sun schedule and its whole day production tallies.
  warmSun;
  daySail;
  dayRocket;
  constructor(siteCount, rand) {
    const n = Math.max(0, Math.floor(siteCount));
    const order = [];
    for (let i = 0; i < n; i++) order.push(i);
    const tiCount = Math.min(3, Math.floor(n / 3));
    for (let k = 0; k < tiCount; k++) {
      const j = k + Math.floor(rand() * (n - k));
      const t = order[k];
      order[k] = order[j];
      order[j] = t;
    }
    const isTi = new Uint8Array(n);
    for (let k = 0; k < tiCount; k++) isTi[order[k]] = 1;
    this.sites = [];
    for (let i = 0; i < n; i++) {
      const ti = isTi[i] === 1;
      const veins = stock();
      if (ti) {
        veins.titanium = 0.5;
        veins.iron = 0.2 + 0.1 * rand();
        veins.silicon = 1 - veins.titanium - veins.iron;
      } else {
        veins.iron = 0.3 + 0.15 * rand();
        veins.copper = 0.22 + 0.13 * rand();
        veins.silicon = 1 - veins.iron - veins.copper;
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
        made: { sails: 0, rockets: 0 }
      });
    }
    let receivers = 0;
    for (const s of this.sites) receivers += s.receivers;
    this.totalReceivers = receivers;
    this.sailFrac = new Float64Array(n);
    this.rocketFrac = new Float64Array(n);
    this.prodSail = new Float64Array(n);
    this.prodRocket = new Float64Array(n);
    this.warmSun = new Float32Array(n);
    this.daySail = new Float64Array(n);
    this.dayRocket = new Float64Array(n);
  }
  // Haulers hand ore to the factory dock. Split by the site's veins; whatever
  // does not fit under the cap stays on the belt, which is the ground's
  // business (it checks the room before unloading).
  deliverOre(site, amount) {
    if (!(amount > 0)) return;
    const s = this.sites[site];
    if (!s) return;
    for (let k = 0; k < 4; k++) {
      const o = ORES[k];
      const v = s.veins[o];
      if (v <= 0) continue;
      let x = s.ore[o] + amount * v;
      if (x > STOCK_CAP) x = STOCK_CAP;
      s.ore[o] = x;
    }
  }
  // One step. sun[i] is the Sun's elevation at site i in 0..1 (0 at night).
  // sphereMW is the whole sphere's output; each receiver draws up to
  // receiverMax of its fair share. Smelting and assembly run at
  // satisfaction = min(1, supply / demand), where supply is solar + ray and
  // demand is every building that has something to do.
  tick(dt, sun, sphereMW) {
    if (!(dt > 0)) return;
    const sites = this.sites;
    const n = sites.length;
    const share = sphereMW > 0 && this.totalReceivers > 0 ? Math.min(POWER_MW.receiverMax, sphereMW / this.totalReceivers) : 0;
    const wantK = this.wantK;
    let sailsMade = 0;
    let rocketsMade = 0;
    let supplySum = 0;
    let demandSum = 0;
    for (let i = 0; i < n; i++) {
      const s = sites[i];
      const ore = s.ore;
      const ing = s.ingots;
      const el = sun[i];
      const sunI = el > 0 ? el < 1 ? el : 1 : 0;
      const solar = s.panels * POWER_MW.panel * sunI;
      const ray = s.receivers * share;
      const smeltCap = s.smelters * (RECIPES.smelt.ore / RECIPES.smelt.seconds) * dt;
      let want = 0;
      for (let k = 0; k < 4; k++) {
        const o = ORES[k];
        let w = ore[o];
        const room = STOCK_CAP - ing[o];
        if (room < w) w = room;
        if (w < 0) w = 0;
        wantK[k] = w;
        want += w;
      }
      const fullF = want > smeltCap ? smeltCap / want : 1;
      const fe = ing.iron + wantK[0] * fullF;
      const cu = ing.copper + wantK[1] * fullF;
      const si = ing.silicon + wantK[2] * fullF;
      const ti = ing.titanium + wantK[3] * fullF;
      const sailCap = s.assemblers * dt / RECIPES.sail.seconds;
      let sailCan = Math.min(fe / RECIPES.sail.iron, cu / RECIPES.sail.copper, si / RECIPES.sail.silicon, (FINISHED_CAP.sails - s.sails) / YIELD.sail);
      if (sailCan < 0) sailCan = 0;
      const rocketCap = s.rocketPlants * dt / RECIPES.rocket.seconds;
      let rocketCan = Math.min(ti / RECIPES.rocket.titanium, fe / RECIPES.rocket.iron, si / RECIPES.rocket.silicon, (FINISHED_CAP.rockets - s.rockets) / YIELD.rocket);
      if (rocketCan < 0) rocketCan = 0;
      const fS = smeltCap > 0 ? Math.min(1, want / smeltCap) : 0;
      const fA = sailCap > 0 ? Math.min(1, sailCan / sailCap) : 0;
      const fR = rocketCap > 0 ? Math.min(1, rocketCan / rocketCap) : 0;
      const demand = s.smelters * POWER_MW.smelter * fS + s.assemblers * POWER_MW.assembler * fA + s.rocketPlants * POWER_MW.rocketPlant * fR;
      const supply = solar + ray;
      const sat = demand > 0 ? Math.min(1, supply / demand) : 1;
      s.power.solar = solar;
      s.power.ray = ray;
      s.power.supply = supply;
      s.power.demand = demand;
      s.power.satisfaction = sat;
      supplySum += supply;
      demandSum += demand;
      const smelt = (want < smeltCap ? want : smeltCap) * sat;
      if (smelt > 0) {
        const f = smelt / want;
        for (let k = 0; k < 4; k++) {
          const o = ORES[k];
          const a = wantK[k] * f;
          if (a <= 0) continue;
          let left = ore[o] - a;
          if (left < 0) left = 0;
          ore[o] = left;
          let got = ing[o] + a;
          if (got > STOCK_CAP) got = STOCK_CAP;
          ing[o] = got;
        }
      }
      let rc = rocketCap * sat;
      if (rc > 0) {
        const can = Math.min(ing.titanium / RECIPES.rocket.titanium, ing.iron / RECIPES.rocket.iron, ing.silicon / RECIPES.rocket.silicon, (FINISHED_CAP.rockets - s.rockets) / YIELD.rocket);
        if (can < rc) rc = can;
      }
      if (rc > 0) {
        ing.titanium = Math.max(0, ing.titanium - rc * RECIPES.rocket.titanium);
        ing.iron = Math.max(0, ing.iron - rc * RECIPES.rocket.iron);
        ing.silicon = Math.max(0, ing.silicon - rc * RECIPES.rocket.silicon);
        const made = rc * YIELD.rocket;
        const acc = this.rocketFrac[i] + made;
        const whole = Math.floor(acc);
        this.rocketFrac[i] = acc - whole;
        s.rockets += whole;
        s.made.rockets += whole;
        rocketsMade += made;
        this.prodRocket[i] = made / dt;
      } else this.prodRocket[i] = 0;
      let sc = sailCap * sat;
      if (sc > 0) {
        const can = Math.min(ing.iron / RECIPES.sail.iron, ing.copper / RECIPES.sail.copper, ing.silicon / RECIPES.sail.silicon, (FINISHED_CAP.sails - s.sails) / YIELD.sail);
        if (can < sc) sc = can;
      }
      if (sc > 0) {
        ing.iron = Math.max(0, ing.iron - sc * RECIPES.sail.iron);
        ing.copper = Math.max(0, ing.copper - sc * RECIPES.sail.copper);
        ing.silicon = Math.max(0, ing.silicon - sc * RECIPES.sail.silicon);
        const made = sc * YIELD.sail;
        const acc = this.sailFrac[i] + made;
        const whole = Math.floor(acc);
        this.sailFrac[i] = acc - whole;
        s.sails += whole;
        s.made.sails += whole;
        sailsMade += made;
        this.prodSail[i] = made / dt;
      } else this.prodSail[i] = 0;
    }
    const alpha = 1 - Math.exp(-dt / RATE_TAU);
    this.sailRate += (sailsMade / dt - this.sailRate) * alpha;
    this.rocketRate += (rocketsMade / dt - this.rocketRate) * alpha;
    this.supplyMW = supplySum;
    this.demandMW = demandSum;
    this.time += dt;
  }
  // Consume one finished sail for a belt package.
  takeSail(site) {
    const s = this.sites[site];
    if (!s || s.sails < 1) return false;
    s.sails -= 1;
    return true;
  }
  // Consume one finished rocket for a silo.
  takeRocket(site) {
    const s = this.sites[site];
    if (!s || s.rockets < 1) return false;
    s.rockets -= 1;
    return true;
  }
  // Recent production rates across all sites, in items per second, and the
  // power picture of the last tick. A fresh object each call; it is a query,
  // not a per step method.
  rates() {
    return { sailsPerSec: this.sailRate, rocketsPerSec: this.rocketRate, supplyMW: this.supplyMW, demandMW: this.demandMW };
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
  advance(seconds, oreRatePerSite, sphereMW) {
    if (!(seconds > 0)) return;
    const sites = this.sites;
    const n = sites.length;
    const sun = this.warmSun;
    const daySail = this.daySail;
    const dayRocket = this.dayRocket;
    const warm = seconds < ADVANCE_WARMUP_S ? seconds : ADVANCE_WARMUP_S;
    const steps = Math.max(1, Math.ceil(warm / ADVANCE_DT - 1e-9));
    const dt = warm / steps;
    const haul = oreRatePerSite > 0 ? oreRatePerSite * dt : 0;
    daySail.fill(0);
    dayRocket.fill(0);
    let avgFrom = -1;
    for (let st = 0; st < steps; st++) {
      const t = st * dt;
      for (let i = 0; i < n; i++) sun[i] = Math.max(0, Math.sin(2 * Math.PI * ((t + 0.5 * dt) / DAY_S + i / n)));
      for (let i = 0; i < n; i++) this.deliverOre(i, haul);
      this.tick(dt, sun, sphereMW);
      for (let i = 0; i < n; i++) {
        const s = sites[i];
        if (s.sails > WORKING_SAILS) s.sails = WORKING_SAILS;
        if (s.rockets > WORKING_ROCKETS) s.rockets = WORKING_ROCKETS;
      }
      if (t >= ADVANCE_AVG_FROM_S - 1e-9) {
        if (avgFrom < 0) avgFrom = t;
        for (let i = 0; i < n; i++) {
          daySail[i] += this.prodSail[i] * dt;
          dayRocket[i] += this.prodRocket[i] * dt;
        }
      }
    }
    const span = avgFrom >= 0 ? warm - avgFrom : 0;
    if (span > 0) {
      let sails = 0;
      let rockets = 0;
      for (let i = 0; i < n; i++) {
        sails += daySail[i] / span;
        rockets += dayRocket[i] / span;
      }
      this.sailRate = sails;
      this.rocketRate = rockets;
    }
    const rest = seconds - warm;
    if (rest > 0) {
      for (let i = 0; i < n; i++) {
        const s = sites[i];
        const sailPerS = span > 0 ? daySail[i] / span : this.prodSail[i];
        const rocketPerS = span > 0 ? dayRocket[i] / span : this.prodRocket[i];
        s.made.sails += Math.floor(sailPerS * rest);
        s.made.rockets += Math.floor(rocketPerS * rest);
      }
      this.time += rest;
    }
  }
};

// src/swarm.ts
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// tools/economy_test.ts
var N = 11;
var DT = 0.1;
var ORE_PER_S = 3.6;
var PHASE_S = 600;
var eco = new Economy(N, mulberry32(11));
var ones = new Float32Array(N).fill(1);
var zeros = new Float32Array(N);
console.log(`${eco.sites.length} sites, recipes: smelt ${RECIPES.smelt.ore} ore/${RECIPES.smelt.seconds}s, sail ${RECIPES.sail.seconds}s for ${YIELD.sail}, rocket ${RECIPES.rocket.seconds}s for ${YIELD.rocket}; stock cap ${STOCK_CAP}, finished cap ${FINISHED_CAP.sails}/${FINISHED_CAP.rockets}`);
var plants = 0;
for (const s of eco.sites) {
  plants += s.rocketPlants;
  const v = ORES.map((k) => `${k.slice(0, 2)} ${(s.veins[k] * 100).toFixed(0)}%`).join(" ");
  const sum = ORES.reduce((a, k) => a + s.veins[k], 0);
  console.log(`  site ${eco.sites.indexOf(s) + 1}: ${s.rocketPlants ? "titanium " : "sail     "} ${v} (sum ${sum.toFixed(3)}) smelters ${s.smelters} assemblers ${s.assemblers} plants ${s.rocketPlants} panels ${s.panels} receivers ${s.receivers}`);
}
console.log(`rocket plants in all: ${plants}`);
function run(seconds, sun, sphereMW) {
  const steps = Math.round(seconds / DT);
  const t02 = performance.now();
  for (let st = 0; st < steps; st++) {
    for (let i = 0; i < N; i++) eco.deliverOre(i, ORE_PER_S * DT);
    eco.tick(DT, sun, sphereMW);
  }
  return (performance.now() - t02) / steps;
}
function fmt(r) {
  const sat = r.demandMW > 0 ? Math.min(1, r.supplyMW / r.demandMW) : 1;
  return `${r.sailsPerSec.toFixed(2)} sails/s, ${r.rocketsPerSec.toFixed(3)} rockets/s, power ${r.supplyMW.toFixed(1)}/${r.demandMW.toFixed(1)} MW (${(sat * 100).toFixed(0)}% satisfied)`;
}
function snapshot(label) {
  const sail = eco.sites.find((s) => s.rocketPlants === 0);
  const ti = eco.sites.find((s) => s.rocketPlants > 0);
  for (const [name, s] of [["sail site", sail], ["titanium site", ti]]) {
    const ore = ORES.map((k) => s.ore[k].toFixed(0)).join("/");
    const ing = ORES.map((k) => s.ingots[k].toFixed(1)).join("/");
    console.log(`    ${label} ${name}: ore ${ore} ingots ${ing} sails ${s.sails} rockets ${s.rockets} made ${s.made.sails}/${s.made.rockets} power solar ${s.power.solar.toFixed(2)} ray ${s.power.ray.toFixed(2)} demand ${s.power.demand.toFixed(2)} sat ${s.power.satisfaction.toFixed(2)}`);
  }
}
var msA = run(PHASE_S, ones, 0);
var day = eco.rates();
console.log(`
after ${PHASE_S} s of full sun, no sphere: ${fmt(day)}`);
snapshot("day");
run(PHASE_S, zeros, 0);
var nightDark = eco.rates();
console.log(`after ${PHASE_S} s of night, no sphere:     ${fmt(nightDark)}`);
snapshot("dark");
run(PHASE_S, zeros, 60);
var nightLit = eco.rates();
console.log(`after ${PHASE_S} s of night, 60 MW sphere:  ${fmt(nightLit)}`);
snapshot("lit");
console.log(`tick cost ${(msA * 1e3).toFixed(1)} us per step for ${N} sites`);
var fresh = new Economy(N, mulberry32(11));
var t0 = performance.now();
fresh.advance(2e4, ORE_PER_S, 30);
var msAdv = performance.now() - t0;
var adv = fresh.rates();
var madeSails = 0;
var madeRockets = 0;
var dockSails = 0;
var dockRockets = 0;
for (const s of fresh.sites) {
  madeSails += s.made.sails;
  madeRockets += s.made.rockets;
  dockSails += s.sails;
  dockRockets += s.rockets;
}
console.log(`
fresh economy after advance(20000, ${ORE_PER_S}, 30) in ${msAdv.toFixed(1)} ms: ${fmt(adv)}`);
console.log(`  made ${madeSails} sails and ${madeRockets} rockets in all (${(madeSails / 2e4).toFixed(2)}/s and ${(madeRockets / 2e4).toFixed(3)}/s over the 20000 s); on the docks ${dockSails} sails, ${dockRockets} rockets; time ${fresh.time}`);
var LEAN_ORE = 1;
var LEAN_SUN = 0.1;
var LEAN_S = 600;
var dim = new Float32Array(N).fill(LEAN_SUN);
function starved(dt) {
  const lean = new Economy(N, mulberry32(11));
  const steps = Math.round(LEAN_S / dt);
  for (let st = 0; st < steps; st++) {
    for (let i = 0; i < N; i++) lean.deliverOre(i, LEAN_ORE * dt);
    lean.tick(dt, dim, 0);
  }
  let drawn = 0;
  let supplied = 0;
  let sails = 0;
  for (const s of lean.sites) {
    let ingots = 0;
    for (const k of ORES) ingots += s.ingots[k];
    const sailCycles = s.made.sails / YIELD.sail;
    const rocketCycles = s.made.rockets / YIELD.rocket;
    const smelted = ingots + sailCycles * (RECIPES.sail.iron + RECIPES.sail.copper + RECIPES.sail.silicon) + rocketCycles * (RECIPES.rocket.titanium + RECIPES.rocket.iron + RECIPES.rocket.silicon);
    drawn += smelted / RECIPES.smelt.ore * RECIPES.smelt.seconds * POWER_MW.smelter;
    drawn += sailCycles * RECIPES.sail.seconds * POWER_MW.assembler;
    drawn += rocketCycles * RECIPES.rocket.seconds * POWER_MW.rocketPlant;
    supplied += s.panels * POWER_MW.panel * LEAN_SUN * LEAN_S;
    sails += s.made.sails;
  }
  const site = lean.sites.find((s) => s.rocketPlants === 0);
  return { drawn, supplied, sailsPerSec: sails / LEAN_S, demand: site.power.demand, sat: site.power.satisfaction };
}
var leanFrame = starved(0.045);
var leanCoarse = starved(1);
var leanSites = eco.sites.filter((s) => s.rocketPlants === 0);
var leanSite = leanSites[0];
var leanDemand = leanSite.smelters * POWER_MW.smelter + leanSite.assemblers * POWER_MW.assembler;
var leanSat = Math.min(1, leanSite.panels * POWER_MW.panel * LEAN_SUN / leanDemand);
var leanBudgetSails = leanSites.length * leanSite.assemblers * YIELD.sail * leanSat / RECIPES.sail.seconds;
console.log(`
starved: ${LEAN_ORE} ore/s hauled, sun ${LEAN_SUN}, no sphere, ${LEAN_S} s`);
console.log(`  at dt 0.045: drew ${leanFrame.drawn.toFixed(0)} MJ of ${leanFrame.supplied.toFixed(0)} MJ supplied, ${leanFrame.sailsPerSec.toFixed(2)} sails/s (budget ${leanBudgetSails.toFixed(2)}), sail site demand ${leanFrame.demand.toFixed(3)} MW sat ${leanFrame.sat.toFixed(3)}`);
console.log(`  at dt 1:     drew ${leanCoarse.drawn.toFixed(0)} MJ of ${leanCoarse.supplied.toFixed(0)} MJ supplied, ${leanCoarse.sailsPerSec.toFixed(2)} sails/s, sail site demand ${leanCoarse.demand.toFixed(3)} MW sat ${leanCoarse.sat.toFixed(3)}`);
var SPAN_S = 2e4;
var SETTLED_DAYS = 4;
function dayNight(sphereMW) {
  const live = new Economy(N, mulberry32(11));
  const sun = new Float32Array(N);
  const steps = Math.round(SPAN_S / DT);
  const from = Math.round((SPAN_S - SETTLED_DAYS * DAY_S) / DT);
  let sails0 = 0;
  let rockets0 = 0;
  const made = () => live.sites.reduce((a, s) => [a[0] + s.made.sails, a[1] + s.made.rockets], [0, 0]);
  for (let st = 0; st < steps; st++) {
    const t = st * DT;
    for (let i = 0; i < N; i++) sun[i] = Math.max(0, Math.sin(2 * Math.PI * ((t + 0.5 * DT) / DAY_S + i / N)));
    for (let i = 0; i < N; i++) live.deliverOre(i, ORE_PER_S * DT);
    live.tick(DT, sun, sphereMW);
    for (const s of live.sites) {
      if (s.sails > 8) s.sails = 8;
      if (s.rockets > 1) s.rockets = 1;
    }
    if (st === from) [sails0, rockets0] = made();
  }
  const [sails1, rockets1] = made();
  const span = (steps - from) * DT;
  return { sailsPerSec: (sails1 - sails0) / span, rocketsPerSec: (rockets1 - rockets0) / span, madeSails: sails1, madeRockets: rockets1 };
}
function fastForward(sphereMW) {
  const e = new Economy(N, mulberry32(11));
  const t02 = performance.now();
  e.advance(SPAN_S, ORE_PER_S, sphereMW);
  const ms = performance.now() - t02;
  const r = e.rates();
  const made = e.sites.reduce((a, s) => [a[0] + s.made.sails, a[1] + s.made.rockets], [0, 0]);
  return { sailsPerSec: r.sailsPerSec, rocketsPerSec: r.rocketsPerSec, madeSails: made[0], madeRockets: made[1], ms };
}
var tLive = performance.now();
var liveDark = dayNight(0);
var liveDim = dayNight(8);
var msLive = performance.now() - tLive;
var advDark = fastForward(0);
var advDim = fastForward(8);
var dn = (label, live, adv2) => {
  console.log(`${label}`);
  console.log(`  live:    settled ${live.sailsPerSec.toFixed(2)} sails/s ${live.rocketsPerSec.toFixed(3)} rockets/s, made ${live.madeSails} sails ${live.madeRockets} rockets in ${SPAN_S} s`);
  console.log(`  advance: ${adv2.sailsPerSec.toFixed(2)} sails/s ${adv2.rocketsPerSec.toFixed(3)} rockets/s, made ${adv2.madeSails} sails ${adv2.madeRockets} rockets in ${SPAN_S} s, ${adv2.ms.toFixed(1)} ms`);
};
console.log(`
day and night, the live chain at dt ${DT} for ${SPAN_S} s twice took ${msLive.toFixed(0)} ms`);
dn("no sphere:", liveDark, advDark);
dn("8 MW sphere:", liveDim, advDim);
var near = (a, b, tol) => Math.abs(a - b) <= tol * Math.abs(b);
var nan = 0;
var overCap = 0;
var walk = (v) => {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) nan++;
  } else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
};
for (const e of [eco, fresh]) {
  for (const s of e.sites) {
    walk(s);
    for (const k of ORES) if (s.ore[k] > STOCK_CAP + 1e-9 || s.ingots[k] > STOCK_CAP + 1e-9) overCap++;
    if (s.sails > FINISHED_CAP.sails + YIELD.sail || s.rockets > FINISHED_CAP.rockets + YIELD.rocket) overCap++;
  }
  walk(e.rates());
}
var sailSite = eco.sites.findIndex((s) => s.rocketPlants === 0);
var tiSite = eco.sites.findIndex((s) => s.rocketPlants > 0);
var before = eco.sites[sailSite].sails;
var took = eco.takeSail(sailSite) && eco.sites[sailSite].sails === before - 1;
var tookRocket = eco.takeRocket(tiSite);
var refused = !eco.takeRocket(sailSite) && !eco.takeSail(99);
console.log(`non finite numbers: ${nan}; stocks over cap: ${overCap}; takeSail ${took ? "ok" : "BAD"}, takeRocket ${tookRocket ? "ok" : "BAD"}, refusals ${refused ? "ok" : "BAD"}`);
var checks = [
  [`full sun: 10 to 14 sails/s (got ${day.sailsPerSec.toFixed(2)})`, day.sailsPerSec >= 10 && day.sailsPerSec <= 14],
  [`full sun: 0.2 to 0.3 rockets/s (got ${day.rocketsPerSec.toFixed(3)})`, day.rocketsPerSec >= 0.2 && day.rocketsPerSec <= 0.3],
  [`night, no sphere: sails under a third of full (got ${nightDark.sailsPerSec.toFixed(2)} vs ${(day.sailsPerSec / 3).toFixed(2)})`, nightDark.sailsPerSec < day.sailsPerSec / 3],
  [`night, 60 MW: sails near full (got ${nightLit.sailsPerSec.toFixed(2)}, want at least ${(0.9 * day.sailsPerSec).toFixed(2)})`, nightLit.sailsPerSec >= 0.9 * day.sailsPerSec],
  [`night, 60 MW: rockets near full (got ${nightLit.rocketsPerSec.toFixed(3)}, want at least ${(0.9 * day.rocketsPerSec).toFixed(3)})`, nightLit.rocketsPerSec >= 0.9 * day.rocketsPerSec],
  [`advance matches the ticked rates within 5% (${adv.sailsPerSec.toFixed(2)} vs ${day.sailsPerSec.toFixed(2)}, ${adv.rocketsPerSec.toFixed(3)} vs ${day.rocketsPerSec.toFixed(3)})`, Math.abs(adv.sailsPerSec - day.sailsPerSec) <= 0.05 * day.sailsPerSec && Math.abs(adv.rocketsPerSec - day.rocketsPerSec) <= 0.05 * day.rocketsPerSec],
  [`advance totals match rate times time within 5% (${madeSails} vs ${Math.round(adv.sailsPerSec * 2e4)}, ${madeRockets} vs ${Math.round(adv.rocketsPerSec * 2e4)})`, Math.abs(madeSails - adv.sailsPerSec * 2e4) <= 0.05 * adv.sailsPerSec * 2e4 && Math.abs(madeRockets - adv.rocketsPerSec * 2e4) <= 0.05 * adv.rocketsPerSec * 2e4],
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
  [`state stays finite and under its caps, takes behave`, nan === 0 && overCap === 0 && took && tookRocket && refused]
];
var failed = 0;
console.log("");
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}
console.log(failed === 0 ? "\nALL PASS" : `
${failed} FAILED`);
var proc = globalThis.process;
if (failed > 0 && proc) proc.exitCode = 1;
