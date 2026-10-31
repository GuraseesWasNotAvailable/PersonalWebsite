// src/swarm.ts
var GM = 72e3;
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
    const steps = Math.max(1, Math.ceil(seconds / 20));
    const dt = seconds / steps;
    let delivered = 0;
    let sailBudget = 0;
    for (let s = 1; s <= steps; s++) {
      const t = s * dt;
      const want = Math.floor(rr * Math.max(0, t - ROCKET_FLIGHT_S));
      if (want > delivered) {
        this.deliverMany(want - delivered);
        delivered = want;
      }
      sailBudget += sr * dt;
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
  launch(pos, vel, target, sphere) {
    if (this.live >= this.N) return false;
    const { layer, kind, index } = target;
    if (!(layer >= 0 && layer < MAX_LAYER && layer === Math.floor(layer))) return false;
    if (kind !== 0 && kind !== 1) return false;
    if (!(index >= 0 && index < MAX_INDEX && index === Math.floor(index))) return false;
    if (sphere) {
      const L = sphere.layers[layer];
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
  step(dt, sphere, t) {
    if (!(dt > 0) || this.live === 0) return;
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
      sphere.structurePos(tg, t, aim);
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
      age[i] += dt;
      if (dist < ARRIVE_RADIUS || age[i] > MAX_FLIGHT_S) {
        if (dist >= ARRIVE_RADIUS) this.timedOut++;
        sphere.deliverRocket(tg);
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
      vx += (gx + tx) * dt;
      vy += (gy + ty) * dt;
      vz += (gz + tz) * dt;
      vel[o] = vx;
      vel[o + 1] = vy;
      vel[o + 2] = vz;
      pos[o] = px + vx * dt;
      pos[o + 1] = py + vy * dt;
      pos[o + 2] = pz + vz * dt;
    }
  }
  // Rockets in flight.
  count() {
    return this.live;
  }
};

// tools/rockets_test.ts
var failures = 0;
var check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};
var pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] : NaN;
console.log(`rockets cruise at ${ROCKET_SPEED}, thrust ${ROCKET_THRUST}, keep out ${KEEP_OUT} round the star`);
{
  const sphere = new DysonSphere([215, 272, 330], 2, 5);
  const rockets = new Rockets(400);
  const R0 = 910;
  const vc = Math.sqrt(GM / R0);
  const omega = vc / R0;
  const dt = 0.05;
  const T = 1200;
  const EVERY = 4;
  const steps = Math.round(T / dt);
  const launchStep = Math.round(EVERY / dt);
  const launchedAt = new Float64Array(rockets.N);
  const wasAlive = new Uint8Array(rockets.N);
  const flights = [];
  let minR = Infinity;
  let maxSpeed = 0;
  let nonFinite = 0;
  let refused = 0;
  let noTarget = 0;
  let maxFlying = 0;
  const pos = [0, 0, 0];
  const vel = [0, 0, 0];
  let t = 0;
  const t0 = Date.now();
  for (let step = 0; step < steps; step++) {
    if (step % launchStep === 0) {
      const th = omega * t;
      const c2 = Math.cos(th);
      const s = Math.sin(th);
      pos[0] = R0 * c2;
      pos[1] = 0;
      pos[2] = R0 * s;
      vel[0] = -vc * s - 18 * c2;
      vel[1] = 0;
      vel[2] = vc * c2 - 18 * s;
      const tg = sphere.nextTarget();
      if (!tg) noTarget++;
      else {
        for (let i = 0; i < rockets.N; i++) wasAlive[i] = rockets.alive[i];
        if (rockets.launch(pos, vel, tg)) {
          for (let i = 0; i < rockets.N; i++) if (rockets.alive[i] && !wasAlive[i]) launchedAt[i] = t;
        } else {
          refused++;
          sphere.cancelRocket(tg);
        }
      }
    }
    for (let i = 0; i < rockets.N; i++) wasAlive[i] = rockets.alive[i];
    t += dt;
    rockets.step(dt, sphere, t);
    const flying = rockets.count();
    if (flying > maxFlying) maxFlying = flying;
    for (let i = 0; i < rockets.N; i++) {
      if (wasAlive[i] && !rockets.alive[i]) flights.push(t - launchedAt[i]);
      if (!rockets.alive[i]) continue;
      const o = i * 3;
      const r = Math.hypot(rockets.pos[o], rockets.pos[o + 1], rockets.pos[o + 2]);
      const v = Math.hypot(rockets.vel[o], rockets.vel[o + 1], rockets.vel[o + 2]);
      if (!Number.isFinite(r) || !Number.isFinite(v)) nonFinite++;
      if (r < minR) minR = r;
      if (v > maxSpeed) maxSpeed = v;
    }
    if (step > 0 && step % Math.round(240 / dt) === 0) {
      const c2 = sphere.counts();
      console.log(`  t=${Math.round(t).toString().padStart(4)}s launched ${rockets.launched} arrived ${rockets.arrived} flying ${rockets.count()} | nodes ${c2.nodesDone}/${c2.nodes} frames ${c2.framesDone}/${c2.frames} | closest to star so far ${minR.toFixed(1)}`);
    }
  }
  const ms = Date.now() - t0;
  flights.sort((a, b) => a - b);
  const c = sphere.counts();
  console.log(`
${steps} steps in ${ms} ms (${(ms / steps * 1e3).toFixed(1)} us/step)`);
  console.log(`launched ${rockets.launched}, arrived ${rockets.arrived}, still in flight ${rockets.count()}, at most ${maxFlying} in the air at once, ${refused} launches refused, ${noTarget} with no target, ${rockets.timedOut} timed out`);
  console.log(`flight time p10/p50/p90 = ${pct(flights, 0.1).toFixed(1)} / ${pct(flights, 0.5).toFixed(1)} / ${pct(flights, 0.9).toFixed(1)} s, min ${flights[0]?.toFixed(1)} max ${flights[flights.length - 1]?.toFixed(1)}`);
  console.log(`closest any rocket came to the star: ${minR.toFixed(1)} (must stay above 40); top speed seen ${maxSpeed.toFixed(1)}; non finite samples ${nonFinite}`);
  console.log(`sphere: ${JSON.stringify(c)}, completion ${(sphere.completion() * 100).toFixed(2)}%, wasted rockets ${sphere.wasted}`);
  check("every fourth second launched a rocket", rockets.launched === Math.ceil(T / EVERY) && refused === 0 && noTarget === 0, `${rockets.launched} launched`);
  check("arrived plus flying accounts for every launch", rockets.arrived + rockets.count() === rockets.launched && flights.length === rockets.arrived && rockets.lost === 0, `${rockets.lost} lost`);
  check("flight times all between 60 and 130 s", flights.length > 0 && flights[0] >= 60 && flights[flights.length - 1] <= 130, `${flights[0]?.toFixed(1)} to ${flights[flights.length - 1]?.toFixed(1)} s`);
  check("no rocket came within 40 of the star", minR > 40, `${minR.toFixed(1)}`);
  check("no NaN or Infinity in flight", nonFinite === 0);
  check("no rocket needed the flight timeout", rockets.timedOut === 0);
  check("every landed rocket counts on the sphere", c.nodesDone * sphere.NODE_COST + sphere.layers[0].nodeProg.reduce((s, v) => s + (v < 1 ? Math.round(v * sphere.NODE_COST) : 0), 0) === rockets.arrived && sphere.wasted === 0, `${rockets.arrived} landed, ${c.nodesDone} nodes done`);
}
{
  const sphere = new DysonSphere([215, 272, 330], 2, 5);
  const rockets = new Rockets(4);
  const launch = [910, 0, 0];
  const vc = Math.sqrt(GM / 910);
  const out = new Float64Array(3);
  const tg = { layer: 0, kind: 0, index: 0 };
  let best = 0;
  let bestMiss = Infinity;
  let bestDist = 0;
  for (let i = 0; i < sphere.layers[0].nodes.length / 3; i++) {
    tg.index = i;
    sphere.structurePos(tg, 0, out);
    const dx = out[0] - launch[0];
    const dy = out[1] - launch[1];
    const dz = out[2] - launch[2];
    const d = Math.hypot(dx, dy, dz);
    const s = -(launch[0] * dx + launch[1] * dy + launch[2] * dz) / d;
    const miss = Math.hypot(launch[0] + s / d * dx, launch[1] + s / d * dy, launch[2] + s / d * dz);
    if (s > 0 && s < d && miss < bestMiss) {
      bestMiss = miss;
      best = i;
      bestDist = d;
    }
  }
  tg.index = best;
  console.log(`
night side launch at node ${best} of the inner shell, ${bestDist.toFixed(0)} away, whose straight line would pass ${bestMiss.toFixed(1)} from the star`);
  const ok = rockets.launch(launch, [18, 0, -vc], tg);
  const dt = 0.05;
  let t = 0;
  let minR = Infinity;
  let maxR = 0;
  let turned = -1;
  while (rockets.count() > 0 && t < 400) {
    t += dt;
    rockets.step(dt, sphere, t);
    if (!rockets.alive[0]) break;
    const r = Math.hypot(rockets.pos[0], rockets.pos[1], rockets.pos[2]);
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    const vr = (rockets.pos[0] * rockets.vel[0] + rockets.pos[1] * rockets.vel[1] + rockets.pos[2] * rockets.vel[2]) / r;
    if (turned < 0 && vr < 0) turned = t;
  }
  const landed = rockets.arrived === 1;
  console.log(`  launched ${ok}, turned round after ${turned.toFixed(1)} s having climbed to ${maxR.toFixed(1)}, landed ${landed} after ${t.toFixed(1)} s, closest to the star ${minR.toFixed(1)}`);
  console.log(`  node progress now ${sphere.layers[0].nodeProg[best].toFixed(4)} (one rocket of ${sphere.NODE_COST})`);
  check("the night side rocket landed", landed && ok, `${t.toFixed(1)} s`);
  check("it went round the star, not through it", minR > KEEP_OUT - 25, `closest ${minR.toFixed(1)}, keep out ${KEEP_OUT}`);
  check("the detour still lands inside 200 s", t < 200, `${t.toFixed(1)} s`);
  check("the landing counted once on its node", Math.abs(sphere.layers[0].nodeProg[best] - 1 / sphere.NODE_COST) < 1e-6);
}
{
  const rockets = new Rockets(2);
  const good = { layer: 0, kind: 0, index: 1 };
  const r1 = rockets.launch([910, 0, 0], [0, 0, 9], { layer: -1, kind: 0, index: 1 });
  const r2 = rockets.launch([910, 0, 0], [0, 0, 9], { layer: 0, kind: 0, index: 1e5 });
  const r3 = rockets.launch([NaN, 0, 0], [0, 0, 9], good);
  const afterBad = rockets.count();
  const r4 = rockets.launch([910, 0, 0], [0, 0, 9], good);
  const r5 = rockets.launch([910, 0, 0], [0, 0, 9], good);
  const r6 = rockets.launch([910, 0, 0], [0, 0, 9], good);
  check("bad layer, bad index and NaN position are refused", !r1 && !r2 && !r3 && afterBad === 0);
  check("a full pool refuses the next launch", r4 && r5 && !r6 && rockets.count() === 2);
  check("the target code packs as the HUD decodes it", rockets.target[0] === 1 && rockets.target[1] === 1);
}
{
  const sphere = new DysonSphere([215, 272, 330], 2, 5);
  const V = sphere.layers[0].nodes.length / 3;
  const E = sphere.layers[0].edges.length / 2;
  const offMesh = [
    { layer: 0, kind: 0, index: V + 8 },
    { layer: 0, kind: 1, index: E + 80 },
    { layer: sphere.layers.length, kind: 0, index: 0 }
  ];
  const onMesh = [
    { layer: 0, kind: 0, index: V - 1 },
    { layer: 0, kind: 1, index: E - 1 },
    { layer: sphere.layers.length - 1, kind: 0, index: 0 }
  ];
  console.log(`
off mesh targets against a sphere of ${sphere.layers.length} layers, ${V} nodes and ${E} edges each`);
  const pad = new Rockets(8);
  const refused = offMesh.map((tg) => !pad.launch([910, 0, 0], [-18, 0, 8.9], tg, sphere));
  const accepted = onMesh.map((tg) => pad.launch([910, 0, 0], [-18, 0, 8.9], tg, sphere));
  console.log(`  with the sphere: off mesh refused ${JSON.stringify(refused)}, the last real node, edge and layer accepted ${JSON.stringify(accepted)}`);
  check("given the sphere, the silo refuses every off mesh target", refused.every((r) => r));
  check("given the sphere, the last real node, edge and layer are still accepted", accepted.every((a) => a) && pad.count() === 3 && pad.lost === 0);
  const blind = new Rockets(8);
  const launched = offMesh.map((tg) => blind.launch([910, 0, 0], [-18, 0, 8.9], tg));
  const before = JSON.stringify(sphere.counts());
  const flying = blind.count();
  blind.step(0.05, sphere, 0.05);
  let moved = 0;
  for (let i = 0; i < 3; i++) if (blind.pos[i * 3] !== 910 || blind.pos[i * 3 + 1] !== 0 || blind.pos[i * 3 + 2] !== 0) moved++;
  console.log(`  without it: launched ${JSON.stringify(launched)}, ${flying} in the pool, after one step ${blind.count()} flying, ${blind.lost} lost, ${blind.arrived} arrived, ${blind.timedOut} timed out, ${moved} moved, sphere wasted ${sphere.wasted}`);
  check("without the sphere the packing lets them through", launched.every((l) => l) && flying === 3);
  check("one step drops all three without flying them", blind.count() === 0 && blind.lost === 3 && moved === 0);
  check("a dropped rocket is not a landing", blind.arrived === 0 && blind.timedOut === 0 && sphere.wasted === 0 && JSON.stringify(sphere.counts()) === before);
  check("dropped slots go back to the pool", blind.launch([910, 0, 0], [-18, 0, 8.9], onMesh[0]) && blind.count() === 1 && blind.target.filter((c) => c >= 0).length === 1);
}
console.log(`
${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
