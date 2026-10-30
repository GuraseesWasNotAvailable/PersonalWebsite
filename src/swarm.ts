// The swarm as physics, with no renderer in sight.
//
// Every sail is a body in the gravity of the star and of the planet. A sail
// begins as a reserved slot while the ground builds it (surface.ts), is fired
// from an ejector with a real position and velocity, falls inward, and steers
// onto its orbit lane with solar-sail thrust: a steering law that pulls its
// velocity toward the circular orbit of the lane and its position onto the
// lane's plane and radius. Once it is close, the thrust drops to a whisper of
// station keeping and gravity carries it round. After a long life it shrinks
// away and goes back to the queue, so the factories never run out of slots.
// The planet orbits the same star under the same gravity. Everything here is
// plain typed arrays so it runs the same in a browser and in Node.

export type LaneSpec = { r: number; tilt: [number, number]; n: number }

export const GM = 72000 // the star's gravitational parameter, in scene units
export const GMP = 128 // the planet's: escape speed 4 at the surface, 1/4 of a launch

// Sail states.
export const QUEUED = 0
export const TRANSIT = 1
export const ORBIT = 2
export const FADING = 3
export const RESERVED = 4 // being built, carried or loaded on the ground

export const FADE_S = 4 // seconds a sail takes to shrink away
export const UNFURL_S = 6 // seconds after launch the sail takes to open
const LIFE_MIN = 170 // seconds a sail stays in orbit before it is recycled
const LIFE_SPREAD = 130

// Steering gains: strong on the way out, gentle once captured.
const TRANSIT_GAINS = { kv: 1.4, kr: 0.6, kn: 0.6, amax: 3.4 }
const ORBIT_GAINS = { kv: 0.35, kr: 0.25, kn: 0.25, amax: 0.35 }

export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A lane is a circular orbit of radius R in the plane with unit normal n. The
// tilt is the pair of angles a three.js Euler (x, 0, z) would use, so the
// normal is Rx(a) Rz(c) applied to +y and u is the same rotation applied to +x.
function laneFrame(tilt: [number, number]) {
  const [a, c] = tilt
  const n = [-Math.sin(c), Math.cos(c) * Math.cos(a), Math.cos(c) * Math.sin(a)]
  const u = [Math.cos(c), Math.sin(c) * Math.cos(a), Math.sin(c) * Math.sin(a)]
  const w = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]]
  return { n, u, w }
}

export class Swarm {
  readonly N: number
  readonly pos: Float32Array
  readonly vel: Float32Array
  readonly state: Uint8Array
  readonly lane: Uint8Array
  readonly timer: Float32Array // life left in orbit, or time spent fading
  readonly age: Float32Array // seconds since launch, for the HUD and tests
  // Each sail has its own orbit near the lane, so a lane is a band, not a line.
  readonly dR: Float32Array
  readonly dN: Float32Array
  readonly lanes: Array<{ R: number; vc: number; n: number[]; u: number[]; w: number[] }>
  readonly planetPos = new Float64Array(3)
  readonly planetVel = new Float64Array(3)
  readonly planetRadius: number
  launched = 0
  private reservePtr = 0
  private nextLane = 0
  private readonly rand: () => number
  time = 0

  constructor(lanes: LaneSpec[], planetStart: ArrayLike<number>, planetVel: ArrayLike<number>, planetRadius: number, seed = 7) {
    this.rand = mulberry32(seed)
    this.N = lanes.reduce((s, l) => s + l.n, 0)
    this.pos = new Float32Array(this.N * 3)
    this.vel = new Float32Array(this.N * 3)
    this.state = new Uint8Array(this.N)
    this.lane = new Uint8Array(this.N)
    this.timer = new Float32Array(this.N)
    this.age = new Float32Array(this.N)
    this.dR = new Float32Array(this.N)
    this.dN = new Float32Array(this.N)
    this.lanes = lanes.map((l) => ({ R: l.r, vc: Math.sqrt(GM / l.r), ...laneFrame(l.tilt) }))
    this.planetRadius = planetRadius

    // The planet starts where the ephemeris puts it, with its real velocity.
    this.planetPos.set([planetStart[0], planetStart[1], planetStart[2]])
    this.planetVel.set([planetVel[0], planetVel[1], planetVel[2]])

    // Lanes and the queue. A share of each lane starts already in orbit so
    // the first frame is not an empty sky.
    let i = 0
    lanes.forEach((l, li) => {
      for (let k = 0; k < l.n; k++, i++) {
        this.lane[i] = li
        this.dR[i] = (this.rand() - 0.5) * 36
        this.dN[i] = (this.rand() - 0.5) * 26
        if (this.rand() < 0.42) this.placeInOrbit(i, this.rand() * Math.PI * 2)
        else this.state[i] = QUEUED
      }
    })
  }

  // Drop a sail straight onto its lane with circular velocity.
  private placeInOrbit(i: number, theta: number) {
    const L = this.lanes[this.lane[i]]
    const c = Math.cos(theta)
    const s = Math.sin(theta)
    const R = L.R + this.dR[i]
    const vc = Math.sqrt(GM / R)
    for (let k = 0; k < 3; k++) {
      this.pos[i * 3 + k] = R * (c * L.u[k] + s * L.w[k]) + this.dN[i] * L.n[k]
      this.vel[i * 3 + k] = vc * (-s * L.u[k] + c * L.w[k])
    }
    this.state[i] = ORBIT
    this.timer[i] = LIFE_MIN + this.rand() * LIFE_SPREAD
    this.age[i] = 60
  }

  // Take a queued sail for the ground to build, walking the lanes in turn so
  // every lane keeps filling. Returns -1 when the whole fleet is in flight.
  reserve(): number {
    const want = this.nextLane
    this.nextLane = (this.nextLane + 1) % this.lanes.length
    for (let pass = 0; pass < 2; pass++) {
      for (let tries = 0; tries < this.N; tries++) {
        const i = (this.reservePtr + tries) % this.N
        if (this.state[i] === QUEUED && (pass === 1 || this.lane[i] === want)) {
          this.reservePtr = (i + 1) % this.N
          this.state[i] = RESERVED
          return i
        }
      }
    }
    return -1
  }

  // Hand a reserved sail back when the ground could not take it.
  release(i: number) {
    if (this.state[i] === RESERVED) this.state[i] = QUEUED
  }

  // Fire a reserved sail from an ejector: an inertial position and velocity.
  launch(i: number, pos: ArrayLike<number>, vel: ArrayLike<number>) {
    const o = i * 3
    this.pos[o] = pos[0]
    this.pos[o + 1] = pos[1]
    this.pos[o + 2] = pos[2]
    this.vel[o] = vel[0]
    this.vel[o + 1] = vel[1]
    this.vel[o + 2] = vel[2]
    this.state[i] = TRANSIT
    this.age[i] = 0
    this.launched++
  }

  // One step of semi-implicit Euler for the planet and every active sail.
  step(dt: number) {
    this.time += dt
    const pp = this.planetPos
    const pv = this.planetVel
    {
      const r2 = pp[0] * pp[0] + pp[1] * pp[1] + pp[2] * pp[2]
      const inv3 = GM / (r2 * Math.sqrt(r2))
      for (let k = 0; k < 3; k++) pv[k] -= pp[k] * inv3 * dt
      for (let k = 0; k < 3; k++) pp[k] += pv[k] * dt
    }
    const ppx = pp[0]
    const ppy = pp[1]
    const ppz = pp[2]

    const { pos, vel, state, lane, timer, age } = this
    for (let i = 0; i < this.N; i++) {
      const st = state[i]
      if (st === QUEUED || st === RESERVED) continue
      const o = i * 3
      const px = pos[o]
      const py = pos[o + 1]
      const pz = pos[o + 2]
      let vx = vel[o]
      let vy = vel[o + 1]
      let vz = vel[o + 2]
      const r2 = px * px + py * py + pz * pz
      const inv3 = GM / (r2 * Math.sqrt(r2))
      let ax = -px * inv3
      let ay = -py * inv3
      let az = -pz * inv3
      // The planet pulls too; it only matters in the first seconds of a launch.
      const dx = px - ppx
      const dy = py - ppy
      const dz = pz - ppz
      const d2 = dx * dx + dy * dy + dz * dz + 1
      const pinv3 = GMP / (d2 * Math.sqrt(d2))
      ax -= dx * pinv3
      ay -= dy * pinv3
      az -= dz * pinv3

      const L = this.lanes[lane[i]]
      const g = st === TRANSIT ? TRANSIT_GAINS : ORBIT_GAINS
      const nx = L.n[0]
      const ny = L.n[1]
      const nz = L.n[2]
      const Ri = L.R + this.dR[i]
      const vci = Math.sqrt(GM / Ri)
      const rn = px * nx + py * ny + pz * nz - this.dN[i]
      const rpx = px - rn * nx
      const rpy = py - rn * ny
      const rpz = pz - rn * nz
      const rpl = Math.hypot(rpx, rpy, rpz) || 1
      const hx = rpx / rpl
      const hy = rpy / rpl
      const hz = rpz / rpl
      // Direction of travel round the lane is n x rhat.
      const tx = ny * hz - nz * hy
      const ty = nz * hx - nx * hz
      const tz = nx * hy - ny * hx
      const eRad = Ri - rpl
      const dvx = tx * vci - vx
      const dvy = ty * vci - vy
      const dvz = tz * vci - vz
      let gx = g.kv * dvx + g.kr * eRad * hx - g.kn * rn * nx
      let gy = g.kv * dvy + g.kr * eRad * hy - g.kn * rn * ny
      let gz = g.kv * dvz + g.kr * eRad * hz - g.kn * rn * nz
      const gl = Math.hypot(gx, gy, gz)
      if (gl > g.amax) {
        const s = g.amax / gl
        gx *= s
        gy *= s
        gz *= s
      }
      ax += gx
      ay += gy
      az += gz

      vx += ax * dt
      vy += ay * dt
      vz += az * dt
      vel[o] = vx
      vel[o + 1] = vy
      vel[o + 2] = vz
      pos[o] = px + vx * dt
      pos[o + 1] = py + vy * dt
      pos[o + 2] = pz + vz * dt
      age[i] += dt

      if (st === TRANSIT) {
        if (Math.abs(eRad) < 4 && Math.abs(rn) < 4 && Math.hypot(dvx, dvy, dvz) < 1.5) {
          state[i] = ORBIT
          timer[i] = LIFE_MIN + this.rand() * LIFE_SPREAD
        }
      } else if (st === ORBIT) {
        timer[i] -= dt
        if (timer[i] <= 0) {
          state[i] = FADING
          timer[i] = 0
        }
      } else if (st === FADING) {
        timer[i] += dt
        if (timer[i] >= FADE_S) state[i] = QUEUED
      }
    }
  }

  // Visual scale for a sail: nothing on the ground, unfurling after launch,
  // full in orbit, shrinking while it fades.
  scaleOf(i: number): number {
    const st = this.state[i]
    if (st === QUEUED || st === RESERVED) return 0
    if (st === FADING) return Math.max(0, 1 - this.timer[i] / FADE_S)
    if (st === TRANSIT) {
      const u = Math.min(1, this.age[i] / UNFURL_S)
      return 0.15 + 0.6 * u * u * (3 - 2 * u)
    }
    return 1
  }

  counts() {
    let orbit = 0
    let transit = 0
    let ground = 0
    for (let i = 0; i < this.N; i++) {
      const s = this.state[i]
      if (s === ORBIT || s === FADING) orbit++
      else if (s === TRANSIT) transit++
      else if (s === RESERVED) ground++
    }
    return { orbit, transit, ground, launched: this.launched }
  }
}
