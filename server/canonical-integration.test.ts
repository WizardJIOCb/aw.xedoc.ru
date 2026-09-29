import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { CanonicalMapData } from "../src/shared/canonical-map.js";
import {
  terrainSegmentClear,
  terrainWalkable,
} from "../src/shared/canonical-map.js";
import {
  derivedAttributes,
  levelForXp,
  xpForLevel,
} from "../src/shared/progression.js";
import type { WorldData } from "../src/shared/types.js";
import { closestWalkable, populateCanonicalWorld } from "./canonical-world.js";
import { Game } from "./game.js";
import { emptyState } from "./persist.js";

const sourceWorld = JSON.parse(
  readFileSync(new URL("../data/world.json", import.meta.url), "utf8"),
) as WorldData;
const sourceMap = JSON.parse(
  readFileSync(new URL("../data/canonical-map.json", import.meta.url), "utf8"),
) as CanonicalMapData;
const canonicalWorld = populateCanonicalWorld(sourceWorld, sourceMap);

function fixture(
  world: WorldData = canonicalWorld,
  map: CanonicalMapData = sourceMap,
) {
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
  const player = game.createPlayer("integration-player", "Integration fixture");
  game.connect(player.id);
  return {
    game,
    state,
    player,
    map,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

// Isolate combat from production placement density while retaining the real item
// catalogue, original sword range and the encoded MAP collision rules.
function combatFixture() {
  const map: CanonicalMapData = {
    version: 1,
    source: "isolated collision fixture",
    sha256: "collision-fixture",
    layout: { width: 512, height: 512, origin: 256, limit: 255, unit: 1 },
    spawn: { x: -100, z: -100 },
    terrain: Array<number>(512 * 512).fill(0),
    definitions: [],
    placements: [],
  };
  const world: WorldData = {
    ...sourceWorld,
    entities: [
      {
        id: "integration-monster",
        name: "Integration monster",
        type: "monster",
        x: -4.6,
        z: -5.5,
        hp: 500,
        maxHp: 500,
        level: 1,
        attackRange: 1,
        damage: [{ type: 0, amount: 2 }],
        alive: true,
      },
    ],
  };
  const f = fixture(world, map);
  Object.assign(f.player, { x: -5.5, z: -5.5 });
  const enemy = f.state.entities[0];
  const wallIndex = 251 * 512 + 250;
  return {
    ...f,
    enemy,
    wall: (blocked: boolean) => {
      map.terrain[wallIndex] = blocked ? 0x00100000 : 0;
    },
  };
}

test("every shipped recipe has a compatible station somewhere on the canonical map", () => {
  assert.equal(canonicalWorld.recipes.length, 135);
  const stations = canonicalWorld.entities.filter((e) => e.type === "station");
  for (const recipe of canonicalWorld.recipes) {
    if (!recipe.station || recipe.station === "none") continue;
    assert.ok(
      stations.some((e) => e.capabilities?.includes(recipe.station)),
      `${recipe.id} requires an unavailable ${recipe.station}`,
    );
  }
  const loom = stations.find(
    (e) => e.name.replace(/\s+/g, " ").toLowerCase() === "sewing machine",
  );
  assert.ok(
    loom?.capabilities?.includes("loom"),
    "source whitespace must not disable tailoring",
  );
});

test("canonical restarts refresh source metadata while retaining damage, position, respawn and resource depletion", () => {
  const f = fixture();
  const monster = f.state.entities.find(
    (e) => e.type === "monster" && e.maxHp! > 5,
  )!;
  const secondMonster = f.state.entities.find(
    (e) => e.type === "monster" && e.id !== monster.id,
  )!;
  const resource = f.state.entities.find(
    (e) => e.type === "resource" && e.resource,
  )!;
  const press = f.state.entities.find(
    (e) => e.type === "station" && e.state === "press",
  )!;
  const bob = f.state.entities.find((e) => e.role === "bob")!;
  const definitions = new Map(canonicalWorld.entities.map((e) => [e.id, e]));
  const position = { x: monster.x + 0.2, z: monster.z + 0.2 };
  Object.assign(monster, {
    ...position,
    hp: 3,
    maxHp: 9999,
    alive: false,
    respawnAt: 50_000,
    name: "stale monster",
    originalId: -1,
    modelId: -1,
    level: 120,
    attackRange: 99,
    state: "stale aggression",
    resource: "stale drop",
    damage: [{ type: 7, amount: 999 }],
    resistances: [999],
  });
  Object.assign(secondMonster, { hp: 9999, maxHp: 9999 });
  Object.assign(resource, {
    stock: 7,
    alive: false,
    respawnAt: 60_000,
    x: 0,
    z: 0,
    name: "stale resource",
    originalId: -1,
    resource: "stale item",
  });
  press.capabilities = ["stale station"];
  press.name = "stale station";
  bob.role = "stale role";
  bob.name = "stale NPC";
  const state = structuredClone(f.state);
  new Game(
    structuredClone(canonicalWorld),
    state,
    () => 11_000,
    undefined,
    undefined,
    sourceMap,
  );
  const restored = new Map(state.entities.map((e) => [e.id, e]));
  const actualMonster = restored.get(monster.id)!;
  const sourceMonster = definitions.get(monster.id)!;
  assert.deepEqual({ x: actualMonster.x, z: actualMonster.z }, position);
  assert.equal(actualMonster.hp, 3);
  assert.equal(actualMonster.alive, false);
  assert.equal(actualMonster.respawnAt, 50_000);
  for (const key of [
    "name",
    "originalId",
    "modelId",
    "level",
    "maxHp",
    "attackRange",
    "state",
    "resource",
  ] as const)
    assert.equal(
      actualMonster[key],
      sourceMonster[key],
      `stale saved ${key} must not override the current catalogue`,
    );
  assert.deepEqual(actualMonster.damage, sourceMonster.damage);
  assert.deepEqual(actualMonster.resistances, sourceMonster.resistances);
  assert.equal(
    restored.get(secondMonster.id)!.hp,
    definitions.get(secondMonster.id)!.maxHp,
    "obsolete HP must be clamped to the current maximum",
  );
  const actualResource = restored.get(resource.id)!;
  const sourceResource = definitions.get(resource.id)!;
  assert.equal(actualResource.stock, 7);
  assert.equal(actualResource.alive, false);
  assert.equal(actualResource.respawnAt, 60_000);
  for (const key of ["x", "z", "name", "originalId", "resource"] as const)
    assert.equal(actualResource[key], sourceResource[key]);
  assert.deepEqual(
    restored.get(press.id),
    definitions.get(press.id),
    "station capabilities come from the current map adapter",
  );
  assert.deepEqual(
    restored.get(bob.id),
    definitions.get(bob.id),
    "NPC service roles must not be pinned by old saved state",
  );
});

test("a real bronze sword recipe consumes inputs at a canonical Press and returns its reusable program once", () => {
  const f = fixture();
  const press = f.state.entities.find(
    (e) => e.type === "station" && e.state === "press",
  )!;
  const recipe = f.game.recipes.get("forge_bronze_sword")!;
  assert.ok(press && recipe);
  assert.equal(recipe.station, "forge");
  assert.ok(press.capabilities?.includes("forge"));
  Object.assign(f.player, closestWalkable(sourceMap, press));
  assert.ok(terrainWalkable(sourceMap, f.player.x, f.player.z));
  assert.ok(Math.hypot(f.player.x - press.x, f.player.z - press.z) <= 6);
  f.player.skills[recipe.skill] = 120;
  f.player.stats.intellect = 120;
  f.player.inventory = { ...recipe.inputs };
  f.player.equipped = null;
  f.game.action(f.player.id, { action: "craft", recipe: recipe.id });
  assert.deepEqual(f.state.jobs[f.player.id].inputs, recipe.inputs);
  assert.deepEqual(f.player.inventory, {});
  f.advance(Math.ceil(Math.max(0.2, recipe.seconds) * 1000));
  f.game.tick();
  assert.equal(f.state.jobs[f.player.id], undefined);
  assert.deepEqual(f.player.inventory, recipe.outputs);
  assert.equal(f.player.inventory.swords_disk, 1);
  f.advance(500);
  f.game.tick();
  assert.deepEqual(
    f.player.inventory,
    recipe.outputs,
    "completed jobs cannot duplicate outputs on another tick",
  );
});

test("an already hostile monster cannot hit through a tile wall and resumes after the wall opens", () => {
  const f = combatFixture();
  f.game.action(f.player.id, { action: "attack", target: f.enemy.id });
  f.wall(true);
  assert.equal(terrainSegmentClear(f.map, f.player, f.enemy), false);
  const hp = f.player.hp;
  f.advance(1000);
  f.game.tick();
  assert.equal(f.player.hp, hp);
  f.wall(false);
  assert.equal(terrainSegmentClear(f.map, f.player, f.enemy), true);
  f.advance(500);
  f.game.tick();
  assert.equal(f.player.hp, hp - 2);
});

test("retaliating monsters stop damaging a player who returns inside the safe radius", () => {
  const f = combatFixture();
  f.game.action(f.player.id, { action: "attack", target: f.enemy.id });
  Object.assign(f.player, f.map.spawn);
  Object.assign(f.enemy, { x: f.player.x + 0.9, z: f.player.z });
  const hp = f.player.hp;
  f.advance(1000);
  f.game.tick();
  assert.equal(f.player.hp, hp);
  Object.assign(f.player, { x: f.map.spawn.x - 12.1 });
  Object.assign(f.enemy, { x: f.player.x + 0.9, z: f.player.z });
  f.advance(1000);
  f.game.tick();
  assert.equal(
    f.player.hp,
    hp - 2,
    "safe-zone protection must not disable all retaliation",
  );
});

test("PvP uses the original melee range and encoded walls, while nearby unobstructed attacks still work", () => {
  const f = combatFixture();
  const victim = f.game.createPlayer(
    "integration-victim",
    "Integration victim",
  );
  f.game.connect(victim.id);
  f.player.level = 10;
  Object.assign(victim, { x: -1, z: -5.5, level: 10, hp: 100, maxHp: 100 });
  assert.equal(f.player.equipped, "bronze_sword");
  assert.throws(
    () => f.game.action(f.player.id, { action: "attack", target: victim.id }),
    /радиус оружия/,
  );
  assert.equal(victim.hp, 100);
  Object.assign(victim, { x: -4.6 });
  f.wall(true);
  assert.throws(
    () => f.game.action(f.player.id, { action: "attack", target: victim.id }),
    /препятствие/,
  );
  assert.equal(victim.hp, 100);
  assert.equal(f.player.pk, 0, "rejected attacks must not count as PK");
  f.wall(false);
  f.game.action(f.player.id, { action: "attack", target: victim.id });
  assert.ok(victim.hp < 100);
  assert.equal(f.player.pk, 1);
});

test("migration preserves skill levels and earned XP, and restarting does not award migration XP again", () => {
  const state = emptyState();
  const legacy = new Game(structuredClone(sourceWorld), state, () => 10_000);
  const player = legacy.createPlayer(
    "legacy-progression",
    "Legacy progression",
  );
  player.skills.geology = 37;
  player.skills.metallurgy = 12;
  player.skills.fencing = 19;
  player.quest["skillXp:geology"] = 1;
  player.quest["skillXp:metallurgy"] = xpForLevel(13) + 7;
  player.quest["skillXp:fencing"] = xpForLevel(19) + 31;
  player.quest.bobComplete = 1;
  player.level = 20;
  player.xp = 40_007;
  state.progressionVersion = undefined;
  const beforeSkills = structuredClone(player.skills);
  const beforeStats = structuredClone(player.stats);
  const migrated = new Game(
    structuredClone(canonicalWorld),
    state,
    () => 10_000,
    undefined,
    undefined,
    sourceMap,
  );
  const actual = migrated.player(player.id);
  assert.equal(actual.xp, 40_007);
  assert.deepEqual(actual.skills, beforeSkills);
  assert.deepEqual(actual.stats, beforeStats);
  assert.equal(actual.quest["skillXp:geology"], xpForLevel(37));
  assert.equal(actual.quest["skillXp:metallurgy"], xpForLevel(13) + 7);
  assert.equal(actual.quest["skillXp:fencing"], xpForLevel(19) + 31);
  assert.equal(actual.quest.bobComplete, 1);
  const savedProgress = structuredClone({
    xp: actual.xp,
    skills: actual.skills,
    stats: actual.stats,
    quest: actual.quest,
  });
  new Game(
    structuredClone(canonicalWorld),
    state,
    () => 11_000,
    undefined,
    undefined,
    sourceMap,
  );
  assert.deepEqual(
    {
      xp: actual.xp,
      skills: actual.skills,
      stats: actual.stats,
      quest: actual.quest,
    },
    savedProgress,
  );
});

test("canonical death removes one eighth of every XP pool and recomputes attributes without duplicating reserved items", () => {
  const f = fixture();
  f.player.xp = 32_007;
  const skillXp = { geology: 4_407, metallurgy: 2_703, fencing: 3_005 };
  const statXp = {
    strength: 2_509,
    agility: 8_711,
    endurance: 1_101,
    intellect: 303,
    intuition: 102,
  };
  for (const [skill, xp] of Object.entries(skillXp)) {
    f.player.skills[skill] = levelForXp(xp);
    f.player.quest[`skillXp:${skill}`] = xp;
  }
  for (const [stat, xp] of Object.entries(statXp)) {
    f.player.stats[stat] = levelForXp(xp);
    f.player.quest[`statXp:${stat}`] = xp;
  }
  Object.assign(f.player, derivedAttributes(f.player.stats));
  f.player.quest.bobComplete = 1;
  f.player.inventory = { bronze_sword: 1, copper_ore: 4 };
  f.player.bank = { tin_ore: 3 };
  f.state.jobs[f.player.id] = {
    playerId: f.player.id,
    recipeId: "smelt_tin",
    completeAt: 50_000,
    inputs: { tin_ore: 2 },
    outputs: { tin_bar: 1 },
  };
  f.game.die(f.player);
  assert.equal(f.player.xp, 32_007 - Math.ceil(32_007 / 8));
  for (const [skill, xp] of Object.entries(skillXp)) {
    const expected = xp - Math.ceil(xp / 8);
    assert.equal(f.player.quest[`skillXp:${skill}`], expected);
    assert.equal(f.player.skills[skill], levelForXp(expected));
  }
  for (const [stat, xp] of Object.entries(statXp)) {
    const expected = xp - Math.ceil(xp / 8);
    assert.equal(f.player.quest[`statXp:${stat}`], expected);
    assert.equal(f.player.stats[stat], levelForXp(expected));
  }
  const expected = derivedAttributes(f.player.stats);
  assert.equal(f.player.level, expected.level);
  assert.equal(f.player.maxHp, expected.maxHp);
  assert.equal(f.player.maxStamina, expected.maxStamina);
  assert.equal(f.player.hp, f.player.maxHp);
  assert.equal(f.player.stamina, f.player.maxStamina);
  assert.equal(f.player.quest.bobComplete, 1);
  assert.deepEqual(f.player.bank, { tin_ore: 3 });
  assert.deepEqual(f.player.inventory, {});
  assert.equal(f.state.jobs[f.player.id], undefined);
  assert.equal(Object.keys(f.state.bags).length, 1);
  assert.deepEqual(Object.values(f.state.bags)[0].items, {
    bronze_sword: 1,
    copper_ore: 4,
    tin_ore: 2,
  });
  f.advance(500);
  f.game.tick();
  assert.deepEqual(
    f.player.inventory,
    {},
    "the discarded crafting job cannot complete after death",
  );
});

test("canonical controlled combat awards primary stat XP and updates stamina when a stat crosses a source threshold", () => {
  const f = combatFixture();
  f.player.quest["statXp:strength"] = 99;
  f.player.quest["statXp:agility"] = 99;
  f.game.action(f.player.id, { action: "attack", target: f.enemy.id });
  const hit = f.game
    .snapshot(f.player.id)
    .events!.find((e) => e.attacker === f.player.id)!;
  assert.equal(hit.damage, 6);
  assert.equal(f.player.quest["statXp:strength"], 102);
  assert.equal(f.player.quest["statXp:agility"], 102);
  assert.equal(f.player.quest["statXp:endurance"], 3);
  assert.equal(f.player.stats.strength, 2);
  assert.equal(f.player.stats.agility, 2);
  assert.equal(f.player.maxStamina, 4);
  assert.equal(f.player.stamina, 4);
});
