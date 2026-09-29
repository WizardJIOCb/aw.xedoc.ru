import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { CanonicalMapData } from "../src/shared/canonical-map.js";
import {
  mapIndex,
  mapPoint,
  terrainSegmentClear,
  terrainWalkable,
} from "../src/shared/canonical-map.js";
import type { WorldData } from "../src/shared/types.js";
import { mapVersion, populateCanonicalWorld } from "./canonical-world.js";
import { Game } from "./game.js";
import { emptyState } from "./persist.js";

const map = JSON.parse(
  readFileSync(new URL("../data/canonical-map.json", import.meta.url), "utf8"),
) as CanonicalMapData;
const sourceWorld = JSON.parse(
  readFileSync(new URL("../data/world.json", import.meta.url), "utf8"),
) as WorldData;
const world = populateCanonicalWorld(sourceWorld, map);
const distance = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);
function fixture() {
  let now = 10_000;
  const state = emptyState();
  const game = new Game(
    structuredClone(world),
    state,
    () => now,
    undefined,
    undefined,
    map,
  );
  const player = game.createPlayer("canonical-player", "Canonical fixture");
  game.connect(player.id);
  return {
    game,
    state,
    player,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("canonical world retains all 45 placed monster types and 148 NPCs with source placement IDs", () => {
  const definitions = new Map(map.definitions.map((d) => [d.originalId, d]));
  const monsters = world.entities.filter((e) => e.type === "monster");
  const npcs = world.entities.filter((e) => e.type === "npc");
  assert.equal(monsters.length, 1571);
  assert.equal(new Set(monsters.map((e) => e.originalId)).size, 45);
  assert.equal(npcs.length, 148);
  assert.equal(
    new Set(world.entities.map((e) => e.id)).size,
    world.entities.length,
  );
  const placements = new Map(map.placements.map((p) => [p.index, p]));
  for (const entity of [...monsters, ...npcs]) {
    assert.ok(entity.placementIndex !== undefined);
    const placement = placements.get(entity.placementIndex)!;
    assert.ok(placement, "source placement exists");
    assert.equal(entity.originalId, placement.originalId);
    assert.equal(entity.type, definitions.get(placement.originalId)?.kind);
    assert.equal(
      mapIndex(entity.x, entity.z),
      placement.index,
      "runtime centre remains in the source placement tile",
    );
  }
  const bob = npcs.find((e) => e.role === "bob")!;
  assert.equal(bob.originalId, 285);
  assert.equal(bob.placementIndex, 58407);
  assert.ok(distance(bob, map.spawn) < 6);
});

test("map migration preserves account, inventories, bank, bags and active crafting job", () => {
  const state = emptyState();
  const legacy = new Game(structuredClone(sourceWorld), state, () => 10_000);
  const player = legacy.createPlayer("legacy", "Legacy fixture");
  player.inventory = { bronze_sword: 1, copper_ore: 4 };
  player.bank = { copper_ore: 3 };
  player.equipped = "bronze_sword";
  player.credits = 317;
  player.quest.bobStarted = 1;
  state.accounts[player.id] = {
    id: player.id,
    name: player.name,
    passwordHash: "unit-fixture-hash",
    createdAt: 1,
  };
  state.sessions.fixtureSessionHash = {
    playerId: player.id,
    expiresAt: 100_000,
  };
  state.jobs[player.id] = {
    playerId: player.id,
    recipeId: "smelt_tin",
    completeAt: 50_000,
    inputs: { tin_ore: 2 },
    outputs: { tin_bar: 1 },
  };
  state.bags.legacyBag = {
    id: "legacyBag",
    owner: player.id,
    items: { raw_meat: 2 },
    privateUntil: 30_000,
    expiresAt: 100_000,
  };
  state.entities.push({
    id: "legacyBag",
    name: "Fixture bag",
    type: "loot",
    x: 0,
    z: 8,
  });
  const preserved = structuredClone({
    accounts: state.accounts,
    sessions: state.sessions,
    inventory: player.inventory,
    bank: player.bank,
    jobs: state.jobs,
    bags: state.bags,
  });
  const migrated = new Game(
    structuredClone(world),
    state,
    () => 10_000,
    undefined,
    undefined,
    map,
  );
  const actual = migrated.player(player.id);
  assert.deepEqual({ x: actual.x, z: actual.z }, map.spawn);
  assert.equal(state.mapVersion, mapVersion(map));
  assert.deepEqual(state.accounts, preserved.accounts);
  assert.deepEqual(state.sessions, preserved.sessions);
  assert.deepEqual(actual.inventory, preserved.inventory);
  assert.deepEqual(actual.bank, preserved.bank);
  assert.deepEqual(state.jobs, preserved.jobs);
  assert.deepEqual(state.bags, preserved.bags);
  assert.equal(actual.credits, 317);
  assert.equal(actual.quest.bobStarted, 1);
  assert.equal(actual.equipped, "bronze_sword");
  assert.equal(actual.online, false);
  const bag = state.entities.filter((e) => e.id === "legacyBag");
  assert.equal(bag.length, 1);
  assert.ok(terrainWalkable(map, bag[0].x, bag[0].z));
  assert.ok(actual.action?.includes("Изготовление"));
});

test("a repeated canonical restart does not reset player position, resource stock, monster damage or jobs", () => {
  const f = fixture();
  const destination = [0.2, -0.2, 0.4, -0.4]
    .map((dx) => ({ x: map.spawn.x + dx, z: map.spawn.z }))
    .find((p) => terrainWalkable(map, p.x, p.z))!;
  Object.assign(f.player, destination);
  f.player.inventory.copper_ore = 7;
  f.player.bank.tin_ore = 4;
  f.state.jobs[f.player.id] = {
    playerId: f.player.id,
    recipeId: "smelt_tin",
    completeAt: 60_000,
    inputs: { tin_ore: 2 },
    outputs: { tin_bar: 1 },
  };
  const resource = f.state.entities.find((e) => e.type === "resource")!;
  resource.stock = 7;
  const monster = f.state.entities.find((e) => e.type === "monster")!;
  monster.hp = 3;
  monster.alive = false;
  monster.respawnAt = 50_000;
  const persisted = structuredClone(f.state);
  const restarted = new Game(
    structuredClone(world),
    persisted,
    () => 11_000,
    undefined,
    undefined,
    map,
  );
  assert.deepEqual(
    { x: restarted.player(f.player.id).x, z: restarted.player(f.player.id).z },
    destination,
  );
  assert.deepEqual(restarted.player(f.player.id).inventory, f.player.inventory);
  assert.deepEqual(restarted.player(f.player.id).bank, f.player.bank);
  assert.deepEqual(persisted.jobs, f.state.jobs);
  assert.equal(persisted.entities.find((e) => e.id === resource.id)?.stock, 7);
  assert.equal(persisted.entities.find((e) => e.id === monster.id)?.hp, 3);
  assert.equal(
    persisted.entities.find((e) => e.id === monster.id)?.alive,
    false,
  );
  assert.equal(
    persisted.entities.find((e) => e.id === monster.id)?.respawnAt,
    50_000,
  );
});

test("canonical snapshots contain nearby entities and omit distant placements", () => {
  const f = fixture();
  const snapshot = f.game.snapshot(f.player.id);
  assert.ok(snapshot.entities.some((e) => e.role === "bob"));
  assert.ok(
    snapshot.entities.length > 0 &&
      snapshot.entities.length < f.state.entities.length,
  );
  assert.ok(snapshot.entities.every((e) => distance(e, f.player) < 55));
  const distant = f.state.entities.find((e) => distance(e, f.player) > 70)!;
  assert.ok(distant);
  assert.equal(
    snapshot.entities.some((e) => e.id === distant.id),
    false,
  );
  snapshot.entities[0].name = "modified client copy";
  assert.notEqual(
    f.state.entities.find((e) => e.id === snapshot.entities[0].id)?.name,
    "modified client copy",
  );
});

test("canonical spatial snapshots also omit remote players", () => {
  const f = fixture();
  const remote = f.game.createPlayer("remote", "Remote fixture");
  f.game.connect(remote.id);
  const point = world.entities.find(
    (e) => distance(e, map.spawn) > 80 && terrainWalkable(map, e.x, e.z),
  )!;
  Object.assign(remote, { x: point.x, z: point.z });
  assert.equal(
    f.game.snapshot(f.player.id).players.some((p) => p.id === remote.id),
    false,
  );
  Object.assign(remote, map.spawn);
  assert.equal(
    f.game.snapshot(f.player.id).players.some((p) => p.id === remote.id),
    true,
  );
});

test("canonical movement enforces 2m/s running, 1m/s walking and elapsed-time clamp", () => {
  const f = fixture();
  const direction = Array.from({ length: 16 }, (_, i) => ({
    x: Math.cos((i * Math.PI) / 8),
    z: Math.sin((i * Math.PI) / 8),
  })).find((d) =>
    terrainSegmentClear(map, f.player, {
      x: f.player.x + d.x * 2,
      z: f.player.z + d.z * 2,
    }),
  )!;
  assert.ok(direction, "spawn has a short traversable test segment");
  for (const [elapsed, running, expected] of [
    [250, true, 0.5],
    [250, false, 0.25],
    [10_000, true, 0.5],
  ] as const) {
    const start = { x: f.player.x, z: f.player.z };
    f.advance(elapsed);
    f.game.move(
      f.player.id,
      start.x + direction.x * 20,
      start.z + direction.z * 20,
      0,
      running,
    );
    assert.ok(Math.abs(distance(f.player, start) - expected) < 1e-6);
  }
});

test("server movement rejects crossing a real encoded tile wall even when both endpoints are walkable", () => {
  const f = fixture();
  let wall:
    { a: { x: number; z: number }; b: { x: number; z: number } } | undefined;
  for (let index = 0; index < map.terrain.length && !wall; index++) {
    const p = mapPoint(index),
      cell = map.terrain[index];
    const candidates = [];
    if (cell & 0x00100000)
      candidates.push({
        a: { x: p.x - 0.05, z: p.z + 0.5 },
        b: { x: p.x + 0.05, z: p.z + 0.5 },
      });
    if (cell & 0x00200000)
      candidates.push({
        a: { x: p.x + 0.5, z: p.z - 0.05 },
        b: { x: p.x + 0.5, z: p.z + 0.05 },
      });
    wall = candidates.find(
      ({ a, b }) =>
        terrainWalkable(map, a.x, a.z) &&
        terrainWalkable(map, b.x, b.z) &&
        !terrainSegmentClear(map, a, b),
    );
  }
  assert.ok(wall, "source map includes a standable tile-wall boundary");
  Object.assign(f.player, wall.a);
  f.advance(250);
  f.game.move(f.player.id, wall.b.x, wall.b.z, 0, true);
  assert.deepEqual({ x: f.player.x, z: f.player.z }, wall.a);
});
