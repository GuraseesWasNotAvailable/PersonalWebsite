// Carrier rockets as physics, with no renderer in sight.
//
// A rocket is a body in the gravity of the star that flies itself at a node
// or a frame of the sphere. The silo hands it a real position and velocity,
// whatever the planet and the pad were doing at that moment, and from then
// on the rocket steers: it wants a velocity of cruise speed along the line
// to its target, eases that speed down over the last few tens of units, and
// its engine makes up the difference and holds off gravity, within a fixed
// thrust. When the straight line to the target would cross the star, the
// rocket aims at the limb of a keep out sphere instead and slides round it
// until the target is in view. Arrival is a small ball round the target: the
// rocket lands as one unit of progress and its slot goes back to the pool.
// A target that is not on the sphere's mesh is refused at the silo when the
// sphere is to hand, and otherwise dropped on the rocket's first step, so
// nothing is ever flown at the origin and nothing lands that the sphere
// cannot book. Targets travel as one packed integer so the HUD and the
// sphere can read them without a lookup. Plain typed arrays, nothing
// allocated per step.

import { GM } from './swarm'
import { encodeTarget, decodeTarget, type DysonSphere, type Target } from './sphere'

export const ROCKET_SPEED = 10 // cruise, scene units per second
export const ROCKET_THRUST = 5 // most the engine can give, units per second squared
export const KEEP_OUT = 160 // rockets fly round the star outside this radius
export const ARRIVE_RADIUS = 3 // within this of the target the rocket has landed
const STEER_GAIN = 1.2 // per second, how hard a velocity error is closed
const APPROACH_SPEED = 2.5 // speed asked for at the target itself
const APPROACH_GAIN = 0.35 // per second; the speed wanted grows with distance from there until it hits cruise
const MAX_FLIGHT_S = 600 // a rocket still flying after this long is landed where it was going, so the sphere's books stay straight
const MAX_LAYER = 1000 // the packing allows these many layers
const MAX_INDEX = 100000 // and this many nodes or edges per layer
// structurePos answers the origin for a target that is not on the mesh; a
// real node or frame sits at its layer's radius, hundreds of units out, so
// an aim inside this radius squared can only mean an off mesh target.
const OFF_MESH_R2 = 1

export class Rockets {
  readonly N: number
  readonly pos: Float32Array // 3 per rocket
  readonly vel: Float32Array
  readonly alive: Uint8Array
  readonly target: Int32Array // layer * 1000000 + kind * 100000 + index, or -1
  readonly age: Float32Array // seconds since launch, for the HUD and tests
  launched = 0
  arrived = 0 // landed, including the ones landed by the flight timeout
  timedOut = 0
  lost = 0 // dropped on their first step because the target was not on the sphere; never flown, never landed
  private live = 0
  private freePtr = 0
  // Scratch for the step, so nothing is allocated while rockets fly.
  private readonly tg: Target = { layer: 0, kind: 0, index: 0 }
  private readonly aim = new Float64Array(3)

  constructor(N: number) {
    this.N = Math.max(0, Math.floor(N))
    this.pos = new Float32Array(this.N * 3)
    this.vel = new Float32Array(this.N * 3)
    this.alive = new Uint8Array(this.N)
    this.target = new Int32Array(this.N).fill(-1)
    this.age = new Float32Array(this.N)
  }

  // Fire a rocket from a silo: an inertial position and velocity and the
  // target the sphere handed out. False when every slot is in flight or the
  // request is malformed. The target must fit the packing; given the sphere
  // it must also name a node or frame that exists on it, so a bad launch is
  // refused at the pad. Without the sphere an off mesh target is still
  // caught, by the first step, which drops the rocket where it stands.
  launch(pos: ArrayLike<number>, vel: ArrayLike<number>, target: Target, sphere?: DysonSphere): boolean {
    if (this.live >= this.N) return false
    const { layer, kind, index } = target
    if (!(layer >= 0 && layer < MAX_LAYER && layer === Math.floor(layer))) return false
    if (kind !== 0 && kind !== 1) return false
    if (!(index >= 0 && index < MAX_INDEX && index === Math.floor(index))) return false
    if (sphere) {
      const L = sphere.layers[layer]
      if (!L) return false
      if (index >= (kind === 0 ? L.nodes.length / 3 : L.edges.length / 2)) return false
    }
    for (let k = 0; k < 3; k++) if (!Number.isFinite(pos[k]) || !Number.isFinite(vel[k])) return false
    for (let tries = 0; tries < this.N; tries++) {
      const i = (this.freePtr + tries) % this.N
      if (this.alive[i]) continue
      this.freePtr = (i + 1) % this.N
      const o = i * 3
      this.pos[o] = pos[0]
      this.pos[o + 1] = pos[1]
      this.pos[o + 2] = pos[2]
      this.vel[o] = vel[0]
      this.vel[o + 1] = vel[1]
      this.vel[o + 2] = vel[2]
      this.target[i] = encodeTarget(layer, kind, index)
      this.age[i] = 0
      this.alive[i] = 1
      this.live++
      this.launched++
      return true
    }
    return false
  }

  // One step of semi-implicit Euler for every rocket in flight: steer at the
  // target's position at time t, land within ARRIVE_RADIUS of it, hand the
  // sphere the rocket and free the slot.
  step(dt: number, sphere: DysonSphere, t: number): void {
    if (!(dt > 0) || this.live === 0) return
    const { pos, vel, alive, target, age } = this
    const tg = this.tg
    const aim = this.aim
    const keep2 = KEEP_OUT * KEEP_OUT
    for (let i = 0; i < this.N; i++) {
      if (!alive[i]) continue
      const o = i * 3
      const px = pos[o]
      const py = pos[o + 1]
      const pz = pos[o + 2]
      let vx = vel[o]
      let vy = vel[o + 1]
      let vz = vel[o + 2]
      decodeTarget(target[i], tg)
      sphere.structurePos(tg, t, aim)
      // An aim at the origin is the sphere saying the target does not exist.
      // Drop the rocket here rather than fly it into the star and book a
      // landing the sphere would silently ignore.
      if (aim[0] * aim[0] + aim[1] * aim[1] + aim[2] * aim[2] < OFF_MESH_R2) {
        alive[i] = 0
        target[i] = -1
        this.live--
        this.lost++
        continue
      }
      const dx = aim[0] - px
      const dy = aim[1] - py
      const dz = aim[2] - pz
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      age[i] += dt
      if (dist < ARRIVE_RADIUS || age[i] > MAX_FLIGHT_S) {
        if (dist >= ARRIVE_RADIUS) this.timedOut++
        sphere.deliverRocket(tg)
        alive[i] = 0
        target[i] = -1
        this.live--
        this.arrived++
        continue
      }

      // Gravity from the star. The radius is floored at one unit so a rocket
      // that somehow sits on the origin feels a large finite pull, not NaN.
      let r2 = px * px + py * py + pz * pz
      if (r2 < 1) r2 = 1
      const inv3 = GM / (r2 * Math.sqrt(r2))
      const gx = -px * inv3
      const gy = -py * inv3
      const gz = -pz * inv3

      // The line to fly. By default straight at the target; when that line
      // passes through the keep out sphere with the star between here and
      // there, aim at the point of the sphere's limb nearest that line
      // instead. Recomputed every step, the limb point walks round the star
      // ahead of the rocket until the target comes into view.
      let ux = dx / dist
      let uy = dy / dist
      let uz = dz / dist
      const s = -(px * ux + py * uy + pz * uz)
      if (s > 0 && s < dist) {
        const cx = px + s * ux
        const cy = py + s * uy
        const cz = pz + s * uz
        const rc2 = cx * cx + cy * cy + cz * cz
        if (rc2 < keep2) {
          let lx: number
          let ly: number
          let lz: number
          if (rc2 > 1e-6) {
            const rc = Math.sqrt(rc2)
            lx = cx / rc
            ly = cy / rc
            lz = cz / rc
          } else {
            // Dead on the star: any direction square to the line will do.
            // Lean on +y, and on +x when the line itself runs along y.
            lx = uz
            ly = 0
            lz = -ux
            const ll = Math.sqrt(lx * lx + lz * lz)
            if (ll > 1e-3) {
              lx /= ll
              lz /= ll
            } else {
              lx = 0
              lz = uy > 0 ? 1 : -1
            }
          }
          const wx = lx * KEEP_OUT - px
          const wy = ly * KEEP_OUT - py
          const wz = lz * KEEP_OUT - pz
          const wl = Math.sqrt(wx * wx + wy * wy + wz * wz)
          if (wl > 1e-6) {
            ux = wx / wl
            uy = wy / wl
            uz = wz / wl
          }
        }
      }

      // The speed wanted eases down toward the target, measured on the real
      // distance left so a detour round the star does not slow the rocket.
      const want = Math.min(ROCKET_SPEED, APPROACH_SPEED + APPROACH_GAIN * dist)
      // Thrust closes the velocity error and holds off gravity, within what
      // the engine can give; what it cannot cancel, gravity keeps.
      let tx = STEER_GAIN * (ux * want - vx) - gx
      let ty = STEER_GAIN * (uy * want - vy) - gy
      let tz = STEER_GAIN * (uz * want - vz) - gz
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz)
      if (tl > ROCKET_THRUST) {
        const k = ROCKET_THRUST / tl
        tx *= k
        ty *= k
        tz *= k
      }
      vx += (gx + tx) * dt
      vy += (gy + ty) * dt
      vz += (gz + tz) * dt
      vel[o] = vx
      vel[o + 1] = vy
      vel[o + 2] = vz
      pos[o] = px + vx * dt
      pos[o + 1] = py + vy * dt
      pos[o + 2] = pz + vz * dt
    }
  }

  // Rockets in flight.
  count(): number {
    return this.live
  }
}
