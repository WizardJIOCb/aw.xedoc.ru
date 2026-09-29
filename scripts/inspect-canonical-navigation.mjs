/** Read-only reachability audit using the same navigation/terrain helpers. */
import { tsImport } from "tsx/esm/api";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const { NavigationGrid } = await tsImport(
  "../src/client/navigation.ts",
  import.meta.url,
);
const { terrainWalkable, terrainSegmentClear } = await tsImport(
  "../src/shared/canonical-map.ts",
  import.meta.url,
);
const base = new URL(process.argv[2] ?? "http://127.0.0.1:3190");
if (
  !["http:", "https:"].includes(base.protocol) ||
  base.username ||
  base.password
)
  throw Error("HTTP(S) origin without credentials required");
async function get(path) {
  const r = await fetch(new URL(path, base), {
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw Error(path + ": " + r.status);
  return r.json();
}
const [map, world] = await Promise.all([get("/api/map"), get("/api/world")]);
const limit = map.layout.limit,
  cell = 1,
  offset = cell * 0.5,
  width = limit * 2 + 1;
const grid = new NavigationGrid([], limit, cell, 0, {
  walkable: (p) => terrainWalkable(map, p.x, p.z),
  segmentClear: (a, b) => terrainSegmentClear(map, a, b),
});
const point = (id) => ({
  x: Math.floor(id / width) - limit + offset,
  z: (id % width) - limit + offset,
});
const idOf = (p) => (p.x + limit - offset) * width + p.z + limit - offset;
const walkable = new Uint8Array(width * width),
  reachable = new Uint8Array(width * width),
  queue = new Int32Array(width * width);
let seed = -1,
  best = Infinity,
  walkableCount = 0;
for (let id = 0; id < walkable.length; id++) {
  const p = point(id);
  if (!grid.walkable(p)) continue;
  walkable[id] = 1;
  walkableCount++;
  const score = (p.x - map.spawn.x) ** 2 + (p.z - map.spawn.z) ** 2;
  if (score < best && grid.segmentClear(map.spawn, p)) {
    seed = id;
    best = score;
  }
}
if (seed < 0) throw Error("Spawn has no connected grid node");
queue[0] = seed;
reachable[seed] = 1;
let head = 0,
  tail = 1;
let minX = Infinity,
  minZ = Infinity,
  maxX = -Infinity,
  maxZ = -Infinity;
const directions = [
  [-1, 0],
  [0, -1],
  [0, 1],
  [1, 0],
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];
while (head < tail) {
  const id = queue[head++],
    p = point(id);
  minX = Math.min(minX, p.x);
  maxX = Math.max(maxX, p.x);
  minZ = Math.min(minZ, p.z);
  maxZ = Math.max(maxZ, p.z);
  for (const [dx, dz] of directions) {
    const q = { x: p.x + dx, z: p.z + dz };
    if (Math.abs(q.x) > limit || Math.abs(q.z) > limit) continue;
    const next = idOf(q);
    if (!walkable[next] || reachable[next]) continue;
    if (
      dx &&
      dz &&
      (!walkable[idOf({ x: p.x + dx, z: p.z })] ||
        !walkable[idOf({ x: p.x, z: p.z + dz })])
    )
      continue;
    if (!grid.segmentClear(p, q)) continue;
    reachable[next] = 1;
    queue[tail++] = next;
  }
}
function approach(entity, range = 5.2) {
  let best;
  for (let rx=Math.max(0,Math.ceil(entity.x-range+limit-offset));rx<=Math.min(width-1,Math.floor(entity.x+range+limit-offset));rx++)
    for (let rz=Math.max(0,Math.ceil(entity.z-range+limit-offset));rz<=Math.min(width-1,Math.floor(entity.z+range+limit-offset));rz++) {
      const p = point(rx*width+rz),{x,z}=p,
        distance = Math.hypot(x - entity.x, z - entity.z);
      if (distance > range || !reachable[idOf(p)]) continue;
      const score = Math.hypot(x - map.spawn.x, z - map.spawn.z);
      if (!best || score < best.distanceFromSpawn)
        best = {
          point: p,
          distanceToEntity: distance,
          distanceFromSpawn: score,
        };
    }
  return best;
}
function measure(entity) {
  const reachableApproach = approach(
    entity,
    entity.type === "monster" ? 4 : 5.2,
  );
  let routeLength = null,
    waypoints = [];
  if (reachableApproach) {
    waypoints = grid.findRoute(map.spawn, reachableApproach.point);
    let previous = map.spawn;
    routeLength = 0;
    for (const p of waypoints) {
      routeLength += Math.hypot(p.x - previous.x, p.z - previous.z);
      previous = p;
    }
    if (!waypoints.length) routeLength = null;
  }
  return {
    id: entity.id,
    originalId: entity.originalId,
    name: entity.name,
    type: entity.type,
    role: entity.role,
    family: entity.family,
    resource: entity.resource,
    level: entity.level,
    hp: entity.hp,
    state: entity.state,
    point: { x: entity.x, z: entity.z },
    directDistance: Math.hypot(entity.x - map.spawn.x, entity.z - map.spawn.z),
    interactionReachable: !!reachableApproach,
    reachableApproach,
    routeLength,
    waypoints,
  };
}
const closest = (kind, predicate = () => true) =>
  world.entities
    .filter((e) => e.type === kind && predicate(e))
    .sort(
      (a, b) =>
        Math.hypot(a.x - map.spawn.x, a.z - map.spawn.z) -
        Math.hypot(b.x - map.spawn.x, b.z - map.spawn.z),
    )
    .slice(0, 8)
    .map(measure);
const entityCounts = {};
let reachableEntities = 0;
for (const e of world.entities) {
  const a = approach(e);
  const s = (entityCounts[e.type] ??= { total: 0, reachable: 0 });
  s.total++;
  if (a) {
    s.reachable++;
    reachableEntities++;
  }
}
const report = {
  at: new Date().toISOString(),
  target: base.origin,
  sourceSha256: map.sha256,
  spawn: map.spawn,
  grid: {
    limit,
    cell,
    offset,
    width,
    walkableNodes: walkableCount,
    reachableNodes: tail,
    seed: point(seed),
    bounds: { minX, minZ, maxX, maxZ },
  },
  reachableEntities,
  entityCounts,
  nearest: {
    resources: closest("resource"),
    monsters: closest("monster"),
    bank: closest("npc", (e) => e.role === "bank"),
    trader: closest("npc", (e) => e.role === "trader"),
    bob: closest("npc", (e) => e.role === "bob"),
  },
  boundary:
    "Reachability uses the remake shared terrain masks and NavigationGrid edges, including its storage seam restriction. It does not establish original-client collision fidelity or safety from aggressive creatures. No account was created and no movement/state mutation was sent.",
};
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = resolve(root, "artifacts/canonical-smoke");
await mkdir(directory, { recursive: true });
const path = resolve(directory, "reachability-" + Date.now() + ".json");
await writeFile(path, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(
  JSON.stringify(
    {
      reachableNodes: tail,
      walkableNodes: walkableCount,
      bounds: report.grid.bounds,
      entityCounts,
      nearest: Object.fromEntries(
        Object.entries(report.nearest).map(([key, value]) => [
          key,
          value
            .slice(0, 3)
            .map(({ id, name, interactionReachable, routeLength }) => ({
              id,
              name,
              interactionReachable,
              routeLength,
            })),
        ]),
      ),
      report: path,
    },
    null,
    2,
  ),
);
