// How the other worlds are drawn: one shader that turns a palette and a few
// knobs into a cratered rock, a banded gas giant, a capped ice world or a
// spotted one; a ring shader with the planet's shadow across the rings; and
// the belts as Keplerian point clouds. Nothing is fetched or painted on the
// CPU except a one-row ring strip.
import * as THREE from 'three'
import { NOISE_GLSL, SHADER_DEFINES } from './planet'
import { GM, distOf, solveKepler, type Body, type Look, type Rings } from './system'

export const SUN_LIGHT = '#fff3e0'
export const SUN_INTENSITY = 2.2
export const AMBIENT_LIGHT = '#262c3c'
export const AMBIENT_INTENSITY = 0.35

export function lightUniforms() {
  return {
    uSun: { value: new THREE.Color(SUN_LIGHT).multiplyScalar(SUN_INTENSITY / Math.PI) },
    uAmbient: { value: new THREE.Color(AMBIENT_LIGHT).multiplyScalar(AMBIENT_INTENSITY / Math.PI) },
  }
}

export const WORLD_VERT = /* glsl */ `
varying vec3 vObj; varying vec3 vWorldNormal;
void main(){
  vObj = normalize(position);
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

export const WORLD_FRAG = /* glsl */ `
uniform vec3 uC0, uC1, uC2, uC3, uCap, uSpotColor;
uniform float uBands, uTurb, uCrater, uCapSize, uSeed, uSpotStrength;
uniform vec3 uSpot; // longitude, latitude, size
uniform vec3 uSunDir, uSun, uAmbient;
varying vec3 vObj; varying vec3 vWorldNormal;
${NOISE_GLSL}
void main(){
  vec3 p = normalize(vObj);
  vec3 q = p + vec3(uSeed * 7.1, uSeed * 3.3, uSeed * 5.7);
  float n1 = fbm(q * 2.6);
  float n2 = fbm(q * 7.0 + 3.1);
  float n3 = fbm(q * 18.0 + 9.7);

  // Gas giant: bands by latitude, warped by turbulence, with pale storms.
  float y = p.y + uTurb * (n2 * 0.16 + n3 * 0.03);
  float b1 = 0.5 + 0.5 * sin(y * 16.0 + uSeed);
  float b2 = 0.5 + 0.5 * sin(y * 37.0 + 2.0 * uSeed + n1 * 1.5);
  vec3 gas = mix(mix(uC0, uC1, b1), mix(uC2, uC3, b2), 0.35 + 0.3 * b1);
  gas = mix(gas, uC2, 0.28 * smoothstep(0.1, 0.45, n2 + 0.3 * n3) * uTurb);

  // Rock: a ramp through the palette from darkest to palest, then crater
  // bowls and rims where the look asks for them.
  float t = clamp(0.5 + n1 * 0.9 + n2 * 0.5 + n3 * 0.25, 0.0, 1.0);
  vec3 rock = mix(uC3, uC1, smoothstep(0.15, 0.4, t));
  rock = mix(rock, uC0, smoothstep(0.4, 0.62, t));
  rock = mix(rock, uC2, smoothstep(0.62, 0.9, t));
  float c = abs(fbm(q * 22.0 + 5.0));
  float bowl = 1.0 - smoothstep(0.0, 0.06, c);
  float rim = smoothstep(0.06, 0.09, c) - smoothstep(0.09, 0.13, c);
  rock = mix(rock, rock * 0.8, bowl * uCrater);
  rock = mix(rock, rock * 1.14, rim * uCrater);

  // Gas worlds that are not fully banded sit on a smooth base, not on rock.
  vec3 base = uBands > 0.0 ? mix(uC0, uC1, 0.5 + n1) : rock;
  vec3 col = mix(base, gas, uBands);
  if (uCapSize > 0.0) col = mix(col, uCap, smoothstep(uCapSize, uCapSize + 0.05, abs(p.y) + n2 * 0.06));
  if (uSpotStrength > 0.0) {
    float lon = atan(p.z, p.x);
    float lat = asin(clamp(p.y, -1.0, 1.0));
    float dl = atan(sin(lon - uSpot.x), cos(lon - uSpot.x));
    float d = length(vec2(dl * cos(lat) * 0.5, lat - uSpot.y)) / uSpot.z;
    float s = (1.0 - smoothstep(0.6, 1.0, d)) * uSpotStrength;
    col = mix(col, uSpotColor, s * (0.75 + 0.5 * n3));
  }
  vec3 n = normalize(vWorldNormal);
  float day = max(dot(n, uSunDir), 0.0);
  gl_FragColor = vec4(col * (day * uSun + uAmbient), 1.0);
}`

export function worldMaterial(look: Look) {
  const c = (hex: string) => new THREE.Color(hex)
  return new THREE.ShaderMaterial({
    defines: { ...SHADER_DEFINES },
    uniforms: {
      ...lightUniforms(),
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uC0: { value: c(look.c0) },
      uC1: { value: c(look.c1) },
      uC2: { value: c(look.c2) },
      uC3: { value: c(look.c3) },
      uCap: { value: c(look.cap ?? '#ffffff') },
      uCapSize: { value: look.capSize },
      uBands: { value: look.bands },
      uTurb: { value: look.turb },
      uCrater: { value: look.crater },
      uSeed: { value: look.seed },
      uSpot: { value: new THREE.Vector3(look.spot?.lon ?? 0, look.spot?.lat ?? 0, look.spot?.size ?? 0.1) },
      uSpotColor: { value: c(look.spot?.color ?? '#000000') },
      uSpotStrength: { value: look.spot?.strength ?? 0 },
    },
    vertexShader: WORLD_VERT,
    fragmentShader: WORLD_FRAG,
  })
}

// --- rings ---------------------------------------------------------------

// A one-row strip across the rings from the inner edge to the outer, with
// the gaps where they are: Cassini and Encke for Saturn, the narrow dark
// rings of Uranus with epsilon outermost, Neptune's faint Galle and Adams.
export function ringTexture(kind: Rings['kind']) {
  const W = 1024
  const c = document.createElement('canvas')
  c.width = W
  c.height = 1
  const g = c.getContext('2d')!
  const img = g.createImageData(W, 1)
  const inner = kind === 'saturn' ? 1.24 : kind === 'uranus' ? 1.64 : 1.7
  const outer = kind === 'saturn' ? 2.27 : kind === 'uranus' ? 2.0 : 2.5
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let x = 0; x < W; x++) {
    const r = inner + ((x + 0.5) / W) * (outer - inner)
    let rgb = [230, 218, 190]
    let a = 0
    if (kind === 'saturn') {
      const stripe = 0.85 + 0.15 * Math.sin(r * 240) * Math.sin(r * 57 + 1) + (rnd() - 0.5) * 0.08
      if (r < 1.53) a = 0.28 * stripe
      else if (r < 1.95) a = 0.95 * stripe
      else if (r < 2.03) a = 0.05
      else if (r < 2.27) a = (r > 2.205 && r < 2.215 ? 0.08 : 0.72) * stripe
      if (r > 2.24) a *= (2.27 - r) / 0.03
      if (r < 1.3) a *= (r - 1.24) / 0.06
      rgb = [232 - 20 * (1 - stripe), 220 - 18 * (1 - stripe), 192 - 14 * (1 - stripe)]
    } else if (kind === 'uranus') {
      rgb = [130, 132, 140]
      for (const [rr, aa, ww] of [
        [1.64, 0.12, 0.004],
        [1.69, 0.12, 0.004],
        [1.73, 0.14, 0.004],
        [1.78, 0.16, 0.005],
        [1.85, 0.14, 0.004],
        [1.94, 0.18, 0.005],
        [2.0, 0.42, 0.012],
      ]) {
        if (Math.abs(r - rr) < ww) a = Math.max(a, aa)
      }
    } else {
      rgb = [160, 150, 160]
      if (r > 1.7 && r < 1.9) a = 0.05
      if (Math.abs(r - 2.49) < 0.012) a = 0.22
      if (Math.abs(r - 2.14) < 0.01) a = 0.1
    }
    const o = x * 4
    img.data[o] = rgb[0]
    img.data[o + 1] = rgb[1]
    img.data[o + 2] = rgb[2]
    img.data[o + 3] = Math.round(Math.min(1, a) * 255)
  }
  g.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.minFilter = THREE.LinearFilter
  t.magFilter = THREE.LinearFilter
  t.wrapS = THREE.ClampToEdgeWrapping
  return t
}

export const RING_VERT = /* glsl */ `
varying vec3 vWorld; varying vec2 vLocal;
void main(){
  vLocal = position.xz;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`

// Lit by the Sun at the origin, in shadow where the planet sits between a
// ring particle and the Sun.
export const RING_FRAG = /* glsl */ `
uniform sampler2D uTex; uniform float uInner, uOuter, uR;
uniform vec3 uCenter, uNormal, uSun, uAmbient;
varying vec3 vWorld; varying vec2 vLocal;
void main(){
  float r = length(vLocal);
  float u = (r - uInner) / (uOuter - uInner);
  if (u < 0.0 || u > 1.0) discard;
  vec4 t = texture2D(uTex, vec2(u, 0.5));
  vec3 d = normalize(-vWorld);
  vec3 oc = vWorld - uCenter;
  float b = dot(oc, d);
  float c = dot(oc, oc) - uR * uR;
  float disc = b * b - c;
  float shadow = 1.0;
  if (disc > 0.0 && -b - sqrt(disc) > 0.0) shadow = 0.1;
  float elev = abs(dot(normalize(uNormal), normalize(-uCenter)));
  float lit = 0.25 + 0.75 * elev;
  gl_FragColor = vec4(t.rgb * (uSun * lit * shadow + uAmbient), t.a);
}`

export function ringMaterial(rings: Rings) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...lightUniforms(),
      uTex: { value: ringTexture(rings.kind) },
      uInner: { value: rings.inner },
      uOuter: { value: rings.outer },
      uR: { value: 1 },
      uCenter: { value: new THREE.Vector3() },
      uNormal: { value: new THREE.Vector3(0, 1, 0) },
    },
    vertexShader: RING_VERT,
    fragmentShader: RING_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}

// --- belts ---------------------------------------------------------------

export type BeltSpec = { n: number; aMin: number; aMax: number; eMax: number; iMax: number }

// A cloud of bodies on their own Keplerian orbits, moved every frame.
export class Belt {
  readonly n: number
  readonly pos: Float32Array
  private readonly a: Float64Array
  private readonly e: Float64Array
  private readonly ci: Float64Array
  private readonly si: Float64Array
  private readonly cO: Float64Array
  private readonly sO: Float64Array
  private readonly cw: Float64Array
  private readonly sw: Float64Array
  private readonly M0: Float64Array
  private readonly nn: Float64Array
  private readonly E: Float64Array // last eccentric anomaly, the warm start

  constructor(n: number, gen: (k: number) => { a: number; e: number; i: number; O: number; w: number; M0: number; n: number }) {
    this.n = n
    this.pos = new Float32Array(n * 3)
    this.a = new Float64Array(n)
    this.e = new Float64Array(n)
    this.ci = new Float64Array(n)
    this.si = new Float64Array(n)
    this.cO = new Float64Array(n)
    this.sO = new Float64Array(n)
    this.cw = new Float64Array(n)
    this.sw = new Float64Array(n)
    this.M0 = new Float64Array(n)
    this.nn = new Float64Array(n)
    this.E = new Float64Array(n)
    for (let k = 0; k < n; k++) {
      const g = gen(k)
      this.a[k] = g.a
      this.e[k] = g.e
      this.ci[k] = Math.cos(g.i)
      this.si[k] = Math.sin(g.i)
      this.cO[k] = Math.cos(g.O)
      this.sO[k] = Math.sin(g.O)
      this.cw[k] = Math.cos(g.w)
      this.sw[k] = Math.sin(g.w)
      this.M0[k] = g.M0
      this.nn[k] = g.n
      this.E[k] = solveKepler(g.M0, g.e) + (g.M0 - Math.atan2(Math.sin(g.M0), Math.cos(g.M0)))
    }
  }

  update(t: number) {
    const { a, e, ci, si, cO, sO, cw, sw, M0, nn, pos } = this
    for (let k = 0; k < this.n; k++) {
      // Two Newton steps from last frame's answer: the mean anomaly moves a
      // tiny fraction of a radian per frame, so this is as exact as a full
      // solve at a fraction of the cost. E tracks the unwrapped M.
      const M = M0[k] + nn[k] * t
      let E = this.E[k]
      E -= (E - e[k] * Math.sin(E) - M) / (1 - e[k] * Math.cos(E))
      E -= (E - e[k] * Math.sin(E) - M) / (1 - e[k] * Math.cos(E))
      this.E[k] = E
      const xo = a[k] * (Math.cos(E) - e[k])
      const yo = a[k] * Math.sqrt(1 - e[k] * e[k]) * Math.sin(E)
      const xe = (cO[k] * cw[k] - sO[k] * sw[k] * ci[k]) * xo + (-cO[k] * sw[k] - sO[k] * cw[k] * ci[k]) * yo
      const ye = (sO[k] * cw[k] + cO[k] * sw[k] * ci[k]) * xo + (-sO[k] * sw[k] + cO[k] * cw[k] * ci[k]) * yo
      const ze = sw[k] * si[k] * xo + cw[k] * si[k] * yo
      pos[k * 3] = xe
      pos[k * 3 + 1] = ze
      pos[k * 3 + 2] = -ye
    }
  }
}

const DEG = Math.PI / 180

export function asteroidBelt(spec: BeltSpec, rand: () => number) {
  return new Belt(spec.n, () => {
    const au = spec.aMin + rand() * (spec.aMax - spec.aMin)
    const a = distOf(au)
    return {
      a,
      e: rand() * spec.eMax,
      i: rand() * spec.iMax * DEG,
      O: rand() * Math.PI * 2,
      w: rand() * Math.PI * 2,
      M0: rand() * Math.PI * 2,
      n: Math.sqrt(GM / (a * a * a)),
    }
  })
}

// Jupiter's Trojans share its orbit and its mean motion, sixty degrees
// ahead and behind, so they keep station as it goes round.
export function trojans(jupiter: Body, n: number, spreadDeg: number, eMax: number, iMax: number, rand: () => number) {
  return new Belt(n, (k) => {
    const lead = k % 2 === 0 ? 1 : -1
    const gauss = (rand() + rand() + rand() - 1.5) * 0.8
    return {
      a: jupiter.a * (1 + (rand() - 0.5) * 0.03),
      e: rand() * eMax,
      i: rand() * iMax * DEG,
      O: jupiter.O,
      w: jupiter.w + rand() * 0.3 - 0.15,
      M0: jupiter.M0 + lead * Math.PI / 3 + gauss * spreadDeg * DEG,
      n: jupiter.n,
    }
  })
}
