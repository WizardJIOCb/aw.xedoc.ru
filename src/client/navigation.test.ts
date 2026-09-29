import { test } from "node:test";
import assert from "node:assert/strict";
import { NavigationGrid, screenRelativeMovement, type Point } from "./navigation.js";

function assertClear(grid: NavigationGrid, start: Point, route: Point[]) {
  assert.ok(route.length);
  for (const point of route) { assert.ok(grid.walkable(point)); assert.ok(grid.segmentClear(start, point), JSON.stringify({ start, point })); start = point; }
}
test("click route detours around a building and preserves the precise ground destination", () => {
  const grid = new NavigationGrid([{ minX: -2, maxX: 2, minZ: -3, maxZ: 3 }], 12);
  const start = { x: -7.3, z: .2 }, destination = { x: 7.4, z: .15 };
  const route = grid.findRoute(start, destination);
  assertClear(grid, start, route);
  assert.ok(route.length > 1);
  assert.deepEqual(route.at(-1), destination);
  assert.deepEqual(grid.findRoute(start, destination), route);
});
test("diagonal paths cannot cut through building corners or an impassable barrier", () => {
  const grid = new NavigationGrid([{ minX: -1, maxX: 1, minZ: -10, maxZ: 10 }], 10);
  assert.deepEqual(grid.findRoute({ x: -5, z: 0 }, { x: 5, z: 0 }), []);
  assert.equal(grid.segmentClear({ x: -2, z: 8 }, { x: 2, z: 10 }), false);
});
test("clicks inside a building resolve to a reachable exterior point", () => {
  const grid = new NavigationGrid([{ minX: -2, maxX: 2, minZ: -2, maxZ: 2 }], 12);
  const start = { x: -6, z: 0 }, route = grid.findRoute(start, { x: 0, z: 0 });
  assertClear(grid, start, route);
  assert.equal(grid.walkable({ x: 0, z: 0 }), false);
});
test("world limits clamp click destinations and invalid coordinates never produce routes", () => {
  const grid = new NavigationGrid([], 119);
  assert.deepEqual(grid.findRoute({ x: 0, z: 0 }, { x: 500, z: -500 }), [{ x: 119, z: -119 }]);
  assert.deepEqual(grid.findRoute({ x: 0, z: 0 }, { x: NaN, z: 0 }), []);
});
test("WASD remains screen-relative at 45 and 90 degree camera yaw with equal diagonal speed", () => {
  const w = screenRelativeMovement(0, -1, Math.PI / 4), d = screenRelativeMovement(1, 0, Math.PI / 4);
  assert.ok(Math.abs(w.x + Math.SQRT1_2) < 1e-8 && Math.abs(w.z + Math.SQRT1_2) < 1e-8);
  assert.ok(Math.abs(d.x - Math.SQRT1_2) < 1e-8 && Math.abs(d.z + Math.SQRT1_2) < 1e-8);
  const diagonal = screenRelativeMovement(1, -1, Math.PI / 2);
  assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.z) - 1) < 1e-8);
  assert.ok(Math.abs(screenRelativeMovement(0, -1, Math.PI / 2).x + 1) < 1e-8);
});
