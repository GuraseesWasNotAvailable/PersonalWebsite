// The ground: factories, haulers, belts, magazines and ejectors, as a
// simulation with no renderer in sight.
//
// A site is a factory on a pad with a mine beside it and a row of ejectors in
// front. Hauler bots carry ore from the mine to the factory dock and queue
// when the dock is full. The factory turns ore into folded sails, one per
// belt, and the belts carry them to the ejectors' racks. Each ejector is a
// gimballed electromagnetic rail that tracks the launch direction the orbit
// needs and fires only while that direction is above its horizon, so as the
// planet turns, sites come into their window, drain their racks in bursts,
// then stall and fill up again on the far side. A fired sail leaves the
// muzzle with a real inertial velocity and from then on belongs to swarm.ts.
//
// Positions here are in the planet's body frame, the frame the surface mesh
// and everything on it rotates in. Sites use a local plane (x along e, y
// along f) wrapped onto the sphere, so a site is flat to walk around but sits
// on the curve.
import { Swarm, mulberry32 } from './swarm'
import { heightAt } from './noise'

export type V3 = [number, number, number]

// How the body frame sits in the world: the scene orients the planet group
// by a rotation Q that takes +y to the planet's pole (system.ts) and spins
// its child group by SPIN_RATE * time about y.
export const SPIN_RATE = 0.05

// Everything on a site is laid out in local metres and drawn at this scale,
// so a site covers a few degrees of the globe rather than a continent.
export const S = 0.6

// Ejectors.
export const BARREL_LEN = 3.2 * S
export const PIVOT_H = 0.95 * S
export const V_MUZZLE = 14.5 // leaves the planet near 14 after climbing out of its gravity
export const MIN_ELEV = 0.35 // radians above the horizon before a rail may fire
export const MAG_CAP = 16
export const FIRE_PERIOD = 0.8
const LOAD_S = 0.35
const RAIL_S = 0.3
const SHIFT_S = 0.3
const SLEW_YAW = 1.1
const SLEW_PITCH = 0.9
const PARK_PITCH = 0.45
const AIM_TOL = 0.05

// Factories and logistics.
export const GUNS_PER_SITE = 4
export const SITES_WANTED = 12
const BUILD_S = 0.4 // a sail every 0.4 s per factory, a little above what its rails can fire
const BELT_SPEED = 2.2 * S
const PKG_GAP = 0.42 * S
const ORE_CAP = 36
const HAUL_LOAD = 3
export const HAULERS_PER_SITE = 12
const BOT_SPEED = 1.6 * S
const BOT_GAP = 0.5 * S
const MINE_LOAD_S = 0.45
const DOCK_UNLOAD_S = 0.35
const MAX_PKG = 2048

// Site layout in local metres: the factory hall sits at the origin, doors on
// its +x face, belts run out to the racks, ejectors beyond; the mine is off
// to -x.
export const GUN_X = 6.4
export const GUN_Y = [-5.1, -1.7, 1.7, 5.1]
export const DOOR_Y = [-0.9, -0.3, 0.3, 0.9]
const BEND_X = [2.6, 3.0, 3.0, 2.6]
export const DOOR_X = 1.75
export const RACK_X0 = 4.6
export const RACK_PITCH = 0.36
const BELT_END_X = 4.3
export const MINE_XY: [number, number] = [-6.4, -3.2]
export const DOCK_XY: [number, number] = [-3.55, 0.5]
const HAUL_WAY: [number, number][] = [MINE_XY, [-5.1, -1.1], DOCK_XY]
const LANE_OFF = 0.3
export const PAD_R = 7.6

// Package states.
export const PK_BELT = 0
export const PK_SHIFT = 1
export const PK_STACK = 2
export const PK_LOAD = 3
export const PK_RAIL = 4

// Bot states.
export const BOT_TO_DOCK = 0
export const BOT_UNLOADING = 1
export const BOT_TO_PIT = 2
export const BOT_LOADING = 3

export type Frame = { pos: V3; ex: V3; ey: V3; up: V3 }
export type Path = { pts: Float32Array; tan: Float32Array; cum: Float32Array; n: number; len: number }

export type Gun = {
  id: number
  site: number
  index: number
  x: number
  y: number
  frame: Frame // at the base, on the ground
  pivot: V3
  rack: V3[]
  belt: Path
  onBelt: number[] // packages on the belt, front first
  shifting: number[] // packages moving from the belt end into a slot
  magazine: number[] // packages in the rack, oldest first
  slotUsed: Uint8Array
  bound: number // packages on the belt or shifting toward this rack
  yaw: number
  pitch: number
  aimYaw: number
  aimPitch: number
  aimOk: boolean
  ready: boolean // aimed inside its window
  cooldown: number
  busy: number // package loading or on the rail, or -1
  charge: number // coil glow, 0..1
  flash: number // muzzle flash, 0..1
  fired: number
}

export type Site = {
  index: number
  center: V3
  e: V3
  f: V3
  hall: Frame
  mine: Frame
  dock: Frame
  guns: Gun[]
  haulOut: Path // mine to dock
  haulBack: Path // dock to mine
  outBots: number[] // bots on haulOut, front first
  backBots: number[]
  ore: number
  build: number
  built: number
  stalled: boolean
  stallReason: string
}

const norm3 = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

// world = Q · Ry(theta) · body, with Q a row-major 3x3.
export function bodyToWorld(b: ArrayLike<number>, theta: number, Q: ArrayLike<number>, out: Float64Array | Float32Array | number[]) {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const x1 = b[0] * c + b[2] * s
  const y1 = b[1]
  const z1 = -b[0] * s + b[2] * c
  out[0] = Q[0] * x1 + Q[1] * y1 + Q[2] * z1
  out[1] = Q[3] * x1 + Q[4] * y1 + Q[5] * z1
  out[2] = Q[6] * x1 + Q[7] * y1 + Q[8] * z1
  return out
}

export function worldToBody(w: ArrayLike<number>, theta: number, Q: ArrayLike<number>, out: Float64Array | Float32Array | number[]) {
  const x1 = Q[0] * w[0] + Q[3] * w[1] + Q[6] * w[2]
  const y1 = Q[1] * w[0] + Q[4] * w[1] + Q[7] * w[2]
  const z1 = Q[2] * w[0] + Q[5] * w[1] + Q[8] * w[2]
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  out[0] = x1 * c - z1 * s
  out[1] = y1
  out[2] = x1 * s + z1 * c
  return out
}

// A point of a site's local plane, wrapped onto the sphere along the great
// circle through the site centre, h above the ground, with the local frame.
export function siteFrame(site: { center: V3; e: V3; f: V3 }, x: number, y: number, h: number, R: number): Frame {
  x *= S
  y *= S
  const rho = Math.hypot(x, y)
  let up: V3
  if (rho < 1e-6) up = site.center
  else {
    const ang = rho / R
    const ca = Math.cos(ang)
    const sa = Math.sin(ang) / rho
    up = norm3([
      ca * site.center[0] + sa * (x * site.e[0] + y * site.f[0]),
      ca * site.center[1] + sa * (x * site.e[1] + y * site.f[1]),
      ca * site.center[2] + sa * (x * site.e[2] + y * site.f[2]),
    ])
  }
  const d = dot(site.e, up)
  const ex = norm3([site.e[0] - d * up[0], site.e[1] - d * up[1], site.e[2] - d * up[2]])
  const ey = cross(up, ex)
  const r = R + h * S
  return { pos: [up[0] * r, up[1] * r, up[2] * r], ex, ey, up }
}

function makePath(site: { center: V3; e: V3; f: V3 }, way: [number, number][], h: number, R: number, step = 0.15): Path {
  const pts: number[] = []
  const push = (x: number, y: number) => {
    const f = siteFrame(site, x, y, h, R)
    pts.push(f.pos[0], f.pos[1], f.pos[2])
  }
  for (let k = 0; k < way.length - 1; k++) {
    const [x0, y0] = way[k]
    const [x1, y1] = way[k + 1]
    const L = Math.hypot(x1 - x0, y1 - y0)
    const n = Math.max(1, Math.ceil(L / step))
    for (let j = 0; j < n; j++) {
      const t = j / n
      push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)
    }
  }
  push(way[way.length - 1][0], way[way.length - 1][1])
  const n = pts.length / 3
  const cum = new Float32Array(n)
  const tan = new Float32Array(n * 3)
  for (let i = 1; i < n; i++) {
    const dx = pts[i * 3] - pts[i * 3 - 3]
    const dy = pts[i * 3 + 1] - pts[i * 3 - 2]
    const dz = pts[i * 3 + 2] - pts[i * 3 - 1]
    const l = Math.hypot(dx, dy, dz)
    cum[i] = cum[i - 1] + l
    tan[i * 3] = dx / l
    tan[i * 3 + 1] = dy / l
    tan[i * 3 + 2] = dz / l
  }
  tan.set(tan.subarray(3, 6), 0)
  return { pts: Float32Array.from(pts), tan, cum, n, len: cum[n - 1] }
}

// Offset a 2D polyline sideways, for the two lanes of a road.
function offsetWay(way: [number, number][], off: number): [number, number][] {
  return way.map(([x, y], i) => {
    const a = way[Math.max(0, i - 1)]
    const b = way[Math.min(way.length - 1, i + 1)]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const l = Math.hypot(dx, dy) || 1
    return [x - (dy / l) * off, y + (dx / l) * off]
  })
}

export function pathAt(p: Path, s: number, out: Float32Array | number[], o = 0, tan?: Float32Array | number[], to = 0) {
  if (s <= 0) {
    out[o] = p.pts[0]
    out[o + 1] = p.pts[1]
    out[o + 2] = p.pts[2]
    if (tan) {
      tan[to] = p.tan[0]
      tan[to + 1] = p.tan[1]
      tan[to + 2] = p.tan[2]
    }
    return
  }
  if (s >= p.len) {
    const k = (p.n - 1) * 3
    out[o] = p.pts[k]
    out[o + 1] = p.pts[k + 1]
    out[o + 2] = p.pts[k + 2]
    if (tan) {
      tan[to] = p.tan[k]
      tan[to + 1] = p.tan[k + 1]
      tan[to + 2] = p.tan[k + 2]
    }
    return
  }
  let lo = 0
  let hi = p.n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (p.cum[mid] <= s) lo = mid
    else hi = mid
  }
  const t = (s - p.cum[lo]) / (p.cum[hi] - p.cum[lo])
  const a = lo * 3
  const b = hi * 3
  out[o] = p.pts[a] + (p.pts[b] - p.pts[a]) * t
  out[o + 1] = p.pts[a + 1] + (p.pts[b + 1] - p.pts[a + 1]) * t
  out[o + 2] = p.pts[a + 2] + (p.pts[b + 2] - p.pts[a + 2]) * t
  if (tan) {
    tan[to] = p.tan[b]
    tan[to + 1] = p.tan[b + 1]
    tan[to + 2] = p.tan[b + 2]
  }
}

// Pick site centres on land, away from the poles and from each other.
function planSites(R: number, rand: () => number, wanted: number): Array<{ center: V3; e: V3; f: V3 }> {
  const cands: V3[] = []
  const N = 1200
  const ring = 8
  const ringRho = PAD_R * S * 0.7
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N
    if (Math.abs(y) > 0.8) continue
    const r = Math.sqrt(1 - y * y)
    const phi = i * 2.399963229728653
    const c: V3 = [r * Math.cos(phi), y, r * Math.sin(phi)]
    if (heightAt(c[0], c[1], c[2]) < 0.53) continue
    // The whole pad should be on land, not just its centre.
    const e0 = norm3(cross([0, 1, 0], c))
    const f0 = cross(c, e0)
    let land = true
    for (let k = 0; k < ring && land; k++) {
      const a = (k / ring) * Math.PI * 2
      const ang = ringRho / R
      const p: V3 = [0, 0, 0]
      for (let j = 0; j < 3; j++) p[j] = Math.cos(ang) * c[j] + Math.sin(ang) * (Math.cos(a) * e0[j] + Math.sin(a) * f0[j])
      if (heightAt(p[0], p[1], p[2]) < 0.49) land = false
    }
    if (land) cands.push(c)
  }
  for (let i = cands.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const t = cands[i]
    cands[i] = cands[j]
    cands[j] = t
  }
  const minSep = (2 * PAD_R * S) / R + 0.01
  const picked: V3[] = []
  for (const c of cands) {
    if (picked.length >= wanted) break
    if (picked.every((p) => Math.acos(Math.max(-1, Math.min(1, dot(p, c)))) > minSep)) picked.push(c)
  }
  return picked.map((c) => {
    const e0 = norm3(cross([0, 1, 0], c))
    const f0 = cross(c, e0)
    const a = rand() * Math.PI * 2
    const e = norm3([
      Math.cos(a) * e0[0] + Math.sin(a) * f0[0],
      Math.cos(a) * e0[1] + Math.sin(a) * f0[1],
      Math.cos(a) * e0[2] + Math.sin(a) * f0[2],
    ])
    return { center: c, e, f: cross(c, e) }
  })
}

export class Surface {
  readonly R: number
  readonly Q: number[] // the launch planet's pole frame
  readonly sites: Site[] = []
  readonly guns: Gun[] = []
  // Packages: folded sails between the factory door and the muzzle.
  readonly pkPos = new Float32Array(MAX_PKG * 3)
  readonly pkAlive = new Uint8Array(MAX_PKG)
  readonly pkState = new Uint8Array(MAX_PKG)
  readonly pkSail = new Int32Array(MAX_PKG)
  readonly pkGun = new Int16Array(MAX_PKG)
  readonly pkS = new Float32Array(MAX_PKG)
  readonly pkSlot = new Int8Array(MAX_PKG)
  readonly pkOf: Int32Array // package index for each sail, or -1
  private freePk: number[] = []
  // Hauler bots.
  readonly nBots: number
  readonly botPos: Float32Array
  readonly botTan: Float32Array
  readonly botSite: Uint8Array
  readonly botState: Uint8Array
  readonly botS: Float32Array
  readonly botTimer: Float32Array
  readonly botLoad: Uint8Array
  readonly botLane: Float32Array
  private readonly rand: () => number
  private readonly aimBody = new Float64Array(3)
  private readonly tmpW = new Float64Array(3)
  private readonly tmpV = new Float64Array(3)
  private readonly tmpM = new Float64Array(3)
  built = 0

  constructor(R: number, swarm: Swarm, Q: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1], seed = 11) {
    this.R = R
    this.Q = Q
    this.rand = mulberry32(seed)
    this.pkOf = new Int32Array(swarm.N).fill(-1)
    for (let i = MAX_PKG - 1; i >= 0; i--) this.freePk.push(i)

    const plans = planSites(R, this.rand, SITES_WANTED)
    plans.forEach((plan, si) => {
      const guns: Gun[] = []
      for (let k = 0; k < GUNS_PER_SITE; k++) {
        const gy = GUN_Y[k]
        const frame = siteFrame(plan, GUN_X, gy, 0, R)
        const pivot: V3 = [frame.pos[0] + frame.up[0] * PIVOT_H, frame.pos[1] + frame.up[1] * PIVOT_H, frame.pos[2] + frame.up[2] * PIVOT_H]
        const rack: V3[] = []
        for (let r = 0; r < 4; r++)
          for (let c = 0; c < 4; c++) rack.push(siteFrame(plan, RACK_X0 + c * RACK_PITCH, gy - 1.5 * RACK_PITCH + r * RACK_PITCH, 0.14, R).pos)
        const way: [number, number][] = [
          [DOOR_X, DOOR_Y[k]],
          [BEND_X[k], DOOR_Y[k]],
          [BEND_X[k], gy],
          [BELT_END_X, gy],
        ]
        const gun: Gun = {
          id: this.guns.length,
          site: si,
          index: k,
          x: GUN_X,
          y: gy,
          frame,
          pivot,
          rack,
          belt: makePath(plan, way, 0.1, R),
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
          fired: 0,
        }
        guns.push(gun)
        this.guns.push(gun)
      }
      const site: Site = {
        index: si,
        center: plan.center,
        e: plan.e,
        f: plan.f,
        hall: siteFrame(plan, 0, 0, 0, R),
        mine: siteFrame(plan, MINE_XY[0], MINE_XY[1], 0, R),
        dock: siteFrame(plan, DOCK_XY[0], DOCK_XY[1], 0, R),
        guns,
        haulOut: makePath(plan, offsetWay(HAUL_WAY, -LANE_OFF), 0.08, R),
        haulBack: makePath(plan, offsetWay(HAUL_WAY.slice().reverse(), -LANE_OFF), 0.08, R),
        outBots: [],
        backBots: [],
        ore: ORE_CAP * 0.5,
        build: 0,
        built: 0,
        stalled: false,
        stallReason: '',
      }
      this.sites.push(site)
    })

    this.nBots = this.sites.length * HAULERS_PER_SITE
    this.botPos = new Float32Array(this.nBots * 3)
    this.botTan = new Float32Array(this.nBots * 3)
    this.botSite = new Uint8Array(this.nBots)
    this.botState = new Uint8Array(this.nBots)
    this.botS = new Float32Array(this.nBots)
    this.botTimer = new Float32Array(this.nBots)
    this.botLoad = new Uint8Array(this.nBots)
    this.botLane = new Float32Array(this.nBots)
    let b = 0
    for (const site of this.sites) {
      // Spread the fleet along both roads so the first frame is already busy.
      for (let k = 0; k < HAULERS_PER_SITE; k++, b++) {
        this.botSite[b] = site.index
        this.botLane[b] = (this.rand() - 0.5) * 0.12 * S
        const out = k % 2 === 0
        this.botState[b] = out ? BOT_TO_DOCK : BOT_TO_PIT
        this.botLoad[b] = out ? 1 : 0
        const path = out ? site.haulOut : site.haulBack
        const list = out ? site.outBots : site.backBots
        this.botS[b] = path.len * (1 - (Math.floor(k / 2) + 0.5) / (HAULERS_PER_SITE / 2))
        list.push(b)
      }
      site.outBots.sort((p, q) => this.botS[q] - this.botS[p])
      site.backBots.sort((p, q) => this.botS[q] - this.botS[p])
    }
  }

  get nPackages() {
    return MAX_PKG
  }

  private allocPk(): number {
    const i = this.freePk.pop()
    return i === undefined ? -1 : i
  }

  private freePackage(i: number) {
    this.pkAlive[i] = 0
    if (this.pkSail[i] >= 0) this.pkOf[this.pkSail[i]] = -1
    this.pkSail[i] = -1
    this.freePk.push(i)
  }

  // One step for every site: haulers, the factory, belts, racks and rails.
  step(dt: number, swarm: Swarm) {
    const theta = SPIN_RATE * swarm.time
    const pp = swarm.planetPos
    const pv = swarm.planetVel
    const pr = Math.hypot(pp[0], pp[1], pp[2])
    // The launch the orbit wants: half the planet's speed shed, and a dive
    // toward the star. The same burn the sails have always used.
    const want = this.tmpW
    for (let k = 0; k < 3; k++) want[k] = -0.5 * pv[k] - (pp[k] / pr) * 13
    const wl = Math.hypot(want[0], want[1], want[2])
    for (let k = 0; k < 3; k++) want[k] /= wl
    const aim = worldToBody(want, theta, this.Q, this.aimBody) as Float64Array
    const aimV: V3 = [aim[0], aim[1], aim[2]]
    const omega = SPIN_RATE

    for (const site of this.sites) {
      this.stepHaulers(site, dt)
      this.stepFactory(site, dt, swarm)
      for (const g of site.guns) {
        this.stepBelt(g, dt)
        this.stepGun(g, dt, aimV, swarm, theta, omega)
      }
    }
  }

  private stepHaulers(site: Site, dt: number) {
    // Bots on a road keep their order and their spacing; the front one stops
    // at the station, is served, and crosses to the other road once there
    // is room at its start.
    const run = (list: number[], path: Path, moving: number, serving: number, serviceS: number, other: number[], canServe: () => boolean, onServed: () => void) => {
      let ahead = Infinity
      for (let k = 0; k < list.length; k++) {
        const b = list[k]
        if (this.botState[b] === moving) {
          let s = this.botS[b] + BOT_SPEED * dt
          if (s > ahead - BOT_GAP) s = ahead - BOT_GAP
          if (s >= path.len) {
            s = path.len
            this.botState[b] = serving
            this.botTimer[b] = serviceS
          }
          this.botS[b] = s
        } else {
          // At the station: served while it has room, then across to the
          // other road as soon as there is room at its start.
          this.botS[b] = path.len
          if (this.botTimer[b] > 0) {
            if (canServe()) this.botTimer[b] -= dt
            if (this.botTimer[b] <= 0) onServed()
          } else if (other.length === 0 || this.botS[other[other.length - 1]] >= BOT_GAP) {
            list.shift()
            other.push(b)
            this.botS[b] = 0
            this.botState[b] = moving === BOT_TO_DOCK ? BOT_TO_PIT : BOT_TO_DOCK
            this.botLoad[b] = moving === BOT_TO_DOCK ? 0 : 1
            k--
            continue
          }
        }
        ahead = this.botS[b]
        pathAt(path, this.botS[b], this.botPos, b * 3, this.botTan, b * 3)
        // A touch of lane wobble so a column is not a perfect line.
        const t = b * 3
        const ux = this.botPos[t] / this.R
        const uy = this.botPos[t + 1] / this.R
        const uz = this.botPos[t + 2] / this.R
        const sx = this.botTan[t + 1] * uz - this.botTan[t + 2] * uy
        const sy = this.botTan[t + 2] * ux - this.botTan[t] * uz
        const sz = this.botTan[t] * uy - this.botTan[t + 1] * ux
        this.botPos[t] += sx * this.botLane[b]
        this.botPos[t + 1] += sy * this.botLane[b]
        this.botPos[t + 2] += sz * this.botLane[b]
      }
    }
    // Unloading at the dock only proceeds while the factory has room.
    run(
      site.outBots,
      site.haulOut,
      BOT_TO_DOCK,
      BOT_UNLOADING,
      DOCK_UNLOAD_S,
      site.backBots,
      () => site.ore + HAUL_LOAD <= ORE_CAP,
      () => (site.ore += HAUL_LOAD),
    )
    run(site.backBots, site.haulBack, BOT_TO_PIT, BOT_LOADING, MINE_LOAD_S, site.outBots, () => true, () => undefined)
  }

  private stepFactory(site: Site, dt: number, swarm: Swarm) {
    site.build -= dt
    if (site.build > 0) return
    if (site.ore < 1) {
      site.stalled = true
      site.stallReason = 'waiting for ore'
      return
    }
    // Send the next sail to the emptiest rack, preferring rails in their window.
    let best: Gun | null = null
    let bestScore = Infinity
    for (const g of site.guns) {
      const queued = g.magazine.length + g.bound
      if (queued >= MAG_CAP) continue
      const last = g.onBelt[g.onBelt.length - 1]
      if (last !== undefined && this.pkS[last] < PKG_GAP) continue
      const score = queued - (g.aimOk ? 8 : 0) + this.rand() * 0.5
      if (score < bestScore) {
        bestScore = score
        best = g
      }
    }
    if (!best) {
      site.stalled = true
      site.stallReason = 'racks full'
      return
    }
    const sail = swarm.reserve()
    if (sail < 0) {
      site.stalled = true
      site.stallReason = 'whole fleet in flight'
      return
    }
    const p = this.allocPk()
    if (p < 0) {
      swarm.release(sail)
      site.stalled = true
      site.stallReason = 'belts full'
      return
    }
    site.stalled = false
    site.ore -= 1
    site.build = BUILD_S
    site.built++
    this.built++
    this.pkAlive[p] = 1
    this.pkState[p] = PK_BELT
    this.pkSail[p] = sail
    this.pkOf[sail] = p
    this.pkGun[p] = best.id
    this.pkS[p] = 0
    this.pkSlot[p] = -1
    best.onBelt.push(p)
    best.bound++
    pathAt(best.belt, 0, this.pkPos, p * 3)
  }

  private stepBelt(g: Gun, dt: number) {
    let ahead = Infinity
    for (let k = 0; k < g.onBelt.length; k++) {
      const p = g.onBelt[k]
      let s = this.pkS[p] + BELT_SPEED * dt
      if (s > ahead - PKG_GAP) s = ahead - PKG_GAP
      if (s >= g.belt.len) {
        s = g.belt.len
        // Into the rack, if a slot is free; otherwise the belt backs up.
        let slot = -1
        for (let j = 0; j < MAG_CAP; j++)
          if (!g.slotUsed[j]) {
            slot = j
            break
          }
        if (slot >= 0) {
          g.slotUsed[slot] = 1
          g.onBelt.splice(k, 1)
          k--
          g.shifting.push(p)
          this.pkSlot[p] = slot
          this.pkState[p] = PK_SHIFT
          this.pkS[p] = 0
          continue
        }
      }
      this.pkS[p] = s
      ahead = s
      pathAt(g.belt, s, this.pkPos, p * 3)
    }
  }

  private stepGun(g: Gun, dt: number, aim: V3, swarm: Swarm, theta: number, omega: number) {
    // Track the launch direction; park when it is below the horizon.
    const f = g.frame
    const aUp = dot(aim, f.up)
    const aEx = dot(aim, f.ex)
    const aEy = dot(aim, f.ey)
    g.aimOk = aUp > Math.sin(MIN_ELEV)
    g.aimYaw = Math.atan2(aEy, aEx)
    g.aimPitch = g.aimOk ? Math.asin(Math.min(1, aUp)) : PARK_PITCH
    const dy = wrap(g.aimYaw - g.yaw)
    g.yaw = wrap(g.yaw + Math.max(-SLEW_YAW * dt, Math.min(SLEW_YAW * dt, dy)))
    const dp = g.aimPitch - g.pitch
    g.pitch += Math.max(-SLEW_PITCH * dt, Math.min(SLEW_PITCH * dt, dp))
    g.ready = g.aimOk && Math.abs(wrap(g.aimYaw - g.yaw)) < AIM_TOL && Math.abs(g.aimPitch - g.pitch) < AIM_TOL

    g.cooldown -= dt
    g.charge = Math.max(0, g.charge - dt * 2.5)
    g.flash = Math.max(0, g.flash - dt * 6)

    // Packages settling from the belt end into their slot.
    for (let k = 0; k < g.shifting.length; k++) {
      const p = g.shifting[k]
      this.pkS[p] += dt / SHIFT_S
      const u = Math.min(1, this.pkS[p])
      const slot = g.rack[this.pkSlot[p]]
      const o = p * 3
      const e = (g.belt.n - 1) * 3
      const lift = Math.sin(u * Math.PI) * 0.35 * S
      for (let j = 0; j < 3; j++) this.pkPos[o + j] = g.belt.pts[e + j] + (slot[j] - g.belt.pts[e + j]) * u + f.up[j] * lift
      if (u >= 1) {
        g.shifting.splice(k, 1)
        k--
        this.pkState[p] = PK_STACK
        g.bound--
        g.magazine.push(p)
        for (let j = 0; j < 3; j++) this.pkPos[o + j] = slot[j]
      }
    }

    if (g.busy < 0 && g.ready && g.cooldown <= 0 && g.magazine.length > 0) {
      const p = g.magazine.shift()!
      g.busy = p
      g.cooldown = FIRE_PERIOD
      this.pkState[p] = PK_LOAD
      this.pkS[p] = 0
    }

    // Barrel direction in the body frame.
    const cp = Math.cos(g.pitch)
    const sp = Math.sin(g.pitch)
    const cy = Math.cos(g.yaw)
    const sy = Math.sin(g.yaw)
    const dir: V3 = [
      cp * (cy * f.ex[0] + sy * f.ey[0]) + sp * f.up[0],
      cp * (cy * f.ex[1] + sy * f.ey[1]) + sp * f.up[1],
      cp * (cy * f.ex[2] + sy * f.ey[2]) + sp * f.up[2],
    ]

    if (g.busy >= 0) {
      const p = g.busy
      const o = p * 3
      if (this.pkState[p] === PK_LOAD) {
        this.pkS[p] += dt / LOAD_S
        const u = Math.min(1, this.pkS[p])
        const slot = g.rack[this.pkSlot[p]]
        const lift = Math.sin(u * Math.PI) * 0.6 * S
        for (let k = 0; k < 3; k++) this.pkPos[o + k] = slot[k] + (g.pivot[k] - slot[k]) * u + f.up[k] * lift
        g.charge = Math.min(1, g.charge + dt * 4)
        if (u >= 1) {
          g.slotUsed[this.pkSlot[p]] = 0
          this.pkSlot[p] = -1
          this.pkState[p] = PK_RAIL
          this.pkS[p] = 0
        }
      } else {
        this.pkS[p] += dt / RAIL_S
        const u = Math.min(1, this.pkS[p])
        const along = u * u * BARREL_LEN
        for (let k = 0; k < 3; k++) this.pkPos[o + k] = g.pivot[k] + dir[k] * along
        g.charge = 1
        if (u >= 1) {
          // Fired: the muzzle's inertial position and velocity, plus the rail.
          const mB = this.tmpM
          for (let k = 0; k < 3; k++) mB[k] = g.pivot[k] + dir[k] * BARREL_LEN
          const mW = bodyToWorld(mB, theta, this.Q, this.tmpV) as Float64Array
          const dW = bodyToWorld(dir, theta, this.Q, new Float64Array(3)) as Float64Array
          // Spin axis in the world is the pole, Q applied to +y.
          const wx = this.Q[1] * omega
          const wy = this.Q[4] * omega
          const wz = this.Q[7] * omega
          const pos = [swarm.planetPos[0] + mW[0], swarm.planetPos[1] + mW[1], swarm.planetPos[2] + mW[2]]
          const vel = [
            swarm.planetVel[0] + (wy * mW[2] - wz * mW[1]) + dW[0] * V_MUZZLE,
            swarm.planetVel[1] + (wz * mW[0] - wx * mW[2]) + dW[1] * V_MUZZLE,
            swarm.planetVel[2] + (wx * mW[1] - wy * mW[0]) + dW[2] * V_MUZZLE,
          ]
          swarm.launch(this.pkSail[p], pos, vel)
          this.freePackage(p)
          g.busy = -1
          g.fired++
          g.flash = 1
        }
      }
    }
  }

  // How many rails can fire right now, and how many are mid-shot.
  counts() {
    let inWindow = 0
    let firing = 0
    let racked = 0
    let onBelts = 0
    let fired = 0
    for (const g of this.guns) {
      if (g.aimOk) inWindow++
      if (g.busy >= 0) firing++
      racked += g.magazine.length
      onBelts += g.onBelt.length
      fired += g.fired
    }
    return { sites: this.sites.length, guns: this.guns.length, inWindow, firing, racked, onBelts, built: this.built, fired }
  }

  // A sentence for the HUD about where a sail is on the ground.
  describePackage(p: number): string {
    const g = this.guns[this.pkGun[p]]
    const where = `site ${g.site + 1}, rail ${g.index + 1}`
    switch (this.pkState[p]) {
      case PK_BELT:
        return `on the belt to ${where}`
      case PK_SHIFT:
        return `into the rack at ${where}`
      case PK_STACK:
        return g.aimOk ? `racked at ${where}, window open` : `racked at ${where}, waiting for its window`
      case PK_LOAD:
        return `loading on ${where}`
      default:
        return `on the rail, ${where}`
    }
  }

  // The body-frame point under a world point, for a ground camera anchor.
  worldToBodyPoint(w: ArrayLike<number>, swarm: Swarm, out: Float32Array | number[]) {
    const theta = SPIN_RATE * swarm.time
    const rel = [w[0] - swarm.planetPos[0], w[1] - swarm.planetPos[1], w[2] - swarm.planetPos[2]]
    return worldToBody(rel, theta, this.Q, out)
  }
}
