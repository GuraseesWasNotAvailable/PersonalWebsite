# The engine behind gurasees.com

A self-running simulation in the manner of Dyson Sphere Program: an economy on
Earth turns ore into solar sails and carrier rockets, rails fire the sails into
orbit, silos fire the rockets at the sphere, rockets build nodes and frames,
sails are absorbed into the shells that the frames enclose, and the sphere's
power feeds back into the factories. No player. Everything on screen is driven
by this engine, and every number in the readout comes from it.

## Conventions that every module follows

- Scene units. The Sun is at the origin. Earth orbits at about 910. The sail
  lanes are circular orbits at radii 190, 245 and 300. Shell layers sit between
  them at 215, 272 and 330. `GM` for the Sun is 72000 and is exported from
  `src/swarm.ts`; import it, never redefine it.
- Time is simulation seconds. The page runs 1.8 simulation seconds per real
  second. A full Earth day is 126 s of simulation time, a year 648 s.
- Pure modules (`economy.ts`, `sphere.ts`, `rockets.ts`) import nothing from
  three. They use typed arrays, are deterministic given a seed (use
  `mulberry32` from `src/swarm.ts`), never allocate in their per-step methods,
  and never produce NaN. Every pure module ships with a Node test in `tools/`
  that bundles with the repo's esbuild (see the header of
  `tools/ground_test.ts`) and prints numbers a human can judge.
- Render modules (`sphereview.ts`) take the pure state and draw it with as few
  draw calls as possible: instanced meshes and merged geometry, one material
  per kind. Colours brighter than 1.0 bloom; keep that for things meant to glow.
- TypeScript strict with `noUnusedLocals` and `noUnusedParameters`. Style as
  the existing files: no semicolons, single quotes, two spaces, long lines are
  fine. Comments explain why, not what. No em dashes anywhere, in code
  comments or on the page.
- `npx tsc --noEmit` must pass before a module is done.

## Modules

### `src/economy.ts`, the factories as numbers

One `SiteEconomy` per factory site on Earth (eleven sites; the count is passed
in). Simplified chain, consistent rates.

```ts
export type Ore = 'iron' | 'copper' | 'silicon' | 'titanium'
export const ORES: readonly Ore[]

export type SiteEconomy = {
  veins: Record<Ore, number>   // share of hauled ore of each kind, sums to 1
  ore: Record<Ore, number>     // raw stock
  ingots: Record<Ore, number>  // smelted stock
  sails: number                // finished sails, waiting for the belts
  rockets: number              // finished carrier rockets, waiting for the silo
  smelters: number
  assemblers: number
  rocketPlants: number         // 0 at most sites; titanium rich sites have 1 or 2
  panels: number               // solar panels
  receivers: number            // ray receivers taking the sphere's power
  power: { supply: number; demand: number; satisfaction: number; solar: number; ray: number } // MW
  made: { sails: number; rockets: number } // running totals
}

export const RECIPES: {
  smelt: { seconds: 1; ore: 1 }                              // per smelter: 1 ore to 1 ingot each second
  sail: { seconds: 4; iron: 1; copper: 1; silicon: 1 }       // per assembler
  rocket: { seconds: 12; titanium: 6; iron: 3; silicon: 2 }  // per rocket plant
}
export const POWER_MW: { smelter: 0.36; assembler: 0.27; rocketPlant: 0.9; panel: 0.36; receiverMax: 4 }
export const STOCK_CAP: number // per ore kind and per ingot kind, so stocks do not grow without bound

export class Economy {
  readonly sites: SiteEconomy[]
  constructor(siteCount: number, rand: () => number)
  // Haulers hand ore to the factory dock. Split by the site's veins.
  deliverOre(site: number, amount: number): void
  // One step. sun[i] is the Sun's elevation at site i in 0..1 (0 at night).
  // sphereMW is the whole sphere's output; each receiver draws up to
  // receiverMax of its fair share. Smelting and assembly run at
  // satisfaction = min(1, supply / demand), where supply is solar + ray and
  // demand is every building that has something to do.
  tick(dt: number, sun: ArrayLike<number>, sphereMW: number): void
  takeSail(site: number): boolean    // consume one finished sail for a belt package
  takeRocket(site: number): boolean  // consume one finished rocket for a silo
  // Recent production rates across all sites, in items per second, from an
  // exponential moving average inside tick.
  rates(): { sailsPerSec: number; rocketsPerSec: number; supplyMW: number; demandMW: number }
  // Fast forward: the state after `seconds` at a given hauled ore rate per
  // site, average sun of 0.5 and a sphere output of sphereMW. Must be cheap
  // (closed form or a few hundred coarse steps), used once at page load.
  advance(seconds: number, oreRatePerSite: number, sphereMW: number): void
}
```

Veins: assign each site a mix. Eight sites are iron, copper and silicon in
varying shares with no titanium; three sites are titanium rich (0.5 titanium,
the rest iron and silicon) and get rocket plants. Building counts per site:
3 smelters, 2 assemblers, 0 to 2 rocket plants, 12 panels, 2 receivers.

Numbers to hit (the test prints them): with 3.6 ore per second hauled to each
site and full sun, the eleven sites together should make about 10 to 14 sails
per second and 0.2 to 0.3 rockets per second; at night with no sphere power,
sail output should fall to under a third of that; with 60 MW of sphere power
at night it should be back near full.

### `src/sphere.ts`, the structure and its construction

```ts
export type Target = { layer: number; kind: 0 | 1; index: number } // 0 node, 1 edge

export class DysonSphere {
  readonly layers: Array<{
    R: number
    nodes: Float32Array   // 3 per node, unit vectors in the sphere's own frame
    edges: Uint16Array    // 2 node indices per edge
    faces: Uint16Array    // 3 node indices per face
    nodeProg: Float32Array  // 0..1
    edgeProg: Float32Array  // 0..1
    faceFill: Float32Array  // 0..1, absorbed sails over FACE_CELLS
    inbound: Uint16Array    // sails currently steering for each face
  }>
  readonly NODE_COST: number   // rockets per node, 40
  readonly EDGE_COST: number   // rockets per frame, 60
  readonly FACE_CELLS: number  // sails per shell face, 1500
  spin: number                 // radians per second about the axis, slow
  axis: [number, number, number]
  constructor(radii: number[], frequency: number, seed: number) // frequency 2 gives 42 nodes, 120 edges, 80 faces per layer
  // Position of a node, or the midpoint of an edge, in world space at time t.
  structurePos(target: Target, t: number, out: { [k: number]: number }): void
  // Where the next rocket should go, or null when every layer is complete.
  // Build order: a layer at a time, outward; within a layer, the node with
  // the most complete neighbours first, then edges whose both nodes are
  // complete, nearest the first node. Spread work across up to six targets
  // at once so rockets do not all queue on one node.
  nextTarget(): Target | null
  deliverRocket(target: Target): void   // one rocket's worth of progress
  // Faces whose three frames are complete and whose fill is below 1, with
  // the centroid in world space at time t, up to `max` of them, favouring
  // faces with few inbound sails.
  readyFaces(t: number, max: number, out: Array<{ layer: number; face: number; cx: number; cy: number; cz: number }>): number
  absorb(layer: number, face: number): void        // one sail into the shell
  setInbound(layer: number, face: number, delta: number): void
  powerMW(): number       // 0.03 MW per absorbed sail, 1.5 MW extra per finished face
  completion(): number    // 0..1 over nodes, frames and cells, all three layers
  counts(): { nodes: number; nodesDone: number; frames: number; framesDone: number; faces: number; facesDone: number; cells: number }
  // Fast forward the construction given production rates, in build order,
  // including the time rockets spend in flight (take 90 s per rocket of
  // travel, so progress lags production by that). Cheap.
  advance(seconds: number, rocketsPerSec: number, sailsPerSec: number): void
}
```

The geodesic: subdivide an icosahedron (frequency 2), project to the unit
sphere, dedupe shared vertices, derive the edge and face lists. Every layer
uses the same mesh scaled to its radius; the sphere turns slowly about an
axis tilted about 0.3 radians from +y.

### `src/rockets.ts`, carrier rockets in flight

Same integrator as the sails: gravity from the Sun (`GM`), semi-implicit Euler,
a steering law toward the target's current position with a top speed and a
top acceleration, so a rocket launched from Earth with 18 units per second of
speed reaches a node 700 units away in about 90 s.

```ts
export class Rockets {
  readonly N: number
  readonly pos: Float32Array   // 3 per rocket
  readonly vel: Float32Array
  readonly alive: Uint8Array
  readonly target: Int32Array  // layer * 1000000 + kind * 100000 + index, or -1
  constructor(N: number)
  launch(pos: ArrayLike<number>, vel: ArrayLike<number>, target: Target): boolean  // false when none free
  step(dt: number, sphere: DysonSphere, t: number): void  // steer, arrive within 3 units, deliverRocket, free the slot
  count(): number
}
```

### `src/sphereview.ts`, drawing the sphere

```ts
export function buildSphereView(sphere: DysonSphere): { group: THREE.Group; update(t: number): void }
```

- Nodes: one instanced sphere of radius 2.4; scale 0.3 to 1 with progress,
  colour from dark steel to a glowing blue white (brighter than 1.0) when done.
- Frames: one instanced thin cylinder (radius 0.45) per edge, laid from the
  first node toward the second and scaled in length by progress, same colour
  ramp.
- Shells: one geometry per layer of all its faces, each face a triangle pulled
  2 units inside the frame radius, with per-vertex attributes for the face
  fill and barycentric coordinates. The shader draws a dark translucent skin
  where fill is above 0, and a hexagonal cell pattern whose cells light up in
  a fixed pseudo random order as fill rises, so a face fills in cell by cell
  rather than fading. Lit cells glow (above 1.0). Faces with fill 0 draw
  nothing. Double sided, transparent, no depth write.
- Rockets are drawn by the page, not here.
- `update(t)` rotates the group with the sphere's spin and refreshes the
  instance matrices and colours and the fill attribute from the pure state.

## The page: how it ties together

- On load, the elapsed time since a fixed epoch, in real seconds, times 1.8,
  modulo a 24 hour cycle, is the simulation time the world has already run.
  The economy and the sphere are fast forwarded by that, so a visitor arrives
  at whatever stage of construction the clock says. The cycle restarts when
  the sphere is complete and has stood for a while.
- The ground simulation (`surface.ts`) hands hauled ore to the economy, builds
  a belt package only when the economy has a finished sail for that site, and
  fires a rocket from the site's silo when the economy has one and the sphere
  has a target. The Sun's elevation at each site drives its solar power.
- The swarm (`swarm.ts`) gains an absorbing state: a sail in orbit chosen for
  a ready face steers to the face centroid and is absorbed, which returns its
  slot to the queue, so the fleet stays bounded while the shells fill.
- The readout shows the sphere's power in GW, its completion, nodes and
  frames done, and the factories' power satisfaction.

## Decisions made while building it (2026-10-31)

- Economy yield. The literal recipe at two assemblers per site gives four
  sails a second across Earth, far below what the rails fire, so one assembler
  cycle folds its inputs into three sails (`YIELD.sail = 3`). Each titanium
  site has one rocket plant, giving 0.25 rockets a second in all. Finished
  goods cap at 3000 sails and 240 rockets per site. `advance` ticks the real
  chain for the first 600 s then extends in closed form, about 1 ms for a day.
- Sphere costs. 40 rockets a node, 60 a frame, 900 sails a shell face. The
  structure of all three layers takes about 27,000 rockets, so at 0.25 a
  second it completes around 30 hours of simulation, 17 hours of real time;
  the shells follow a few hours behind. The cycle is 24 real hours from
  2026-10-31 00:00 UTC, so the finished sphere stands for the last quarter.
- Absorption. Up to sixteen ready faces draw sails at once, ten inbound each,
  about half the launch rate, so the swarm stays dense while shells fill.
- Look. Nothing on the sphere is brighter than about 1.0 except thin strut
  highlights: a finished sphere fills the view from the star and anything
  brighter blooms the page to white. Cells are dark translucent panes with
  glowing rims, so even a complete shell reads as a lattice with the Sun
  inside. An unbuilt frame collapses on every axis; collapsing only its
  length left end caps with zero normals, and one NaN fragment turned the
  whole bloom pass black.
- Camera. The star view sits 900 units out so the finished sphere, radius
  330, fills about half the height. `?t=<hours>` opens the build at that
  point of the cycle, for looking and for tests.
