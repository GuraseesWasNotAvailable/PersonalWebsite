// The Dyson sphere as numbers, with no renderer in sight.
//
// Three geodesic shells round the star. Each is the same mesh, an icosahedron
// subdivided and pushed onto the unit sphere, scaled to its own radius. The
// carrier rockets build it the way Dyson Sphere Program does: nodes first,
// grown outward from the top of the sphere, then the frames between finished
// nodes, and a face begins taking solar sails once its three frames stand. A
// rocket is one fixed share of a node or a frame, a sail is one cell of a
// shell. Progress is kept as integer counts and the floats the renderer reads
// are derived from them, so a day of small additions never drifts. The whole
// structure turns slowly about a tilted axis, and every position handed out
// to a rocket or a sail is in world space at the time asked for.

import { mulberry32 } from './swarm'

export type Target = { layer: number; kind: 0 | 1; index: number } // 0 node, 1 edge

export type ReadyFace = { layer: number; face: number; cx: number; cy: number; cz: number }

export type SphereLayer = {
  R: number
  nodes: Float32Array // 3 per node, unit vectors in the sphere's own frame
  edges: Uint16Array // 2 node indices per edge, lower index first
  faces: Uint16Array // 3 node indices per face, wound outward
  nodeProg: Float32Array // 0..1
  edgeProg: Float32Array // 0..1
  faceFill: Float32Array // 0..1, absorbed sails over FACE_CELLS
  inbound: Uint16Array // sails currently steering for each face
}

export type Geodesic = {
  nodes: Float32Array
  edges: Uint16Array
  faces: Uint16Array
  faceEdges: Uint16Array // 3 edge indices per face
  adjStart: Uint32Array // CSR offsets into adj, one more than the node count
  adj: Uint16Array // neighbour node indices
}

export const ROCKET_FLIGHT_S = 90 // what advance() assumes a rocket spends in flight
export const SAIL_MW = 0.03 // power per absorbed sail
export const FACE_BONUS_MW = 1.5 // extra once a face is sealed
const SLOTS = 6 // targets open at once, so rockets fan out instead of queueing on one node
const DIST_EPS = 1e-4 // radians; distances closer than this are a tie and the seed decides
const AXIS_TILT = 0.3 // radians off +y
const SPIN_PERIOD_S = 2400 // one turn of the structure, in simulation seconds

// Targets travel through other modules as one integer, the same packing the
// rockets use, so a slot table here is a plain Int32Array.
export function encodeTarget(layer: number, kind: number, index: number): number {
  return layer * 1000000 + kind * 100000 + index
}

export function decodeTarget(code: number, out: Target): Target {
  const layer = Math.floor(code / 1000000)
  const rest = code - layer * 1000000
  const kind = Math.floor(rest / 100000)
  out.layer = layer
  out.kind = kind === 1 ? 1 : 0
  out.index = rest - kind * 100000
  return out
}

// An icosahedron with a vertex at each pole, every face split into
// frequency^2 triangles, the new points pushed onto the unit sphere and
// shared points merged. Node 0 is the north pole, so a build that orders by
// distance from the first node grows down from the top of the sphere.
export function buildGeodesic(frequency: number): Geodesic {
  const f = Math.max(1, Math.floor(frequency))
  const lat = Math.atan(0.5)
  const ico: number[][] = [[0, 1, 0]]
  for (let k = 0; k < 5; k++) {
    const lon = (k * 2 * Math.PI) / 5
    ico.push([Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)])
  }
  for (let k = 0; k < 5; k++) {
    const lon = ((k + 0.5) * 2 * Math.PI) / 5
    ico.push([Math.cos(lat) * Math.cos(lon), -Math.sin(lat), Math.cos(lat) * Math.sin(lon)])
  }
  ico.push([0, -1, 0])
  const icoFaces: number[][] = []
  for (let k = 0; k < 5; k++) {
    const u0 = 1 + k
    const u1 = 1 + ((k + 1) % 5)
    const l0 = 6 + k
    const l1 = 6 + ((k + 1) % 5)
    icoFaces.push([0, u0, u1], [u0, l0, u1], [l0, l1, u1], [11, l1, l0])
  }

  const verts: number[] = []
  const seen = new Map<string, number>()
  const addVert = (x: number, y: number, z: number) => {
    const l = Math.hypot(x, y, z)
    x /= l
    y /= l
    z /= l
    // Shared points reach here from neighbouring faces by sums in a different
    // order; rounding the key absorbs the last bit of noise.
    const key = `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`
    let i = seen.get(key)
    if (i === undefined) {
      i = verts.length / 3
      seen.set(key, i)
      verts.push(x, y, z)
    }
    return i
  }
  for (const v of ico) addVert(v[0], v[1], v[2])

  const tris: number[] = []
  const pushTri = (a: number, b: number, c: number) => {
    // Wind every triangle outward so a renderer can cull or shade them alike.
    const ax = verts[a * 3]
    const ay = verts[a * 3 + 1]
    const az = verts[a * 3 + 2]
    const ux = verts[b * 3] - ax
    const uy = verts[b * 3 + 1] - ay
    const uz = verts[b * 3 + 2] - az
    const vx = verts[c * 3] - ax
    const vy = verts[c * 3 + 1] - ay
    const vz = verts[c * 3 + 2] - az
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    const outward = nx * (ax * 3 + ux + vx) + ny * (ay * 3 + uy + vy) + nz * (az * 3 + uz + vz)
    if (outward < 0) tris.push(a, c, b)
    else tris.push(a, b, c)
  }
  for (const [a, b, c] of icoFaces) {
    const grid: number[][] = []
    for (let i = 0; i <= f; i++) {
      const row: number[] = []
      for (let j = 0; i + j <= f; j++) {
        const wa = (f - i - j) / f
        const wb = i / f
        const wc = j / f
        row.push(
          addVert(
            ico[a][0] * wa + ico[b][0] * wb + ico[c][0] * wc,
            ico[a][1] * wa + ico[b][1] * wb + ico[c][1] * wc,
            ico[a][2] * wa + ico[b][2] * wb + ico[c][2] * wc,
          ),
        )
      }
      grid.push(row)
    }
    for (let i = 0; i < f; i++) {
      for (let j = 0; i + j < f; j++) {
        pushTri(grid[i][j], grid[i + 1][j], grid[i][j + 1])
        if (i + j + 1 < f) pushTri(grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1])
      }
    }
  }

  const edges: number[] = []
  const faceEdges: number[] = []
  const edgeOf = new Map<number, number>()
  for (let t = 0; t < tris.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = tris[t + e]
      const b = tris[t + ((e + 1) % 3)]
      const lo = a < b ? a : b
      const hi = a < b ? b : a
      const key = lo * 65536 + hi
      let i = edgeOf.get(key)
      if (i === undefined) {
        i = edges.length / 2
        edgeOf.set(key, i)
        edges.push(lo, hi)
      }
      faceEdges.push(i)
    }
  }
  const V = verts.length / 3
  const adjStart = new Uint32Array(V + 1)
  for (let e = 0; e < edges.length; e++) adjStart[edges[e] + 1]++
  for (let v = 0; v < V; v++) adjStart[v + 1] += adjStart[v]
  const adj = new Uint16Array(edges.length)
  const fill = new Uint32Array(V)
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e]
    const b = edges[e + 1]
    adj[adjStart[a] + fill[a]++] = b
    adj[adjStart[b] + fill[b]++] = a
  }
  return {
    nodes: Float32Array.from(verts),
    edges: Uint16Array.from(edges),
    faces: Uint16Array.from(tris),
    faceEdges: Uint16Array.from(faceEdges),
    adjStart,
    adj,
  }
}

export class DysonSphere {
  readonly layers: SphereLayer[]
  readonly NODE_COST = 40 // rockets per node
  readonly EDGE_COST = 60 // rockets per frame
  readonly FACE_CELLS = 900 // sails per shell face
  spin: number // radians per second about the axis
  axis: [number, number, number]
  // Rockets that arrived at a node or frame already finished. A handful is
  // normal at the very end of the build; many would mean a caller drops
  // targets after asking for them without calling cancelRocket.
  wasted = 0

  // The mesh is shared by every layer.
  private readonly V: number
  private readonly E: number
  private readonly F: number
  private readonly faceEdges: Uint16Array
  private readonly adjStart: Uint32Array
  private readonly adj: Uint16Array
  // Build order: angle from node 0, and a seeded key that settles the many
  // exact ties a symmetric mesh has, so the growth has a little character.
  private readonly nodeDist: Float32Array
  private readonly edgeDist: Float32Array
  private readonly nodeKey: Float32Array
  private readonly edgeKey: Float32Array
  // Per layer integer progress. Pending counts the rockets handed out by
  // nextTarget that have not landed yet, so a node is not promised to more
  // rockets than it needs while forty of them are in the air.
  private readonly nodeRockets: Uint16Array[]
  private readonly edgeRockets: Uint16Array[]
  private readonly nodePending: Uint16Array[]
  private readonly edgePending: Uint16Array[]
  private readonly faceCells: Uint16Array[]
  // The open targets rockets are being spread across, as encoded codes or -1.
  private readonly slots = new Int32Array(SLOTS)
  private slotPtr = 0
  private faceCursor = 0
  // Scratch for the rotation, so no vector is ever allocated per call.
  private rx = 0
  private ry = 0
  private rz = 0

  constructor(radii: number[], frequency: number, seed: number) {
    const rand = mulberry32(seed)
    const mesh = buildGeodesic(frequency)
    const V = mesh.nodes.length / 3
    const E = mesh.edges.length / 2
    const F = mesh.faces.length / 3
    this.V = V
    this.E = E
    this.F = F
    this.faceEdges = mesh.faceEdges
    this.adjStart = mesh.adjStart
    this.adj = mesh.adj
    this.layers = radii.map((R) => ({
      R,
      nodes: mesh.nodes,
      edges: mesh.edges,
      faces: mesh.faces,
      nodeProg: new Float32Array(V),
      edgeProg: new Float32Array(E),
      faceFill: new Float32Array(F),
      inbound: new Uint16Array(F),
    }))
    this.nodeRockets = radii.map(() => new Uint16Array(V))
    this.edgeRockets = radii.map(() => new Uint16Array(E))
    this.nodePending = radii.map(() => new Uint16Array(V))
    this.edgePending = radii.map(() => new Uint16Array(E))
    this.faceCells = radii.map(() => new Uint16Array(F))
    this.slots.fill(-1)

    const n = mesh.nodes
    const px = n[0]
    const py = n[1]
    const pz = n[2]
    this.nodeDist = new Float32Array(V)
    this.nodeKey = new Float32Array(V)
    for (let i = 0; i < V; i++) {
      const d = n[i * 3] * px + n[i * 3 + 1] * py + n[i * 3 + 2] * pz
      this.nodeDist[i] = Math.acos(Math.max(-1, Math.min(1, d)))
      this.nodeKey[i] = rand()
    }
    this.edgeDist = new Float32Array(E)
    this.edgeKey = new Float32Array(E)
    for (let e = 0; e < E; e++) {
      const a = mesh.edges[e * 2] * 3
      const b = mesh.edges[e * 2 + 1] * 3
      const mx = n[a] + n[b]
      const my = n[a + 1] + n[b + 1]
      const mz = n[a + 2] + n[b + 2]
      const ml = Math.hypot(mx, my, mz) || 1
      const d = (mx * px + my * py + mz * pz) / ml
      this.edgeDist[e] = Math.acos(Math.max(-1, Math.min(1, d)))
      this.edgeKey[e] = rand()
    }

    const az = rand() * Math.PI * 2
    this.axis = [Math.sin(AXIS_TILT) * Math.cos(az), Math.cos(AXIS_TILT), Math.sin(AXIS_TILT) * Math.sin(az)]
    this.spin = (2 * Math.PI) / SPIN_PERIOD_S
  }

  // Rodrigues rotation of (x, y, z) about the axis by the angle whose cosine
  // and sine are given. The result lands in rx, ry, rz.
  private rotate(x: number, y: number, z: number, c: number, s: number) {
    const a = this.axis
    const al = Math.hypot(a[0], a[1], a[2]) || 1
    const ax = a[0] / al
    const ay = a[1] / al
    const az = a[2] / al
    const d = (ax * x + ay * y + az * z) * (1 - c)
    this.rx = x * c + (ay * z - az * y) * s + ax * d
    this.ry = y * c + (az * x - ax * z) * s + ay * d
    this.rz = z * c + (ax * y - ay * x) * s + az * d
  }

  // Position of a node, or the midpoint of an edge, in world space at time t.
  structurePos(target: Target, t: number, out: { [k: number]: number }): void {
    const L = this.layers[target.layer]
    let x = 0
    let y = 0
    let z = 0
    if (L && target.index >= 0) {
      const nodes = L.nodes
      if (target.kind === 0) {
        if (target.index < this.V) {
          const o = target.index * 3
          x = nodes[o] * L.R
          y = nodes[o + 1] * L.R
          z = nodes[o + 2] * L.R
        }
      } else if (target.index < this.E) {
        const a = L.edges[target.index * 2] * 3
        const b = L.edges[target.index * 2 + 1] * 3
        x = (nodes[a] + nodes[b]) * 0.5 * L.R
        y = (nodes[a + 1] + nodes[b + 1]) * 0.5 * L.R
        z = (nodes[a + 2] + nodes[b + 2]) * 0.5 * L.R
      }
    }
    const ang = this.spin * t
    this.rotate(x, y, z, Math.cos(ang), Math.sin(ang))
    out[0] = this.rx
    out[1] = this.ry
    out[2] = this.rz
  }

  // A node or frame is covered once the rockets it has plus the rockets on
  // their way add up to its cost. Covered is what the planner reasons with;
  // the renderer and the faces only care about rockets that have landed.
  private nodeCovered(layer: number, i: number): boolean {
    return this.nodeRockets[layer][i] + this.nodePending[layer][i] >= this.NODE_COST
  }

  private edgeCovered(layer: number, e: number): boolean {
    return this.edgeRockets[layer][e] + this.edgePending[layer][e] >= this.EDGE_COST
  }

  private need(code: number): number {
    const layer = Math.floor(code / 1000000)
    const rest = code - layer * 1000000
    const kind = Math.floor(rest / 100000)
    const index = rest - kind * 100000
    return kind === 0
      ? this.NODE_COST - this.nodeRockets[layer][index] - this.nodePending[layer][index]
      : this.EDGE_COST - this.edgeRockets[layer][index] - this.edgePending[layer][index]
  }

  private layerOpen(layer: number): boolean {
    for (let i = 0; i < this.V; i++) if (!this.nodeCovered(layer, i)) return true
    for (let e = 0; e < this.E; e++) if (!this.edgeCovered(layer, e)) return true
    return false
  }

  private inSlots(code: number): boolean {
    for (let s = 0; s < SLOTS; s++) if (this.slots[s] === code) return true
    return false
  }

  // The next thing to build that is not already open: in the innermost
  // unfinished layer, the node with the most covered neighbours and then the
  // one nearest the first node, so the structure grows as one patch rather
  // than as freckles; once every node is covered, the frame between two
  // covered nodes nearest the first node.
  private pickCandidate(): number {
    let layer = 0
    while (layer < this.layers.length && !this.layerOpen(layer)) layer++
    if (layer >= this.layers.length) return -1
    let best = -1
    let bestN = -1
    let bestD = 0
    let bestK = 0
    const { adjStart, adj, nodeDist, nodeKey } = this
    for (let i = 0; i < this.V; i++) {
      if (this.nodeCovered(layer, i)) continue
      const code = encodeTarget(layer, 0, i)
      if (this.inSlots(code)) continue
      let n = 0
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) if (this.nodeCovered(layer, adj[k])) n++
      const d = nodeDist[i]
      const key = nodeKey[i]
      if (best < 0 || n > bestN || (n === bestN && (d < bestD - DIST_EPS || (Math.abs(d - bestD) <= DIST_EPS && key < bestK)))) {
        best = code
        bestN = n
        bestD = d
        bestK = key
      }
    }
    if (best >= 0) return best
    const { edges } = this.layers[layer]
    const { edgeDist, edgeKey } = this
    for (let e = 0; e < this.E; e++) {
      if (this.edgeCovered(layer, e)) continue
      if (!this.nodeCovered(layer, edges[e * 2]) || !this.nodeCovered(layer, edges[e * 2 + 1])) continue
      const code = encodeTarget(layer, 1, e)
      if (this.inSlots(code)) continue
      const d = edgeDist[e]
      const key = edgeKey[e]
      if (best < 0 || d < bestD - DIST_EPS || (Math.abs(d - bestD) <= DIST_EPS && key < bestK)) {
        best = code
        bestD = d
        bestK = key
      }
    }
    return best
  }

  // Anything whose rockets have not all landed, for when the planner has
  // nothing open: the most advanced node first, then the most advanced frame.
  private pickUnfinished(): number {
    for (let layer = 0; layer < this.layers.length; layer++) {
      let best = -1
      let bestHave = -1
      const nr = this.nodeRockets[layer]
      for (let i = 0; i < this.V; i++) {
        if (nr[i] < this.NODE_COST && nr[i] > bestHave) {
          best = i
          bestHave = nr[i]
        }
      }
      if (best >= 0) return encodeTarget(layer, 0, best)
      const er = this.edgeRockets[layer]
      for (let e = 0; e < this.E; e++) {
        if (er[e] < this.EDGE_COST && er[e] > bestHave) {
          best = e
          bestHave = er[e]
        }
      }
      if (best >= 0) return encodeTarget(layer, 1, best)
    }
    return -1
  }

  // Retire the slots whose targets are covered and refill them in build order.
  private refreshSlots() {
    for (let s = 0; s < SLOTS; s++) if (this.slots[s] >= 0 && this.need(this.slots[s]) <= 0) this.slots[s] = -1
    for (let s = 0; s < SLOTS; s++) {
      if (this.slots[s] >= 0) continue
      const code = this.pickCandidate()
      if (code < 0) break
      this.slots[s] = code
    }
  }

  private addPending(target: Target, delta: number) {
    const pend = target.kind === 0 ? this.nodePending[target.layer] : this.edgePending[target.layer]
    if (!pend || target.index < 0 || target.index >= pend.length) return
    const v = pend[target.index] + delta
    pend[target.index] = v < 0 ? 0 : v > 65535 ? 65535 : v
  }

  // Where the next rocket should go, or null when every layer is complete.
  // The open targets are served in turn, so a burst of launches lands on up
  // to six places rather than one. A fresh object is returned each time; a
  // launch happens a few times a minute, so this is not a hot path.
  nextTarget(): Target | null {
    this.refreshSlots()
    for (let k = 0; k < SLOTS; k++) {
      const s = (this.slotPtr + k) % SLOTS
      const code = this.slots[s]
      if (code < 0) continue
      this.slotPtr = (s + 1) % SLOTS
      const tg = decodeTarget(code, { layer: 0, kind: 0, index: 0 })
      this.addPending(tg, 1)
      return tg
    }
    // Everything has its rockets on the way. If a caller dropped a target
    // after asking for it, that target would otherwise wait forever, so once
    // the slots run dry rockets go to whatever has not landed yet. At the end
    // of a clean build that costs a few wasted rockets and nothing more.
    const code = this.pickUnfinished()
    if (code < 0) return null
    const tg = decodeTarget(code, { layer: 0, kind: 0, index: 0 })
    this.addPending(tg, 1)
    return tg
  }

  // A rocket handed out by nextTarget that never launched; gives its share back.
  cancelRocket(target: Target): void {
    this.addPending(target, -1)
  }

  private addNodeRockets(layer: number, i: number, k: number) {
    const have = this.nodeRockets[layer][i]
    const room = this.NODE_COST - have
    if (k > room) {
      this.wasted += k - room
      k = room
    }
    if (k <= 0) return
    this.nodeRockets[layer][i] = have + k
    this.layers[layer].nodeProg[i] = (have + k) / this.NODE_COST
  }

  private addEdgeRockets(layer: number, e: number, k: number) {
    const have = this.edgeRockets[layer][e]
    const room = this.EDGE_COST - have
    if (k > room) {
      this.wasted += k - room
      k = room
    }
    if (k <= 0) return
    this.edgeRockets[layer][e] = have + k
    this.layers[layer].edgeProg[e] = (have + k) / this.EDGE_COST
  }

  private deliverCode(code: number, k: number) {
    const layer = Math.floor(code / 1000000)
    const rest = code - layer * 1000000
    const kind = Math.floor(rest / 100000)
    const index = rest - kind * 100000
    if (kind === 0) this.addNodeRockets(layer, index, k)
    else this.addEdgeRockets(layer, index, k)
  }

  // One rocket's worth of progress.
  deliverRocket(target: Target): void {
    const layer = target.layer
    const i = target.index
    if (layer < 0 || layer >= this.layers.length || i < 0) return
    if (target.kind === 0) {
      if (i >= this.V) return
      const pend = this.nodePending[layer]
      if (pend[i] > 0) pend[i]--
      this.addNodeRockets(layer, i, 1)
    } else {
      if (i >= this.E) return
      const pend = this.edgePending[layer]
      if (pend[i] > 0) pend[i]--
      this.addEdgeRockets(layer, i, 1)
    }
  }

  // A face takes sails once its three frames have all their rockets and
  // until its cells are full.
  private faceReady(layer: number, f: number): boolean {
    if (this.faceCells[layer][f] >= this.FACE_CELLS) return false
    const er = this.edgeRockets[layer]
    const fe = this.faceEdges
    const o = f * 3
    return er[fe[o]] >= this.EDGE_COST && er[fe[o + 1]] >= this.EDGE_COST && er[fe[o + 2]] >= this.EDGE_COST
  }

  // Faces ready for sails, up to `max`, least loaded first, with the centroid
  // in world space at time t. `out` is reused; an entry is only created when
  // the array is shorter than the count returned.
  readyFaces(t: number, max: number, out: ReadyFace[]): number {
    if (max <= 0) return 0
    const nl = this.layers.length
    const F = this.F
    const total = nl * F
    let lo = 65535
    let hi = -1
    for (let l = 0; l < nl; l++) {
      const inb = this.layers[l].inbound
      for (let f = 0; f < F; f++) {
        if (!this.faceReady(l, f)) continue
        const v = inb[f]
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    if (hi < 0) return 0
    const ang = this.spin * t
    const c = Math.cos(ang)
    const s = Math.sin(ang)
    let n = 0
    // Walk the inbound counts from the least loaded up so a face with few
    // sails on the way is offered before a crowded one; after a few levels
    // take whatever is left. The cursor moves the start so ties rotate.
    for (let level = lo; level <= hi && n < max; level++) {
      const last = level === hi || level - lo >= 6
      for (let k = 0; k < total && n < max; k++) {
        const g = (this.faceCursor + k) % total
        const l = Math.floor(g / F)
        const f = g - l * F
        if (!this.faceReady(l, f)) continue
        const v = this.layers[l].inbound[f]
        if (last ? v < level : v !== level) continue
        let item = out[n]
        if (item === undefined) {
          item = { layer: 0, face: 0, cx: 0, cy: 0, cz: 0 }
          out.push(item)
        }
        const L = this.layers[l]
        const nodes = L.nodes
        const a = L.faces[f * 3] * 3
        const b = L.faces[f * 3 + 1] * 3
        const d = L.faces[f * 3 + 2] * 3
        const third = L.R / 3
        this.rotate(
          (nodes[a] + nodes[b] + nodes[d]) * third,
          (nodes[a + 1] + nodes[b + 1] + nodes[d + 1]) * third,
          (nodes[a + 2] + nodes[b + 2] + nodes[d + 2]) * third,
          c,
          s,
        )
        item.layer = l
        item.face = f
        item.cx = this.rx
        item.cy = this.ry
        item.cz = this.rz
        n++
      }
      if (last) break
    }
    this.faceCursor = (this.faceCursor + n) % total
    return n
  }

  private addCells(layer: number, face: number, k: number) {
    const cells = this.faceCells[layer]
    const have = cells[face]
    const v = have + k > this.FACE_CELLS ? this.FACE_CELLS : have + k
    if (v === have) return
    cells[face] = v
    this.layers[layer].faceFill[face] = v / this.FACE_CELLS
  }

  // One sail into the shell.
  absorb(layer: number, face: number): void {
    if (layer < 0 || layer >= this.layers.length || face < 0 || face >= this.F) return
    this.addCells(layer, face, 1)
  }

  setInbound(layer: number, face: number, delta: number): void {
    if (layer < 0 || layer >= this.layers.length || face < 0 || face >= this.F) return
    const inb = this.layers[layer].inbound
    const v = inb[face] + delta
    inb[face] = v < 0 ? 0 : v > 65535 ? 65535 : v
  }

  // 0.03 MW per absorbed sail, 1.5 MW extra per finished face.
  powerMW(): number {
    let cells = 0
    let done = 0
    for (let l = 0; l < this.layers.length; l++) {
      const fc = this.faceCells[l]
      for (let f = 0; f < this.F; f++) {
        cells += fc[f]
        if (fc[f] >= this.FACE_CELLS) done++
      }
    }
    return cells * SAIL_MW + done * FACE_BONUS_MW
  }

  // Every node, frame and face counts as one unit, whatever it costs, so the
  // readout moves at a steady pace through the whole build instead of sitting
  // near zero until the shells start to fill.
  completion(): number {
    let sum = 0
    for (let l = 0; l < this.layers.length; l++) {
      const nr = this.nodeRockets[l]
      const er = this.edgeRockets[l]
      const fc = this.faceCells[l]
      for (let i = 0; i < this.V; i++) sum += nr[i] / this.NODE_COST
      for (let e = 0; e < this.E; e++) sum += er[e] / this.EDGE_COST
      for (let f = 0; f < this.F; f++) sum += fc[f] / this.FACE_CELLS
    }
    const total = this.layers.length * (this.V + this.E + this.F)
    return total > 0 ? Math.min(1, sum / total) : 0
  }

  counts(): { nodes: number; nodesDone: number; frames: number; framesDone: number; faces: number; facesDone: number; cells: number } {
    let nodesDone = 0
    let framesDone = 0
    let facesDone = 0
    let cells = 0
    for (let l = 0; l < this.layers.length; l++) {
      const nr = this.nodeRockets[l]
      const er = this.edgeRockets[l]
      const fc = this.faceCells[l]
      for (let i = 0; i < this.V; i++) if (nr[i] >= this.NODE_COST) nodesDone++
      for (let e = 0; e < this.E; e++) if (er[e] >= this.EDGE_COST) framesDone++
      for (let f = 0; f < this.F; f++) {
        cells += fc[f]
        if (fc[f] >= this.FACE_CELLS) facesDone++
      }
    }
    const nl = this.layers.length
    return { nodes: nl * this.V, nodesDone, frames: nl * this.E, framesDone, faces: nl * this.F, facesDone, cells }
  }

  // Land n rockets the way nextTarget would have handed them out, in whole
  // rounds across the open slots at a time: every slot gets as many as the
  // neediest one can take before any of them finishes, then the finished
  // slots are refilled, and a final partial round goes one by one from the
  // pointer. The same decisions as the live planner, in far fewer steps.
  private deliverMany(n: number) {
    while (n > 0) {
      this.refreshSlots()
      let live = 0
      let m = 1 << 30
      for (let s = 0; s < SLOTS; s++) {
        const code = this.slots[s]
        if (code < 0) continue
        live++
        const need = this.need(code)
        if (need < m) m = need
      }
      if (live === 0) {
        const code = this.pickUnfinished()
        if (code < 0) return
        this.deliverCode(code, 1)
        n--
        continue
      }
      if (n >= live * m) {
        for (let s = 0; s < SLOTS; s++) if (this.slots[s] >= 0) this.deliverCode(this.slots[s], m)
        n -= live * m
        continue
      }
      const per = Math.floor(n / live)
      let extra = n - per * live
      let lastExtra = -1
      for (let k = 0; k < SLOTS; k++) {
        const s = (this.slotPtr + k) % SLOTS
        const code = this.slots[s]
        if (code < 0) continue
        let give = per
        if (extra > 0) {
          give++
          extra--
          lastExtra = s
        }
        if (give > 0) this.deliverCode(code, give)
      }
      if (lastExtra >= 0) this.slotPtr = (lastExtra + 1) % SLOTS
      n = 0
    }
  }

  // Share k sails evenly over the faces ready for them. Sails with no face to
  // take them are not banked: in the live sim they stay in orbit and are
  // recycled, so production before the first frames stand is simply lost.
  private spreadSails(k: number) {
    const nl = this.layers.length
    let n = 0
    for (let l = 0; l < nl; l++) for (let f = 0; f < this.F; f++) if (this.faceReady(l, f)) n++
    if (n === 0) return
    const per = Math.floor(k / n)
    let extra = k - per * n
    for (let l = 0; l < nl; l++) {
      for (let f = 0; f < this.F; f++) {
        if (!this.faceReady(l, f)) continue
        let give = per
        if (extra > 0) {
          give++
          extra--
        }
        if (give > 0) this.addCells(l, f, give)
      }
    }
  }

  // Fast forward the construction given production rates, in build order.
  // Rockets land ROCKET_FLIGHT_S after they are made, so progress lags
  // production by that; sails are absorbed as they are made, into whatever
  // faces are ready at the time. Coarse steps of about twenty seconds keep
  // the opening of faces and the sails that follow in the right order.
  advance(seconds: number, rocketsPerSec: number, sailsPerSec: number): void {
    if (!(seconds > 0)) return
    const rr = rocketsPerSec > 0 ? rocketsPerSec : 0
    const sr = sailsPerSec > 0 ? sailsPerSec : 0
    const steps = Math.max(1, Math.ceil(seconds / 20))
    const dt = seconds / steps
    let delivered = 0
    let sailBudget = 0
    for (let s = 1; s <= steps; s++) {
      const t = s * dt
      const want = Math.floor(rr * Math.max(0, t - ROCKET_FLIGHT_S))
      if (want > delivered) {
        this.deliverMany(want - delivered)
        delivered = want
      }
      sailBudget += sr * dt
      const k = Math.floor(sailBudget)
      if (k > 0) {
        this.spreadSails(k)
        sailBudget -= k
      }
    }
  }
}
