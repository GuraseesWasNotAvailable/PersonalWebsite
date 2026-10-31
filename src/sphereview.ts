// The Dyson sphere drawn from the pure state in sphere.ts, in five draw
// calls: every node of every layer as one instanced sphere, every frame as
// one instanced cylinder, and each layer's shell as one triangle soup whose
// shader paints the cells. Nothing here decides anything. The structure's
// progress, fill and spin are read each frame and the geometry follows, and
// only the buffers whose numbers moved are sent to the GPU again.
import * as THREE from 'three'
import { mulberry32 } from './swarm'
import type { DysonSphere } from './sphere'
import { lightUniforms } from './worlds'

const NODE_RADIUS = 3.0
const FRAME_RADIUS = 0.8
const SHELL_INSET = 2 // the skin sits this far inside the frames
const CELL_SPACING = 9 // scene units between neighbouring cell centres, the same on every layer
const STEEL = new THREE.Color(0.4, 0.44, 0.5)
const PALE = new THREE.Color(0.78, 0.84, 0.95)
// Finished structure glows only a little: the sphere fills the view from
// the star and anything far past 1.0 blooms the page to white.
const DONE = new THREE.Color(0.66, 0.8, 1.02)
const Y = new THREE.Vector3(0, 1, 0)

// Dark steel while the rockets land, paling as the share grows, and the glow
// comes on over the last tenth so completion is an event you can see.
function ramp(prog: number, out: THREE.Color) {
  const p = prog < 0 ? 0 : prog > 1 ? 1 : prog
  out.copy(STEEL).lerp(PALE, p)
  const g = (p - 0.9) * 10
  if (g > 0) out.lerp(DONE, g * g * (3 - 2 * g))
  return out
}

// Nodes and frames: lit by the Sun at the origin, with a little wrap and a
// floor of space light so the night side of the structure still reads
// against the sky. A colour whose peak passes 1.0 is taken as emissive and
// bypasses the shading, so a finished node blooms whichever way it faces.
// The frames are scaled only along their own axis and a cylinder's side
// normals lie across that axis, so the plain matrix is the right normal
// transform here; the caps are renormalised.
const STRUCT_VERT = /* glsl */ `
varying vec3 vWorld; varying vec3 vNormal; varying vec3 vColor;
void main(){
  vec4 p = vec4(position, 1.0);
  vec3 n = normal;
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
    n = mat3(instanceMatrix) * n;
  #endif
  vec4 w = modelMatrix * p;
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * n);
  vColor = vec3(1.0);
  #ifdef USE_INSTANCING_COLOR
    vColor = instanceColor;
  #endif
  gl_Position = projectionMatrix * viewMatrix * w;
}`

const STRUCT_FRAG = /* glsl */ `
uniform vec3 uSun, uAmbient; uniform float uSpaceLight;
varying vec3 vWorld; varying vec3 vNormal; varying vec3 vColor;
void main(){
  // A collapsed instance can hand over a zero normal; never normalise it
  // into NaN, one NaN fragment turns the bloom pass black.
  vec3 n = vNormal / max(length(vNormal), 1e-6);
  vec3 toSun = normalize(-vWorld);
  float d = dot(n, toSun);
  float lit = max(d, 0.0);
  float wrap = 0.5 + 0.5 * d;
  vec3 shade = uAmbient + uSun * (0.7 * lit + 0.3 * wrap * wrap) + vec3(uSpaceLight);
  float peak = max(vColor.r, max(vColor.g, vColor.b));
  float glow = smoothstep(0.9, 1.2, peak);
  gl_FragColor = vec4(mix(vColor * shade, vColor, glow), 1.0);
}`

// The shell. Each face carries its fill, its barycentric corner weights and a
// pair (seed, n): the seed makes its cell order its own, n is how many cells
// sit along one edge. A face with nothing on it is folded to a point beyond
// the far plane so it costs no fragments at all.
const SHELL_VERT = /* glsl */ `
attribute float aFill; attribute vec3 aBary; attribute vec2 aCell;
varying float vFill; varying vec3 vBary; varying vec2 vCell;
void main(){
  vFill = aFill;
  vBary = aBary;
  vCell = aCell;
  gl_Position = aFill > 0.0 ? projectionMatrix * modelViewMatrix * vec4(position, 1.0) : vec4(0.0, 0.0, 2.0, 1.0);
}`

// Cells. The barycentric weights of the second and third corners, times n,
// are lattice coordinates over the face: the corners land on (0,0), (n,0)
// and (0,n), and every integer pair with i + j <= n is a cell centre. Mapped
// to the plane with a 60 degree basis the lattice is triangular, so the
// region nearest each centre is a regular hexagon. The point's small
// triangle has three centres at its corners and the nearest of them owns
// the point; the other two give the distance to the hexagon's border, since
// inside that triangle only their bisectors bound the cell. Each cell draws
// a fixed number from a hash of its index and the face seed and lights once
// the fill passes it, so the fraction lit tracks the fill while the order
// never changes between frames; the cell next in line charges up dimly as
// the fill nears its number, and snaps to full when it is passed.
const SHELL_FRAG = /* glsl */ `
uniform vec3 uSkin, uLit, uLine; uniform float uSkinAlpha;
varying float vFill; varying vec3 vBary; varying vec2 vCell;
const mat2 toPlane = mat2(1.0, 0.0, 0.5, 0.8660254);
float hash13(vec3 p){
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
void main(){
  if (vFill <= 0.0) discard;
  float n = floor(vCell.y + 0.5);
  float seed = vCell.x * 61.7;
  vec2 uv = vBary.yz * n;
  vec2 f = floor(uv);
  vec2 r = uv - f;
  vec2 c0 = r.x + r.y < 1.0 ? f : f + 1.0;
  vec2 c1 = f + vec2(1.0, 0.0);
  vec2 c2 = f + vec2(0.0, 1.0);
  vec2 P = toPlane * uv;
  vec2 e0 = P - toPlane * c0;
  vec2 e1 = P - toPlane * c1;
  vec2 e2 = P - toPlane * c2;
  float d0 = dot(e0, e0);
  float d1 = dot(e1, e1);
  float d2 = dot(e2, e2);
  vec2 cell = c0; float dn = d0; float dA = d1; float dB = d2;
  if (d1 < dn) { cell = c1; dn = d1; dA = d0; dB = d2; }
  if (d2 < dn) { cell = c2; dn = d2; dA = d0; dB = d1; }
  float border = 0.5 * min(dA - dn, dB - dn);
  float aa = fwidth(border);
  float tile = smoothstep(0.07 - aa, 0.07 + aa, border);
  float order = hash13(vec3(cell, seed));
  float cells = 0.5 * (n + 1.0) * (n + 2.0);
  float charge = clamp((vFill - order) * cells + 1.0, 0.0, 1.0);
  float lit = order <= vFill ? 1.0 : 0.4 * charge * charge;
  float tone = 0.85 + 0.3 * hash13(vec3(cell, seed + 7.3));
  // A cell is a dark translucent pane with a glowing rim once it is lit,
  // so a finished shell reads as a lattice, not a wall of light.
  float line = 1.0 - tile;
  vec3 pane = mix(uSkin, uLit * tone, lit);
  vec3 rim = mix(uSkin * 3.0, uLine, lit);
  vec3 col = mix(pane, rim, line);
  float alpha = mix(mix(uSkinAlpha, 0.11, lit), mix(0.14, 0.42, lit), line);
  gl_FragColor = vec4(col, alpha);
}`

export function buildSphereView(sphere: DysonSphere): { group: THREE.Group; update(t: number): void } {
  const group = new THREE.Group()
  const layers = sphere.layers
  const nl = layers.length
  let nNodes = 0
  let nFrames = 0
  for (let l = 0; l < nl; l++) {
    nNodes += layers[l].nodeProg.length
    nFrames += layers[l].edgeProg.length
  }

  const structMat = new THREE.ShaderMaterial({
    uniforms: { ...lightUniforms(), uSpaceLight: { value: 0.16 } },
    vertexShader: STRUCT_VERT,
    fragmentShader: STRUCT_FRAG,
  })
  // Instances cover the whole structure and the group turns; three's one-off
  // bounding sphere would cull them wrongly, so never cull.
  const inst = (geo: THREE.BufferGeometry, n: number) => {
    const m = new THREE.InstancedMesh(geo, structMat, Math.max(1, n))
    m.frustumCulled = false
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    for (let i = 0; i < m.count; i++) m.setColorAt(i, STEEL)
    const colours = m.instanceColor as THREE.InstancedBufferAttribute
    colours.setUsage(THREE.DynamicDrawUsage)
    group.add(m)
    return { mesh: m, colours }
  }
  const nodes = inst(new THREE.SphereGeometry(NODE_RADIUS, 14, 10), nNodes)
  // The cylinder spans y from 0 to 1 so a scale along y lays it from the
  // first node toward the second.
  const frames = inst(new THREE.CylinderGeometry(FRAME_RADIUS, FRAME_RADIUS, 1, 8, 1).translate(0, 0.5, 0), nFrames)

  // Where each frame starts and which way it points never changes, only how
  // far along it has been built, so the matrix of a frame at full length is
  // made once and its y column is shrunk by the progress each frame.
  const frameBase = new Float32Array(nFrames * 16)
  const nodeAt = new Float32Array(nNodes * 3)
  {
    const o3 = new THREE.Object3D()
    const dir = new THREE.Vector3()
    let k = 0
    let j = 0
    for (let l = 0; l < nl; l++) {
      const L = layers[l]
      const nd = L.nodes
      const R = L.R
      const Vl = L.nodeProg.length
      for (let i = 0; i < Vl; i++, j++) {
        nodeAt[j * 3] = nd[i * 3] * R
        nodeAt[j * 3 + 1] = nd[i * 3 + 1] * R
        nodeAt[j * 3 + 2] = nd[i * 3 + 2] * R
      }
      const El = L.edgeProg.length
      for (let e = 0; e < El; e++, k++) {
        const a = L.edges[e * 2] * 3
        const b = L.edges[e * 2 + 1] * 3
        dir.set(nd[b] - nd[a], nd[b + 1] - nd[a + 1], nd[b + 2] - nd[a + 2])
        const len = dir.length() * R
        if (len > 0) dir.normalize()
        else dir.copy(Y)
        o3.position.set(nd[a] * R, nd[a + 1] * R, nd[a + 2] * R)
        o3.quaternion.setFromUnitVectors(Y, dir)
        o3.scale.set(1, len, 1)
        o3.updateMatrix()
        o3.matrix.toArray(frameBase, k * 16)
      }
    }
  }

  // One shell per layer. The cell count along an edge follows the layer's
  // radius so cells are about CELL_SPACING across on every shell.
  const shellMat = new THREE.ShaderMaterial({
    uniforms: {
      // Lit cells stay below the bloom threshold: a finished sphere covers
      // most of the screen and anything brighter washes the page out.
      uSkin: { value: new THREE.Color(0.02, 0.04, 0.09) },
      uLit: { value: new THREE.Color(0.1, 0.2, 0.42) },
      uLine: { value: new THREE.Color(0.4, 0.62, 0.95) },
      uSkinAlpha: { value: 0.07 },
    },
    vertexShader: SHELL_VERT,
    fragmentShader: SHELL_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const rand = mulberry32(2718)
  const fills: THREE.BufferAttribute[] = []
  for (let l = 0; l < nl; l++) {
    const L = layers[l]
    const nd = L.nodes
    const Fl = L.faceFill.length
    const El = L.edgeProg.length
    let chord = 0
    for (let e = 0; e < El; e++) {
      const a = L.edges[e * 2] * 3
      const b = L.edges[e * 2 + 1] * 3
      chord += Math.hypot(nd[b] - nd[a], nd[b + 1] - nd[a + 1], nd[b + 2] - nd[a + 2])
    }
    chord = El > 0 ? chord / El : 1
    const n = Math.max(3, Math.round((chord * L.R) / CELL_SPACING))
    const r = L.R - SHELL_INSET
    const pos = new Float32Array(Fl * 9)
    const bary = new Float32Array(Fl * 9)
    const cell = new Float32Array(Fl * 6)
    for (let f = 0; f < Fl; f++) {
      const seed = rand()
      for (let k = 0; k < 3; k++) {
        const v = L.faces[f * 3 + k] * 3
        const vi = f * 3 + k
        pos[vi * 3] = nd[v] * r
        pos[vi * 3 + 1] = nd[v + 1] * r
        pos[vi * 3 + 2] = nd[v + 2] * r
        bary[vi * 3 + k] = 1
        cell[vi * 2] = seed
        cell[vi * 2 + 1] = n
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aBary', new THREE.BufferAttribute(bary, 3))
    g.setAttribute('aCell', new THREE.BufferAttribute(cell, 2))
    const fill = new THREE.BufferAttribute(new Float32Array(Fl * 3), 1)
    fill.setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('aFill', fill)
    fills.push(fill)
    group.add(new THREE.Mesh(g, shellMat))
  }

  // Scratch for update, and the progress each instance was last drawn with,
  // so a frame in which nothing landed uploads nothing.
  const axis = new THREE.Vector3()
  const mat = new THREE.Matrix4()
  const colour = new THREE.Color()
  const lastNode = new Float32Array(nNodes).fill(-1)
  const lastFrame = new Float32Array(nFrames).fill(-1)

  function update(t: number) {
    axis.set(sphere.axis[0], sphere.axis[1], sphere.axis[2])
    if (axis.lengthSq() > 0) axis.normalize()
    else axis.copy(Y)
    group.quaternion.setFromAxisAngle(axis, sphere.spin * t)

    let k = 0
    let dirty = false
    for (let l = 0; l < nl; l++) {
      const prog = layers[l].nodeProg
      const Vl = prog.length
      for (let i = 0; i < Vl; i++, k++) {
        const p = prog[i]
        if (p === lastNode[k]) continue
        lastNode[k] = p
        dirty = true
        const s = 0.3 + 0.7 * (p < 0 ? 0 : p > 1 ? 1 : p)
        mat.makeScale(s, s, s)
        mat.setPosition(nodeAt[k * 3], nodeAt[k * 3 + 1], nodeAt[k * 3 + 2])
        nodes.mesh.setMatrixAt(k, mat)
        nodes.mesh.setColorAt(k, ramp(p, colour))
      }
    }
    if (dirty) {
      nodes.mesh.instanceMatrix.needsUpdate = true
      nodes.colours.needsUpdate = true
    }

    k = 0
    dirty = false
    for (let l = 0; l < nl; l++) {
      const prog = layers[l].edgeProg
      const El = prog.length
      for (let e = 0; e < El; e++, k++) {
        const p = prog[e]
        if (p === lastFrame[k]) continue
        lastFrame[k] = p
        dirty = true
        const s = p < 0 ? 0 : p > 1 ? 1 : p
        mat.fromArray(frameBase, k * 16)
        const m = mat.elements
        if (s <= 0) {
          // Nothing built yet: collapse every axis so no cap is drawn.
          for (let q = 0; q < 12; q++) m[q] = 0
        } else {
          m[4] *= s
          m[5] *= s
          m[6] *= s
        }
        frames.mesh.setMatrixAt(k, mat)
        frames.mesh.setColorAt(k, ramp(p, colour))
      }
    }
    if (dirty) {
      frames.mesh.instanceMatrix.needsUpdate = true
      frames.colours.needsUpdate = true
    }

    for (let l = 0; l < nl; l++) {
      const src = layers[l].faceFill
      const attr = fills[l]
      const dst = attr.array as Float32Array
      const Fl = src.length
      let changed = false
      for (let f = 0; f < Fl; f++) {
        const v = src[f]
        const o = f * 3
        if (dst[o] === v) continue
        dst[o] = v
        dst[o + 1] = v
        dst[o + 2] = v
        changed = true
      }
      if (changed) attr.needsUpdate = true
    }
  }

  return { group, update }
}
