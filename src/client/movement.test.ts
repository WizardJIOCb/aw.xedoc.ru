import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { CanonicalMapData, MapPoint } from "../shared/canonical-map.js";
import {
  mapIndex,
  terrainCombatClear,
  terrainSegmentClear,
  terrainWalkable,
} from "../shared/canonical-map.js";
import { NavigationGrid } from "./navigation.js";

const map = JSON.parse(
  readFileSync(
    new URL("../../data/canonical-map.json", import.meta.url),
    "utf8",
  ),
) as CanonicalMapData;
const splitClear = (a: MapPoint, b: MapPoint, pieces: number) => {
  let previous = a;
  for (let i = 1; i <= pieces; i++) {
    const next = {
      x: a.x + ((b.x - a.x) * i) / pieces,
      z: a.z + ((b.z - a.z) * i) / pieces,
    };
    if (!terrainSegmentClear(map, previous, next)) return false;
    previous = next;
  }
  return true;
};

test("the real failed Scorpion approach diagonal has identical whole and frame-sized collision results", () => {
  const a = { x: -138.5, z: -217.5 },
    b = { x: -137.5, z: -218.5 };
  // The old eight-sample ray returned true, although the actual shorter frame
  // crossing (-138,-218) rejected the same route and repeatedly replanned it.
  assert.equal(terrainSegmentClear(map, a, b), false);
  const failedStart = { x: -138.03033967593586, z: -217.96966032406414 };
  const failedEnd = { x: -137.87378623458116, z: -218.12621376541884 };
  assert.equal(terrainSegmentClear(map, failedStart, failedEnd), false);
  for (const [from, to] of [
    [a, b],
    [b, a],
  ])
    for (const pieces of [2, 3, 7, 8, 9, 13, 85])
      assert.equal(
        splitClear(from, to, pieces),
        terrainSegmentClear(map, from, to),
        `split into ${pieces} must not change the wall result`,
      );
});

test("roundoff at an exact tile vertex cannot hide a closed corner or block an open corner", () => {
  const fixture = { terrain: Array<number>(512 * 512).fill(0) };
  const start = { x: -10.5, z: -10.5 },
    end = { x: -9.5, z: -9.5 };
  for (const perturbation of [-1e-12, 0, 1e-12]) {
    const vertex = { x: -10 + perturbation, z: -10 - perturbation };
    assert.equal(terrainSegmentClear(fixture, start, vertex), true);
    assert.equal(terrainSegmentClear(fixture, vertex, end), true);
  }
  fixture.terrain[mapIndex(-9.5, -10.5)] = 0x00100000;
  assert.equal(terrainSegmentClear(fixture, start, end), false);
  for (const perturbation of [-1e-12, 0, 1e-12]) {
    const vertex = { x: -10 + perturbation, z: -10 - perturbation };
    assert.equal(terrainSegmentClear(fixture, start, vertex), false);
    assert.equal(terrainSegmentClear(fixture, vertex, end), false);
  }
});

test("real map diagonals preserve their collision result when divided at tile boundaries", () => {
  const regions = [
    { x: -141.5, z: -214.5 },
    { x: -116.5, z: -228.5 },
    { x: -128.5, z: -225.5 },
    { x: -129.5, z: -153.5 },
  ];
  let checked = 0;
  for (const region of regions)
    for (const dx of [-1, 1])
      for (const dz of [-1, 1]) {
        const end = { x: region.x + dx, z: region.z + dz };
        for (const [a, b] of [
          [region, end],
          [end, region],
        ]) {
          const whole = terrainSegmentClear(map, a, b);
          for (const pieces of [2, 7, 11, 60])
            assert.equal(splitClear(a, b, pieces), whole);
          checked++;
        }
      }
  assert.equal(checked, 32);
});

test("the stalled UI position routes to Scorpion 65054 and every walking frame reaches a valid attack position", () => {
  assert.ok(
    map.placements.some((p) => p.index === 65054),
    "target is a real source placement",
  );
  const grid = new NavigationGrid([], map.layout.limit, 1, 0, {
    walkable: (p) => terrainWalkable(map, p.x, p.z),
    segmentClear: (a, b) => terrainSegmentClear(map, a, b),
  });
  const start = { x: -116.687241875661, z: -228.312758124339 };
  // This saved monster position is an integer vertex beside a solid cell. The
  // character must approach a legal neighbour rather than enter that vertex.
  const target = { x: -129, z: -226 };
  const route = grid.findRoute(start, target);
  assert.ok(route.length > 0);
  const endpoint = route.at(-1)!;
  assert.ok(Math.hypot(endpoint.x - target.x, endpoint.z - target.z) <= 0.9);
  assert.equal(terrainCombatClear(map, endpoint, target, 1), true);
  for (const frameDistance of [1 / 60, 0.02, 0.04, 0.18]) {
    let position = { ...start },
      frames = 0;
    for (const waypoint of route) {
      assert.equal(grid.segmentClear(position, waypoint), true);
      while (
        Math.hypot(waypoint.x - position.x, waypoint.z - position.z) > 1e-7
      ) {
        const distance = Math.hypot(
          waypoint.x - position.x,
          waypoint.z - position.z,
        );
        const step = Math.min(distance, frameDistance);
        const next = {
          x: position.x + ((waypoint.x - position.x) / distance) * step,
          z: position.z + ((waypoint.z - position.z) / distance) * step,
        };
        assert.equal(
          grid.segmentClear(position, next),
          true,
          JSON.stringify({ position, next, waypoint, frameDistance }),
        );
        position = next;
        assert.ok(++frames < 5000, "walking must finish without a replan loop");
      }
    }
    assert.ok(Math.hypot(position.x - target.x, position.z - target.z) <= 0.9);
    assert.equal(terrainCombatClear(map, position, target, 1), true);
  }
});
