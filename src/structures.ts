// Everything built on the planet, drawn from the ground simulation: pads,
// roads and belts as merged ribbons hugging the sphere; halls, stacks, mines
// and rail mounts as static instances; barrels, coils, muzzle flashes,
// packages and bots as instances refreshed every frame. One draw call per
// kind, so a planet full of industry costs about twenty.
import * as THREE from 'three'
import { DOCK_XY, DOOR_X, DOOR_Y, GUN_Y, MINE_XY, PAD_R, PK_RAIL, PK_STACK, RACK_PITCH, RACK_X0, S, SILO_H, Surface, BARREL_LEN, siteFrame, type Frame, type Path } from './surface'

const PKG_COLOUR = new THREE.Color(0.2, 0.42, 1.0)
const PKG_HOT = new THREE.Color(2.6, 3.0, 4.0)
const PKG_RACKED = new THREE.Color(0.12, 0.26, 0.7)
const COIL_IDLE = new THREE.Color(0.1, 0.45, 0.6)
const COIL_HOT = new THREE.Color(0.9, 3.2, 4.2)

class GeoAcc {
  pos: number[] = []
  nrm: number[] = []
  idx: number[] = []
  vertex(p: ArrayLike<number>, n: ArrayLike<number>) {
    this.pos.push(p[0], p[1], p[2])
    this.nrm.push(n[0], n[1], n[2])
    return this.pos.length / 3 - 1
  }
  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d)
  }
  build() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setIndex(this.idx)
    return g
  }
}

// A strip of constant width laid along a path, lifted h above the ground.
function ribbon(acc: GeoAcc, path: Path, halfW: number, h: number) {
  let prevL = -1
  let prevR = -1
  const up = [0, 0, 0]
  const side = [0, 0, 0]
  for (let i = 0; i < path.n; i++) {
    const o = i * 3
    const px = path.pts[o]
    const py = path.pts[o + 1]
    const pz = path.pts[o + 2]
    const l = Math.hypot(px, py, pz)
    up[0] = px / l
    up[1] = py / l
    up[2] = pz / l
    const tx = path.tan[o]
    const ty = path.tan[o + 1]
    const tz = path.tan[o + 2]
    side[0] = up[1] * tz - up[2] * ty
    side[1] = up[2] * tx - up[0] * tz
    side[2] = up[0] * ty - up[1] * tx
    const sl = Math.hypot(side[0], side[1], side[2]) || 1
    for (let k = 0; k < 3; k++) side[k] = (side[k] / sl) * halfW
    const L = acc.vertex([px + side[0] + up[0] * h, py + side[1] + up[1] * h, pz + side[2] + up[2] * h], up)
    const Rr = acc.vertex([px - side[0] + up[0] * h, py - side[1] + up[1] * h, pz - side[2] + up[2] * h], up)
    if (prevL >= 0) acc.quad(prevL, prevR, Rr, L)
    prevL = L
    prevR = Rr
  }
}

// A disk of the sphere under a site.
function pad(acc: GeoAcc, site: { center: number[]; e: number[]; f: number[] }, R: number, radius: number, h: number) {
  const rings = 6
  const segs = 40
  const s = site as { center: [number, number, number]; e: [number, number, number]; f: [number, number, number] }
  const c = siteFrame(s, 0, 0, h, R)
  const centre = acc.vertex(c.pos, c.up)
  let prev: number[] = []
  for (let r = 1; r <= rings; r++) {
    const rad = (radius * r) / rings
    const ring: number[] = []
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * Math.PI * 2
      const f = siteFrame(s, Math.cos(a) * rad, Math.sin(a) * rad, h, R)
      ring.push(acc.vertex(f.pos, f.up))
    }
    for (let k = 0; k < segs; k++) {
      const k1 = (k + 1) % segs
      if (r === 1) acc.idx.push(centre, ring[k], ring[k1])
      else acc.quad(prev[k], ring[k], ring[k1], prev[k1])
    }
    prev = ring
  }
}

function box(w: number, h: number, d: number, dx = 0, dy = 0, dz = 0) {
  const g = new THREE.BoxGeometry(w * S, h * S, d * S)
  g.translate(dx * S, (dy + h / 2) * S, dz * S)
  return g
}

const Y = new THREE.Vector3(0, 1, 0)

export type Ground = {
  group: THREE.Group
  packages: THREE.InstancedMesh
  bots: THREE.InstancedMesh
  update: (camera: THREE.Camera) => void
}

export function buildGround(ground: Surface, R: number, glow: THREE.Texture): Ground {
  const group = new THREE.Group()
  const sites = ground.sites
  const guns = ground.guns
  const nS = sites.length
  const nG = guns.length

  // Merged ground pieces.
  const padAcc = new GeoAcc()
  const roadAcc = new GeoAcc()
  const beltAcc = new GeoAcc()
  const beltLineAcc = new GeoAcc()
  for (const site of sites) {
    pad(padAcc, site, R, PAD_R, 0.03)
    ribbon(roadAcc, site.haulOut, 0.22 * S, 0.02 * S)
    ribbon(roadAcc, site.haulBack, 0.22 * S, 0.02 * S)
    for (const g of site.guns) {
      ribbon(beltAcc, g.belt, 0.2 * S, -0.06 * S)
      ribbon(beltLineAcc, g.belt, 0.035 * S, -0.04 * S)
    }
  }
  const padMat = new THREE.MeshStandardMaterial({ color: '#3d424c', roughness: 0.95, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
  group.add(new THREE.Mesh(padAcc.build(), padMat))
  group.add(new THREE.Mesh(roadAcc.build(), new THREE.MeshStandardMaterial({ color: '#434955', roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })))
  group.add(new THREE.Mesh(beltAcc.build(), new THREE.MeshStandardMaterial({ color: '#15181f', roughness: 0.6, metalness: 0.4, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })))
  group.add(new THREE.Mesh(beltLineAcc.build(), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 0.75, 1.0), polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })))

  const steel = new THREE.MeshStandardMaterial({ color: '#9aa3b2', roughness: 0.5, metalness: 0.45 })
  const dark = new THREE.MeshStandardMaterial({ color: '#4a5160', roughness: 0.7, metalness: 0.3 })
  const concrete = new THREE.MeshStandardMaterial({ color: '#7d8491', roughness: 0.9, metalness: 0.05 })
  // Lights brighter than white bloom, which is the point up close and a
  // flicker from afar, where they are smaller than a pixel. Each keeps its
  // base colour and is dimmed with distance in update().
  const lit = (r: number, g: number, b: number) => {
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b) })
    m.userData.base = new THREE.Color(r, g, b)
    hdr.push(m)
    return m
  }
  const hdr: THREE.MeshBasicMaterial[] = []
  const warm = lit(1.9, 1.25, 0.6)
  const cyan = lit(0.5, 1.5, 1.9)
  const amber = lit(2.2, 0.9, 0.3)

  const dummy = new THREE.Object3D()
  const basis = new THREE.Matrix4()
  const vx = new THREE.Vector3()
  const vy = new THREE.Vector3()
  const vz = new THREE.Vector3()
  const frameQuat = (f: Frame, out: THREE.Quaternion) => {
    vx.set(f.ex[0], f.ex[1], f.ex[2])
    vy.set(f.up[0], f.up[1], f.up[2])
    vz.set(-f.ey[0], -f.ey[1], -f.ey[2])
    basis.makeBasis(vx, vy, vz)
    return out.setFromRotationMatrix(basis)
  }
  const place = (mesh: THREE.InstancedMesh, i: number, f: Frame) => {
    dummy.position.set(f.pos[0], f.pos[1], f.pos[2])
    frameQuat(f, dummy.quaternion)
    dummy.scale.setScalar(1)
    dummy.updateMatrix()
    mesh.setMatrixAt(i, dummy.matrix)
  }
  const statics: THREE.InstancedMesh[] = []
  const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number, dynamic = false) => {
    const m = new THREE.InstancedMesh(geo, mat, n)
    // Instances move all over the planet; the one-off bounding sphere three
    // computes at first draw would cull them wrongly, so never cull.
    m.frustumCulled = false
    if (dynamic) m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    else statics.push(m)
    group.add(m)
    return m
  }

  // Per site: hall, wing, two stacks, dome, four light strips, four doors, mine.
  const hall = inst(box(3.4, 1.4, 2.4), concrete, nS)
  const wing = inst(box(1.8, 0.9, 1.6), dark, nS)
  const stack = inst(new THREE.CylinderGeometry(0.17 * S, 0.22 * S, 2.3 * S, 12).translate(0, 1.15 * S, 0), steel, nS * 2)
  const dome = inst(new THREE.SphereGeometry(0.75 * S, 20, 14), steel, nS)
  const strip = inst(box(3.2, 0.07, 0.07), warm, nS * 4)
  const door = inst(box(0.06, 0.32, 0.26), cyan, nS * 4)
  const pit = inst(new THREE.CylinderGeometry(1.3 * S, 1.3 * S, 0.1 * S, 24), new THREE.MeshStandardMaterial({ color: '#0d0f13', roughness: 1 }), nS)
  const tower = inst(box(0.5, 1.9, 0.5), dark, nS)
  const beacon = inst(box(0.16, 0.16, 0.16, 0, 1.9), amber, nS)
  const dockLamp = inst(box(0.1, 0.1, 0.4, 0, 0.9), warm, nS)
  // The silo: a tower with a pad on top, a gantry mast beside it, and a
  // carrier rocket standing on the pad whenever the economy has one ready.
  const siloTower = inst(new THREE.CylinderGeometry(0.42 * S, 0.5 * S, 2.6 * S, 16).translate(0, 1.3 * S, 0), dark, nS)
  const siloPad = inst(new THREE.CylinderGeometry(0.7 * S, 0.7 * S, 0.1 * S, 16).translate(0, 2.65 * S, 0), steel, nS)
  const siloMast = inst(box(0.14, 3.4, 0.14, 0.55, 0, 0.55), steel, nS)
  const siloLamp = inst(box(0.12, 0.12, 0.12, 0.55, 3.4, 0.55), amber, nS)
  // Per rail: base, yoke, rack platform.
  const base = inst(new THREE.CylinderGeometry(0.55 * S, 0.64 * S, 0.35 * S, 20).translate(0, 0.175 * S, 0), dark, nG)
  const yoke = inst(box(0.5, 0.7, 0.9, 0, 0.35), steel, nG)
  const rackPlate = inst(box(1.6, 0.08, 1.6), dark, nG)

  sites.forEach((site, si) => {
    const at = (x: number, y: number, h = 0) => siteFrame(site, x, y, h, R)
    place(hall, si, site.hall)
    place(wing, si, at(-2.6, 0.5))
    place(stack, si * 2, at(-0.5, 0.8))
    place(stack, si * 2 + 1, at(-0.5, -0.8))
    place(dome, si, at(0.5, 0, 1.4))
    place(strip, si * 4, at(0, 1.21, 0.5))
    place(strip, si * 4 + 1, at(0, -1.21, 0.5))
    place(strip, si * 4 + 2, at(0, 1.21, 1.05))
    place(strip, si * 4 + 3, at(0, -1.21, 1.05))
    for (let k = 0; k < 4; k++) place(door, si * 4 + k, at(DOOR_X - 0.03, DOOR_Y[k], 0.02))
    place(pit, si, at(MINE_XY[0], MINE_XY[1], 0.03))
    place(tower, si, at(MINE_XY[0] + 1.0, MINE_XY[1] + 0.7))
    place(beacon, si, at(MINE_XY[0] + 1.0, MINE_XY[1] + 0.7))
    place(dockLamp, si, at(DOCK_XY[0] + 0.1, DOCK_XY[1]))
    place(siloTower, si, site.silo)
    place(siloPad, si, site.silo)
    place(siloMast, si, site.silo)
    place(siloLamp, si, site.silo)
    site.guns.forEach((g) => {
      place(base, g.id, g.frame)
      place(yoke, g.id, g.frame)
      place(rackPlate, g.id, at(RACK_X0 + 1.5 * RACK_PITCH, GUN_Y[g.index]))
    })
  })
  for (const m of statics) m.instanceMatrix.needsUpdate = true

  // Barrels and coils pivot every frame; flashes sit at the muzzle.
  const barrelGeo = (() => {
    const parts: THREE.BufferGeometry[] = []
    for (const z of [-0.14, 0.14]) parts.push(new THREE.BoxGeometry(3.2 * S, 0.08 * S, 0.08 * S).translate(1.6 * S, 0, z * S))
    parts.push(new THREE.BoxGeometry(0.55 * S, 0.4 * S, 0.5 * S).translate(0.2 * S, 0, 0))
    parts.push(new THREE.CylinderGeometry(0.05 * S, 0.05 * S, 3.0 * S, 8).rotateZ(Math.PI / 2).translate(1.6 * S, 0, 0))
    return merge(parts)
  })()
  const coilGeo = (() => {
    const parts: THREE.BufferGeometry[] = []
    for (let k = 0; k < 6; k++) parts.push(new THREE.TorusGeometry(0.21 * S, 0.035 * S, 8, 20).rotateY(Math.PI / 2).translate((0.55 + 0.47 * k) * S, 0, 0))
    return merge(parts)
  })()
  const barrel = inst(barrelGeo, steel, nG, true)
  const coils = inst(coilGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), nG, true)
  const flash = inst(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: glow, color: '#bfe0ff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    nG,
    true,
  )
  for (let i = 0; i < nG; i++) coils.setColorAt(i, COIL_IDLE)
  // The rocket on the pad and its launch flash.
  const rocketGeo = merge([
    new THREE.CylinderGeometry(0.17 * S, 0.19 * S, 1.1 * S, 12).translate(0, 0.55 * S, 0),
    new THREE.ConeGeometry(0.17 * S, 0.45 * S, 12).translate(0, 1.325 * S, 0),
    new THREE.CylinderGeometry(0.3 * S, 0.22 * S, 0.22 * S, 12).translate(0, 0.11 * S, 0),
  ])
  const padRocket = inst(rocketGeo, new THREE.MeshStandardMaterial({ color: '#e6e9ef', roughness: 0.45, metalness: 0.3 }), nS, true)
  const siloFlash = inst(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: glow, color: '#ffd9a8', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    nS,
    true,
  )

  // Folded sails and the hauler fleet.
  const nP = ground.nPackages
  const packages = inst(box(0.3, 0.14, 0.3, 0, -0.07), new THREE.MeshBasicMaterial({ color: 0xffffff }), nP, true)
  for (let i = 0; i < nP; i++) packages.setColorAt(i, PKG_COLOUR)
  const nB = ground.nBots
  const bots = inst(box(0.32, 0.14, 0.22, 0, 0.03), new THREE.MeshStandardMaterial({ color: '#d2d7e0', roughness: 0.6, metalness: 0.3 }), nB, true)
  const lamps = inst(box(0.07, 0.06, 0.16, 0.16, 0.1), lit(1.4, 1.6, 2.2), nB, true)
  const crates = inst(box(0.18, 0.12, 0.16, 0, 0.17), new THREE.MeshStandardMaterial({ color: '#e0893a', roughness: 0.8 }), nB, true)

  const zero = new THREE.Matrix4().makeScale(0, 0, 0)
  const up = new THREE.Vector3()
  const fwd = new THREE.Vector3()
  const right = new THREE.Vector3()
  const groupQ = new THREE.Quaternion()
  const billboard = new THREE.Quaternion()
  const tmpC = new THREE.Color()
  const hot = new THREE.Color()
  const hotPkg = new THREE.Color()
  const here = new THREE.Vector3()

  function update(camera: THREE.Camera) {
    // How bright the lights may be: full within 90 units of Earth's centre,
    // down to a non-blooming level beyond 420.
    group.getWorldPosition(here)
    const d = camera.position.distanceTo(here)
    const u = Math.max(0, Math.min(1, (420 - d) / 330))
    const gain = u * u * (3 - 2 * u)
    const dimTo = (base: THREE.Color, out: THREE.Color) => {
      const peak = Math.max(base.r, base.g, base.b)
      const floor = Math.min(1, 0.55 / peak)
      return out.copy(base).multiplyScalar(floor + (1 - floor) * gain)
    }
    for (const m of hdr) dimTo(m.userData.base as THREE.Color, m.color)
    dimTo(COIL_HOT, hot)
    dimTo(PKG_HOT, hotPkg)
    // Rails: pivot the barrel to its yaw and pitch; glow with the charge.
    for (const g of guns) {
      dummy.position.set(g.pivot[0], g.pivot[1], g.pivot[2])
      frameQuat(g.frame, dummy.quaternion)
      dummy.rotateY(g.yaw)
      dummy.rotateZ(g.pitch)
      dummy.scale.setScalar(1)
      dummy.updateMatrix()
      barrel.setMatrixAt(g.id, dummy.matrix)
      coils.setMatrixAt(g.id, dummy.matrix)
      tmpC.copy(COIL_IDLE).lerp(hot, g.charge)
      coils.setColorAt(g.id, tmpC)
      if (g.flash > 0.01) {
        // The muzzle, facing the camera.
        fwd.set(1, 0, 0).applyQuaternion(dummy.quaternion)
        dummy.position.addScaledVector(fwd, BARREL_LEN)
        groupQ.setFromRotationMatrix(group.matrixWorld).invert()
        billboard.copy(groupQ).multiply(camera.quaternion)
        dummy.quaternion.copy(billboard)
        dummy.scale.setScalar(g.flash * 2.2 * S * gain)
        dummy.updateMatrix()
        flash.setMatrixAt(g.id, dummy.matrix)
      } else flash.setMatrixAt(g.id, zero)
    }
    barrel.instanceMatrix.needsUpdate = true
    coils.instanceMatrix.needsUpdate = true
    coils.instanceColor!.needsUpdate = true
    flash.instanceMatrix.needsUpdate = true

    // Silos: the rocket stands on the pad while one is ready; a flash when it goes.
    for (let si = 0; si < sites.length; si++) {
      const site = sites[si]
      const f = site.silo
      if (site.siloLoaded) {
        dummy.position.set(f.pos[0] + f.up[0] * SILO_H, f.pos[1] + f.up[1] * SILO_H, f.pos[2] + f.up[2] * SILO_H)
        frameQuat(f, dummy.quaternion)
        dummy.scale.setScalar(1)
        dummy.updateMatrix()
        padRocket.setMatrixAt(si, dummy.matrix)
      } else padRocket.setMatrixAt(si, zero)
      if (site.siloFlash > 0.01) {
        const h = SILO_H + 0.6 * S
        dummy.position.set(f.pos[0] + f.up[0] * h, f.pos[1] + f.up[1] * h, f.pos[2] + f.up[2] * h)
        groupQ.setFromRotationMatrix(group.matrixWorld).invert()
        dummy.quaternion.copy(groupQ).multiply(camera.quaternion)
        dummy.scale.setScalar(site.siloFlash * 3.2 * S * gain)
        dummy.updateMatrix()
        siloFlash.setMatrixAt(si, dummy.matrix)
      } else siloFlash.setMatrixAt(si, zero)
    }
    padRocket.instanceMatrix.needsUpdate = true
    siloFlash.instanceMatrix.needsUpdate = true

    // Packages: a box standing on the ground wherever the simulation put it.
    const { pkPos, pkAlive, pkState } = ground
    for (let p = 0; p < nP; p++) {
      if (!pkAlive[p]) {
        packages.setMatrixAt(p, zero)
        continue
      }
      const o = p * 3
      dummy.position.set(pkPos[o], pkPos[o + 1], pkPos[o + 2])
      up.copy(dummy.position).normalize()
      dummy.quaternion.setFromUnitVectors(Y, up)
      dummy.scale.setScalar(1)
      dummy.updateMatrix()
      packages.setMatrixAt(p, dummy.matrix)
      const st = pkState[p]
      packages.setColorAt(p, st === PK_RAIL ? hotPkg : st === PK_STACK ? PKG_RACKED : PKG_COLOUR)
    }
    packages.instanceMatrix.needsUpdate = true
    packages.instanceColor!.needsUpdate = true

    // Bots: nose along the road, crate on top when loaded.
    const { botPos, botTan, botLoad } = ground
    for (let b = 0; b < nB; b++) {
      const o = b * 3
      dummy.position.set(botPos[o], botPos[o + 1], botPos[o + 2])
      up.copy(dummy.position).normalize()
      fwd.set(botTan[o], botTan[o + 1], botTan[o + 2])
      fwd.addScaledVector(up, -fwd.dot(up)).normalize()
      right.crossVectors(fwd, up)
      basis.makeBasis(fwd, up, right)
      dummy.quaternion.setFromRotationMatrix(basis)
      dummy.scale.setScalar(1)
      dummy.updateMatrix()
      bots.setMatrixAt(b, dummy.matrix)
      lamps.setMatrixAt(b, dummy.matrix)
      crates.setMatrixAt(b, botLoad[b] ? dummy.matrix : zero)
    }
    bots.instanceMatrix.needsUpdate = true
    lamps.instanceMatrix.needsUpdate = true
    crates.instanceMatrix.needsUpdate = true
  }

  return { group, packages, bots, update }
}

// Merge geometries that share the same attributes into one, so a barrel or a
// coil stack is a single instanced draw.
function merge(parts: THREE.BufferGeometry[]) {
  const pos: number[] = []
  const nrm: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  let base = 0
  for (const g of parts) {
    const p = g.getAttribute('position')
    const n = g.getAttribute('normal')
    const u = g.getAttribute('uv')
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i))
      nrm.push(n.getX(i), n.getY(i), n.getZ(i))
      uv.push(u ? u.getX(i) : 0, u ? u.getY(i) : 0)
    }
    const ix = g.getIndex()
    if (ix) for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + base)
    else for (let i = 0; i < p.count; i++) idx.push(i + base)
    base += p.count
    g.dispose()
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  out.setIndex(idx)
  return out
}
