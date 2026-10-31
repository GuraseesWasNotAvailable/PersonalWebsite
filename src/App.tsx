import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { Swarm, QUEUED, RESERVED, TRANSIT, mulberry32, type LaneSpec } from './swarm'
import { Surface, SPIN_RATE } from './surface'
import { buildGround } from './structures'
import { makePlanet, ATMOSPHERE_FRAG, ATMOSPHERE_VERT, NOISE_GLSL, PLANET_FRAG, PLANET_VERT } from './planet'
import { BELT_SPECS, buildSystem, positionOf, spinOf, type Body } from './system'
import { AMBIENT_INTENSITY, AMBIENT_LIGHT, SUN_INTENSITY, SUN_LIGHT, asteroidBelt, lightUniforms, ringMaterial, trojans, worldMaterial, type Belt } from './worlds'
import { Economy } from './economy'
import { DysonSphere, type Target } from './sphere'
import { Rockets } from './rockets'
import { buildSphereView } from './sphereview'

// ---------------------------------------------------------------------------
// One scene: our solar system, with a Dyson swarm gathering around the Sun,
// after Dyson Sphere Program. Every world is where the real sky has it today
// (system.ts), on orbits compressed so Neptune fits beside Mercury. Earth is
// the launch world: haulers feed factories, factories fold sails onto belts,
// belts fill the racks of electromagnetic rails, and each rail fires when the
// launch direction its orbit needs rises above its horizon (surface.ts). A
// fired sail leaves the muzzle with a real velocity, falls toward the Sun
// under gravity and steers onto its lane (swarm.ts). Click a world to fly
// there, click Earth to land, click a sail or a bot to ride along, Esc to
// pull back. Drag to orbit, scroll to zoom; it drifts when idle.
// ---------------------------------------------------------------------------

const LINKS = [
  { label: 'robo dir', href: 'https://datasets.gurasees.com' },
  { label: 'Gantry', href: '/gantry.html' },
  { label: 'X', href: 'https://x.com/gurasees0' },
  { label: 'LinkedIn', href: 'https://www.linkedin.com/in/gurasees-singh-dhanoa-9aa7a221b/' },
  { label: 'GitHub', href: 'https://github.com/GuraseesWasNotAvailable' },
]

const LANES: LaneSpec[] = [
  { r: 190, tilt: [0.9, 0.3], n: 2200 },
  { r: 245, tilt: [-0.5, 0.9], n: 2400 },
  { r: 300, tilt: [0.25, -1.1], n: 2600 },
]
const SUN_R = 10
const TIME_SCALE = 1.8 // simulation seconds per real second
const WARMUP_S = 45 // seconds simulated before the first frame, so streams are already flowing
const SHELL_RADII = [215, 272, 330] // between the sail lanes
// The world has been running since this moment; a visitor arrives at the
// stage of construction the clock says, and the build restarts each cycle.
const EPOCH_S = Date.UTC(2026, 9, 31) / 1000
const CYCLE_REAL_S = 24 * 3600

// --- procedural textures ----------------------------------------------------

function radialTexture(stops: Array<[number, string]>, size = 256) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  for (const [offset, colour] of stops) grd.addColorStop(offset, colour)
  g.fillStyle = grd
  g.fillRect(0, 0, size, size)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function streakTexture(w = 1024, h = 32) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  const across = g.createLinearGradient(0, 0, w, 0)
  across.addColorStop(0, 'rgba(255,200,140,0)')
  across.addColorStop(0.5, 'rgba(255,245,225,0.95)')
  across.addColorStop(1, 'rgba(255,200,140,0)')
  g.fillStyle = across
  g.fillRect(0, 0, w, h)
  g.globalCompositeOperation = 'destination-in'
  const down = g.createLinearGradient(0, 0, 0, h)
  down.addColorStop(0, 'rgba(0,0,0,0)')
  down.addColorStop(0.5, 'rgba(0,0,0,1)')
  down.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = down
  g.fillRect(0, 0, w, h)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

// One solar sail: a square film with a bright rim and a cross of struts.
function sailTexture(size = 64) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const grd = g.createLinearGradient(0, 0, size, size)
  grd.addColorStop(0, '#8fb0ff')
  grd.addColorStop(0.5, '#4f7af2')
  grd.addColorStop(1, '#bcd3ff')
  g.fillStyle = grd
  g.fillRect(2, 2, size - 4, size - 4)
  g.strokeStyle = 'rgba(210,228,255,0.95)'
  g.lineWidth = 3
  g.strokeRect(2.5, 2.5, size - 5, size - 5)
  g.lineWidth = 2
  g.beginPath()
  g.moveTo(size / 2, 2)
  g.lineTo(size / 2, size - 2)
  g.moveTo(2, size / 2)
  g.lineTo(size - 2, size / 2)
  g.stroke()
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

// --- the Sun's shaders --------------------------------------------------------

const SUN_VERT = /* glsl */ `
varying vec3 vNormal; varying vec3 vPos; varying vec3 vView;
void main(){
  vNormal = normalize(normalMatrix * normal);
  vPos = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`

// A G2 star: a white photosphere with granulation, orange in the cells.
const SUN_FRAG = /* glsl */ `
uniform float uTime;
varying vec3 vNormal; varying vec3 vPos; varying vec3 vView;
${NOISE_GLSL}
void main(){
  vec3 p = normalize(vPos);
  float n = fbm(p * 3.2 + vec3(uTime * 0.06, uTime * 0.04, 0.0));
  float cells = fbm(p * 9.0 - vec3(0.0, uTime * 0.1, uTime * 0.07));
  float heat = 0.55 + 0.35 * n + 0.25 * cells;
  vec3 col = mix(vec3(1.0, 0.62, 0.22), vec3(1.0, 0.97, 0.9), clamp(heat, 0.0, 1.0));
  float limb = pow(max(dot(vNormal, vView), 0.0), 0.45);
  col *= 0.75 + 0.6 * limb;
  gl_FragColor = vec4(col * 1.45, 1.0);
}`

const CORONA_FRAG = /* glsl */ `
uniform float uTime;
varying vec3 vNormal; varying vec3 vPos; varying vec3 vView;
${NOISE_GLSL}
void main(){
  float rim = 1.0 - max(dot(vNormal, vView), 0.0);
  float flicker = 0.85 + 0.15 * fbm(normalize(vPos) * 4.0 + vec3(uTime * 0.2));
  float a = pow(rim, 2.6) * flicker;
  vec3 col = mix(vec3(1.0, 0.55, 0.2), vec3(1.0, 0.93, 0.8), pow(rim, 4.0));
  gl_FragColor = vec4(col * 1.6, a * 0.9);
}`

// --- the camera's subject ----------------------------------------------------

type Focus =
  | { kind: 'star' }
  | { kind: 'ground'; body: THREE.Vector3 }
  | { kind: 'sail'; i: number }
  | { kind: 'bot'; b: number }
  | { kind: 'body'; b: number }
  | { kind: 'rocket'; r: number }

const LIMITS = {
  star: { min: 40, max: 16000 },
  ground: { min: 0.7, max: 700 },
  sail: { min: 1.0, max: 300 },
  bot: { min: 0.5, max: 60 },
  rocket: { min: 1.5, max: 300 },
}

export type Counts = {
  orbit: number
  transit: number
  ground: number
  absorbing: number
  launched: number
  absorbed: number
  sites: number
  guns: number
  inWindow: number
  firing: number
  racked: number
  onBelts: number
  built: number
  rocketsFired: number
  rocketsFlying: number
  powerMW: number
  completion: number
  nodes: number
  nodesDone: number
  frames: number
  framesDone: number
  faces: number
  facesDone: number
  cells: number
  supplyMW: number
  demandMW: number
  satisfaction: number
}

type Sim = { counts: () => Counts; focusText: () => string; land: () => void; dispose: () => void }

type Node = {
  body: Body
  tilt: THREE.Group
  spin: THREE.Group
  mesh: THREE.Mesh
  mat: THREE.ShaderMaterial | null // the world shader, or null for Earth
  ring: THREE.ShaderMaterial | null
  tag: HTMLButtonElement
  pos: THREE.Vector3
}

function startScene(canvas: HTMLCanvasElement, tags: HTMLElement, reduceMotion: boolean): Sim {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05

  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#02040f')
  const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.5, 60000)
  camera.position.set(250, 95, 330)

  // The composer's own target: sized to the drawing buffer, pixel ratio
  // included. A custom multisampled target drew into a quarter of the canvas
  // on Intel graphics at a 1.5 display scale, so none of that here.
  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.6, 0.5, 0.72))
  composer.addPass(new OutputPass())

  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.dampingFactor = 0.06
  controls.minDistance = LIMITS.star.min
  controls.maxDistance = LIMITS.star.max
  controls.zoomSpeed = 0.9
  controls.rotateSpeed = 0.6
  controls.autoRotate = !reduceMotion
  controls.autoRotateSpeed = 0.35
  let idleTimer = 0
  controls.addEventListener('start', () => {
    controls.autoRotate = false
    window.clearTimeout(idleTimer)
  })
  controls.addEventListener('end', () => {
    if (reduceMotion) return
    idleTimer = window.setTimeout(() => (controls.autoRotate = true), 4000)
  })

  // The Sun lights everything. No falloff, so Neptune is still a world and not a dot of black.
  scene.add(new THREE.PointLight(SUN_LIGHT, SUN_INTENSITY, 0, 0))
  scene.add(new THREE.AmbientLight(AMBIENT_LIGHT, AMBIENT_INTENSITY))

  const dot = radialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.25, 'rgba(255,255,255,0.9)'],
    [1, 'rgba(255,255,255,0)'],
  ])
  const glow = radialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.12, 'rgba(255,230,200,0.8)'],
    [0.4, 'rgba(255,170,90,0.25)'],
    [1, 'rgba(200,90,40,0)'],
  ])
  const blueGlow = radialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.12, 'rgba(200,220,255,0.8)'],
    [0.4, 'rgba(90,130,255,0.25)'],
    [1, 'rgba(40,70,200,0)'],
  ])

  // Far stars, outside the whole system.
  const starLayer = (n: number, rMin: number, rMax: number, size: number, colour: string, opacity: number) => {
    const p = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const r = rMin + Math.random() * (rMax - rMin)
      const u = Math.random() * 2 - 1
      const phi = Math.random() * Math.PI * 2
      const s = Math.sqrt(1 - u * u)
      p.set([r * s * Math.cos(phi), r * u, r * s * Math.sin(phi)], i * 3)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(p, 3))
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size, sizeAttenuation: false, map: dot, color: colour, transparent: true, opacity, depthWrite: false })))
  }
  starLayer(6000, 26000, 34000, 1.6, '#b9c8ff', 0.5)
  starLayer(1400, 24000, 30000, 2.4, '#dbe4ff', 0.7)
  starLayer(180, 22000, 26000, 3.6, '#ffffff', 0.9)

  // The Sun.
  const star = new THREE.Group()
  const sunUniforms = { uTime: { value: 0 } }
  const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(SUN_R, 96, 96), new THREE.ShaderMaterial({ uniforms: sunUniforms, vertexShader: SUN_VERT, fragmentShader: SUN_FRAG }))
  star.add(sunMesh)
  star.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(SUN_R * 1.45, 96, 96),
      new THREE.ShaderMaterial({ uniforms: sunUniforms, vertexShader: SUN_VERT, fragmentShader: CORONA_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide }),
    ),
  )
  const sprite = (tex: THREE.Texture, sx: number, sy: number, colour: string, opacity: number) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: colour, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }))
    s.scale.set(sx, sy, 1)
    star.add(s)
  }
  sprite(glow, 120, 120, '#ffd9a6', 0.32)
  sprite(glow, 340, 340, '#ffb070', 0.07)
  sprite(streakTexture(), 1500, 9, '#ffecd2', 0.1)
  scene.add(star)

  // The system as the real sky has it today, plus the swarm's own random stream.
  const rand = mulberry32(2026)
  const bodies = buildSystem(new Date(), rand)
  const earthIndex = bodies.findIndex((b) => b.name === 'Earth')
  const earth = bodies[earthIndex]
  earth.spin0 = 0 // the ground simulation counts its day from zero
  const PLANET_R = earth.R

  // Earth: a tilted group that moves on its orbit, a spinning group inside it
  // carrying the surface and everything built on it.
  const planet = new THREE.Group()
  const spin = new THREE.Group()
  const tex = makePlanet(3)
  const aniso = renderer.capabilities.getMaxAnisotropy()
  tex.height.anisotropy = aniso
  tex.clouds.anisotropy = aniso
  const lin = (hex: string) => new THREE.Color(hex)
  const planetUniforms = {
    ...lightUniforms(),
    uData: { value: tex.height },
    uSunDir: { value: new THREE.Vector3(-1, 0, 0) },
    uDeep: { value: lin('#081c5a') },
    uShallow: { value: lin('#1a5cb4') },
    uShore: { value: lin('#c4b278') },
    uLow: { value: lin('#34703a') },
    uHigh: { value: lin('#806e48') },
    uPeak: { value: lin('#a0a0a4') },
    uIce: { value: lin('#e8f0ff') },
    uCity: { value: lin('#ffcd82') },
  }
  const surface = new THREE.Mesh(new THREE.SphereGeometry(PLANET_R, 96, 64), new THREE.ShaderMaterial({ uniforms: planetUniforms, vertexShader: PLANET_VERT, fragmentShader: PLANET_FRAG }))
  spin.add(surface)
  const cloudMat = new THREE.MeshLambertMaterial({ map: tex.clouds, transparent: true, depthWrite: false, opacity: 0.95 })
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(PLANET_R * 1.025, 64, 48), cloudMat)
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(PLANET_R * 1.09, 64, 48),
    new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color('#5a8cff') } },
      vertexShader: ATMOSPHERE_VERT,
      fragmentShader: ATMOSPHERE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  )
  planet.add(spin, clouds, atmosphere)
  scene.add(planet)

  const frameOf = (Q: number[]) => {
    const m = new THREE.Matrix4()
    m.set(Q[0], Q[1], Q[2], 0, Q[3], Q[4], Q[5], 0, Q[6], Q[7], Q[8], 0, 0, 0, 0, 1)
    return new THREE.Quaternion().setFromRotationMatrix(m)
  }
  planet.quaternion.copy(frameOf(earth.Q))

  // Every other world: a tilted group, a spinning sphere with its look, rings
  // where there are rings, and a tag to click.
  const nodes: Node[] = []
  const makeTag = (name: string, onClick: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'tag'
    b.textContent = name
    b.addEventListener('click', onClick)
    tags.appendChild(b)
    return b
  }
  bodies.forEach((body, bi) => {
    let tilt: THREE.Group
    let sp: THREE.Group
    let mesh: THREE.Mesh
    let mat: THREE.ShaderMaterial | null = null
    let ring: THREE.ShaderMaterial | null = null
    if (bi === earthIndex) {
      tilt = planet
      sp = spin
      mesh = surface
    } else {
      tilt = new THREE.Group()
      tilt.quaternion.copy(frameOf(body.Q))
      sp = new THREE.Group()
      tilt.add(sp)
      const segs = body.R > 20 ? 96 : body.R > 6 ? 64 : 32
      if (body.look === 'comet') {
        mesh = new THREE.Mesh(new THREE.SphereGeometry(body.R, 16, 12), new THREE.MeshBasicMaterial({ color: '#8d99ab' }))
        const coma = new THREE.Sprite(new THREE.SpriteMaterial({ map: blueGlow, color: '#cfe4ff', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }))
        coma.name = 'coma'
        tilt.add(coma)
      } else {
        mat = worldMaterial(body.look === 'earth' ? { c0: '#fff', c1: '#fff', c2: '#fff', c3: '#fff', bands: 0, turb: 0, crater: 0, capSize: 0, seed: 0 } : body.look)
        mesh = new THREE.Mesh(new THREE.SphereGeometry(body.R, segs, Math.round(segs * 0.66)), mat)
      }
      sp.add(mesh)
      if (body.rings) {
        ring = ringMaterial(body.rings)
        ring.uniforms.uR.value = body.R
        const geo = new THREE.RingGeometry(body.rings.inner, body.rings.outer, 180, 2)
        geo.rotateX(-Math.PI / 2)
        tilt.add(new THREE.Mesh(geo, ring))
      }
      scene.add(tilt)
    }
    const tag = makeTag(body.name, () => (bi === earthIndex ? land() : flyTo(bi)))
    nodes.push({ body, tilt, spin: sp, mesh, mat, ring, tag, pos: new THREE.Vector3() })
  })
  const nodeOfMesh = new Map<THREE.Object3D, number>()
  nodes.forEach((n, i) => nodeOfMesh.set(n.mesh, i))

  // The belts: the main belt, Jupiter's Trojans, the Kuiper belt.
  const jupiter = bodies.find((b) => b.name === 'Jupiter')!
  const belts: Array<{ belt: Belt; attr: THREE.BufferAttribute }> = []
  const addBelt = (belt: Belt, colour: string, size: number) => {
    const g = new THREE.BufferGeometry()
    const attr = new THREE.BufferAttribute(belt.pos, 3)
    attr.setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('position', attr)
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ size, sizeAttenuation: false, color: colour, transparent: true, opacity: 0.8, depthWrite: false }))
    pts.frustumCulled = false
    scene.add(pts)
    belts.push({ belt, attr })
  }
  addBelt(asteroidBelt(BELT_SPECS.asteroids, rand), '#bdb2a0', 1.7)
  addBelt(trojans(jupiter, BELT_SPECS.trojans.n, BELT_SPECS.trojans.spread, BELT_SPECS.trojans.eMax, BELT_SPECS.trojans.iMax, rand), '#aaa49b', 1.6)
  addBelt(asteroidBelt(BELT_SPECS.kuiper, rand), '#9fb3cc', 1.7)

  // The comet's tail: points streaming away from the Sun, longer the closer it is.
  const TAIL = 110
  const cometIndex = bodies.findIndex((b) => b.look === 'comet')
  const tailPos = new Float32Array(TAIL * 3)
  const tailCol = new Float32Array(TAIL * 3)
  const tailGeo = new THREE.BufferGeometry()
  const tailAttr = new THREE.BufferAttribute(tailPos, 3)
  tailAttr.setUsage(THREE.DynamicDrawUsage)
  tailGeo.setAttribute('position', tailAttr)
  for (let k = 0; k < TAIL; k++) {
    const f = Math.pow(1 - k / TAIL, 1.6)
    tailCol[k * 3] = 0.55 * f
    tailCol[k * 3 + 1] = 0.75 * f
    tailCol[k * 3 + 2] = 1.0 * f
  }
  tailGeo.setAttribute('color', new THREE.BufferAttribute(tailCol, 3))
  const tail = new THREE.Points(tailGeo, new THREE.PointsMaterial({ size: 2.4, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }))
  tail.frustumCulled = false
  if (cometIndex >= 0) scene.add(tail)
  const tailJitter = new Float32Array(TAIL * 2)
  for (let k = 0; k < TAIL * 2; k++) tailJitter[k] = rand() - 0.5

  // The swarm and the ground that feeds it; run ahead so the sky and the
  // belts are already busy on the first frame. Earth starts exactly where the
  // ephemeris has it, with its real velocity, and the physics takes it from there.
  const e0 = new Float64Array(3)
  const v0 = new Float64Array(3)
  positionOf(earth, 0, null, e0, v0)
  const swarm = new Swarm(LANES, e0, v0, PLANET_R, 7)
  const ground = new Surface(PLANET_R, swarm, earth.Q, 11)

  // The engine: an economy on Earth, the sphere the rockets build, the
  // rockets in flight. Fast forwarded to where the clock says the build is.
  const economy = new Economy(ground.sites.length, mulberry32(11))
  const sphere = new DysonSphere(SHELL_RADII, 2, 5)
  const rockets = new Rockets(400)
  ground.attach(economy, sphere, rockets)
  // ?t=<hours> looks at the build at a chosen point of the cycle instead.
  const tParam = new URLSearchParams(location.search).get('t')
  const elapsedReal = tParam !== null ? Math.max(0, Number(tParam)) * 3600 : (((Date.now() / 1000 - EPOCH_S) % CYCLE_REAL_S) + CYCLE_REAL_S) % CYCLE_REAL_S
  economy.advance(elapsedReal * TIME_SCALE, 3.6, 30)
  const r0 = economy.rates()
  sphere.advance(elapsedReal * TIME_SCALE, r0.rocketsPerSec, r0.sailsPerSec)

  // Absorption: a face whose frames are done pulls in the nearest orbiting
  // sails, a few at a time; each sail's target follows the turning sphere.
  const faceKey = (layer: number, face: number) => layer * 100000 + face
  const tgt: Target = { layer: 0, kind: 0, index: 0 }
  const cpos = new Float64Array(3)
  const centroidOf = (key: number, out: Float32Array, o: number) => {
    const layer = Math.floor(key / 100000)
    const face = key % 100000
    const L = sphere.layers[layer]
    out[o] = out[o + 1] = out[o + 2] = 0
    for (let k = 0; k < 3; k++) {
      tgt.layer = layer
      tgt.kind = 0
      tgt.index = L.faces[face * 3 + k]
      sphere.structurePos(tgt, swarm.time, cpos)
      out[o] += cpos[0] / 3
      out[o + 1] += cpos[1] / 3
      out[o + 2] += cpos[2] / 3
    }
  }
  const onAbsorbed = (_i: number, key: number) => {
    const layer = Math.floor(key / 100000)
    const face = key % 100000
    sphere.absorb(layer, face)
    sphere.setInbound(layer, face, -1)
  }
  // Up to sixteen faces draw sails at once, ten inbound each, which absorbs
  // about half of what the rails launch, so the swarm stays dense while the
  // shells fill.
  const READY_FACES = 16
  const INBOUND_PER_FACE = 10
  const ready: Array<{ layer: number; face: number; cx: number; cy: number; cz: number }> = []
  for (let k = 0; k < READY_FACES; k++) ready.push({ layer: 0, face: 0, cx: 0, cy: 0, cz: 0 })
  let absorbClock = 0
  const absorbTick = (dt: number) => {
    absorbClock -= dt
    if (absorbClock > 0) return
    absorbClock = 0.5
    const n = sphere.readyFaces(swarm.time, READY_FACES, ready)
    for (let k = 0; k < n; k++) {
      const f = ready[k]
      const want = INBOUND_PER_FACE - sphere.layers[f.layer].inbound[f.face]
      if (want <= 0) continue
      const sent = swarm.pickForFace(faceKey(f.layer, f.face), f.cx, f.cy, f.cz, want)
      if (sent > 0) sphere.setInbound(f.layer, f.face, sent)
    }
  }
  const stepWorld = (dt: number) => {
    swarm.step(dt / 2, centroidOf, onAbsorbed)
    swarm.step(dt / 2, centroidOf, onAbsorbed)
    ground.step(dt, swarm)
    economy.tick(dt, ground.sunElev, sphere.powerMW())
    rockets.step(dt, sphere, swarm.time)
    absorbTick(dt)
  }
  for (let s = 0; s < WARMUP_S / 0.1; s++) stepWorld(0.1)
  const built = buildGround(ground, PLANET_R, blueGlow)
  spin.add(built.group)
  const sphereView = buildSphereView(sphere)
  scene.add(sphereView.group)

  // Rockets in flight: a small hull pointed along its velocity and a flame behind.
  const rocketGeo = (() => {
    const g = new THREE.CylinderGeometry(0.35, 0.45, 2.6, 10)
    g.translate(0, 0.3, 0)
    const nose = new THREE.ConeGeometry(0.35, 1.0, 10)
    nose.translate(0, 2.1, 0)
    const parts = [g, nose]
    const pos: number[] = []
    const nrm: number[] = []
    const idx: number[] = []
    let base = 0
    for (const p of parts) {
      const a = p.getAttribute('position')
      const n = p.getAttribute('normal')
      for (let i = 0; i < a.count; i++) {
        pos.push(a.getX(i), a.getY(i), a.getZ(i))
        nrm.push(n.getX(i), n.getY(i), n.getZ(i))
      }
      const ix = p.getIndex()!
      for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + base)
      base += a.count
    }
    const out = new THREE.BufferGeometry()
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
    out.setIndex(idx)
    return out
  })()
  const rocketMesh = new THREE.InstancedMesh(rocketGeo, new THREE.MeshStandardMaterial({ color: '#e8ebf2', roughness: 0.4, metalness: 0.35 }), rockets.N)
  rocketMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  rocketMesh.frustumCulled = false
  const flameMesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(2.2, 2.2),
    new THREE.MeshBasicMaterial({ map: glow, color: '#ffc27a', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    rockets.N,
  )
  flameMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  flameMesh.frustumCulled = false
  scene.add(rocketMesh, flameMesh)

  const sailGeo = new THREE.PlaneGeometry(2.2, 2.2)
  const sailMat = new THREE.MeshBasicMaterial({ map: sailTexture(), color: '#b4ccff', side: THREE.DoubleSide, transparent: true, opacity: 0.95 })
  const sails = new THREE.InstancedMesh(sailGeo, sailMat, swarm.N)
  sails.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  scene.add(sails)

  const tmp = new THREE.Vector3()
  const tmp2 = new THREE.Vector3()
  const scratch = new Float64Array(3)
  const placeBodies = () => {
    const t = swarm.time
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      const b = n.body
      if (i === earthIndex) n.pos.set(swarm.planetPos[0], swarm.planetPos[1], swarm.planetPos[2])
      else {
        const parent = b.parent >= 0 ? nodes[b.parent].pos : null
        positionOf(b, t, parent ? [parent.x, parent.y, parent.z] : null, scratch)
        n.pos.set(scratch[0], scratch[1], scratch[2])
      }
      n.tilt.position.copy(n.pos)
      n.spin.rotation.y = i === earthIndex ? SPIN_RATE * t : spinOf(b, t)
      if (n.mat) n.mat.uniforms.uSunDir.value.copy(n.pos).negate().normalize()
      if (n.ring) {
        n.ring.uniforms.uCenter.value.copy(n.pos)
        n.ring.uniforms.uNormal.value.set(b.pole[0], b.pole[1], b.pole[2])
      }
    }
    planetUniforms.uSunDir.value.copy(planet.position).negate().normalize()
    clouds.rotation.y = t * 0.065
    planet.updateMatrixWorld(true)
    // The comet: coma and tail by distance from the Sun.
    if (cometIndex >= 0) {
      const c = nodes[cometIndex]
      const r = c.pos.length()
      const coma = c.tilt.getObjectByName('coma') as THREE.Sprite
      // Never smaller than a few pixels, so it does not flicker from afar.
      const dc = camera.position.distanceTo(c.pos)
      const pxUnit = (2 * Math.tan((camera.fov * Math.PI) / 360) * dc) / window.innerHeight
      const bySun = Math.min(70, 50 * (650 / r))
      coma.scale.setScalar(Math.max(8 * pxUnit, bySun))
      ;(coma.material as THREE.SpriteMaterial).opacity = bySun > 8 * pxUnit ? 0.9 : 0.45
      const L = Math.max(6, Math.min(2400, 1500 * Math.pow(650 / r, 1.8)))
      tmp.copy(c.pos).normalize()
      tmp2.set(-tmp.z, 0, tmp.x).normalize()
      for (let k = 0; k < TAIL; k++) {
        const s = Math.pow(k / TAIL, 1.35) * L
        const j = s * 0.08
        tailPos[k * 3] = c.pos.x + tmp.x * s + tmp2.x * tailJitter[k * 2] * j
        tailPos[k * 3 + 1] = c.pos.y + tmp.y * s + tailJitter[k * 2 + 1] * j
        tailPos[k * 3 + 2] = c.pos.z + tmp.z * s + tmp2.z * tailJitter[k * 2] * j
      }
      tailAttr.needsUpdate = true
    }
    for (const { belt, attr } of belts) {
      belt.update(t)
      attr.needsUpdate = true
    }
  }
  placeBodies()

  // Open with the Sun in the middle and Earth beside it, from the far side of
  // the Sun so the launch streams curve in toward the camera.
  {
    const away = planet.position.clone().normalize().negate()
    const side = new THREE.Vector3().crossVectors(away, new THREE.Vector3(0, 1, 0)).normalize()
    const dir = away.multiplyScalar(Math.cos(0.36)).addScaledVector(side, Math.sin(0.36))
    dir.y += 0.26
    camera.position.copy(dir.normalize().multiplyScalar(900))
    controls.target.set(0, 0, 0)
    controls.update()
  }

  // --- focus: what the camera orbits ---------------------------------------
  let focus: Focus = { kind: 'star' }
  const anchor = new THREE.Vector3()
  const prevAnchor = new THREE.Vector3()
  const origin = new THREE.Vector3()
  const anchorOf = (f: Focus, out: THREE.Vector3) => {
    if (f.kind === 'star') return out.set(0, 0, 0)
    if (f.kind === 'ground') return out.copy(f.body).applyMatrix4(spin.matrixWorld)
    if (f.kind === 'body') return out.copy(nodes[f.b].pos)
    if (f.kind === 'rocket') return out.set(rockets.pos[f.r * 3], rockets.pos[f.r * 3 + 1], rockets.pos[f.r * 3 + 2])
    if (f.kind === 'bot') {
      const o = f.b * 3
      return out.set(ground.botPos[o], ground.botPos[o + 1], ground.botPos[o + 2]).applyMatrix4(spin.matrixWorld)
    }
    const st = swarm.state[f.i]
    if (st === RESERVED) {
      const p = ground.pkOf[f.i]
      if (p < 0) return out.copy(planet.position)
      return out.set(ground.pkPos[p * 3], ground.pkPos[p * 3 + 1], ground.pkPos[p * 3 + 2]).applyMatrix4(spin.matrixWorld)
    }
    return out.set(swarm.pos[f.i * 3], swarm.pos[f.i * 3 + 1], swarm.pos[f.i * 3 + 2])
  }
  const limitsOf = (f: Focus) => {
    if (f.kind !== 'body') return LIMITS[f.kind]
    const b = nodes[f.b].body
    const reach = b.rings ? b.rings.outer : b.R
    return { min: reach * 1.25, max: Math.max(400, b.R * 90) }
  }

  type Tween = { t: number; T: number; target0: THREE.Vector3; dir0: THREE.Vector3; len0: number; dir1: THREE.Vector3; len1: number }
  let tween: Tween | null = null
  const setFocus = (f: Focus, dist: number, seconds = 1.6) => {
    focus = f
    const lim = limitsOf(f)
    controls.minDistance = lim.min
    controls.maxDistance = lim.max
    anchorOf(f, anchor)
    const target0 = controls.target.clone()
    const dir0 = camera.position.clone().sub(target0)
    const len0 = dir0.length() || 1
    dir0.divideScalar(len0)
    const dir1 = camera.position.clone().sub(anchor)
    if (dir1.lengthSq() < 1e-6) dir1.copy(dir0)
    dir1.normalize()
    tween = { t: 0, T: reduceMotion ? 0 : seconds, target0, dir0, len0, dir1, len1: Math.max(lim.min, Math.min(lim.max, dist)) }
    controls.enabled = tween.T > 0 ? false : true
    controls.autoRotate = false
    window.clearTimeout(idleTimer)
  }
  const viewDist = (b: Body) => (b.rings ? b.rings.outer * 2.6 : b.R * 4.2)
  // Fly to a world; the flight takes longer the farther it is.
  const flyTo = (bi: number) => {
    if (bi === earthIndex) return land()
    const far = camera.position.distanceTo(nodes[bi].pos)
    setFocus({ kind: 'body', b: bi }, viewDist(nodes[bi].body), Math.min(4, 1.4 + far / 4000))
  }
  // Land: the point of Earth facing the camera, from a hemisphere away.
  const land = () => {
    if (focus.kind === 'ground' || focus.kind === 'sail' || focus.kind === 'bot') return
    const here = tmp.copy(camera.position).sub(planet.position).normalize().multiplyScalar(PLANET_R).add(planet.position)
    const far = camera.position.distanceTo(planet.position)
    setFocus({ kind: 'ground', body: spin.worldToLocal(here.clone()) }, 48, Math.min(4, 1.6 + far / 4000))
  }
  const pullBack = () => {
    if (focus.kind === 'star') return
    if (focus.kind === 'ground' || focus.kind === 'body' || focus.kind === 'rocket') setFocus({ kind: 'star' }, 900, 2)
    else {
      const onGround = focus.kind === 'bot' || swarm.state[focus.i] === RESERVED
      if (onGround) setFocus({ kind: 'ground', body: spin.worldToLocal(anchorOf(focus, tmp).clone()) }, 10)
      else setFocus({ kind: 'star' }, 900, 2)
    }
  }

  // Clicks: a short press that did not drag. Raycast the small things first.
  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  let press: { x: number; y: number; t: number } | null = null
  const onDown = (e: PointerEvent) => {
    if (e.button === 0) press = { x: e.clientX, y: e.clientY, t: performance.now() }
  }
  const solids = [sunMesh, ...nodes.map((n) => n.mesh)]
  const onUp = (e: PointerEvent) => {
    if (!press) return
    const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y)
    const held = performance.now() - press.t
    press = null
    if (moved > 6 || held > 500) return
    ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1)
    raycaster.setFromCamera(ndc, camera)
    // The big things by ray; the small things by nearest on screen, since a
    // sail is a couple of pixels from the Sun and a bot is a dot.
    const hits = raycaster.intersectObjects(solids, false)
    const solid = hits.length ? hits[0] : null
    const occluder = solid ? solid.distance : Infinity
    let best: Focus | null = null
    let bestDist = 0
    let bestPx = 12
    const consider = (f: Focus, dist: number) => {
      // tmp holds the world position.
      const d = tmp.distanceTo(camera.position)
      if (d > occluder) return
      tmp.project(camera)
      if (tmp.z > 1) return
      const px = Math.hypot(((tmp.x + 1) / 2) * window.innerWidth - e.clientX, ((1 - tmp.y) / 2) * window.innerHeight - e.clientY)
      if (px < bestPx) {
        bestPx = px
        best = f
        bestDist = dist
      }
    }
    for (let i = 0; i < swarm.N; i++) {
      if (swarm.scaleOf(i) === 0) continue
      tmp.set(swarm.pos[i * 3], swarm.pos[i * 3 + 1], swarm.pos[i * 3 + 2])
      consider({ kind: 'sail', i }, 9)
    }
    for (let p = 0; p < ground.nPackages; p++) {
      if (!ground.pkAlive[p]) continue
      tmp.set(ground.pkPos[p * 3], ground.pkPos[p * 3 + 1], ground.pkPos[p * 3 + 2]).applyMatrix4(spin.matrixWorld)
      consider({ kind: 'sail', i: ground.pkSail[p] }, 2.2)
    }
    for (let b = 0; b < ground.nBots; b++) {
      tmp.set(ground.botPos[b * 3], ground.botPos[b * 3 + 1], ground.botPos[b * 3 + 2]).applyMatrix4(spin.matrixWorld)
      consider({ kind: 'bot', b }, 2.2)
    }
    for (let r = 0; r < rockets.N; r++) {
      if (!rockets.alive[r]) continue
      tmp.set(rockets.pos[r * 3], rockets.pos[r * 3 + 1], rockets.pos[r * 3 + 2])
      consider({ kind: 'rocket', r }, 12)
    }
    if (best) {
      setFocus(best, bestDist)
      return
    }
    if (!solid) return
    if (solid.object === surface) {
      const here = camera.position.distanceTo(controls.target)
      const dist = focus.kind === 'ground' ? Math.max(1.2, here * 0.4) : 48
      setFocus({ kind: 'ground', body: spin.worldToLocal(solid.point.clone()) }, dist, focus.kind === 'ground' ? 1.2 : 2.2)
    } else if (solid.object === sunMesh) setFocus({ kind: 'star' }, 900, 2)
    else {
      const bi = nodeOfMesh.get(solid.object)
      if (bi !== undefined) flyTo(bi)
    }
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') pullBack()
  }
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointerup', onUp)
  window.addEventListener('keydown', onKey)

  // ?view=planet opens on Earth's lit side, ?view=night on its dark side,
  // ?view=site over the factory nearest the Sun, ?view=rails on its rails,
  // ?view=<world> beside any world by name.
  const view = (new URLSearchParams(location.search).get('view') || '').toLowerCase()
  if (view === 'planet' || view === 'night') {
    const side = view === 'planet' ? -1 : 1 // toward the Sun, or away from it
    const rhat = planet.position.clone().normalize()
    const point = planet.position.clone().addScaledVector(rhat, side * PLANET_R)
    camera.position.copy(point).addScaledVector(rhat, side * 58).add(new THREE.Vector3(18, 12, 0))
    controls.target.copy(point)
    setFocus({ kind: 'ground', body: spin.worldToLocal(point.clone()) }, 58, 0)
  } else if (view === 'site' || view === 'rails') {
    const rhat = planet.position.clone().normalize()
    let bestSite = ground.sites[0]
    let bestDot = -2
    for (const s of ground.sites) {
      const d = tmp.set(s.center[0], s.center[1], s.center[2]).transformDirection(spin.matrixWorld).dot(rhat) * -1
      if (d > bestDot) {
        bestDot = d
        bestSite = s
      }
    }
    const hall = new THREE.Vector3(...bestSite.hall.pos).applyMatrix4(spin.matrixWorld)
    const up = tmp.set(bestSite.hall.up[0], bestSite.hall.up[1], bestSite.hall.up[2]).transformDirection(spin.matrixWorld).clone()
    const ex = new THREE.Vector3(bestSite.hall.ex[0], bestSite.hall.ex[1], bestSite.hall.ex[2]).transformDirection(spin.matrixWorld)
    const ey = new THREE.Vector3(bestSite.hall.ey[0], bestSite.hall.ey[1], bestSite.hall.ey[2]).transformDirection(spin.matrixWorld)
    const S = 0.6
    const look = view === 'site' ? hall.clone().addScaledVector(ex, 1.0 * S) : hall.clone().addScaledVector(ex, 5.2 * S)
    if (view === 'site') camera.position.copy(look).addScaledVector(up, 6.5).addScaledVector(ex, -9).addScaledVector(ey, -3)
    else camera.position.copy(look).addScaledVector(up, 3.2).addScaledVector(ex, -3.2).addScaledVector(ey, 2.4)
    controls.target.copy(look)
    setFocus({ kind: 'ground', body: spin.worldToLocal(look.clone()) }, camera.position.distanceTo(look), 0)
  } else if (view) {
    const bi = bodies.findIndex((b) => b.name.toLowerCase() === view)
    if (bi >= 0 && bi !== earthIndex) {
      const n = nodes[bi]
      const toSun = n.pos.clone().normalize().negate()
      const side = new THREE.Vector3().crossVectors(toSun, new THREE.Vector3(0, 1, 0)).normalize()
      const dir = toSun.multiplyScalar(0.7).addScaledVector(side, 0.55).add(new THREE.Vector3(0, 0.4, 0)).normalize()
      camera.position.copy(n.pos).addScaledVector(dir, viewDist(n.body))
      controls.target.copy(n.pos)
      setFocus({ kind: 'body', b: bi }, viewDist(n.body), 0)
    }
  }
  // A preset lands instantly; the closure above hides the assignment from
  // the type checker, hence the cast.
  const preset = tween as Tween | null
  if (preset && preset.T === 0) {
    tween = null
    controls.enabled = true
    anchorOf(focus, prevAnchor)
  }

  const clock = new THREE.Clock()
  const dummy = new THREE.Object3D()
  const zero = new THREE.Matrix4().makeScale(0, 0, 0)
  const offset = new THREE.Vector3()
  const yAxis = new THREE.Vector3(0, 1, 0)

  // Tags ride with their worlds while those are small on screen. Moons only
  // show once you are near their planet.
  const placeTags = () => {
    const camDist = camera.position.distanceTo(controls.target)
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      const b = n.body
      let show = true
      const dp = camera.position.distanceTo(n.pos)
      if (focus.kind === 'body' && focus.b === i) show = false
      if (i === earthIndex && focus.kind !== 'star' && focus.kind !== 'body') show = false
      if (dp < b.R * 14) show = false
      if (b.kind === 'moon') {
        const parent = nodes[b.parent]
        const near = focus.kind === 'body' && (focus.b === b.parent || nodes[focus.b].body.parent === b.parent)
        if (!near && camera.position.distanceTo(parent.pos) > parent.body.R * 12) show = false
      }
      if (b.kind === 'dwarf' && camDist < 2500 && dp > 3000) show = false
      // No tag through a world that hides its body.
      if (show) {
        tmp2.copy(n.pos).sub(camera.position)
        for (let j = 0; j < nodes.length && show; j++) {
          if (j === i) continue
          const o = nodes[j]
          if (o.body.R < 3) continue
          tmp.copy(o.pos).sub(camera.position)
          const along = tmp.dot(tmp2) / dp
          if (along <= 0 || along >= dp) continue
          const miss = Math.sqrt(Math.max(0, tmp.lengthSq() - along * along))
          if (miss < o.body.R) show = false
        }
      }
      if (show) {
        tmp.copy(n.pos).project(camera)
        if (tmp.z < 1 && Math.abs(tmp.x) < 0.97 && Math.abs(tmp.y) < 0.97) {
          const x = ((tmp.x + 1) / 2) * window.innerWidth
          const y = ((1 - tmp.y) / 2) * window.innerHeight
          n.tag.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`
        } else show = false
      }
      n.tag.style.opacity = show ? '1' : '0'
      n.tag.style.pointerEvents = show ? 'auto' : 'none'
    }
  }

  function render() {
    const wall = Math.min(clock.getDelta(), 0.25)
    const real = Math.min(wall, 1 / 20)
    const simDt = reduceMotion ? 0 : real * TIME_SCALE
    if (simDt > 0) stepWorld(simDt)
    const t = swarm.time
    sunUniforms.uTime.value = t

    placeBodies()

    const { pos, N } = swarm
    for (let i = 0; i < N; i++) {
      const k = swarm.scaleOf(i)
      if (k === 0) {
        sails.setMatrixAt(i, zero)
        continue
      }
      dummy.position.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
      dummy.lookAt(origin)
      dummy.rotateZ(i * 0.7 + t * 0.2)
      dummy.scale.setScalar(k)
      dummy.updateMatrix()
      sails.setMatrixAt(i, dummy.matrix)
    }
    sails.instanceMatrix.needsUpdate = true
    built.update(camera)
    sphereView.update(t)

    // Rockets: hull along the velocity, flame at the tail facing the camera.
    for (let r = 0; r < rockets.N; r++) {
      if (!rockets.alive[r]) {
        rocketMesh.setMatrixAt(r, zero)
        flameMesh.setMatrixAt(r, zero)
        continue
      }
      const o = r * 3
      dummy.position.set(rockets.pos[o], rockets.pos[o + 1], rockets.pos[o + 2])
      tmp.set(rockets.vel[o], rockets.vel[o + 1], rockets.vel[o + 2])
      if (tmp.lengthSq() < 1e-8) tmp.copy(yAxis)
      else tmp.normalize()
      dummy.quaternion.setFromUnitVectors(yAxis, tmp)
      dummy.scale.setScalar(1)
      dummy.updateMatrix()
      rocketMesh.setMatrixAt(r, dummy.matrix)
      dummy.position.addScaledVector(tmp, -1.2)
      dummy.quaternion.copy(camera.quaternion)
      dummy.updateMatrix()
      flameMesh.setMatrixAt(r, dummy.matrix)
    }
    rocketMesh.instanceMatrix.needsUpdate = true
    flameMesh.instanceMatrix.needsUpdate = true

    // A followed sail that has been recycled or absorbed is gone, and so is
    // a rocket that has arrived; go back to the Sun.
    if (focus.kind === 'sail' && swarm.state[focus.i] === QUEUED) setFocus({ kind: 'star' }, 900, 2)
    if (focus.kind === 'rocket' && !rockets.alive[focus.r]) setFocus({ kind: 'star' }, 900, 2)

    // Keep the camera riding with its subject: the subject moved, so the
    // target and the camera move by the same amount. A tween blends the
    // target and the viewing offset from the old subject to the new one.
    anchorOf(focus, anchor)
    if (tween) {
      tween.t += wall
      const u = Math.min(1, tween.t / tween.T)
      const k = u * u * (3 - 2 * u)
      controls.target.copy(tween.target0).lerp(anchor, k)
      offset.copy(tween.dir0).lerp(tween.dir1, k).normalize().multiplyScalar(tween.len0 + (tween.len1 - tween.len0) * k)
      camera.position.copy(controls.target).add(offset)
      if (u >= 1) {
        tween = null
        controls.enabled = true
        if (!reduceMotion) idleTimer = window.setTimeout(() => (controls.autoRotate = true), 6000)
      }
    } else {
      tmp.copy(anchor).sub(prevAnchor)
      camera.position.add(tmp)
      controls.target.copy(anchor)
    }
    prevAnchor.copy(anchor)

    // Near plane follows the viewing distance, so a bot a metre away and
    // Neptune ten thousand away both resolve; clouds thin out as you come down.
    const dist = camera.position.distanceTo(controls.target)
    const near = Math.max(0.02, Math.min(4, dist * 0.004))
    if (Math.abs(near - camera.near) > camera.near * 0.2) {
      camera.near = near
      camera.updateProjectionMatrix()
    }
    const dp = camera.position.distanceTo(planet.position)
    const cloudFade = Math.max(0, Math.min(1, (dp - 19) / 22))
    cloudMat.opacity = 0.95 * cloudFade * cloudFade
    clouds.visible = cloudFade > 0.01

    placeTags()
    controls.update()
    composer.render()
  }

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight, false)
    composer.setSize(window.innerWidth, window.innerHeight)
    if (reduceMotion) render()
  }
  window.addEventListener('resize', onResize)

  let raf = 0
  if (reduceMotion) {
    render()
    controls.addEventListener('change', render)
  } else {
    const loop = () => {
      render()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
  }

  const focusText = () => {
    if (focus.kind === 'star' || focus.kind === 'ground') return ''
    if (focus.kind === 'body') return nodes[focus.b].body.facts
    if (focus.kind === 'rocket') {
      const key = rockets.target[focus.r]
      if (key < 0) return 'rocket: arrived'
      const layer = Math.floor(key / 1000000)
      const kind = Math.floor((key % 1000000) / 100000)
      const index = key % 100000
      return `carrier rocket ${focus.r + 1}: bound for ${kind === 0 ? 'node' : 'frame'} ${index + 1} of shell ${layer + 1}`
    }
    if (focus.kind === 'bot') {
      const site = ground.botSite[focus.b] + 1
      const st = ground.botState[focus.b]
      const what = st === 0 ? 'hauling ore to the factory' : st === 1 ? 'unloading at the dock' : st === 2 ? 'heading back to the mine' : 'loading at the mine'
      return `bot ${focus.b + 1}, site ${site}: ${what}`
    }
    const i = focus.i
    const st = swarm.state[i]
    const lane = swarm.lane[i] + 1
    if (st === RESERVED) {
      const p = ground.pkOf[i]
      return `sail ${i + 1}: ${p >= 0 ? ground.describePackage(p) : 'being built'}`
    }
    if (st === TRANSIT) return `sail ${i + 1}: in flight ${Math.round(swarm.age[i])} s, steering for lane ${lane}`
    if (swarm.face[i] >= 0) return `sail ${i + 1}: steering into shell ${Math.floor(swarm.face[i] / 100000) + 1}, face ${(swarm.face[i] % 100000) + 1}`
    return `sail ${i + 1}: in orbit, lane ${lane}`
  }

  // A hook for the headless test: where things are on screen, and what the
  // camera is following. Harmless in a real browser.
  const toScreen = (v: THREE.Vector3) => {
    const p = v.clone().project(camera)
    if (p.z > 1 || Math.abs(p.x) > 0.95 || Math.abs(p.y) > 0.95) return null
    return { x: ((p.x + 1) / 2) * window.innerWidth, y: ((1 - p.y) / 2) * window.innerHeight }
  }
  ;(window as unknown as { __dyson: unknown }).__dyson = {
    focus: () => focus.kind,
    text: focusText,
    screen: (what: string) => {
      if (what === 'planet' || what === 'earth') return toScreen(planet.position)
      if (what === 'star' || what === 'sun') return toScreen(origin)
      if (what === 'bot') return toScreen(new THREE.Vector3(ground.botPos[0], ground.botPos[1], ground.botPos[2]).applyMatrix4(spin.matrixWorld))
      if (what !== 'sail') {
        const n = nodes.find((x) => x.body.name.toLowerCase() === what)
        return n ? toScreen(n.pos) : null
      }
      let best: { x: number; y: number } | null = null
      let bestD = Infinity
      for (let i = 0; i < swarm.N; i++) {
        if (swarm.state[i] !== TRANSIT || swarm.age[i] < 12) continue
        const s = toScreen(new THREE.Vector3(swarm.pos[i * 3], swarm.pos[i * 3 + 1], swarm.pos[i * 3 + 2]))
        if (!s) continue
        const d = Math.hypot(s.x - window.innerWidth / 2, s.y - window.innerHeight / 2)
        if (d < bestD) {
          bestD = d
          best = s
        }
      }
      return best
    },
  }

  return {
    counts: () => {
      const sc = sphere.counts()
      const er = economy.rates()
      return {
        ...swarm.counts(),
        ...ground.counts(),
        rocketsFlying: rockets.count(),
        powerMW: sphere.powerMW(),
        completion: sphere.completion(),
        nodes: sc.nodes,
        nodesDone: sc.nodesDone,
        frames: sc.frames,
        framesDone: sc.framesDone,
        faces: sc.faces,
        facesDone: sc.facesDone,
        cells: sc.cells,
        supplyMW: er.supplyMW,
        demandMW: er.demandMW,
        satisfaction: er.demandMW > 0 ? Math.min(1, er.supplyMW / er.demandMW) : 1,
      }
    },
    focusText,
    land,
    dispose() {
      cancelAnimationFrame(raf)
      window.clearTimeout(idleTimer)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKey)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      controls.dispose()
      for (const n of nodes) n.tag.remove()
      scene.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.geometry) m.geometry.dispose()
        const mat = m.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else mat?.dispose()
      })
      composer.dispose()
      renderer.dispose()
    },
  }
}

const EMPTY: Counts = {
  orbit: 0,
  transit: 0,
  ground: 0,
  absorbing: 0,
  launched: 0,
  absorbed: 0,
  sites: 0,
  guns: 0,
  inWindow: 0,
  firing: 0,
  racked: 0,
  onBelts: 0,
  built: 0,
  rocketsFired: 0,
  rocketsFlying: 0,
  powerMW: 0,
  completion: 0,
  nodes: 0,
  nodesDone: 0,
  frames: 0,
  framesDone: 0,
  faces: 0,
  facesDone: 0,
  cells: 0,
  supplyMW: 0,
  demandMW: 0,
  satisfaction: 1,
}
const n = (x: number) => x.toLocaleString('en-US')
const gw = (mw: number) => (mw >= 1000 ? `${(mw / 1000).toFixed(2)} GW` : `${mw.toFixed(0)} MW`)

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const tagsRef = useRef<HTMLDivElement>(null)
  const [counts, setCounts] = useState<Counts>(EMPTY)
  const [track, setTrack] = useState('')
  const [webgl, setWebgl] = useState(true)

  useEffect(() => {
    const canvas = canvasRef.current
    const tags = tagsRef.current
    if (!canvas || !tags) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let sim: Sim
    try {
      sim = startScene(canvas, tags, reduce)
    } catch {
      setWebgl(false)
      return
    }
    const tick = window.setInterval(() => {
      setCounts(sim.counts())
      setTrack(sim.focusText())
    }, 250)
    return () => {
      window.clearInterval(tick)
      sim.dispose()
    }
  }, [])

  return (
    <>
      <canvas ref={canvasRef} className="sky" />
      <div ref={tagsRef} className="tags" aria-label="Worlds" />
      {!webgl && (
        <div className="nogl">
          <p>This page draws the solar system in WebGL, which your browser has turned off.</p>
        </div>
      )}
      <div className="overlay fade-in">
        <h1 className="name">
          Gurasees Singh Dhanoa
          <small>Building a Dyson sphere.</small>
        </h1>
        <div />
        <div className="foot">
          <div>
            <nav className="links" aria-label="Links">
              {LINKS.map((l) => (
                <a key={l.label} href={l.href} target={l.href.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer">
                  {l.label}
                </a>
              ))}
            </nav>
            <p className="hint">
              the solar system as it stands today, distances and sizes compressed
              <br />
              drag to orbit, scroll to zoom, click a world to fly there
              <br />
              click earth to land, click a sail or a bot to ride along, esc to pull back
            </p>
          </div>
          <div className="hud" aria-live="polite">
            <div>
              Dyson sphere <b>{gw(counts.powerMW)}</b>, <b>{(counts.completion * 100).toFixed(1)}%</b> built
            </div>
            <div>
              <b>{n(counts.nodesDone)}</b> of {n(counts.nodes)} nodes, <b>{n(counts.framesDone)}</b> of {n(counts.frames)} frames, <b>{n(counts.cells)}</b> cells
            </div>
            <div>
              swarm <b>{n(counts.orbit)}</b> in orbit, <b>{n(counts.transit)}</b> in transit, <b>{n(counts.absorbing)}</b> being absorbed
            </div>
            <div>
              <b>{n(counts.rocketsFlying)}</b> rockets in flight, <b>{n(counts.inWindow)}</b> of {n(counts.guns)} rails in their window
            </div>
            <div>
              factories at <b>{Math.round(counts.satisfaction * 100)}%</b> power, {counts.supplyMW.toFixed(0)} of {counts.demandMW.toFixed(0)} MW
            </div>
            {track && <div className="track">{track}</div>}
          </div>
        </div>
      </div>
    </>
  )
}
