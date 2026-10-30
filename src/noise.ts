// Value noise shared by the planet painter and the ground simulation, so the
// factories are placed on the same continents the texture draws. No
// dependencies, so it runs in Node for the physics tests.

export function hash3(x: number, y: number, z: number, seed: number) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1013904223) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function fade(t: number) {
  return t * t * (3 - 2 * t)
}

// Trilinear value noise on an integer lattice.
export function noise3(x: number, y: number, z: number, seed: number) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)
  const fx = fade(x - xi)
  const fy = fade(y - yi)
  const fz = fade(z - zi)
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t
  const c00 = lerp(hash3(xi, yi, zi, seed), hash3(xi + 1, yi, zi, seed), fx)
  const c10 = lerp(hash3(xi, yi + 1, zi, seed), hash3(xi + 1, yi + 1, zi, seed), fx)
  const c01 = lerp(hash3(xi, yi, zi + 1, seed), hash3(xi + 1, yi, zi + 1, seed), fx)
  const c11 = lerp(hash3(xi, yi + 1, zi + 1, seed), hash3(xi + 1, yi + 1, zi + 1, seed), fx)
  return lerp(lerp(c00, c10, fy), lerp(c01, c11, fy), fz)
}

export function fbm(x: number, y: number, z: number, seed: number, octaves = 5) {
  let f = 0
  let a = 0.5
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    f += a * noise3(x, y, z, seed + i * 17)
    norm += a
    x = x * 2.03 + 1.7
    y = y * 2.03 + 1.7
    z = z * 2.03 + 1.7
    a *= 0.5
  }
  return f / norm
}

export const smooth = (a: number, b: number, t: number) => {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)))
  return u * u * (3 - 2 * u)
}

export const mix = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

// Terrain height, 0..1 with sea level near 0.5, for a unit vector in the
// planet mesh's own frame. The painter and the site planner both call this,
// so a factory never lands in the sea.
export const PLANET_SEED = 3
export const SEA_LEVEL = 0.5
export function heightAt(mx: number, my: number, mz: number, seed = PLANET_SEED) {
  return fbm(-mx * 2.4, my * 2.4, mz * 2.4, seed)
}
