export type Point = { x: number; z: number };
export type Obstacle = { minX: number; maxX: number; minZ: number; maxZ: number };
export type NavigationRules = { walkable: (point: Point) => boolean; segmentClear: (a: Point, b: Point) => boolean };
const EPSILON = 1e-7;

/** Small cached grid: collision and every A* edge share the same inflated footprints. */
export class NavigationGrid {
  private readonly blocked: Uint8Array;
  private readonly width: number;
  private readonly obstacles: Obstacle[];
  constructor(obstacles: Obstacle[], readonly limit = 119, readonly cell = 1, clearance = .1, private readonly rules?: NavigationRules, private readonly offset = rules ? cell*.5 : 0) {
    this.width = Math.round(limit * 2 / cell) + 1;
    this.obstacles = obstacles.map(o => ({ minX: o.minX - clearance, maxX: o.maxX + clearance, minZ: o.minZ - clearance, maxZ: o.maxZ + clearance }));
    this.blocked = new Uint8Array(this.width * this.width);
    for (let i = 0; i < this.blocked.length; i++) this.blocked[i] = this.walkable(this.point(i)) ? 0 : 1;
  }
  walkable(p: Point): boolean {
    return Number.isFinite(p.x) && Number.isFinite(p.z) && Math.abs(p.x) <= this.limit && Math.abs(p.z) <= this.limit && (!this.rules || this.rules.walkable(p)) && !this.obstacles.some(o => p.x >= o.minX - EPSILON && p.x <= o.maxX + EPSILON && p.z >= o.minZ - EPSILON && p.z <= o.maxZ + EPSILON);
  }
  segmentClear(a: Point, b: Point): boolean {
    if (!this.walkable(a) || !this.walkable(b)) return false;
    return (!this.rules || this.rules.segmentClear(a, b)) && !this.obstacles.some(o => intersectsRectangle(a, b, o));
  }
  findRoute(start: Point, requested: Point): Point[] {
    if (![start.x, start.z, requested.x, requested.z].every(Number.isFinite) || !this.walkable(start)) return [];
    const goal = { x: Math.max(-this.limit, Math.min(this.limit, requested.x)), z: Math.max(-this.limit, Math.min(this.limit, requested.z)) };
    if (this.segmentClear(start, goal)) return [goal];
    const first = this.closestNode(start, true);
    let last = this.closestNode(goal, this.walkable(goal));
    // An exact wall/solid-cell vertex can be nominally walkable yet have no
    // collision-free line into it. Approach its nearest legal centre instead.
    if (last < 0) last = this.closestNode(goal, false);
    if (first < 0 || last < 0) return [];
    const costs = new Float64Array(this.blocked.length).fill(Infinity);
    const parents = new Int32Array(this.blocked.length).fill(-1);
    const closed = new Uint8Array(this.blocked.length);
    const queue = new MinHeap();
    const final = this.point(last);
    costs[first] = 0;
    queue.push({ id: first, g: 0, f: distance(this.point(first), final) });
    const neighbors = [[-1, 0], [0, -1], [0, 1], [1, 0], [-1, -1], [-1, 1], [1, -1], [1, 1]];
    while (queue.size) {
      const current = queue.pop()!;
      if (closed[current.id] || costs[current.id] !== current.g) continue;
      if (current.id === last) {
        const route: Point[] = [];
        for (let id = last; id >= 0; id = parents[id]) route.push(this.point(id));
        route.reverse();
        if (this.segmentClear(final, goal)) route.push(goal);
        return this.smooth(start, route);
      }
      closed[current.id] = 1;
      const x = Math.floor(current.id / this.width), z = current.id % this.width;
      const from = this.point(current.id);
      for (const [dx, dz] of neighbors) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= this.width || nz >= this.width) continue;
        const next = nx * this.width + nz;
        if (closed[next] || this.blocked[next]) continue;
        if (dx && dz && (this.blocked[nx * this.width + z] || this.blocked[x * this.width + nz])) continue;
        const point = this.point(next);
        if (!this.segmentClear(from, point)) continue;
        const g = current.g + this.cell * (dx && dz ? Math.SQRT2 : 1);
        if (g + EPSILON >= costs[next]) continue;
        costs[next] = g; parents[next] = current.id;
        queue.push({ id: next, g, f: g + distance(point, final) });
      }
    }
    return [];
  }
  private point(id: number): Point { return { x: Math.floor(id / this.width) * this.cell - this.limit + this.offset, z: (id % this.width) * this.cell - this.limit + this.offset }; }
  private closestNode(point: Point, requireLine: boolean): number {
    let best = -1, score = Infinity;
    for (let id = 0; id < this.blocked.length; id++) {
      if (this.blocked[id]) continue;
      const candidate = this.point(id), d = (candidate.x - point.x) ** 2 + (candidate.z - point.z) ** 2;
      if (d >= score || (requireLine && !this.segmentClear(point, candidate))) continue;
      best = id; score = d;
    }
    return best;
  }
  private smooth(start: Point, route: Point[]): Point[] {
    const result: Point[] = [];
    let anchor = start, index = 0;
    while (index < route.length) {
      let next = route.length - 1;
      while (next > index && !this.segmentClear(anchor, route[next])) next--;
      if (!this.segmentClear(anchor, route[next])) return [];
      if (distance(anchor, route[next]) > EPSILON) result.push(route[next]);
      anchor = route[next]; index = next + 1;
    }
    return result;
  }
}

function distance(a: Point, b: Point) { return Math.hypot(a.x - b.x, a.z - b.z); }
function intersectsRectangle(a: Point, b: Point, o: Obstacle): boolean {
  let enter = 0, exit = 1;
  for (const [origin, delta, min, max] of [[a.x, b.x - a.x, o.minX, o.maxX], [a.z, b.z - a.z, o.minZ, o.maxZ]]) {
    if (Math.abs(delta) < EPSILON) { if (origin < min || origin > max) return false; }
    else {
      let t1 = (min - origin) / delta, t2 = (max - origin) / delta;
      if (t1 > t2) [t1, t2] = [t2, t1];
      enter = Math.max(enter, t1); exit = Math.min(exit, t2);
      if (enter > exit + EPSILON) return false;
    }
  }
  return true;
}

type Node = { id: number; g: number; f: number };
class MinHeap {
  private values: Node[] = [];
  get size() { return this.values.length; }
  push(value: Node) {
    const a = this.values; a.push(value);
    let i = a.length - 1;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (!this.less(a[i], a[parent])) break;
      [a[parent], a[i]] = [a[i], a[parent]]; i = parent;
    }
  }
  pop(): Node | undefined {
    const a = this.values, first = a[0], tail = a.pop();
    if (!a.length) return first;
    a[0] = tail!;
    let i = 0;
    while (i * 2 + 1 < a.length) {
      let child = i * 2 + 1;
      if (child + 1 < a.length && this.less(a[child + 1], a[child])) child++;
      if (!this.less(a[child], a[i])) break;
      [a[child], a[i]] = [a[i], a[child]]; i = child;
    }
    return first;
  }
  private less(a: Node, b: Node) { return a.f < b.f || (a.f === b.f && a.id < b.id); }
}

export function screenRelativeMovement(horizontal: number, vertical: number, yaw: number): Point {
  const length = Math.hypot(horizontal, vertical);
  if (!length) return { x: 0, z: 0 };
  return { x: (horizontal * Math.cos(yaw) + vertical * Math.sin(yaw)) / length, z: (-horizontal * Math.sin(yaw) + vertical * Math.cos(yaw)) / length };
}
