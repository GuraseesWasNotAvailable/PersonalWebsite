// Our solar system, as data and Kepler's equation. No renderer in sight.
//
// Every planet carries its J2000 mean orbital elements and their secular
// rates (JPL's approximate elements, good for 1800 to 2050), so the system
// opens in the configuration the real sky has today. Pole directions are the
// IAU values, so Uranus really does roll on its side and Venus really does
// spin backwards. Distances are compressed with a power law so Neptune fits
// on a screen with Mercury, and sizes are exaggerated so a planet is more
// than a pixel; both are stated on the page. Orbital speeds follow Kepler's
// third law in scene units with the same gravity the sails feel, so a sail
// launched from Earth and Earth itself obey one physics.

import { GM } from './swarm'

export type V3 = [number, number, number]

export const AU_SCALE = 914 // scene units for 1 AU, Earth's distance
export const DIST_EXP = 0.6 // distance ∝ AU^0.6, so Neptune is 7.7x Earth, not 30x
export const EARTH_R = 16
export const SIZE_EXP = 0.55 // radius ∝ (R/R_earth)^0.55, so Jupiter is 3.8x Earth, not 11x
export { GM } // the Sun's gravitational parameter in scene units, one value for sails and planets
export const SPIN_EARTH = 0.05 // Earth's spin in radians per scene second (a day is 126 s)

const DEG = Math.PI / 180
const OBLIQUITY = 23.4392811 * DEG

export const distOf = (au: number) => AU_SCALE * Math.pow(au, DIST_EXP)
export const radiusOf = (earthRadii: number) => EARTH_R * Math.pow(earthRadii, SIZE_EXP)

// A look the world shader can draw: a palette, banding and turbulence for
// gas giants, blotches and craters for rock, polar caps, and one named spot.
export type Look = {
  c0: string
  c1: string
  c2: string
  c3: string
  bands: number
  turb: number
  crater: number
  cap?: string
  capSize: number
  spot?: { lon: number; lat: number; size: number; color: string; strength: number }
  seed: number
}

export type Rings = { inner: number; outer: number; kind: 'saturn' | 'uranus' | 'neptune' }

export type Body = {
  name: string
  kind: 'planet' | 'dwarf' | 'moon' | 'comet'
  parent: number // index of the body it orbits, or -1 for the Sun
  R: number // scene radius
  // Heliocentric orbit in scene units (for moons: around the parent).
  a: number
  e: number
  i: number
  O: number
  w: number
  M0: number // mean anomaly at t = 0
  n: number // mean motion, rad per scene second (negative for retrograde moons)
  plane: 'ecliptic' | 'equator' // moons: which plane the orbit lies in
  pole: V3 // spin axis in scene coordinates
  Q: number[] // 3x3 row-major rotation taking +y to the pole
  spin: number // rad per scene second about the pole, negative for retrograde
  spin0: number
  locked: boolean // tidally locked moon: the same face stays toward the parent
  look: Look | 'earth' | 'comet'
  rings?: Rings
  facts: string
}

// --- Kepler --------------------------------------------------------------

export function solveKepler(M: number, e: number) {
  M = Math.atan2(Math.sin(M), Math.cos(M))
  let E = e > 0.8 ? Math.PI : M + e * Math.sin(M)
  for (let k = 0; k < 12; k++) {
    const f = E - e * Math.sin(E) - M
    const fp = 1 - e * Math.cos(E)
    const d = f / fp
    E -= d
    if (Math.abs(d) < 1e-10) break
  }
  return E
}

// Position (and velocity) on a Keplerian orbit, in scene coordinates where
// the ecliptic is the xz plane and ecliptic north is +y.
export function orbitState(a: number, e: number, i: number, O: number, w: number, M: number, n: number, pos: ArrayLike<number> & { [k: number]: number }, vel?: { [k: number]: number }) {
  const E = solveKepler(M, e)
  const cE = Math.cos(E)
  const sE = Math.sin(E)
  const b = a * Math.sqrt(1 - e * e)
  const xo = a * (cE - e)
  const yo = b * sE
  const cO = Math.cos(O)
  const sO = Math.sin(O)
  const cw = Math.cos(w)
  const sw = Math.sin(w)
  const ci = Math.cos(i)
  const si = Math.sin(i)
  const r11 = cO * cw - sO * sw * ci
  const r12 = -cO * sw - sO * cw * ci
  const r21 = sO * cw + cO * sw * ci
  const r22 = -sO * sw + cO * cw * ci
  const r31 = sw * si
  const r32 = cw * si
  const xe = r11 * xo + r12 * yo
  const ye = r21 * xo + r22 * yo
  const ze = r31 * xo + r32 * yo
  pos[0] = xe
  pos[1] = ze
  pos[2] = -ye
  if (vel) {
    const Ed = n / (1 - e * cE)
    const vxo = -a * sE * Ed
    const vyo = b * cE * Ed
    vel[0] = r11 * vxo + r12 * vyo
    vel[1] = r31 * vxo + r32 * vyo
    vel[2] = -(r21 * vxo + r22 * vyo)
  }
}

// --- orientation ---------------------------------------------------------

// A pole given as right ascension and declination (equatorial, J2000) as a
// unit vector in scene coordinates.
export function poleToScene(raDeg: number, decDeg: number): V3 {
  const ra = raDeg * DEG
  const dec = decDeg * DEG
  const xe = Math.cos(dec) * Math.cos(ra)
  const ye = Math.cos(dec) * Math.sin(ra)
  const ze = Math.sin(dec)
  const c = Math.cos(OBLIQUITY)
  const s = Math.sin(OBLIQUITY)
  const yq = c * ye + s * ze
  const zq = -s * ye + c * ze
  return [xe, zq, -yq]
}

// The rotation taking +y to the pole, as a row-major 3x3.
export function poleFrame(p: V3): number[] {
  const y: V3 = [0, 1, 0]
  const kx = y[1] * p[2] - y[2] * p[1]
  const ky = y[2] * p[0] - y[0] * p[2]
  const kz = y[0] * p[1] - y[1] * p[0]
  const sl = Math.hypot(kx, ky, kz)
  const c = Math.max(-1, Math.min(1, p[1]))
  if (sl < 1e-9) {
    if (c > 0) return [1, 0, 0, 0, 1, 0, 0, 0, 1]
    return [1, 0, 0, 0, -1, 0, 0, 0, -1] // pole is -y: a half turn about x
  }
  const ax = kx / sl
  const ay = ky / sl
  const az = kz / sl
  const s = sl
  const t = 1 - c
  return [
    t * ax * ax + c, t * ax * ay - s * az, t * ax * az + s * ay,
    t * ax * ay + s * az, t * ay * ay + c, t * ay * az - s * ax,
    t * ax * az - s * ay, t * ay * az + s * ax, t * az * az + c,
  ]
}

export function applyQ(Q: number[], v: ArrayLike<number>, out: { [k: number]: number }) {
  const x = v[0]
  const y = v[1]
  const z = v[2]
  out[0] = Q[0] * x + Q[1] * y + Q[2] * z
  out[1] = Q[3] * x + Q[4] * y + Q[5] * z
  out[2] = Q[6] * x + Q[7] * y + Q[8] * z
  return out
}

export function applyQT(Q: number[], v: ArrayLike<number>, out: { [k: number]: number }) {
  const x = v[0]
  const y = v[1]
  const z = v[2]
  out[0] = Q[0] * x + Q[3] * y + Q[6] * z
  out[1] = Q[1] * x + Q[4] * y + Q[7] * z
  out[2] = Q[2] * x + Q[5] * y + Q[8] * z
  return out
}

// --- the catalogue -------------------------------------------------------

// JPL approximate elements: value at J2000 and rate per Julian century.
// a in AU, angles in degrees: L mean longitude, w longitude of perihelion,
// O longitude of the ascending node.
type Jpl = [a: number, e: number, i: number, L: number, w: number, O: number]
type PlanetSpec = {
  name: string
  el: Jpl
  rate: Jpl
  radiusEarth: number
  pole: [ra: number, dec: number]
  rotHours: number // negative for retrograde
  look: Look | 'earth'
  rings?: Rings
  facts: string
}

const PLANETS: PlanetSpec[] = [
  {
    name: 'Mercury',
    el: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593],
    rate: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
    radiusEarth: 0.3829,
    pole: [281.01, 61.45],
    rotHours: 1407.6,
    look: { c0: '#5c5a57', c1: '#8c8984', c2: '#726c66', c3: '#3a3835', bands: 0, turb: 0, crater: 1, capSize: 0, seed: 1 },
    facts: '0.39 AU from the Sun. A day lasts 59 Earth days, a year 88. No moons, no air, 430 C by day and minus 180 at night.',
  },
  {
    name: 'Venus',
    el: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255],
    rate: [0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418],
    radiusEarth: 0.9499,
    pole: [272.76, 67.16],
    rotHours: -5832.5,
    look: { c0: '#e3c67c', c1: '#d2ae5c', c2: '#f1dca4', c3: '#c39b47', bands: 0.7, turb: 1.6, crater: 0, capSize: 0, seed: 2 },
    facts: '0.72 AU from the Sun. Spins backwards, one turn every 243 days, longer than its 225 day year. 460 C under a sulphuric acid cloud deck.',
  },
  {
    name: 'Earth',
    el: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
    rate: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
    radiusEarth: 1,
    pole: [0, 90],
    rotHours: 23.934,
    look: 'earth',
    facts: '1 AU from the Sun. The launch world: eleven factories feed the rails that build the swarm.',
  },
  {
    name: 'Mars',
    el: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    rate: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
    radiusEarth: 0.5320,
    pole: [317.68, 52.89],
    rotHours: 24.623,
    look: { c0: '#b4552c', c1: '#8a3c22', c2: '#d48a5a', c3: '#5a2a1a', bands: 0, turb: 0, crater: 0.5, cap: '#f4f0ea', capSize: 0.86, seed: 3 },
    facts: '1.52 AU from the Sun. A day of 24.6 hours, a year of 687 days, carbon dioxide ice at the poles, two small moons.',
  },
  {
    name: 'Jupiter',
    el: [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    rate: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
    radiusEarth: 11.209,
    pole: [268.06, 64.5],
    rotHours: 9.925,
    look: { c0: '#c9a87c', c1: '#a3774f', c2: '#ecdcbf', c3: '#8a5a3a', bands: 1, turb: 0.9, crater: 0, capSize: 0, spot: { lon: 0.6, lat: -0.38, size: 0.16, color: '#b8482a', strength: 0.9 }, seed: 4 },
    facts: '5.2 AU from the Sun. Eleven Earths across, a ten hour day, a twelve year year, and a storm older than any map of it.',
  },
  {
    name: 'Saturn',
    el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    rate: [-0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
    radiusEarth: 9.449,
    pole: [40.59, 83.54],
    rotHours: 10.656,
    look: { c0: '#e1c99c', c1: '#c7aa78', c2: '#f2e4c6', c3: '#b39262', bands: 1, turb: 0.4, crater: 0, capSize: 0, seed: 5 },
    rings: { inner: 1.24, outer: 2.27, kind: 'saturn' },
    facts: '9.5 AU from the Sun. Rings of ice from 1.2 to 2.3 radii out, a 10.7 hour day, a 29 year year.',
  },
  {
    name: 'Uranus',
    el: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503],
    rate: [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
    radiusEarth: 4.007,
    pole: [257.31, -15.18],
    rotHours: -17.24,
    look: { c0: '#a4dbe8', c1: '#8fcfdf', c2: '#c0ebf2', c3: '#7fc2d6', bands: 0.35, turb: 0.3, crater: 0, capSize: 0, seed: 6 },
    rings: { inner: 1.64, outer: 2.0, kind: 'uranus' },
    facts: '19 AU from the Sun. Rolls on its side, pole tipped 98 degrees, so each pole gets 42 years of day. A 17 hour day, an 84 year year.',
  },
  {
    name: 'Neptune',
    el: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
    rate: [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
    radiusEarth: 3.883,
    pole: [299.36, 43.46],
    rotHours: 16.11,
    look: { c0: '#2f52d6', c1: '#2443b2', c2: '#5078ef', c3: '#1c318f', bands: 0.6, turb: 0.5, crater: 0, capSize: 0, spot: { lon: 2.2, lat: -0.35, size: 0.12, color: '#162a72', strength: 0.8 }, seed: 7 },
    rings: { inner: 1.7, outer: 2.5, kind: 'neptune' },
    facts: '30 AU from the Sun. The fastest winds in the system, 2,000 km/h. A 16 hour day and a 165 year year; it has completed one orbit since it was found.',
  },
]

// Dwarf planets and a comet: elements at an epoch (JD) with the real
// period, enough to put them in the right part of the sky today.
type SmallSpec = {
  name: string
  kind: 'dwarf' | 'comet'
  a: number
  e: number
  i: number
  O: number
  w: number
  M: number // mean anomaly at epoch, degrees
  epoch: number // JD
  periodDays: number
  radiusEarth: number
  pole: [number, number]
  rotHours: number
  look: Look | 'comet'
  facts: string
}

const SMALL: SmallSpec[] = [
  {
    name: 'Ceres',
    kind: 'dwarf',
    a: 2.7691,
    e: 0.0760,
    i: 10.594,
    O: 80.305,
    w: 73.597,
    M: 77.37,
    epoch: 2459000.5,
    periodDays: 1680,
    radiusEarth: 0.0742,
    pole: [291.4, 66.8],
    rotHours: 9.07,
    look: { c0: '#6e6a63', c1: '#4f4b45', c2: '#8d887f', c3: '#3a3733', bands: 0, turb: 0, crater: 0.8, capSize: 0, seed: 11 },
    facts: 'The largest thing in the asteroid belt, 2.8 AU out, 940 km across, a quarter of the belt by mass, with bright salt flats in its craters.',
  },
  {
    name: 'Pluto',
    kind: 'dwarf',
    a: 39.482,
    e: 0.2488,
    i: 17.14,
    O: 110.30,
    w: 113.76,
    M: 14.53,
    epoch: 2451545.0,
    periodDays: 90560,
    radiusEarth: 0.1868,
    pole: [132.99, -6.16],
    rotHours: -153.29,
    look: { c0: '#cfa77d', c1: '#8e6a4b', c2: '#ecdcc8', c3: '#5a3d2a', bands: 0, turb: 0, crater: 0.3, capSize: 0, spot: { lon: 3.0, lat: -0.2, size: 0.3, color: '#f3ebe0', strength: 1 }, seed: 12 },
    facts: '39 AU on average, inside Neptune for twenty years of every 248. A heart of nitrogen ice the size of Texas, and a moon half its own size.',
  },
  {
    name: 'Haumea',
    kind: 'dwarf',
    a: 43.12,
    e: 0.195,
    i: 28.21,
    O: 122.16,
    w: 239.0,
    M: 218.0,
    epoch: 2459000.5,
    periodDays: 103400,
    radiusEarth: 0.128,
    pole: [282.0, -10.0],
    rotHours: 3.92,
    look: { c0: '#d9d6d0', c1: '#b8b4ad', c2: '#eeece8', c3: '#9a958d', bands: 0, turb: 0, crater: 0.2, capSize: 0, seed: 13 },
    facts: '43 AU out, spinning once every four hours, so fast it is stretched into an egg; it has rings and two moons.',
  },
  {
    name: 'Makemake',
    kind: 'dwarf',
    a: 45.43,
    e: 0.161,
    i: 28.98,
    O: 79.62,
    w: 294.8,
    M: 165.5,
    epoch: 2459000.5,
    periodDays: 111800,
    radiusEarth: 0.112,
    pole: [280.0, 30.0],
    rotHours: 22.83,
    look: { c0: '#b5774e', c1: '#8c5a3a', c2: '#d3a07c', c3: '#5e3a24', bands: 0, turb: 0, crater: 0.3, capSize: 0, seed: 14 },
    facts: '45 AU out, reddish with methane frost, a 306 year year.',
  },
  {
    name: 'Eris',
    kind: 'dwarf',
    a: 67.86,
    e: 0.4361,
    i: 44.04,
    O: 35.95,
    w: 151.44,
    M: 205.0,
    epoch: 2459000.5,
    periodDays: 204200,
    radiusEarth: 0.182,
    pole: [280.0, 50.0],
    rotHours: 25.9,
    look: { c0: '#d8d4cc', c1: '#b2ada4', c2: '#f0eee9', c3: '#8c8780', bands: 0, turb: 0, crater: 0.1, capSize: 0, seed: 15 },
    facts: 'The most massive dwarf planet, on a 558 year orbit tipped 44 degrees, now near its farthest from the Sun at 96 AU.',
  },
]

type MoonSpec = {
  name: string
  parent: string
  aParentRadii: number
  radiusParent: number
  periodDays: number
  retro?: boolean
  plane: 'ecliptic' | 'equator'
  look: Look
  facts: string
}

const MOONS: MoonSpec[] = [
  { name: 'Moon', parent: 'Earth', aParentRadii: 60.3, radiusParent: 0.2727, periodDays: 27.32, plane: 'ecliptic', look: { c0: '#8f8f8c', c1: '#5a5a58', c2: '#aaa9a5', c3: '#45443f', bands: 0, turb: 0, crater: 1, capSize: 0, seed: 21 }, facts: 'The Moon. Keeps one face to Earth, 384,000 km out, a month round.' },
  { name: 'Io', parent: 'Jupiter', aParentRadii: 5.9, radiusParent: 0.0261, periodDays: 1.769, plane: 'equator', look: { c0: '#e2c35c', c1: '#b9862f', c2: '#f5e6a6', c3: '#8a541c', bands: 0, turb: 0, crater: 0.4, capSize: 0, seed: 22 }, facts: 'Io. Four hundred volcanoes, kneaded by Jupiter\'s tides, 1.8 days round.' },
  { name: 'Europa', parent: 'Jupiter', aParentRadii: 9.4, radiusParent: 0.0245, periodDays: 3.551, plane: 'equator', look: { c0: '#d9d0c2', c1: '#bba68d', c2: '#eeece8', c3: '#9c7f66', bands: 0.2, turb: 1.2, crater: 0, capSize: 0, seed: 23 }, facts: 'Europa. A cracked ice shell over an ocean with twice Earth\'s water, 3.6 days round.' },
  { name: 'Ganymede', parent: 'Jupiter', aParentRadii: 15.0, radiusParent: 0.0413, periodDays: 7.155, plane: 'equator', look: { c0: '#8f8779', c1: '#6b6359', c2: '#aca395', c3: '#4f473f', bands: 0, turb: 0, crater: 0.5, capSize: 0, seed: 24 }, facts: 'Ganymede. The largest moon in the system, bigger than Mercury, with its own magnetic field.' },
  { name: 'Callisto', parent: 'Jupiter', aParentRadii: 26.3, radiusParent: 0.0378, periodDays: 16.69, plane: 'equator', look: { c0: '#5f5a52', c1: '#43403a', c2: '#7f796f', c3: '#302d28', bands: 0, turb: 0, crater: 1, capSize: 0, seed: 25 }, facts: 'Callisto. The most cratered surface known, unchanged for four billion years.' },
  { name: 'Titan', parent: 'Saturn', aParentRadii: 20.3, radiusParent: 0.0442, periodDays: 15.95, plane: 'equator', look: { c0: '#d9a251', c1: '#bf8a3b', c2: '#ebc47c', c3: '#a2702c', bands: 0.25, turb: 0.6, crater: 0, capSize: 0, seed: 26 }, facts: 'Titan. Thicker air than Earth, rain and lakes of methane, 16 days round.' },
  { name: 'Titania', parent: 'Uranus', aParentRadii: 17.1, radiusParent: 0.0311, periodDays: 8.706, plane: 'equator', look: { c0: '#9a948c', c1: '#726d66', c2: '#b7b1a9', c3: '#55504a', bands: 0, turb: 0, crater: 0.6, capSize: 0, seed: 27 }, facts: 'Titania. Uranus\' largest moon, canyons three times deeper than the Grand Canyon.' },
  { name: 'Oberon', parent: 'Uranus', aParentRadii: 22.8, radiusParent: 0.0299, periodDays: 13.46, plane: 'equator', look: { c0: '#8c837a', c1: '#665e56', c2: '#aba39a', c3: '#4a443e', bands: 0, turb: 0, crater: 0.7, capSize: 0, seed: 28 }, facts: 'Oberon. Outermost of the big five, 13.5 days round.' },
  { name: 'Triton', parent: 'Neptune', aParentRadii: 14.3, radiusParent: 0.0549, periodDays: 5.877, retro: true, plane: 'equator', look: { c0: '#d8cbc3', c1: '#b9aba3', c2: '#efe8e3', c3: '#9d9089', bands: 0, turb: 0, crater: 0.2, cap: '#f4e6ea', capSize: 0.7, seed: 29 }, facts: 'Triton. Orbits backwards, a captured Kuiper belt world with nitrogen geysers, slowly spiralling in.' },
  { name: 'Charon', parent: 'Pluto', aParentRadii: 16.5, radiusParent: 0.51, periodDays: 6.387, plane: 'equator', look: { c0: '#a9a6a2', c1: '#7c7976', c2: '#c8c5c1', c3: '#5e5b58', bands: 0, turb: 0, crater: 0.4, cap: '#5a3a3a', capSize: 0.8, seed: 30 }, facts: 'Charon. Half Pluto\'s size; the two keep the same faces to each other for ever.' },
]

export const BELT_SPECS = {
  asteroids: { n: 2600, aMin: 2.1, aMax: 3.3, eMax: 0.2, iMax: 15 },
  trojans: { n: 700, spread: 14, eMax: 0.12, iMax: 20 },
  kuiper: { n: 3200, aMin: 30, aMax: 50, eMax: 0.15, iMax: 20 },
}

// Scale a real orbit: perihelion and aphelion each go through the distance
// law, which keeps "inside Mercury" inside Mercury however eccentric it is.
function scaledOrbit(aAU: number, e: number) {
  const q = distOf(aAU * (1 - e))
  const Qa = distOf(aAU * (1 + e))
  return { a: (q + Qa) / 2, e: (Qa - q) / (Qa + q) }
}

const wrap = (x: number) => x - Math.floor(x / (2 * Math.PI)) * 2 * Math.PI

export function julianDay(date: Date) {
  return date.getTime() / 86400000 + 2440587.5
}

export function buildSystem(date: Date, rand: () => number): Body[] {
  const JD = julianDay(date)
  const T = (JD - 2451545.0) / 36525
  const bodies: Body[] = []
  const index = new Map<string, number>()

  for (const p of PLANETS) {
    const el = p.el.map((v, k) => v + p.rate[k] * T) as Jpl
    const [aAU, e, iDeg, LDeg, wbarDeg, ODeg] = el
    const { a, e: es } = scaledOrbit(aAU, e)
    const M0 = wrap((LDeg - wbarDeg) * DEG)
    const w = (wbarDeg - ODeg) * DEG
    const pole = poleToScene(p.pole[0], p.pole[1])
    const R = radiusOf(p.radiusEarth)
    index.set(p.name, bodies.length)
    bodies.push({
      name: p.name,
      kind: 'planet',
      parent: -1,
      R,
      a,
      e: es,
      i: iDeg * DEG,
      O: ODeg * DEG,
      w,
      M0,
      n: Math.sqrt(GM / (a * a * a)),
      plane: 'ecliptic',
      pole,
      Q: poleFrame(pole),
      spin: SPIN_EARTH * (23.934 / p.rotHours),
      spin0: rand() * Math.PI * 2,
      locked: false,
      look: p.look,
      rings: p.rings ? { inner: p.rings.inner * R, outer: p.rings.outer * R, kind: p.rings.kind } : undefined,
      facts: p.facts,
    })
  }

  for (const s of SMALL) {
    const { a, e } = scaledOrbit(s.a, s.e)
    const M0 = wrap(s.M * DEG + ((JD - s.epoch) / s.periodDays) * 2 * Math.PI)
    const pole = poleToScene(s.pole[0], s.pole[1])
    const R = s.kind === 'comet' ? 2.2 : radiusOf(s.radiusEarth)
    index.set(s.name, bodies.length)
    bodies.push({
      name: s.name,
      kind: s.kind,
      parent: -1,
      R,
      a,
      e,
      i: s.i * DEG,
      O: s.O * DEG,
      w: s.w * DEG,
      M0,
      n: Math.sqrt(GM / (a * a * a)),
      plane: 'ecliptic',
      pole,
      Q: poleFrame(pole),
      spin: SPIN_EARTH * (23.934 / s.rotHours),
      spin0: rand() * Math.PI * 2,
      locked: false,
      look: s.look,
      facts: s.facts,
    })
  }

  for (const m of MOONS) {
    const pi = index.get(m.parent)!
    const parent = bodies[pi]
    const a = parent.R * Math.pow(m.aParentRadii, 0.55)
    const R = parent.R * Math.pow(m.radiusParent, 0.8)
    const Tscene = 45 * Math.pow(m.periodDays, 0.6)
    const n = ((m.retro ? -1 : 1) * 2 * Math.PI) / Tscene
    const pole: V3 = m.plane === 'equator' ? parent.pole : [0, 1, 0]
    index.set(m.name, bodies.length)
    bodies.push({
      name: m.name,
      kind: 'moon',
      parent: pi,
      R,
      a,
      e: 0,
      i: 0,
      O: 0,
      w: 0,
      M0: rand() * Math.PI * 2,
      n,
      plane: m.plane,
      pole,
      Q: poleFrame(pole),
      spin: n,
      spin0: 0,
      locked: true,
      look: m.look,
      facts: m.facts,
    })
  }
  return bodies
}

// Where a body is at scene time t. Moons need their parent's position, so
// callers evaluate parents first (the catalogue is in that order).
export function positionOf(b: Body, t: number, parentPos: ArrayLike<number> | null, pos: { [k: number]: number }, vel?: { [k: number]: number }) {
  if (b.kind !== 'moon') {
    orbitState(b.a, b.e, b.i, b.O, b.w, b.M0 + b.n * t, b.n, pos as ArrayLike<number> & { [k: number]: number }, vel)
    return
  }
  const phi = b.M0 + b.n * t
  const local = [b.a * Math.cos(phi), 0, -b.a * Math.sin(phi)]
  if (b.plane === 'equator') applyQ(b.Q, local, pos)
  else {
    pos[0] = local[0]
    pos[1] = local[1]
    pos[2] = local[2]
  }
  pos[0] += parentPos![0]
  pos[1] += parentPos![1]
  pos[2] += parentPos![2]
}

// Spin angle about the pole at time t. A locked moon turns with its orbit so
// the same face stays toward the parent.
export function spinOf(b: Body, t: number) {
  if (b.locked) return b.M0 + b.n * t + Math.PI
  return b.spin0 + b.spin * t
}
