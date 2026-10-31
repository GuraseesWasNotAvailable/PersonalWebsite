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
  FACE_CELLS = 1500;
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
    this.layers = radii.map((R) => ({
      R,
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
    const dt = seconds / steps2;
    let delivered = 0;
    let sailBudget2 = 0;
    for (let s = 1; s <= steps2; s++) {
      const t = s * dt;
      const want = Math.floor(rr * Math.max(0, t - ROCKET_FLIGHT_S));
      if (want > delivered) {
        this.deliverMany(want - delivered);
        delivered = want;
      }
      sailBudget2 += sr * dt;
      const k = Math.floor(sailBudget2);
      if (k > 0) {
        this.spreadSails(k);
        sailBudget2 -= k;
      }
    }
  }
};

// tools/sphere_test.ts
var failures = 0;
var check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};
var fmt = (s) => {
  const c = s.counts();
  return `completion ${(s.completion() * 100).toFixed(2)}% | nodes ${c.nodesDone}/${c.nodes} frames ${c.framesDone}/${c.frames} faces ${c.facesDone}/${c.faces} cells ${c.cells} | ${s.powerMW().toFixed(1)} MW`;
};
var RADII = [215, 272, 330];
var sphere = new DysonSphere(RADII, 2, 5);
console.log(`axis [${sphere.axis.map((v) => v.toFixed(3)).join(", ")}], spin ${sphere.spin.toExponential(3)} rad/s, one turn in ${(2 * Math.PI / sphere.spin).toFixed(0)} s`);
for (let l = 0; l < sphere.layers.length; l++) {
  const L = sphere.layers[l];
  const V = L.nodes.length / 3;
  const E = L.edges.length / 2;
  const F = L.faces.length / 3;
  check(`layer ${l} (R ${L.R}) has 42 nodes, 120 edges, 80 faces`, V === 42 && E === 120 && F === 80, `${V} / ${E} / ${F}`);
  const faceCount = /* @__PURE__ */ new Map();
  for (let f = 0; f < F; f++) {
    for (let e = 0; e < 3; e++) {
      const a = L.faces[f * 3 + e];
      const b = L.faces[f * 3 + (e + 1) % 3];
      const key = `${Math.min(a, b)},${Math.max(a, b)}`;
      faceCount.set(key, (faceCount.get(key) ?? 0) + 1);
    }
  }
  let twoFaced = 0;
  for (let e = 0; e < E; e++) {
    const a = L.edges[e * 2];
    const b = L.edges[e * 2 + 1];
    if (faceCount.get(`${Math.min(a, b)},${Math.max(a, b)}`) === 2) twoFaced++;
  }
  check(`layer ${l} every edge belongs to exactly two faces`, twoFaced === E && faceCount.size === E, `${twoFaced}/${E} edges two faced, ${faceCount.size} distinct face edges`);
  let worst = 0;
  for (let i = 0; i < V; i++) worst = Math.max(worst, Math.abs(Math.hypot(L.nodes[i * 3], L.nodes[i * 3 + 1], L.nodes[i * 3 + 2]) - 1));
  check(`layer ${l} every node is a unit vector`, worst < 1e-5, `worst |len - 1| ${worst.toExponential(2)}`);
  let degreeOk = true;
  const deg = new Uint8Array(V);
  for (let e = 0; e < E; e++) {
    deg[L.edges[e * 2]]++;
    deg[L.edges[e * 2 + 1]]++;
  }
  let fives = 0;
  for (let i = 0; i < V; i++) {
    if (deg[i] === 5) fives++;
    else if (deg[i] !== 6) degreeOk = false;
  }
  check(`layer ${l} twelve nodes of degree 5, the rest 6`, degreeOk && fives === 12, `${fives} of degree 5`);
}
var ROCKET_RATE = 0.25;
var SAIL_RATE = 13;
var HOURS = 3;
var DT = 1;
var ready = [];
for (let k = 0; k < 40; k++) ready.push({ layer: 0, face: 0, cx: 0, cy: 0, cz: 0 });
var rocketBudget = 0;
var sailBudget = 0;
var fired = 0;
var absorbed = 0;
var lost = 0;
var nullTargets = 0;
var maxReady = 0;
var seenTargets = /* @__PURE__ */ new Set();
var t0 = Date.now();
var steps = Math.round(HOURS * 3600 / DT);
console.log(`
stepped run: ${HOURS} h at dt ${DT}, ${ROCKET_RATE} rockets/s and ${SAIL_RATE} sails/s`);
for (let step = 1; step <= steps; step++) {
  const t = step * DT;
  rocketBudget += ROCKET_RATE * DT;
  while (rocketBudget >= 1) {
    rocketBudget -= 1;
    const tg = sphere.nextTarget();
    if (!tg) {
      nullTargets++;
      continue;
    }
    seenTargets.add(`${tg.layer}:${tg.kind}:${tg.index}`);
    sphere.deliverRocket(tg);
    fired++;
  }
  sailBudget += SAIL_RATE * DT;
  const k = Math.floor(sailBudget);
  sailBudget -= k;
  const n = sphere.readyFaces(t, 40, ready);
  if (n > maxReady) maxReady = n;
  if (n > 0) {
    for (let i = 0; i < k; i++) sphere.absorb(ready[i % n].layer, ready[i % n].face);
    absorbed += k;
  } else lost += k;
  if (t % 1800 === 0) console.log(`  t=${(t / 60).toFixed(0).padStart(3)} min  ${fmt(sphere)}`);
}
var steppedMs = Date.now() - t0;
console.log(`  ${fired} rockets fired to ${seenTargets.size} distinct targets, ${absorbed} sails absorbed, ${lost} sails with no face to take them, up to ${maxReady} faces ready at once, ${nullTargets} empty targets, ${sphere.wasted} wasted rockets, ${steppedMs} ms`);
check("stepped run fired every rocket the budget allowed", fired === Math.floor(ROCKET_RATE * HOURS * 3600) && nullTargets === 0, `${fired} fired`);
check("stepped run wasted no rockets", sphere.wasted === 0, `${sphere.wasted}`);
var stepped = sphere.counts();
check("stepped run finished every node of the first layer before any of the second", stepped.nodesDone >= 42 && sphere.layers[1].nodeProg.every((v) => v === 0), `${stepped.nodesDone} nodes done`);
check("stepped run completed a face only where its three frames stand", (() => {
  for (let l = 0; l < sphere.layers.length; l++) {
    const L = sphere.layers[l];
    const edgeOf = /* @__PURE__ */ new Map();
    for (let e = 0; e < L.edges.length / 2; e++) edgeOf.set(`${L.edges[e * 2]},${L.edges[e * 2 + 1]}`, e);
    for (let f = 0; f < L.faces.length / 3; f++) {
      if (L.faceFill[f] <= 0) continue;
      for (let k = 0; k < 3; k++) {
        const a = L.faces[f * 3 + k];
        const b = L.faces[f * 3 + (k + 1) % 3];
        const e = edgeOf.get(`${Math.min(a, b)},${Math.max(a, b)}`);
        if (e === void 0 || L.edgeProg[e] < 1) return false;
      }
    }
  }
  return true;
})());
var fresh = new DysonSphere(RADII, 2, 5);
var t1 = Date.now();
fresh.advance(HOURS * 3600, ROCKET_RATE, SAIL_RATE);
var advMs = Date.now() - t1;
console.log(`
advance(${HOURS * 3600}, ${ROCKET_RATE}, ${SAIL_RATE}) in ${advMs} ms:
  ${fmt(fresh)}`);
var ff = fresh.counts();
var dCompletion = (fresh.completion() - sphere.completion()) * 100;
console.log(`  difference, advance minus stepped: completion ${dCompletion.toFixed(2)} points, nodes ${ff.nodesDone - stepped.nodesDone}, frames ${ff.framesDone - stepped.framesDone}, faces ${ff.facesDone - stepped.facesDone}, cells ${ff.cells - stepped.cells}, power ${(fresh.powerMW() - sphere.powerMW()).toFixed(1)} MW`);
console.log(`  (advance lands rockets 90 s after they are made, so it is ${Math.round(ROCKET_RATE * 90)} rockets behind the stepped run by design)`);
check("advance lands close to the stepped run", Math.abs(dCompletion) < 2 && ff.nodesDone === stepped.nodesDone && Math.abs(ff.framesDone - stepped.framesDone) <= 6 && Math.abs(ff.facesDone - stepped.facesDone) <= 6, `completion differs by ${dCompletion.toFixed(2)} points`);
{
  const s = new DysonSphere(RADII, 2, 5);
  s.advance(3e4, ROCKET_RATE, 0);
  const list = [];
  const n = s.readyFaces(0, 240, list);
  let ok = n >= 3;
  if (ok) {
    for (let k = 1; k < n; k++) s.setInbound(list[k].layer, list[k].face, 3);
    const one = [];
    const got = s.readyFaces(0, 1, one);
    ok = got === 1 && one[0].layer === list[0].layer && one[0].face === list[0].face;
    let r = 0;
    for (let k = 0; k < n; k++) r = Math.max(r, Math.abs(Math.hypot(list[k].cx, list[k].cy, list[k].cz) - RADII[list[k].layer]));
    check("ready face centroids sit just inside their layer radius", r < RADII[2] * 0.08 && Number.isFinite(r), `${n} faces ready after 30000 s, centroid radius within ${r.toFixed(1)} of R`);
  }
  check("readyFaces offers the face with the fewest inbound sails first", ok, `${n} ready faces`);
}
{
  const out = new Float64Array(3);
  const first = new Float64Array(3);
  const tg = { layer: 0, kind: 0, index: 0 };
  const period = 2 * Math.PI / sphere.spin;
  const samples = 48;
  let finite = true;
  let worstNode = 0;
  let worstEdgeLo = Infinity;
  let worstEdgeHi = 0;
  let worstReturn = 0;
  let moved = 0;
  for (let l = 0; l < sphere.layers.length; l++) {
    const L = sphere.layers[l];
    for (let kind = 0; kind <= 1; kind++) {
      const count = kind === 0 ? L.nodes.length / 3 : L.edges.length / 2;
      for (let i = 0; i < count; i++) {
        tg.layer = l;
        tg.kind = kind;
        tg.index = i;
        for (let k = 0; k <= samples; k++) {
          sphere.structurePos(tg, k / samples * period, out);
          if (!Number.isFinite(out[0]) || !Number.isFinite(out[1]) || !Number.isFinite(out[2])) finite = false;
          const r = Math.hypot(out[0], out[1], out[2]);
          if (kind === 0) worstNode = Math.max(worstNode, Math.abs(r - L.R));
          else {
            worstEdgeLo = Math.min(worstEdgeLo, r / L.R);
            worstEdgeHi = Math.max(worstEdgeHi, r / L.R);
          }
          if (k === 0) first.set(out);
          else if (k === samples / 2) moved = Math.max(moved, Math.hypot(out[0] - first[0], out[1] - first[1], out[2] - first[2]));
          else if (k === samples) worstReturn = Math.max(worstReturn, Math.hypot(out[0] - first[0], out[1] - first[1], out[2] - first[2]));
        }
      }
    }
  }
  check("structurePos is finite for every node and edge over a full rotation", finite);
  check("node radius within 0.5 of the layer radius over a full rotation", worstNode < 0.5, `worst ${worstNode.toExponential(2)}`);
  check("edge midpoints sit just inside the layer radius", worstEdgeLo > 0.9 && worstEdgeHi <= 1 + 1e-6, `radius / R in ${worstEdgeLo.toFixed(4)}..${worstEdgeHi.toFixed(4)}`);
  check("a full turn brings every point back where it started", worstReturn < 1e-6, `worst ${worstReturn.toExponential(2)}`);
  check("the structure actually turns", moved > 10, `a point moves up to ${moved.toFixed(1)} units over half a turn`);
}
{
  const s = new DysonSphere(RADII, 2, 5);
  const CYCLE_S = 24 * 3600 * 1.8;
  const t2 = Date.now();
  s.advance(CYCLE_S, ROCKET_RATE, SAIL_RATE);
  const ms = Date.now() - t2;
  console.log(`
advance over a full ${(CYCLE_S / 3600).toFixed(1)} h cycle in ${ms} ms:
  ${fmt(s)}`);
  const c = s.counts();
  check("a full cycle completes every node, frame and face", s.completion() === 1 && c.nodesDone === c.nodes && c.framesDone === c.frames && c.facesDone === c.faces);
  check("a complete sphere makes 11160 MW", Math.abs(s.powerMW() - 11160) < 1e-6, `${s.powerMW().toFixed(1)} MW`);
  check("a complete sphere has no next target", s.nextTarget() === null);
  check("a full cycle fast forward is cheap", ms < 500, `${ms} ms`);
  const before = s.counts().cells;
  s.deliverRocket({ layer: 0, kind: 0, index: 0 });
  s.absorb(0, 0);
  check("extra rockets and sails after completion are wasted, not applied", s.wasted === 1 && s.counts().cells === before && s.completion() === 1);
}
{
  const a = new DysonSphere(RADII, 2, 5);
  const b = new DysonSphere(RADII, 2, 5);
  let same = a.axis.every((v, i) => v === b.axis[i]);
  for (let k = 0; k < 300 && same; k++) {
    const ta = a.nextTarget();
    const tb = b.nextTarget();
    same = !!ta && !!tb && ta.layer === tb.layer && ta.kind === tb.kind && ta.index === tb.index;
    if (ta) a.deliverRocket(ta);
    if (tb) b.deliverRocket(tb);
  }
  check("the build order is deterministic for a seed", same);
}
console.log(`
${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
