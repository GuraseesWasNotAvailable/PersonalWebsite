// src/swarm.ts
var GM = 72e3;
var GMP = 128;
var QUEUED = 0;
var TRANSIT = 1;
var ORBIT = 2;
var FADING = 3;
var RESERVED = 4;
var ABSORB = 5;
var FADE_S = 4;
var UNFURL_S = 6;
var LIFE_MIN = 230;
var LIFE_SPREAD = 150;
var TRANSIT_GAINS = { kv: 1.4, kr: 0.6, kn: 0.6, amax: 3.4 };
var ORBIT_GAINS = { kv: 0.35, kr: 0.25, kn: 0.25, amax: 0.35 };
var ABSORB_SPEED = 14;
var ABSORB_GAIN = 1.2;
var ABSORB_AMAX = 4;
var ABSORB_RADIUS = 4;
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
function laneFrame(tilt2) {
  const [a, c] = tilt2;
  const n = [-Math.sin(c), Math.cos(c) * Math.cos(a), Math.cos(c) * Math.sin(a)];
  const u = [Math.cos(c), Math.sin(c) * Math.cos(a), Math.sin(c) * Math.sin(a)];
  const w = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  return { n, u, w };
}
var Swarm = class {
  N;
  pos;
  vel;
  state;
  lane;
  timer;
  // life left in orbit, or time spent fading
  age;
  // seconds since launch, for the HUD and tests
  // Each sail has its own orbit near the lane, so a lane is a band, not a line.
  dR;
  dN;
  // Absorbing sails: the face they are bound for (a key the caller defines)
  // and its centroid, refreshed by the caller each step since the sphere turns.
  face;
  target;
  absorbed = 0;
  lanes;
  planetPos = new Float64Array(3);
  planetVel = new Float64Array(3);
  planetRadius;
  launched = 0;
  reservePtr = 0;
  nextLane = 0;
  rand;
  time = 0;
  constructor(lanes2, planetStart, planetVel, planetRadius, seed = 7) {
    this.rand = mulberry32(seed);
    this.N = lanes2.reduce((s, l) => s + l.n, 0);
    this.pos = new Float32Array(this.N * 3);
    this.vel = new Float32Array(this.N * 3);
    this.state = new Uint8Array(this.N);
    this.lane = new Uint8Array(this.N);
    this.timer = new Float32Array(this.N);
    this.age = new Float32Array(this.N);
    this.dR = new Float32Array(this.N);
    this.dN = new Float32Array(this.N);
    this.face = new Int32Array(this.N).fill(-1);
    this.target = new Float32Array(this.N * 3);
    this.lanes = lanes2.map((l) => ({ R: l.r, vc: Math.sqrt(GM / l.r), ...laneFrame(l.tilt) }));
    this.planetRadius = planetRadius;
    this.planetPos.set([planetStart[0], planetStart[1], planetStart[2]]);
    this.planetVel.set([planetVel[0], planetVel[1], planetVel[2]]);
    let i = 0;
    lanes2.forEach((l, li) => {
      for (let k = 0; k < l.n; k++, i++) {
        this.lane[i] = li;
        this.dR[i] = (this.rand() - 0.5) * 24;
        this.dN[i] = (this.rand() - 0.5) * 18;
        if (this.rand() < 0.58) this.placeInOrbit(i, this.rand() * Math.PI * 2);
        else this.state[i] = QUEUED;
      }
    });
  }
  // Drop a sail straight onto its lane with circular velocity.
  placeInOrbit(i, theta) {
    const L = this.lanes[this.lane[i]];
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const R2 = L.R + this.dR[i];
    const vc2 = Math.sqrt(GM / R2);
    for (let k = 0; k < 3; k++) {
      this.pos[i * 3 + k] = R2 * (c * L.u[k] + s * L.w[k]) + this.dN[i] * L.n[k];
      this.vel[i * 3 + k] = vc2 * (-s * L.u[k] + c * L.w[k]);
    }
    this.state[i] = ORBIT;
    this.timer[i] = LIFE_MIN + this.rand() * LIFE_SPREAD;
    this.age[i] = 60;
  }
  // Take a queued sail for the ground to build, walking the lanes in turn so
  // every lane keeps filling. Returns -1 when the whole fleet is in flight.
  reserve() {
    const want = this.nextLane;
    this.nextLane = (this.nextLane + 1) % this.lanes.length;
    for (let pass = 0; pass < 2; pass++) {
      for (let tries = 0; tries < this.N; tries++) {
        const i = (this.reservePtr + tries) % this.N;
        if (this.state[i] === QUEUED && (pass === 1 || this.lane[i] === want)) {
          this.reservePtr = (i + 1) % this.N;
          this.state[i] = RESERVED;
          return i;
        }
      }
    }
    return -1;
  }
  // Hand a reserved sail back when the ground could not take it.
  release(i) {
    if (this.state[i] === RESERVED) this.state[i] = QUEUED;
  }
  // Send up to `count` orbiting sails nearest a face centroid to be absorbed
  // there. Returns how many were sent. A small insertion sort keeps the
  // nearest few without allocating.
  pickForFace(key, cx, cy, cz, count) {
    const n = Math.min(count, 8);
    if (n <= 0) return 0;
    const bestI = this.pickI;
    const bestD = this.pickD;
    for (let k = 0; k < n; k++) {
      bestI[k] = -1;
      bestD[k] = Infinity;
    }
    const { pos, state } = this;
    for (let i = 0; i < this.N; i++) {
      if (state[i] !== ORBIT) continue;
      const o = i * 3;
      const dx = pos[o] - cx;
      const dy = pos[o + 1] - cy;
      const dz = pos[o + 2] - cz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d >= bestD[n - 1]) continue;
      let k = n - 1;
      while (k > 0 && bestD[k - 1] > d) {
        bestD[k] = bestD[k - 1];
        bestI[k] = bestI[k - 1];
        k--;
      }
      bestD[k] = d;
      bestI[k] = i;
    }
    let sent = 0;
    for (let k = 0; k < n; k++) {
      const i = bestI[k];
      if (i < 0) break;
      state[i] = ABSORB;
      this.face[i] = key;
      this.target[i * 3] = cx;
      this.target[i * 3 + 1] = cy;
      this.target[i * 3 + 2] = cz;
      sent++;
    }
    return sent;
  }
  pickI = new Int32Array(8);
  pickD = new Float64Array(8);
  // Fire a reserved sail from an ejector: an inertial position and velocity.
  launch(i, pos, vel) {
    const o = i * 3;
    this.pos[o] = pos[0];
    this.pos[o + 1] = pos[1];
    this.pos[o + 2] = pos[2];
    this.vel[o] = vel[0];
    this.vel[o + 1] = vel[1];
    this.vel[o + 2] = vel[2];
    this.state[i] = TRANSIT;
    this.age[i] = 0;
    this.launched++;
  }
  // One step of semi-implicit Euler for the planet and every active sail.
  // `centroid` refreshes an absorbing sail's target from its face key;
  // `onAbsorbed` is told when a sail arrives and its slot returns to the queue.
  step(dt2, centroid, onAbsorbed2) {
    this.time += dt2;
    const pp = this.planetPos;
    const pv = this.planetVel;
    {
      const r2 = pp[0] * pp[0] + pp[1] * pp[1] + pp[2] * pp[2];
      const inv3 = GM / (r2 * Math.sqrt(r2));
      for (let k = 0; k < 3; k++) pv[k] -= pp[k] * inv3 * dt2;
      for (let k = 0; k < 3; k++) pp[k] += pv[k] * dt2;
    }
    const ppx = pp[0];
    const ppy = pp[1];
    const ppz = pp[2];
    const { pos, vel, state, lane, timer, age } = this;
    for (let i = 0; i < this.N; i++) {
      const st = state[i];
      if (st === QUEUED || st === RESERVED) continue;
      const o = i * 3;
      const px = pos[o];
      const py = pos[o + 1];
      const pz = pos[o + 2];
      let vx = vel[o];
      let vy = vel[o + 1];
      let vz = vel[o + 2];
      const r2 = px * px + py * py + pz * pz;
      const inv3 = GM / (r2 * Math.sqrt(r2));
      let ax = -px * inv3;
      let ay = -py * inv3;
      let az = -pz * inv3;
      if (st === ABSORB) {
        if (centroid) centroid(this.face[i], this.target, o);
        const tx2 = this.target[o] - px;
        const ty2 = this.target[o + 1] - py;
        const tz2 = this.target[o + 2] - pz;
        const dist = Math.hypot(tx2, ty2, tz2);
        if (dist < ABSORB_RADIUS) {
          state[i] = QUEUED;
          this.absorbed++;
          if (onAbsorbed2) onAbsorbed2(i, this.face[i]);
          this.face[i] = -1;
          continue;
        }
        const want = Math.min(ABSORB_SPEED, 2 + dist * 0.6) / dist;
        let gx2 = ABSORB_GAIN * (tx2 * want - vx);
        let gy2 = ABSORB_GAIN * (ty2 * want - vy);
        let gz2 = ABSORB_GAIN * (tz2 * want - vz);
        const gl2 = Math.hypot(gx2, gy2, gz2);
        if (gl2 > ABSORB_AMAX) {
          const s = ABSORB_AMAX / gl2;
          gx2 *= s;
          gy2 *= s;
          gz2 *= s;
        }
        vx += (ax + gx2) * dt2;
        vy += (ay + gy2) * dt2;
        vz += (az + gz2) * dt2;
        vel[o] = vx;
        vel[o + 1] = vy;
        vel[o + 2] = vz;
        pos[o] = px + vx * dt2;
        pos[o + 1] = py + vy * dt2;
        pos[o + 2] = pz + vz * dt2;
        age[i] += dt2;
        continue;
      }
      const dx = px - ppx;
      const dy = py - ppy;
      const dz = pz - ppz;
      const d2 = dx * dx + dy * dy + dz * dz + 1;
      const pinv3 = GMP / (d2 * Math.sqrt(d2));
      ax -= dx * pinv3;
      ay -= dy * pinv3;
      az -= dz * pinv3;
      const L = this.lanes[lane[i]];
      const g = st === TRANSIT ? TRANSIT_GAINS : ORBIT_GAINS;
      const nx = L.n[0];
      const ny = L.n[1];
      const nz = L.n[2];
      const Ri = L.R + this.dR[i];
      const vci = Math.sqrt(GM / Ri);
      const rn = px * nx + py * ny + pz * nz - this.dN[i];
      const rpx = px - rn * nx;
      const rpy = py - rn * ny;
      const rpz = pz - rn * nz;
      const rpl = Math.hypot(rpx, rpy, rpz) || 1;
      const hx = rpx / rpl;
      const hy = rpy / rpl;
      const hz = rpz / rpl;
      const tx = ny * hz - nz * hy;
      const ty = nz * hx - nx * hz;
      const tz = nx * hy - ny * hx;
      const eRad = Ri - rpl;
      const dvx = tx * vci - vx;
      const dvy = ty * vci - vy;
      const dvz = tz * vci - vz;
      let gx = g.kv * dvx + g.kr * eRad * hx - g.kn * rn * nx;
      let gy = g.kv * dvy + g.kr * eRad * hy - g.kn * rn * ny;
      let gz = g.kv * dvz + g.kr * eRad * hz - g.kn * rn * nz;
      const gl = Math.hypot(gx, gy, gz);
      if (gl > g.amax) {
        const s = g.amax / gl;
        gx *= s;
        gy *= s;
        gz *= s;
      }
      ax += gx;
      ay += gy;
      az += gz;
      vx += ax * dt2;
      vy += ay * dt2;
      vz += az * dt2;
      vel[o] = vx;
      vel[o + 1] = vy;
      vel[o + 2] = vz;
      pos[o] = px + vx * dt2;
      pos[o + 1] = py + vy * dt2;
      pos[o + 2] = pz + vz * dt2;
      age[i] += dt2;
      if (st === TRANSIT) {
        if (Math.abs(eRad) < 4 && Math.abs(rn) < 4 && Math.hypot(dvx, dvy, dvz) < 1.5) {
          state[i] = ORBIT;
          timer[i] = LIFE_MIN + this.rand() * LIFE_SPREAD;
        }
      } else if (st === ORBIT) {
        timer[i] -= dt2;
        if (timer[i] <= 0) {
          state[i] = FADING;
          timer[i] = 0;
        }
      } else if (st === FADING) {
        timer[i] += dt2;
        if (timer[i] >= FADE_S) state[i] = QUEUED;
      }
    }
  }
  // Visual scale for a sail: nothing on the ground, unfurling after launch,
  // full in orbit, shrinking while it fades.
  scaleOf(i) {
    const st = this.state[i];
    if (st === QUEUED || st === RESERVED) return 0;
    if (st === ABSORB) return 1;
    if (st === FADING) return Math.max(0, 1 - this.timer[i] / FADE_S);
    if (st === TRANSIT) {
      const u = Math.min(1, this.age[i] / UNFURL_S);
      return 0.15 + 0.6 * u * u * (3 - 2 * u);
    }
    return 1;
  }
  counts() {
    let orbit = 0;
    let transit = 0;
    let ground2 = 0;
    let absorbing = 0;
    for (let i = 0; i < this.N; i++) {
      const s = this.state[i];
      if (s === ORBIT || s === FADING) orbit++;
      else if (s === TRANSIT) transit++;
      else if (s === RESERVED) ground2++;
      else if (s === ABSORB) absorbing++;
    }
    return { orbit, transit, ground: ground2, absorbing, launched: this.launched, absorbed: this.absorbed };
  }
};

// src/noise.ts
function hash3(x, y, z, seed) {
  let h = x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1013904223 | 0;
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return ((h ^ h >>> 16) >>> 0) / 4294967296;
}
function fade(t) {
  return t * t * (3 - 2 * t);
}
function noise3(x, y, z, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fx = fade(x - xi);
  const fy = fade(y - yi);
  const fz = fade(z - zi);
  const lerp = (a, b, t) => a + (b - a) * t;
  const c00 = lerp(hash3(xi, yi, zi, seed), hash3(xi + 1, yi, zi, seed), fx);
  const c10 = lerp(hash3(xi, yi + 1, zi, seed), hash3(xi + 1, yi + 1, zi, seed), fx);
  const c01 = lerp(hash3(xi, yi, zi + 1, seed), hash3(xi + 1, yi, zi + 1, seed), fx);
  const c11 = lerp(hash3(xi, yi + 1, zi + 1, seed), hash3(xi + 1, yi + 1, zi + 1, seed), fx);
  return lerp(lerp(c00, c10, fy), lerp(c01, c11, fy), fz);
}
function fbm(x, y, z, seed, octaves = 5) {
  let f = 0;
  let a = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    f += a * noise3(x, y, z, seed + i * 17);
    norm += a;
    x = x * 2.03 + 1.7;
    y = y * 2.03 + 1.7;
    z = z * 2.03 + 1.7;
    a *= 0.5;
  }
  return f / norm;
}
var PLANET_SEED = 3;
function heightAt(mx, my, mz, seed = PLANET_SEED) {
  return fbm(-mx * 2.4, my * 2.4, mz * 2.4, seed);
}

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
  tick(dt2, sun, sphereMW) {
    if (!(dt2 > 0)) return;
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
      const smeltCap = s.smelters * (RECIPES.smelt.ore / RECIPES.smelt.seconds) * dt2;
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
      const sailCap = s.assemblers * dt2 / RECIPES.sail.seconds;
      let sailCan = Math.min(fe / RECIPES.sail.iron, cu / RECIPES.sail.copper, si / RECIPES.sail.silicon, (FINISHED_CAP.sails - s.sails) / YIELD.sail);
      if (sailCan < 0) sailCan = 0;
      const rocketCap = s.rocketPlants * dt2 / RECIPES.rocket.seconds;
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
        this.prodRocket[i] = made / dt2;
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
        this.prodSail[i] = made / dt2;
      } else this.prodSail[i] = 0;
    }
    const alpha = 1 - Math.exp(-dt2 / RATE_TAU);
    this.sailRate += (sailsMade / dt2 - this.sailRate) * alpha;
    this.rocketRate += (rocketsMade / dt2 - this.rocketRate) * alpha;
    this.supplyMW = supplySum;
    this.demandMW = demandSum;
    this.time += dt2;
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
    const steps2 = Math.max(1, Math.ceil(warm / ADVANCE_DT - 1e-9));
    const dt2 = warm / steps2;
    const haul = oreRatePerSite > 0 ? oreRatePerSite * dt2 : 0;
    daySail.fill(0);
    dayRocket.fill(0);
    let avgFrom = -1;
    for (let st = 0; st < steps2; st++) {
      const t = st * dt2;
      for (let i = 0; i < n; i++) sun[i] = Math.max(0, Math.sin(2 * Math.PI * ((t + 0.5 * dt2) / DAY_S + i / n)));
      for (let i = 0; i < n; i++) this.deliverOre(i, haul);
      this.tick(dt2, sun, sphereMW);
      for (let i = 0; i < n; i++) {
        const s = sites[i];
        if (s.sails > WORKING_SAILS) s.sails = WORKING_SAILS;
        if (s.rockets > WORKING_ROCKETS) s.rockets = WORKING_ROCKETS;
      }
      if (t >= ADVANCE_AVG_FROM_S - 1e-9) {
        if (avgFrom < 0) avgFrom = t;
        for (let i = 0; i < n; i++) {
          daySail[i] += this.prodSail[i] * dt2;
          dayRocket[i] += this.prodRocket[i] * dt2;
        }
      }
    }
    const span = avgFrom >= 0 ? warm - avgFrom : 0;
    if (span > 0) {
      let sails = 0;
      let rockets2 = 0;
      for (let i = 0; i < n; i++) {
        sails += daySail[i] / span;
        rockets2 += dayRocket[i] / span;
      }
      this.sailRate = sails;
      this.rocketRate = rockets2;
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

// src/surface.ts
var SPIN_RATE = 0.05;
var S = 0.6;
var BARREL_LEN = 3.2 * S;
var PIVOT_H = 0.95 * S;
var V_MUZZLE = 14.5;
var MIN_ELEV = 0.35;
var MAG_CAP = 16;
var FIRE_PERIOD = 0.8;
var LOAD_S = 0.35;
var RAIL_S = 0.3;
var SHIFT_S = 0.3;
var SLEW_YAW = 1.1;
var SLEW_PITCH = 0.9;
var PARK_PITCH = 0.45;
var AIM_TOL = 0.05;
var GUNS_PER_SITE = 4;
var SITES_WANTED = 12;
var BUILD_S = 0.4;
var BELT_SPEED = 2.2 * S;
var PKG_GAP = 0.42 * S;
var ORE_CAP = 36;
var HAUL_LOAD = 3;
var HAULERS_PER_SITE = 12;
var BOT_SPEED = 1.6 * S;
var BOT_GAP = 0.5 * S;
var MINE_LOAD_S = 0.45;
var DOCK_UNLOAD_S = 0.35;
var MAX_PKG = 2048;
var GUN_X = 6.4;
var GUN_Y = [-5.1, -1.7, 1.7, 5.1];
var DOOR_Y = [-0.9, -0.3, 0.3, 0.9];
var BEND_X = [2.6, 3, 3, 2.6];
var DOOR_X = 1.75;
var RACK_X0 = 4.6;
var RACK_PITCH = 0.36;
var BELT_END_X = 4.3;
var MINE_XY = [-6.4, -3.2];
var DOCK_XY = [-3.55, 0.5];
var SILO_XY = [-2.6, 4.4];
var SILO_H = 2.6 * S;
var SILO_SPEED = 18;
var SILO_COOLDOWN = 6;
var HAUL_WAY = [MINE_XY, [-5.1, -1.1], DOCK_XY];
var LANE_OFF = 0.3;
var PAD_R = 7.6;
var PK_BELT = 0;
var PK_SHIFT = 1;
var PK_STACK = 2;
var PK_LOAD = 3;
var PK_RAIL = 4;
var BOT_TO_DOCK = 0;
var BOT_UNLOADING = 1;
var BOT_TO_PIT = 2;
var BOT_LOADING = 3;
var norm3 = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
var cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
var dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
var wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
function bodyToWorld(b, theta, Q2, out) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const x1 = b[0] * c + b[2] * s;
  const y1 = b[1];
  const z1 = -b[0] * s + b[2] * c;
  out[0] = Q2[0] * x1 + Q2[1] * y1 + Q2[2] * z1;
  out[1] = Q2[3] * x1 + Q2[4] * y1 + Q2[5] * z1;
  out[2] = Q2[6] * x1 + Q2[7] * y1 + Q2[8] * z1;
  return out;
}
function worldToBody(w, theta, Q2, out) {
  const x1 = Q2[0] * w[0] + Q2[3] * w[1] + Q2[6] * w[2];
  const y1 = Q2[1] * w[0] + Q2[4] * w[1] + Q2[7] * w[2];
  const z1 = Q2[2] * w[0] + Q2[5] * w[1] + Q2[8] * w[2];
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  out[0] = x1 * c - z1 * s;
  out[1] = y1;
  out[2] = x1 * s + z1 * c;
  return out;
}
function siteFrame(site, x, y, h, R2) {
  x *= S;
  y *= S;
  const rho = Math.hypot(x, y);
  let up;
  if (rho < 1e-6) up = site.center;
  else {
    const ang = rho / R2;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang) / rho;
    up = norm3([
      ca * site.center[0] + sa * (x * site.e[0] + y * site.f[0]),
      ca * site.center[1] + sa * (x * site.e[1] + y * site.f[1]),
      ca * site.center[2] + sa * (x * site.e[2] + y * site.f[2])
    ]);
  }
  const d = dot(site.e, up);
  const ex = norm3([site.e[0] - d * up[0], site.e[1] - d * up[1], site.e[2] - d * up[2]]);
  const ey = cross(up, ex);
  const r = R2 + h * S;
  return { pos: [up[0] * r, up[1] * r, up[2] * r], ex, ey, up };
}
function makePath(site, way, h, R2, step = 0.15) {
  const pts = [];
  const push = (x, y) => {
    const f = siteFrame(site, x, y, h, R2);
    pts.push(f.pos[0], f.pos[1], f.pos[2]);
  };
  for (let k = 0; k < way.length - 1; k++) {
    const [x0, y0] = way[k];
    const [x1, y1] = way[k + 1];
    const L = Math.hypot(x1 - x0, y1 - y0);
    const n2 = Math.max(1, Math.ceil(L / step));
    for (let j = 0; j < n2; j++) {
      const t = j / n2;
      push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
    }
  }
  push(way[way.length - 1][0], way[way.length - 1][1]);
  const n = pts.length / 3;
  const cum = new Float32Array(n);
  const tan = new Float32Array(n * 3);
  for (let i = 1; i < n; i++) {
    const dx = pts[i * 3] - pts[i * 3 - 3];
    const dy = pts[i * 3 + 1] - pts[i * 3 - 2];
    const dz = pts[i * 3 + 2] - pts[i * 3 - 1];
    const l = Math.hypot(dx, dy, dz);
    cum[i] = cum[i - 1] + l;
    tan[i * 3] = dx / l;
    tan[i * 3 + 1] = dy / l;
    tan[i * 3 + 2] = dz / l;
  }
  tan.set(tan.subarray(3, 6), 0);
  return { pts: Float32Array.from(pts), tan, cum, n, len: cum[n - 1] };
}
function offsetWay(way, off) {
  return way.map(([x, y], i) => {
    const a = way[Math.max(0, i - 1)];
    const b = way[Math.min(way.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [x - dy / l * off, y + dx / l * off];
  });
}
function oreRoom(econ, site) {
  const e = econ.sites[site];
  let total = 0;
  for (const k of ORES) total += e.ore[k];
  return STOCK_CAP * ORES.length - total;
}
function pathAt(p, s, out, o = 0, tan, to = 0) {
  if (s <= 0) {
    out[o] = p.pts[0];
    out[o + 1] = p.pts[1];
    out[o + 2] = p.pts[2];
    if (tan) {
      tan[to] = p.tan[0];
      tan[to + 1] = p.tan[1];
      tan[to + 2] = p.tan[2];
    }
    return;
  }
  if (s >= p.len) {
    const k = (p.n - 1) * 3;
    out[o] = p.pts[k];
    out[o + 1] = p.pts[k + 1];
    out[o + 2] = p.pts[k + 2];
    if (tan) {
      tan[to] = p.tan[k];
      tan[to + 1] = p.tan[k + 1];
      tan[to + 2] = p.tan[k + 2];
    }
    return;
  }
  let lo = 0;
  let hi = p.n - 1;
  while (hi - lo > 1) {
    const mid = lo + hi >> 1;
    if (p.cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const t = (s - p.cum[lo]) / (p.cum[hi] - p.cum[lo]);
  const a = lo * 3;
  const b = hi * 3;
  out[o] = p.pts[a] + (p.pts[b] - p.pts[a]) * t;
  out[o + 1] = p.pts[a + 1] + (p.pts[b + 1] - p.pts[a + 1]) * t;
  out[o + 2] = p.pts[a + 2] + (p.pts[b + 2] - p.pts[a + 2]) * t;
  if (tan) {
    tan[to] = p.tan[b];
    tan[to + 1] = p.tan[b + 1];
    tan[to + 2] = p.tan[b + 2];
  }
}
function planSites(R2, rand, wanted) {
  const cands = [];
  const N = 1200;
  const ring = 8;
  const ringRho = PAD_R * S * 0.7;
  for (let i = 0; i < N; i++) {
    const y = 1 - 2 * (i + 0.5) / N;
    if (Math.abs(y) > 0.8) continue;
    const r = Math.sqrt(1 - y * y);
    const phi = i * 2.399963229728653;
    const c = [r * Math.cos(phi), y, r * Math.sin(phi)];
    if (heightAt(c[0], c[1], c[2]) < 0.53) continue;
    const e0 = norm3(cross([0, 1, 0], c));
    const f0 = cross(c, e0);
    let land = true;
    for (let k = 0; k < ring && land; k++) {
      const a = k / ring * Math.PI * 2;
      const ang = ringRho / R2;
      const p = [0, 0, 0];
      for (let j = 0; j < 3; j++) p[j] = Math.cos(ang) * c[j] + Math.sin(ang) * (Math.cos(a) * e0[j] + Math.sin(a) * f0[j]);
      if (heightAt(p[0], p[1], p[2]) < 0.49) land = false;
    }
    if (land) cands.push(c);
  }
  for (let i = cands.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = cands[i];
    cands[i] = cands[j];
    cands[j] = t;
  }
  const minSep = 2 * PAD_R * S / R2 + 0.01;
  const picked = [];
  for (const c of cands) {
    if (picked.length >= wanted) break;
    if (picked.every((p) => Math.acos(Math.max(-1, Math.min(1, dot(p, c)))) > minSep)) picked.push(c);
  }
  return picked.map((c) => {
    const e0 = norm3(cross([0, 1, 0], c));
    const f0 = cross(c, e0);
    const a = rand() * Math.PI * 2;
    const e = norm3([
      Math.cos(a) * e0[0] + Math.sin(a) * f0[0],
      Math.cos(a) * e0[1] + Math.sin(a) * f0[1],
      Math.cos(a) * e0[2] + Math.sin(a) * f0[2]
    ]);
    return { center: c, e, f: cross(c, e) };
  });
}
var Surface = class {
  R;
  Q;
  // the launch planet's pole frame
  sites = [];
  guns = [];
  // Packages: folded sails between the factory door and the muzzle.
  pkPos = new Float32Array(MAX_PKG * 3);
  pkAlive = new Uint8Array(MAX_PKG);
  pkState = new Uint8Array(MAX_PKG);
  pkSail = new Int32Array(MAX_PKG);
  pkGun = new Int16Array(MAX_PKG);
  pkS = new Float32Array(MAX_PKG);
  pkSlot = new Int8Array(MAX_PKG);
  pkOf;
  // package index for each sail, or -1
  freePk = [];
  // Hauler bots.
  nBots;
  botPos;
  botTan;
  botSite;
  botState;
  botS;
  botTimer;
  botLoad;
  botLane;
  rand;
  aimBody = new Float64Array(3);
  tmpW = new Float64Array(3);
  tmpV = new Float64Array(3);
  tmpM = new Float64Array(3);
  tmpS = new Float64Array(3);
  built = 0;
  // The engine behind the ground, attached by the page: the economy that
  // turns hauled ore into sails and rockets, the sphere the rockets build,
  // and the rockets in flight.
  economy = null;
  sphere = null;
  rockets = null;
  sunElev;
  constructor(R2, swarm, Q2 = [1, 0, 0, 0, 1, 0, 0, 0, 1], seed = 11) {
    this.R = R2;
    this.Q = Q2;
    this.rand = mulberry32(seed);
    this.pkOf = new Int32Array(swarm.N).fill(-1);
    for (let i = MAX_PKG - 1; i >= 0; i--) this.freePk.push(i);
    const plans = planSites(R2, this.rand, SITES_WANTED);
    plans.forEach((plan, si) => {
      const guns = [];
      for (let k = 0; k < GUNS_PER_SITE; k++) {
        const gy = GUN_Y[k];
        const frame = siteFrame(plan, GUN_X, gy, 0, R2);
        const pivot = [frame.pos[0] + frame.up[0] * PIVOT_H, frame.pos[1] + frame.up[1] * PIVOT_H, frame.pos[2] + frame.up[2] * PIVOT_H];
        const rack = [];
        for (let r = 0; r < 4; r++)
          for (let c = 0; c < 4; c++) rack.push(siteFrame(plan, RACK_X0 + c * RACK_PITCH, gy - 1.5 * RACK_PITCH + r * RACK_PITCH, 0.14, R2).pos);
        const way = [
          [DOOR_X, DOOR_Y[k]],
          [BEND_X[k], DOOR_Y[k]],
          [BEND_X[k], gy],
          [BELT_END_X, gy]
        ];
        const gun = {
          id: this.guns.length,
          site: si,
          index: k,
          x: GUN_X,
          y: gy,
          frame,
          pivot,
          rack,
          belt: makePath(plan, way, 0.1, R2),
          onBelt: [],
          shifting: [],
          magazine: [],
          slotUsed: new Uint8Array(MAG_CAP),
          bound: 0,
          yaw: 0,
          pitch: PARK_PITCH,
          aimYaw: 0,
          aimPitch: PARK_PITCH,
          aimOk: false,
          ready: false,
          cooldown: this.rand() * FIRE_PERIOD,
          busy: -1,
          charge: 0,
          flash: 0,
          fired: 0
        };
        guns.push(gun);
        this.guns.push(gun);
      }
      const site = {
        index: si,
        center: plan.center,
        e: plan.e,
        f: plan.f,
        hall: siteFrame(plan, 0, 0, 0, R2),
        mine: siteFrame(plan, MINE_XY[0], MINE_XY[1], 0, R2),
        dock: siteFrame(plan, DOCK_XY[0], DOCK_XY[1], 0, R2),
        silo: siteFrame(plan, SILO_XY[0], SILO_XY[1], 0, R2),
        siloCooldown: this.rand() * SILO_COOLDOWN,
        siloLoaded: false,
        siloFlash: 0,
        rocketsFired: 0,
        guns,
        haulOut: makePath(plan, offsetWay(HAUL_WAY, -LANE_OFF), 0.08, R2),
        haulBack: makePath(plan, offsetWay(HAUL_WAY.slice().reverse(), -LANE_OFF), 0.08, R2),
        outBots: [],
        backBots: [],
        ore: ORE_CAP * 0.5,
        build: 0,
        built: 0,
        stalled: false,
        stallReason: ""
      };
      this.sites.push(site);
    });
    this.sunElev = new Float32Array(this.sites.length);
    this.nBots = this.sites.length * HAULERS_PER_SITE;
    this.botPos = new Float32Array(this.nBots * 3);
    this.botTan = new Float32Array(this.nBots * 3);
    this.botSite = new Uint8Array(this.nBots);
    this.botState = new Uint8Array(this.nBots);
    this.botS = new Float32Array(this.nBots);
    this.botTimer = new Float32Array(this.nBots);
    this.botLoad = new Uint8Array(this.nBots);
    this.botLane = new Float32Array(this.nBots);
    let b = 0;
    for (const site of this.sites) {
      for (let k = 0; k < HAULERS_PER_SITE; k++, b++) {
        this.botSite[b] = site.index;
        this.botLane[b] = (this.rand() - 0.5) * 0.12 * S;
        const out = k % 2 === 0;
        this.botState[b] = out ? BOT_TO_DOCK : BOT_TO_PIT;
        this.botLoad[b] = out ? 1 : 0;
        const path = out ? site.haulOut : site.haulBack;
        const list = out ? site.outBots : site.backBots;
        this.botS[b] = path.len * (1 - (Math.floor(k / 2) + 0.5) / (HAULERS_PER_SITE / 2));
        list.push(b);
      }
      site.outBots.sort((p, q) => this.botS[q] - this.botS[p]);
      site.backBots.sort((p, q) => this.botS[q] - this.botS[p]);
    }
  }
  get nPackages() {
    return MAX_PKG;
  }
  attach(economy2, sphere2, rockets2) {
    this.economy = economy2;
    this.sphere = sphere2;
    this.rockets = rockets2;
  }
  allocPk() {
    const i = this.freePk.pop();
    return i === void 0 ? -1 : i;
  }
  freePackage(i) {
    this.pkAlive[i] = 0;
    if (this.pkSail[i] >= 0) this.pkOf[this.pkSail[i]] = -1;
    this.pkSail[i] = -1;
    this.freePk.push(i);
  }
  // One step for every site: haulers, the factory, belts, racks and rails.
  step(dt2, swarm) {
    const theta = SPIN_RATE * swarm.time;
    const pp = swarm.planetPos;
    const pv = swarm.planetVel;
    const pr = Math.hypot(pp[0], pp[1], pp[2]);
    const want = this.tmpW;
    for (let k = 0; k < 3; k++) want[k] = -0.5 * pv[k] - pp[k] / pr * 13;
    const wl = Math.hypot(want[0], want[1], want[2]);
    for (let k = 0; k < 3; k++) want[k] /= wl;
    const aim = worldToBody(want, theta, this.Q, this.aimBody);
    const aimV = [aim[0], aim[1], aim[2]];
    const omega = SPIN_RATE;
    for (const site of this.sites) {
      const w = bodyToWorld(site.center, theta, this.Q, this.tmpS);
      this.sunElev[site.index] = Math.max(0, -(w[0] * pp[0] + w[1] * pp[1] + w[2] * pp[2]) / pr);
      this.stepHaulers(site, dt2);
      this.stepFactory(site, dt2, swarm);
      for (const g of site.guns) {
        this.stepBelt(g, dt2);
        this.stepGun(g, dt2, aimV, swarm, theta, omega);
      }
      this.stepSilo(site, dt2, swarm, theta, omega);
    }
  }
  // The silo: when the economy has a finished rocket and the sphere has
  // somewhere to put it, fire straight up with the planet's motion added.
  stepSilo(site, dt2, swarm, theta, omega) {
    const econ = this.economy;
    site.siloCooldown -= dt2;
    site.siloFlash = Math.max(0, site.siloFlash - dt2 * 3);
    if (!econ || !this.sphere || !this.rockets) {
      site.siloLoaded = false;
      return;
    }
    site.siloLoaded = econ.sites[site.index].rockets >= 1;
    if (site.siloCooldown > 0 || !site.siloLoaded) return;
    const target = this.sphere.nextTarget();
    if (!target) return;
    const f = site.silo;
    const top = this.tmpM;
    for (let k = 0; k < 3; k++) top[k] = f.pos[k] + f.up[k] * SILO_H;
    const tW = bodyToWorld(top, theta, this.Q, this.tmpV);
    const uW = bodyToWorld(f.up, theta, this.Q, this.tmpS);
    const wx = this.Q[1] * omega;
    const wy = this.Q[4] * omega;
    const wz = this.Q[7] * omega;
    const pos = [swarm.planetPos[0] + tW[0], swarm.planetPos[1] + tW[1], swarm.planetPos[2] + tW[2]];
    const vel = [
      swarm.planetVel[0] + (wy * tW[2] - wz * tW[1]) + uW[0] * SILO_SPEED,
      swarm.planetVel[1] + (wz * tW[0] - wx * tW[2]) + uW[1] * SILO_SPEED,
      swarm.planetVel[2] + (wx * tW[1] - wy * tW[0]) + uW[2] * SILO_SPEED
    ];
    if (!this.rockets.launch(pos, vel, target)) return;
    econ.takeRocket(site.index);
    site.siloCooldown = SILO_COOLDOWN;
    site.siloFlash = 1;
    site.rocketsFired++;
  }
  stepHaulers(site, dt2) {
    const run = (list, path, moving, serving, serviceS, other, canServe, onServed) => {
      let ahead = Infinity;
      for (let k = 0; k < list.length; k++) {
        const b = list[k];
        if (this.botState[b] === moving) {
          let s = this.botS[b] + BOT_SPEED * dt2;
          if (s > ahead - BOT_GAP) s = ahead - BOT_GAP;
          if (s >= path.len) {
            s = path.len;
            this.botState[b] = serving;
            this.botTimer[b] = serviceS;
          }
          this.botS[b] = s;
        } else {
          this.botS[b] = path.len;
          if (this.botTimer[b] > 0) {
            if (canServe()) this.botTimer[b] -= dt2;
            if (this.botTimer[b] <= 0) onServed();
          } else if (other.length === 0 || this.botS[other[other.length - 1]] >= BOT_GAP) {
            list.shift();
            other.push(b);
            this.botS[b] = 0;
            this.botState[b] = moving === BOT_TO_DOCK ? BOT_TO_PIT : BOT_TO_DOCK;
            this.botLoad[b] = moving === BOT_TO_DOCK ? 0 : 1;
            k--;
            continue;
          }
        }
        ahead = this.botS[b];
        pathAt(path, this.botS[b], this.botPos, b * 3, this.botTan, b * 3);
        const t = b * 3;
        const ux = this.botPos[t] / this.R;
        const uy = this.botPos[t + 1] / this.R;
        const uz = this.botPos[t + 2] / this.R;
        const sx = this.botTan[t + 1] * uz - this.botTan[t + 2] * uy;
        const sy = this.botTan[t + 2] * ux - this.botTan[t] * uz;
        const sz = this.botTan[t] * uy - this.botTan[t + 1] * ux;
        this.botPos[t] += sx * this.botLane[b];
        this.botPos[t + 1] += sy * this.botLane[b];
        this.botPos[t + 2] += sz * this.botLane[b];
      }
    };
    const econ = this.economy;
    run(
      site.outBots,
      site.haulOut,
      BOT_TO_DOCK,
      BOT_UNLOADING,
      DOCK_UNLOAD_S,
      site.backBots,
      () => econ ? oreRoom(econ, site.index) >= HAUL_LOAD : site.ore + HAUL_LOAD <= ORE_CAP,
      () => econ ? econ.deliverOre(site.index, HAUL_LOAD) : site.ore += HAUL_LOAD
    );
    run(site.backBots, site.haulBack, BOT_TO_PIT, BOT_LOADING, MINE_LOAD_S, site.outBots, () => true, () => void 0);
  }
  stepFactory(site, dt2, swarm) {
    site.build -= dt2;
    if (site.build > 0) return;
    const econ = this.economy;
    if (econ ? econ.sites[site.index].sails < 1 : site.ore < 1) {
      site.stalled = true;
      site.stallReason = econ ? "waiting for sails from the assemblers" : "waiting for ore";
      return;
    }
    let best = null;
    let bestScore = Infinity;
    for (const g of site.guns) {
      const queued = g.magazine.length + g.bound;
      if (queued >= MAG_CAP) continue;
      const last = g.onBelt[g.onBelt.length - 1];
      if (last !== void 0 && this.pkS[last] < PKG_GAP) continue;
      const score = queued - (g.aimOk ? 8 : 0) + this.rand() * 0.5;
      if (score < bestScore) {
        bestScore = score;
        best = g;
      }
    }
    if (!best) {
      site.stalled = true;
      site.stallReason = "racks full";
      return;
    }
    const sail = swarm.reserve();
    if (sail < 0) {
      site.stalled = true;
      site.stallReason = "whole fleet in flight";
      return;
    }
    const p = this.allocPk();
    if (p < 0) {
      swarm.release(sail);
      site.stalled = true;
      site.stallReason = "belts full";
      return;
    }
    site.stalled = false;
    if (econ) econ.takeSail(site.index);
    else site.ore -= 1;
    site.build = BUILD_S;
    site.built++;
    this.built++;
    this.pkAlive[p] = 1;
    this.pkState[p] = PK_BELT;
    this.pkSail[p] = sail;
    this.pkOf[sail] = p;
    this.pkGun[p] = best.id;
    this.pkS[p] = 0;
    this.pkSlot[p] = -1;
    best.onBelt.push(p);
    best.bound++;
    pathAt(best.belt, 0, this.pkPos, p * 3);
  }
  stepBelt(g, dt2) {
    let ahead = Infinity;
    for (let k = 0; k < g.onBelt.length; k++) {
      const p = g.onBelt[k];
      let s = this.pkS[p] + BELT_SPEED * dt2;
      if (s > ahead - PKG_GAP) s = ahead - PKG_GAP;
      if (s >= g.belt.len) {
        s = g.belt.len;
        let slot = -1;
        for (let j = 0; j < MAG_CAP; j++)
          if (!g.slotUsed[j]) {
            slot = j;
            break;
          }
        if (slot >= 0) {
          g.slotUsed[slot] = 1;
          g.onBelt.splice(k, 1);
          k--;
          g.shifting.push(p);
          this.pkSlot[p] = slot;
          this.pkState[p] = PK_SHIFT;
          this.pkS[p] = 0;
          continue;
        }
      }
      this.pkS[p] = s;
      ahead = s;
      pathAt(g.belt, s, this.pkPos, p * 3);
    }
  }
  stepGun(g, dt2, aim, swarm, theta, omega) {
    const f = g.frame;
    const aUp = dot(aim, f.up);
    const aEx = dot(aim, f.ex);
    const aEy = dot(aim, f.ey);
    g.aimOk = aUp > Math.sin(MIN_ELEV);
    g.aimYaw = Math.atan2(aEy, aEx);
    g.aimPitch = g.aimOk ? Math.asin(Math.min(1, aUp)) : PARK_PITCH;
    const dy = wrap(g.aimYaw - g.yaw);
    g.yaw = wrap(g.yaw + Math.max(-SLEW_YAW * dt2, Math.min(SLEW_YAW * dt2, dy)));
    const dp = g.aimPitch - g.pitch;
    g.pitch += Math.max(-SLEW_PITCH * dt2, Math.min(SLEW_PITCH * dt2, dp));
    g.ready = g.aimOk && Math.abs(wrap(g.aimYaw - g.yaw)) < AIM_TOL && Math.abs(g.aimPitch - g.pitch) < AIM_TOL;
    g.cooldown -= dt2;
    g.charge = Math.max(0, g.charge - dt2 * 2.5);
    g.flash = Math.max(0, g.flash - dt2 * 6);
    for (let k = 0; k < g.shifting.length; k++) {
      const p = g.shifting[k];
      this.pkS[p] += dt2 / SHIFT_S;
      const u = Math.min(1, this.pkS[p]);
      const slot = g.rack[this.pkSlot[p]];
      const o = p * 3;
      const e = (g.belt.n - 1) * 3;
      const lift = Math.sin(u * Math.PI) * 0.35 * S;
      for (let j = 0; j < 3; j++) this.pkPos[o + j] = g.belt.pts[e + j] + (slot[j] - g.belt.pts[e + j]) * u + f.up[j] * lift;
      if (u >= 1) {
        g.shifting.splice(k, 1);
        k--;
        this.pkState[p] = PK_STACK;
        g.bound--;
        g.magazine.push(p);
        for (let j = 0; j < 3; j++) this.pkPos[o + j] = slot[j];
      }
    }
    if (g.busy < 0 && g.ready && g.cooldown <= 0 && g.magazine.length > 0) {
      const p = g.magazine.shift();
      g.busy = p;
      g.cooldown = FIRE_PERIOD;
      this.pkState[p] = PK_LOAD;
      this.pkS[p] = 0;
    }
    const cp = Math.cos(g.pitch);
    const sp = Math.sin(g.pitch);
    const cy = Math.cos(g.yaw);
    const sy = Math.sin(g.yaw);
    const dir = [
      cp * (cy * f.ex[0] + sy * f.ey[0]) + sp * f.up[0],
      cp * (cy * f.ex[1] + sy * f.ey[1]) + sp * f.up[1],
      cp * (cy * f.ex[2] + sy * f.ey[2]) + sp * f.up[2]
    ];
    if (g.busy >= 0) {
      const p = g.busy;
      const o = p * 3;
      if (this.pkState[p] === PK_LOAD) {
        this.pkS[p] += dt2 / LOAD_S;
        const u = Math.min(1, this.pkS[p]);
        const slot = g.rack[this.pkSlot[p]];
        const lift = Math.sin(u * Math.PI) * 0.6 * S;
        for (let k = 0; k < 3; k++) this.pkPos[o + k] = slot[k] + (g.pivot[k] - slot[k]) * u + f.up[k] * lift;
        g.charge = Math.min(1, g.charge + dt2 * 4);
        if (u >= 1) {
          g.slotUsed[this.pkSlot[p]] = 0;
          this.pkSlot[p] = -1;
          this.pkState[p] = PK_RAIL;
          this.pkS[p] = 0;
        }
      } else {
        this.pkS[p] += dt2 / RAIL_S;
        const u = Math.min(1, this.pkS[p]);
        const along = u * u * BARREL_LEN;
        for (let k = 0; k < 3; k++) this.pkPos[o + k] = g.pivot[k] + dir[k] * along;
        g.charge = 1;
        if (u >= 1) {
          const mB = this.tmpM;
          for (let k = 0; k < 3; k++) mB[k] = g.pivot[k] + dir[k] * BARREL_LEN;
          const mW = bodyToWorld(mB, theta, this.Q, this.tmpV);
          const dW = bodyToWorld(dir, theta, this.Q, new Float64Array(3));
          const wx = this.Q[1] * omega;
          const wy = this.Q[4] * omega;
          const wz = this.Q[7] * omega;
          const pos = [swarm.planetPos[0] + mW[0], swarm.planetPos[1] + mW[1], swarm.planetPos[2] + mW[2]];
          const vel = [
            swarm.planetVel[0] + (wy * mW[2] - wz * mW[1]) + dW[0] * V_MUZZLE,
            swarm.planetVel[1] + (wz * mW[0] - wx * mW[2]) + dW[1] * V_MUZZLE,
            swarm.planetVel[2] + (wx * mW[1] - wy * mW[0]) + dW[2] * V_MUZZLE
          ];
          swarm.launch(this.pkSail[p], pos, vel);
          this.freePackage(p);
          g.busy = -1;
          g.fired++;
          g.flash = 1;
        }
      }
    }
  }
  // How many rails can fire right now, and how many are mid-shot.
  counts() {
    let inWindow = 0;
    let firing = 0;
    let racked = 0;
    let onBelts = 0;
    let fired = 0;
    for (const g of this.guns) {
      if (g.aimOk) inWindow++;
      if (g.busy >= 0) firing++;
      racked += g.magazine.length;
      onBelts += g.onBelt.length;
      fired += g.fired;
    }
    let rocketsFired = 0;
    for (const s of this.sites) rocketsFired += s.rocketsFired;
    return { sites: this.sites.length, guns: this.guns.length, inWindow, firing, racked, onBelts, built: this.built, fired, rocketsFired };
  }
  // A sentence for the HUD about where a sail is on the ground.
  describePackage(p) {
    const g = this.guns[this.pkGun[p]];
    const where = `site ${g.site + 1}, rail ${g.index + 1}`;
    switch (this.pkState[p]) {
      case PK_BELT:
        return `on the belt to ${where}`;
      case PK_SHIFT:
        return `into the rack at ${where}`;
      case PK_STACK:
        return g.aimOk ? `racked at ${where}, window open` : `racked at ${where}, waiting for its window`;
      case PK_LOAD:
        return `loading on ${where}`;
      default:
        return `on the rail, ${where}`;
    }
  }
  // The body-frame point under a world point, for a ground camera anchor.
  worldToBodyPoint(w, swarm, out) {
    const theta = SPIN_RATE * swarm.time;
    const rel = [w[0] - swarm.planetPos[0], w[1] - swarm.planetPos[1], w[2] - swarm.planetPos[2]];
    return worldToBody(rel, theta, this.Q, out);
  }
};

// src/sphere.ts
var ROCKET_FLIGHT_S = 90;
var SAIL_MW = 0.03;
var FACE_BONUS_MW = 1.5;
var SLOTS = 6;
var DIST_EPS = 1e-4;
var AXIS_TILT = 0.3;
var SPIN_PERIOD_S = 2400;
function encodeTarget(layer, kind, index) {
  return layer * 1e6 + kind * 1e5 + index;
}
function decodeTarget(code, out) {
  const layer = Math.floor(code / 1e6);
  const rest = code - layer * 1e6;
  const kind = Math.floor(rest / 1e5);
  out.layer = layer;
  out.kind = kind === 1 ? 1 : 0;
  out.index = rest - kind * 1e5;
  return out;
}
function buildGeodesic(frequency) {
  const f = Math.max(1, Math.floor(frequency));
  const lat = Math.atan(0.5);
  const ico = [[0, 1, 0]];
  for (let k = 0; k < 5; k++) {
    const lon = k * 2 * Math.PI / 5;
    ico.push([Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)]);
  }
  for (let k = 0; k < 5; k++) {
    const lon = (k + 0.5) * 2 * Math.PI / 5;
    ico.push([Math.cos(lat) * Math.cos(lon), -Math.sin(lat), Math.cos(lat) * Math.sin(lon)]);
  }
  ico.push([0, -1, 0]);
  const icoFaces = [];
  for (let k = 0; k < 5; k++) {
    const u0 = 1 + k;
    const u1 = 1 + (k + 1) % 5;
    const l0 = 6 + k;
    const l1 = 6 + (k + 1) % 5;
    icoFaces.push([0, u0, u1], [u0, l0, u1], [l0, l1, u1], [11, l1, l0]);
  }
  const verts = [];
  const seen = /* @__PURE__ */ new Map();
  const addVert = (x, y, z) => {
    const l = Math.hypot(x, y, z);
    x /= l;
    y /= l;
    z /= l;
    const key = `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;
    let i = seen.get(key);
    if (i === void 0) {
      i = verts.length / 3;
      seen.set(key, i);
      verts.push(x, y, z);
    }
    return i;
  };
  for (const v of ico) addVert(v[0], v[1], v[2]);
  const tris = [];
  const pushTri = (a, b, c) => {
    const ax = verts[a * 3];
    const ay = verts[a * 3 + 1];
    const az = verts[a * 3 + 2];
    const ux = verts[b * 3] - ax;
    const uy = verts[b * 3 + 1] - ay;
    const uz = verts[b * 3 + 2] - az;
    const vx = verts[c * 3] - ax;
    const vy = verts[c * 3 + 1] - ay;
    const vz = verts[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const outward = nx * (ax * 3 + ux + vx) + ny * (ay * 3 + uy + vy) + nz * (az * 3 + uz + vz);
    if (outward < 0) tris.push(a, c, b);
    else tris.push(a, b, c);
  };
  for (const [a, b, c] of icoFaces) {
    const grid = [];
    for (let i = 0; i <= f; i++) {
      const row = [];
      for (let j = 0; i + j <= f; j++) {
        const wa = (f - i - j) / f;
        const wb = i / f;
        const wc = j / f;
        row.push(
          addVert(
            ico[a][0] * wa + ico[b][0] * wb + ico[c][0] * wc,
            ico[a][1] * wa + ico[b][1] * wb + ico[c][1] * wc,
            ico[a][2] * wa + ico[b][2] * wb + ico[c][2] * wc
          )
        );
      }
      grid.push(row);
    }
    for (let i = 0; i < f; i++) {
      for (let j = 0; i + j < f; j++) {
        pushTri(grid[i][j], grid[i + 1][j], grid[i][j + 1]);
        if (i + j + 1 < f) pushTri(grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]);
      }
    }
  }
  const edges = [];
  const faceEdges = [];
  const edgeOf = /* @__PURE__ */ new Map();
  for (let t = 0; t < tris.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = tris[t + e];
      const b = tris[t + (e + 1) % 3];
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const key = lo * 65536 + hi;
      let i = edgeOf.get(key);
      if (i === void 0) {
        i = edges.length / 2;
        edgeOf.set(key, i);
        edges.push(lo, hi);
      }
      faceEdges.push(i);
    }
  }
  const V = verts.length / 3;
  const adjStart = new Uint32Array(V + 1);
  for (let e = 0; e < edges.length; e++) adjStart[edges[e] + 1]++;
  for (let v = 0; v < V; v++) adjStart[v + 1] += adjStart[v];
  const adj = new Uint16Array(edges.length);
  const fill = new Uint32Array(V);
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e];
    const b = edges[e + 1];
    adj[adjStart[a] + fill[a]++] = b;
    adj[adjStart[b] + fill[b]++] = a;
  }
  return {
    nodes: Float32Array.from(verts),
    edges: Uint16Array.from(edges),
    faces: Uint16Array.from(tris),
    faceEdges: Uint16Array.from(faceEdges),
    adjStart,
    adj
  };
}
var DysonSphere = class {
  layers;
  NODE_COST = 40;
  // rockets per node
  EDGE_COST = 60;
  // rockets per frame
  FACE_CELLS = 900;
  // sails per shell face
  spin;
  // radians per second about the axis
  axis;
  // Rockets that arrived at a node or frame already finished. A handful is
  // normal at the very end of the build; many would mean a caller drops
  // targets after asking for them without calling cancelRocket.
  wasted = 0;
  // The mesh is shared by every layer.
  V;
  E;
  F;
  faceEdges;
  adjStart;
  adj;
  // Build order: angle from node 0, and a seeded key that settles the many
  // exact ties a symmetric mesh has, so the growth has a little character.
  nodeDist;
  edgeDist;
  nodeKey;
  edgeKey;
  // Per layer integer progress. Pending counts the rockets handed out by
  // nextTarget that have not landed yet, so a node is not promised to more
  // rockets than it needs while forty of them are in the air.
  nodeRockets;
  edgeRockets;
  nodePending;
  edgePending;
  faceCells;
  // The open targets rockets are being spread across, as encoded codes or -1.
  slots = new Int32Array(SLOTS);
  slotPtr = 0;
  faceCursor = 0;
  // Scratch for the rotation, so no vector is ever allocated per call.
  rx = 0;
  ry = 0;
  rz = 0;
  constructor(radii, frequency, seed) {
    const rand = mulberry32(seed);
    const mesh = buildGeodesic(frequency);
    const V = mesh.nodes.length / 3;
    const E = mesh.edges.length / 2;
    const F = mesh.faces.length / 3;
    this.V = V;
    this.E = E;
    this.F = F;
    this.faceEdges = mesh.faceEdges;
    this.adjStart = mesh.adjStart;
    this.adj = mesh.adj;
    this.layers = radii.map((R2) => ({
      R: R2,
      nodes: mesh.nodes,
      edges: mesh.edges,
      faces: mesh.faces,
      nodeProg: new Float32Array(V),
      edgeProg: new Float32Array(E),
      faceFill: new Float32Array(F),
      inbound: new Uint16Array(F)
    }));
    this.nodeRockets = radii.map(() => new Uint16Array(V));
    this.edgeRockets = radii.map(() => new Uint16Array(E));
    this.nodePending = radii.map(() => new Uint16Array(V));
    this.edgePending = radii.map(() => new Uint16Array(E));
    this.faceCells = radii.map(() => new Uint16Array(F));
    this.slots.fill(-1);
    const n = mesh.nodes;
    const px = n[0];
    const py = n[1];
    const pz = n[2];
    this.nodeDist = new Float32Array(V);
    this.nodeKey = new Float32Array(V);
    for (let i = 0; i < V; i++) {
      const d = n[i * 3] * px + n[i * 3 + 1] * py + n[i * 3 + 2] * pz;
      this.nodeDist[i] = Math.acos(Math.max(-1, Math.min(1, d)));
      this.nodeKey[i] = rand();
    }
    this.edgeDist = new Float32Array(E);
    this.edgeKey = new Float32Array(E);
    for (let e = 0; e < E; e++) {
      const a = mesh.edges[e * 2] * 3;
      const b = mesh.edges[e * 2 + 1] * 3;
      const mx = n[a] + n[b];
      const my = n[a + 1] + n[b + 1];
      const mz = n[a + 2] + n[b + 2];
      const ml = Math.hypot(mx, my, mz) || 1;
      const d = (mx * px + my * py + mz * pz) / ml;
      this.edgeDist[e] = Math.acos(Math.max(-1, Math.min(1, d)));
      this.edgeKey[e] = rand();
    }
    const az = rand() * Math.PI * 2;
    this.axis = [Math.sin(AXIS_TILT) * Math.cos(az), Math.cos(AXIS_TILT), Math.sin(AXIS_TILT) * Math.sin(az)];
    this.spin = 2 * Math.PI / SPIN_PERIOD_S;
  }
  // Rodrigues rotation of (x, y, z) about the axis by the angle whose cosine
  // and sine are given. The result lands in rx, ry, rz.
  rotate(x, y, z, c, s) {
    const a = this.axis;
    const al = Math.hypot(a[0], a[1], a[2]) || 1;
    const ax = a[0] / al;
    const ay = a[1] / al;
    const az = a[2] / al;
    const d = (ax * x + ay * y + az * z) * (1 - c);
    this.rx = x * c + (ay * z - az * y) * s + ax * d;
    this.ry = y * c + (az * x - ax * z) * s + ay * d;
    this.rz = z * c + (ax * y - ay * x) * s + az * d;
  }
  // Position of a node, or the midpoint of an edge, in world space at time t.
  structurePos(target, t, out) {
    const L = this.layers[target.layer];
    let x = 0;
    let y = 0;
    let z = 0;
    if (L && target.index >= 0) {
      const nodes = L.nodes;
      if (target.kind === 0) {
        if (target.index < this.V) {
          const o = target.index * 3;
          x = nodes[o] * L.R;
          y = nodes[o + 1] * L.R;
          z = nodes[o + 2] * L.R;
        }
      } else if (target.index < this.E) {
        const a = L.edges[target.index * 2] * 3;
        const b = L.edges[target.index * 2 + 1] * 3;
        x = (nodes[a] + nodes[b]) * 0.5 * L.R;
        y = (nodes[a + 1] + nodes[b + 1]) * 0.5 * L.R;
        z = (nodes[a + 2] + nodes[b + 2]) * 0.5 * L.R;
      }
    }
    const ang = this.spin * t;
    this.rotate(x, y, z, Math.cos(ang), Math.sin(ang));
    out[0] = this.rx;
    out[1] = this.ry;
    out[2] = this.rz;
  }
  // A node or frame is covered once the rockets it has plus the rockets on
  // their way add up to its cost. Covered is what the planner reasons with;
  // the renderer and the faces only care about rockets that have landed.
  nodeCovered(layer, i) {
    return this.nodeRockets[layer][i] + this.nodePending[layer][i] >= this.NODE_COST;
  }
  edgeCovered(layer, e) {
    return this.edgeRockets[layer][e] + this.edgePending[layer][e] >= this.EDGE_COST;
  }
  need(code) {
    const layer = Math.floor(code / 1e6);
    const rest = code - layer * 1e6;
    const kind = Math.floor(rest / 1e5);
    const index = rest - kind * 1e5;
    return kind === 0 ? this.NODE_COST - this.nodeRockets[layer][index] - this.nodePending[layer][index] : this.EDGE_COST - this.edgeRockets[layer][index] - this.edgePending[layer][index];
  }
  layerOpen(layer) {
    for (let i = 0; i < this.V; i++) if (!this.nodeCovered(layer, i)) return true;
    for (let e = 0; e < this.E; e++) if (!this.edgeCovered(layer, e)) return true;
    return false;
  }
  inSlots(code) {
    for (let s = 0; s < SLOTS; s++) if (this.slots[s] === code) return true;
    return false;
  }
  // The next thing to build that is not already open: in the innermost
  // unfinished layer, the node with the most covered neighbours and then the
  // one nearest the first node, so the structure grows as one patch rather
  // than as freckles; once every node is covered, the frame between two
  // covered nodes nearest the first node.
  pickCandidate() {
    let layer = 0;
    while (layer < this.layers.length && !this.layerOpen(layer)) layer++;
    if (layer >= this.layers.length) return -1;
    let best = -1;
    let bestN = -1;
    let bestD = 0;
    let bestK = 0;
    const { adjStart, adj, nodeDist, nodeKey } = this;
    for (let i = 0; i < this.V; i++) {
      if (this.nodeCovered(layer, i)) continue;
      const code = encodeTarget(layer, 0, i);
      if (this.inSlots(code)) continue;
      let n = 0;
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) if (this.nodeCovered(layer, adj[k])) n++;
      const d = nodeDist[i];
      const key = nodeKey[i];
      if (best < 0 || n > bestN || n === bestN && (d < bestD - DIST_EPS || Math.abs(d - bestD) <= DIST_EPS && key < bestK)) {
        best = code;
        bestN = n;
        bestD = d;
        bestK = key;
      }
    }
    if (best >= 0) return best;
    const { edges } = this.layers[layer];
    const { edgeDist, edgeKey } = this;
    for (let e = 0; e < this.E; e++) {
      if (this.edgeCovered(layer, e)) continue;
      if (!this.nodeCovered(layer, edges[e * 2]) || !this.nodeCovered(layer, edges[e * 2 + 1])) continue;
      const code = encodeTarget(layer, 1, e);
      if (this.inSlots(code)) continue;
      const d = edgeDist[e];
      const key = edgeKey[e];
      if (best < 0 || d < bestD - DIST_EPS || Math.abs(d - bestD) <= DIST_EPS && key < bestK) {
        best = code;
        bestD = d;
        bestK = key;
      }
    }
    return best;
  }
  // Anything whose rockets have not all landed, for when the planner has
  // nothing open: the most advanced node first, then the most advanced frame.
  pickUnfinished() {
    for (let layer = 0; layer < this.layers.length; layer++) {
      let best = -1;
      let bestHave = -1;
      const nr = this.nodeRockets[layer];
      for (let i = 0; i < this.V; i++) {
        if (nr[i] < this.NODE_COST && nr[i] > bestHave) {
          best = i;
          bestHave = nr[i];
        }
      }
      if (best >= 0) return encodeTarget(layer, 0, best);
      const er = this.edgeRockets[layer];
      for (let e = 0; e < this.E; e++) {
        if (er[e] < this.EDGE_COST && er[e] > bestHave) {
          best = e;
          bestHave = er[e];
        }
      }
      if (best >= 0) return encodeTarget(layer, 1, best);
    }
    return -1;
  }
  // Retire the slots whose targets are covered and refill them in build order.
  refreshSlots() {
    for (let s = 0; s < SLOTS; s++) if (this.slots[s] >= 0 && this.need(this.slots[s]) <= 0) this.slots[s] = -1;
    for (let s = 0; s < SLOTS; s++) {
      if (this.slots[s] >= 0) continue;
      const code = this.pickCandidate();
      if (code < 0) break;
      this.slots[s] = code;
    }
  }
  addPending(target, delta) {
    const pend = target.kind === 0 ? this.nodePending[target.layer] : this.edgePending[target.layer];
    if (!pend || target.index < 0 || target.index >= pend.length) return;
    const v = pend[target.index] + delta;
    pend[target.index] = v < 0 ? 0 : v > 65535 ? 65535 : v;
  }
  // Where the next rocket should go, or null when every layer is complete.
  // The open targets are served in turn, so a burst of launches lands on up
  // to six places rather than one. A fresh object is returned each time; a
  // launch happens a few times a minute, so this is not a hot path.
  nextTarget() {
    this.refreshSlots();
    for (let k = 0; k < SLOTS; k++) {
      const s = (this.slotPtr + k) % SLOTS;
      const code2 = this.slots[s];
      if (code2 < 0) continue;
      this.slotPtr = (s + 1) % SLOTS;
      const tg2 = decodeTarget(code2, { layer: 0, kind: 0, index: 0 });
      this.addPending(tg2, 1);
      return tg2;
    }
    const code = this.pickUnfinished();
    if (code < 0) return null;
    const tg = decodeTarget(code, { layer: 0, kind: 0, index: 0 });
    this.addPending(tg, 1);
    return tg;
  }
  // A rocket handed out by nextTarget that never launched; gives its share back.
  cancelRocket(target) {
    this.addPending(target, -1);
  }
  addNodeRockets(layer, i, k) {
    const have = this.nodeRockets[layer][i];
    const room = this.NODE_COST - have;
    if (k > room) {
      this.wasted += k - room;
      k = room;
    }
    if (k <= 0) return;
    this.nodeRockets[layer][i] = have + k;
    this.layers[layer].nodeProg[i] = (have + k) / this.NODE_COST;
  }
  addEdgeRockets(layer, e, k) {
    const have = this.edgeRockets[layer][e];
    const room = this.EDGE_COST - have;
    if (k > room) {
      this.wasted += k - room;
      k = room;
    }
    if (k <= 0) return;
    this.edgeRockets[layer][e] = have + k;
    this.layers[layer].edgeProg[e] = (have + k) / this.EDGE_COST;
  }
  deliverCode(code, k) {
    const layer = Math.floor(code / 1e6);
    const rest = code - layer * 1e6;
    const kind = Math.floor(rest / 1e5);
    const index = rest - kind * 1e5;
    if (kind === 0) this.addNodeRockets(layer, index, k);
    else this.addEdgeRockets(layer, index, k);
  }
  // One rocket's worth of progress.
  deliverRocket(target) {
    const layer = target.layer;
    const i = target.index;
    if (layer < 0 || layer >= this.layers.length || i < 0) return;
    if (target.kind === 0) {
      if (i >= this.V) return;
      const pend = this.nodePending[layer];
      if (pend[i] > 0) pend[i]--;
      this.addNodeRockets(layer, i, 1);
    } else {
      if (i >= this.E) return;
      const pend = this.edgePending[layer];
      if (pend[i] > 0) pend[i]--;
      this.addEdgeRockets(layer, i, 1);
    }
  }
  // A face takes sails once its three frames have all their rockets and
  // until its cells are full.
  faceReady(layer, f) {
    if (this.faceCells[layer][f] >= this.FACE_CELLS) return false;
    const er = this.edgeRockets[layer];
    const fe = this.faceEdges;
    const o = f * 3;
    return er[fe[o]] >= this.EDGE_COST && er[fe[o + 1]] >= this.EDGE_COST && er[fe[o + 2]] >= this.EDGE_COST;
  }
  // Faces ready for sails, up to `max`, least loaded first, with the centroid
  // in world space at time t. `out` is reused; an entry is only created when
  // the array is shorter than the count returned.
  readyFaces(t, max, out) {
    if (max <= 0) return 0;
    const nl = this.layers.length;
    const F = this.F;
    const total = nl * F;
    let lo = 65535;
    let hi = -1;
    for (let l = 0; l < nl; l++) {
      const inb = this.layers[l].inbound;
      for (let f = 0; f < F; f++) {
        if (!this.faceReady(l, f)) continue;
        const v = inb[f];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (hi < 0) return 0;
    const ang = this.spin * t;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    let n = 0;
    for (let level = lo; level <= hi && n < max; level++) {
      const last = level === hi || level - lo >= 6;
      for (let k = 0; k < total && n < max; k++) {
        const g = (this.faceCursor + k) % total;
        const l = Math.floor(g / F);
        const f = g - l * F;
        if (!this.faceReady(l, f)) continue;
        const v = this.layers[l].inbound[f];
        if (last ? v < level : v !== level) continue;
        let item = out[n];
        if (item === void 0) {
          item = { layer: 0, face: 0, cx: 0, cy: 0, cz: 0 };
          out.push(item);
        }
        const L = this.layers[l];
        const nodes = L.nodes;
        const a = L.faces[f * 3] * 3;
        const b = L.faces[f * 3 + 1] * 3;
        const d = L.faces[f * 3 + 2] * 3;
        const third = L.R / 3;
        this.rotate(
          (nodes[a] + nodes[b] + nodes[d]) * third,
          (nodes[a + 1] + nodes[b + 1] + nodes[d + 1]) * third,
          (nodes[a + 2] + nodes[b + 2] + nodes[d + 2]) * third,
          c,
          s
        );
        item.layer = l;
        item.face = f;
        item.cx = this.rx;
        item.cy = this.ry;
        item.cz = this.rz;
        n++;
      }
      if (last) break;
    }
    this.faceCursor = (this.faceCursor + n) % total;
    return n;
  }
  addCells(layer, face, k) {
    const cells = this.faceCells[layer];
    const have = cells[face];
    const v = have + k > this.FACE_CELLS ? this.FACE_CELLS : have + k;
    if (v === have) return;
    cells[face] = v;
    this.layers[layer].faceFill[face] = v / this.FACE_CELLS;
  }
  // One sail into the shell.
  absorb(layer, face) {
    if (layer < 0 || layer >= this.layers.length || face < 0 || face >= this.F) return;
    this.addCells(layer, face, 1);
  }
  setInbound(layer, face, delta) {
    if (layer < 0 || layer >= this.layers.length || face < 0 || face >= this.F) return;
    const inb = this.layers[layer].inbound;
    const v = inb[face] + delta;
    inb[face] = v < 0 ? 0 : v > 65535 ? 65535 : v;
  }
  // 0.03 MW per absorbed sail, 1.5 MW extra per finished face.
  powerMW() {
    let cells = 0;
    let done = 0;
    for (let l = 0; l < this.layers.length; l++) {
      const fc = this.faceCells[l];
      for (let f = 0; f < this.F; f++) {
        cells += fc[f];
        if (fc[f] >= this.FACE_CELLS) done++;
      }
    }
    return cells * SAIL_MW + done * FACE_BONUS_MW;
  }
  // Every node, frame and face counts as one unit, whatever it costs, so the
  // readout moves at a steady pace through the whole build instead of sitting
  // near zero until the shells start to fill.
  completion() {
    let sum = 0;
    for (let l = 0; l < this.layers.length; l++) {
      const nr = this.nodeRockets[l];
      const er = this.edgeRockets[l];
      const fc = this.faceCells[l];
      for (let i = 0; i < this.V; i++) sum += nr[i] / this.NODE_COST;
      for (let e = 0; e < this.E; e++) sum += er[e] / this.EDGE_COST;
      for (let f = 0; f < this.F; f++) sum += fc[f] / this.FACE_CELLS;
    }
    const total = this.layers.length * (this.V + this.E + this.F);
    return total > 0 ? Math.min(1, sum / total) : 0;
  }
  counts() {
    let nodesDone = 0;
    let framesDone = 0;
    let facesDone = 0;
    let cells = 0;
    for (let l = 0; l < this.layers.length; l++) {
      const nr = this.nodeRockets[l];
      const er = this.edgeRockets[l];
      const fc = this.faceCells[l];
      for (let i = 0; i < this.V; i++) if (nr[i] >= this.NODE_COST) nodesDone++;
      for (let e = 0; e < this.E; e++) if (er[e] >= this.EDGE_COST) framesDone++;
      for (let f = 0; f < this.F; f++) {
        cells += fc[f];
        if (fc[f] >= this.FACE_CELLS) facesDone++;
      }
    }
    const nl = this.layers.length;
    return { nodes: nl * this.V, nodesDone, frames: nl * this.E, framesDone, faces: nl * this.F, facesDone, cells };
  }
  // Land n rockets the way nextTarget would have handed them out, in whole
  // rounds across the open slots at a time: every slot gets as many as the
  // neediest one can take before any of them finishes, then the finished
  // slots are refilled, and a final partial round goes one by one from the
  // pointer. The same decisions as the live planner, in far fewer steps.
  deliverMany(n) {
    while (n > 0) {
      this.refreshSlots();
      let live = 0;
      let m = 1 << 30;
      for (let s = 0; s < SLOTS; s++) {
        const code = this.slots[s];
        if (code < 0) continue;
        live++;
        const need = this.need(code);
        if (need < m) m = need;
      }
      if (live === 0) {
        const code = this.pickUnfinished();
        if (code < 0) return;
        this.deliverCode(code, 1);
        n--;
        continue;
      }
      if (n >= live * m) {
        for (let s = 0; s < SLOTS; s++) if (this.slots[s] >= 0) this.deliverCode(this.slots[s], m);
        n -= live * m;
        continue;
      }
      const per = Math.floor(n / live);
      let extra = n - per * live;
      let lastExtra = -1;
      for (let k = 0; k < SLOTS; k++) {
        const s = (this.slotPtr + k) % SLOTS;
        const code = this.slots[s];
        if (code < 0) continue;
        let give = per;
        if (extra > 0) {
          give++;
          extra--;
          lastExtra = s;
        }
        if (give > 0) this.deliverCode(code, give);
      }
      if (lastExtra >= 0) this.slotPtr = (lastExtra + 1) % SLOTS;
      n = 0;
    }
  }
  // Share k sails evenly over the faces ready for them. Sails with no face to
  // take them are not banked: in the live sim they stay in orbit and are
  // recycled, so production before the first frames stand is simply lost.
  spreadSails(k) {
    const nl = this.layers.length;
    let n = 0;
    for (let l = 0; l < nl; l++) for (let f = 0; f < this.F; f++) if (this.faceReady(l, f)) n++;
    if (n === 0) return;
    const per = Math.floor(k / n);
    let extra = k - per * n;
    for (let l = 0; l < nl; l++) {
      for (let f = 0; f < this.F; f++) {
        if (!this.faceReady(l, f)) continue;
        let give = per;
        if (extra > 0) {
          give++;
          extra--;
        }
        if (give > 0) this.addCells(l, f, give);
      }
    }
  }
  // Fast forward the construction given production rates, in build order.
  // Rockets land ROCKET_FLIGHT_S after they are made, so progress lags
  // production by that; sails are absorbed as they are made, into whatever
  // faces are ready at the time. Coarse steps of about twenty seconds keep
  // the opening of faces and the sails that follow in the right order.
  advance(seconds, rocketsPerSec, sailsPerSec) {
    if (!(seconds > 0)) return;
    const rr = rocketsPerSec > 0 ? rocketsPerSec : 0;
    const sr = sailsPerSec > 0 ? sailsPerSec : 0;
    const steps2 = Math.max(1, Math.ceil(seconds / 20));
    const dt2 = seconds / steps2;
    let delivered = 0;
    let sailBudget = 0;
    for (let s = 1; s <= steps2; s++) {
      const t = s * dt2;
      const want = Math.floor(rr * Math.max(0, t - ROCKET_FLIGHT_S));
      if (want > delivered) {
        this.deliverMany(want - delivered);
        delivered = want;
      }
      sailBudget += sr * dt2;
      const k = Math.floor(sailBudget);
      if (k > 0) {
        this.spreadSails(k);
        sailBudget -= k;
      }
    }
  }
};

// src/rockets.ts
var ROCKET_SPEED = 10;
var ROCKET_THRUST = 5;
var KEEP_OUT = 160;
var ARRIVE_RADIUS = 3;
var STEER_GAIN = 1.2;
var APPROACH_SPEED = 2.5;
var APPROACH_GAIN = 0.35;
var MAX_FLIGHT_S = 600;
var MAX_LAYER = 1e3;
var MAX_INDEX = 1e5;
var OFF_MESH_R2 = 1;
var Rockets = class {
  N;
  pos;
  // 3 per rocket
  vel;
  alive;
  target;
  // layer * 1000000 + kind * 100000 + index, or -1
  age;
  // seconds since launch, for the HUD and tests
  launched = 0;
  arrived = 0;
  // landed, including the ones landed by the flight timeout
  timedOut = 0;
  lost = 0;
  // dropped on their first step because the target was not on the sphere; never flown, never landed
  live = 0;
  freePtr = 0;
  // Scratch for the step, so nothing is allocated while rockets fly.
  tg = { layer: 0, kind: 0, index: 0 };
  aim = new Float64Array(3);
  constructor(N) {
    this.N = Math.max(0, Math.floor(N));
    this.pos = new Float32Array(this.N * 3);
    this.vel = new Float32Array(this.N * 3);
    this.alive = new Uint8Array(this.N);
    this.target = new Int32Array(this.N).fill(-1);
    this.age = new Float32Array(this.N);
  }
  // Fire a rocket from a silo: an inertial position and velocity and the
  // target the sphere handed out. False when every slot is in flight or the
  // request is malformed. The target must fit the packing; given the sphere
  // it must also name a node or frame that exists on it, so a bad launch is
  // refused at the pad. Without the sphere an off mesh target is still
  // caught, by the first step, which drops the rocket where it stands.
  launch(pos, vel, target, sphere2) {
    if (this.live >= this.N) return false;
    const { layer, kind, index } = target;
    if (!(layer >= 0 && layer < MAX_LAYER && layer === Math.floor(layer))) return false;
    if (kind !== 0 && kind !== 1) return false;
    if (!(index >= 0 && index < MAX_INDEX && index === Math.floor(index))) return false;
    if (sphere2) {
      const L = sphere2.layers[layer];
      if (!L) return false;
      if (index >= (kind === 0 ? L.nodes.length / 3 : L.edges.length / 2)) return false;
    }
    for (let k = 0; k < 3; k++) if (!Number.isFinite(pos[k]) || !Number.isFinite(vel[k])) return false;
    for (let tries = 0; tries < this.N; tries++) {
      const i = (this.freePtr + tries) % this.N;
      if (this.alive[i]) continue;
      this.freePtr = (i + 1) % this.N;
      const o = i * 3;
      this.pos[o] = pos[0];
      this.pos[o + 1] = pos[1];
      this.pos[o + 2] = pos[2];
      this.vel[o] = vel[0];
      this.vel[o + 1] = vel[1];
      this.vel[o + 2] = vel[2];
      this.target[i] = encodeTarget(layer, kind, index);
      this.age[i] = 0;
      this.alive[i] = 1;
      this.live++;
      this.launched++;
      return true;
    }
    return false;
  }
  // One step of semi-implicit Euler for every rocket in flight: steer at the
  // target's position at time t, land within ARRIVE_RADIUS of it, hand the
  // sphere the rocket and free the slot.
  step(dt2, sphere2, t) {
    if (!(dt2 > 0) || this.live === 0) return;
    const { pos, vel, alive, target, age } = this;
    const tg = this.tg;
    const aim = this.aim;
    const keep2 = KEEP_OUT * KEEP_OUT;
    for (let i = 0; i < this.N; i++) {
      if (!alive[i]) continue;
      const o = i * 3;
      const px = pos[o];
      const py = pos[o + 1];
      const pz = pos[o + 2];
      let vx = vel[o];
      let vy = vel[o + 1];
      let vz = vel[o + 2];
      decodeTarget(target[i], tg);
      sphere2.structurePos(tg, t, aim);
      if (aim[0] * aim[0] + aim[1] * aim[1] + aim[2] * aim[2] < OFF_MESH_R2) {
        alive[i] = 0;
        target[i] = -1;
        this.live--;
        this.lost++;
        continue;
      }
      const dx = aim[0] - px;
      const dy = aim[1] - py;
      const dz = aim[2] - pz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      age[i] += dt2;
      if (dist < ARRIVE_RADIUS || age[i] > MAX_FLIGHT_S) {
        if (dist >= ARRIVE_RADIUS) this.timedOut++;
        sphere2.deliverRocket(tg);
        alive[i] = 0;
        target[i] = -1;
        this.live--;
        this.arrived++;
        continue;
      }
      let r2 = px * px + py * py + pz * pz;
      if (r2 < 1) r2 = 1;
      const inv3 = GM / (r2 * Math.sqrt(r2));
      const gx = -px * inv3;
      const gy = -py * inv3;
      const gz = -pz * inv3;
      let ux = dx / dist;
      let uy = dy / dist;
      let uz = dz / dist;
      const s = -(px * ux + py * uy + pz * uz);
      if (s > 0 && s < dist) {
        const cx = px + s * ux;
        const cy = py + s * uy;
        const cz = pz + s * uz;
        const rc2 = cx * cx + cy * cy + cz * cz;
        if (rc2 < keep2) {
          let lx;
          let ly;
          let lz;
          if (rc2 > 1e-6) {
            const rc = Math.sqrt(rc2);
            lx = cx / rc;
            ly = cy / rc;
            lz = cz / rc;
          } else {
            lx = uz;
            ly = 0;
            lz = -ux;
            const ll = Math.sqrt(lx * lx + lz * lz);
            if (ll > 1e-3) {
              lx /= ll;
              lz /= ll;
            } else {
              lx = 0;
              lz = uy > 0 ? 1 : -1;
            }
          }
          const wx = lx * KEEP_OUT - px;
          const wy = ly * KEEP_OUT - py;
          const wz = lz * KEEP_OUT - pz;
          const wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
          if (wl > 1e-6) {
            ux = wx / wl;
            uy = wy / wl;
            uz = wz / wl;
          }
        }
      }
      const want = Math.min(ROCKET_SPEED, APPROACH_SPEED + APPROACH_GAIN * dist);
      let tx = STEER_GAIN * (ux * want - vx) - gx;
      let ty = STEER_GAIN * (uy * want - vy) - gy;
      let tz = STEER_GAIN * (uz * want - vz) - gz;
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (tl > ROCKET_THRUST) {
        const k = ROCKET_THRUST / tl;
        tx *= k;
        ty *= k;
        tz *= k;
      }
      vx += (gx + tx) * dt2;
      vy += (gy + ty) * dt2;
      vz += (gz + tz) * dt2;
      vel[o] = vx;
      vel[o + 1] = vy;
      vel[o + 2] = vz;
      pos[o] = px + vx * dt2;
      pos[o + 1] = py + vy * dt2;
      pos[o + 2] = pz + vz * dt2;
    }
  }
  // Rockets in flight.
  count() {
    return this.live;
  }
};

// tools/engine_test.ts
var lanes = [
  { r: 190, tilt: [0.9, 0.3], n: 2200 },
  { r: 245, tilt: [-0.5, 0.9], n: 2400 },
  { r: 300, tilt: [0.25, -1.1], n: 2600 }
];
var R = 16;
var start = [910, 0, 0];
var vc = Math.sqrt(GM / 910);
var sw = new Swarm(lanes, start, [0, 0, -vc], R, 7);
var tilt = 0.4;
var Q = [Math.cos(tilt), -Math.sin(tilt), 0, Math.sin(tilt), Math.cos(tilt), 0, 0, 0, 1];
var ground = new Surface(R, sw, Q, 11);
var economy = new Economy(ground.sites.length, mulberry32(11));
var sphere = new DysonSphere([215, 272, 330], 2, 5);
var rockets = new Rockets(400);
ground.attach(economy, sphere, rockets);
var FAST_FORWARD_S = Number(process.argv[2] ?? 4 * 3600);
economy.advance(FAST_FORWARD_S, 3.6, 30);
var r0 = economy.rates();
sphere.advance(FAST_FORWARD_S, r0.rocketsPerSec, r0.sailsPerSec);
console.log(`after fast forward of ${(FAST_FORWARD_S / 3600).toFixed(1)} h: economy ${r0.sailsPerSec.toFixed(2)} sails/s ${r0.rocketsPerSec.toFixed(3)} rockets/s; sphere ${(sphere.completion() * 100).toFixed(1)}% ${JSON.stringify(sphere.counts())} ${sphere.powerMW().toFixed(0)} MW`);
var tgt = { layer: 0, kind: 0, index: 0 };
var cpos = new Float64Array(3);
var centroidOf = (key, out, o) => {
  const layer = Math.floor(key / 1e5);
  const face = key % 1e5;
  const L = sphere.layers[layer];
  out[o] = out[o + 1] = out[o + 2] = 0;
  for (let k = 0; k < 3; k++) {
    tgt.layer = layer;
    tgt.kind = 0;
    tgt.index = L.faces[face * 3 + k];
    sphere.structurePos(tgt, sw.time, cpos);
    out[o] += cpos[0] / 3;
    out[o + 1] += cpos[1] / 3;
    out[o + 2] += cpos[2] / 3;
  }
};
var onAbsorbed = (_i, key) => {
  sphere.absorb(Math.floor(key / 1e5), key % 1e5);
  sphere.setInbound(Math.floor(key / 1e5), key % 1e5, -1);
};
var ready = [];
for (let k = 0; k < 16; k++) ready.push({ layer: 0, face: 0, cx: 0, cy: 0, cz: 0 });
var absorbClock = 0;
var absorbTick = (dt2) => {
  absorbClock -= dt2;
  if (absorbClock > 0) return;
  absorbClock = 0.5;
  const n = sphere.readyFaces(sw.time, 16, ready);
  for (let k = 0; k < n; k++) {
    const f = ready[k];
    const want = 10 - sphere.layers[f.layer].inbound[f.face];
    if (want <= 0) continue;
    const sent = sw.pickForFace(f.layer * 1e5 + f.face, f.cx, f.cy, f.cz, want);
    if (sent > 0) sphere.setInbound(f.layer, f.face, sent);
  }
};
var dt = 1 / 40;
var T = Number(process.argv[3] ?? 600);
var steps = Math.round(T / dt);
var minRocketR = Infinity;
var bad = 0;
var t0 = Date.now();
var c0 = sphere.counts();
var launched0 = sw.launched;
for (let s = 0; s < steps; s++) {
  sw.step(dt / 2, centroidOf, onAbsorbed);
  sw.step(dt / 2, centroidOf, onAbsorbed);
  ground.step(dt, sw);
  economy.tick(dt, ground.sunElev, sphere.powerMW());
  rockets.step(dt, sphere, sw.time);
  absorbTick(dt);
  for (let r = 0; r < rockets.N; r++) {
    if (!rockets.alive[r]) continue;
    const d = Math.hypot(rockets.pos[r * 3], rockets.pos[r * 3 + 1], rockets.pos[r * 3 + 2]);
    if (!Number.isFinite(d)) bad++;
    if (d < minRocketR) minRocketR = d;
  }
  if (s % Math.round(120 / dt) === 0) {
    const c = sw.counts();
    const g = ground.counts();
    const e = economy.rates();
    const sc = sphere.counts();
    const sat = e.demandMW > 0 ? Math.min(1, e.supplyMW / e.demandMW) : 1;
    const sun = Array.from(ground.sunElev).map((x) => x.toFixed(1)).join(",");
    console.log(
      `t=${Math.round(sw.time)}s orbit=${c.orbit} transit=${c.transit} absorbing=${c.absorbing} absorbed=${c.absorbed} launched=${c.launched} | rockets fired ${g.rocketsFired} flying ${rockets.count()} | sphere ${(sphere.completion() * 100).toFixed(2)}% nodes ${sc.nodesDone}/${sc.nodes} frames ${sc.framesDone}/${sc.frames} cells ${sc.cells} ${sphere.powerMW().toFixed(0)} MW | factories ${(sat * 100).toFixed(0)}% power (${e.supplyMW.toFixed(0)}/${e.demandMW.toFixed(0)} MW) ${e.sailsPerSec.toFixed(2)} sails/s ${e.rocketsPerSec.toFixed(3)} rockets/s | sun ${sun}`
    );
  }
}
var ms = Date.now() - t0;
var c1 = sphere.counts();
console.log(`
${steps} steps in ${ms} ms (${(ms / steps).toFixed(2)} ms/step, whole engine)`);
console.log(`live run: sails launched ${sw.launched - launched0} (${((sw.launched - launched0) / T).toFixed(1)}/s), absorbed ${sw.absorbed}, rockets fired ${ground.counts().rocketsFired}, nodes +${c1.nodesDone - c0.nodesDone}, frames +${c1.framesDone - c0.framesDone}, cells +${c1.cells - c0.cells}`);
console.log(`closest a rocket came to the Sun: ${minRocketR.toFixed(1)} (must stay above 40); non finite rocket positions: ${bad}`);
var mismatches = 0;
for (let p = 0; p < ground.nPackages; p++) {
  if (!ground.pkAlive[p]) continue;
  const i = ground.pkSail[p];
  if (i < 0 || sw.state[i] !== 4 || ground.pkOf[i] !== p) mismatches++;
}
console.log(`package/sail bookkeeping mismatches: ${mismatches}`);
