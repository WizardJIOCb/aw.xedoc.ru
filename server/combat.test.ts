import assert from "node:assert/strict";
import { test } from "node:test";
import type { CombatEvent, WorldData } from "../src/shared/types.js";
import { Game, GameError } from "./game.js";
import { emptyState } from "./persist.js";

// This fixture deliberately has no imported map or external persistence. Tests
// exercise the combat simulation contract rather than production world content.
const fixtureWorld: WorldData = {
  items: [
    {
      id: "dagger",
      name: "Fixture dagger",
      kind: "weapon",
      damage: 6,
      skill: "piercing",
      weight: 1,
      value: 1,
    },
    { id: "raw_meat", name: "Fixture meat", kind: "food", weight: 1, value: 1 },
  ],
  recipes: [],
  professions: [],
  entities: [
    {
      id: "rat",
      name: "Fixture rat",
      type: "monster",
      x: 2,
      z: 8,
      hp: 500,
      maxHp: 500,
      level: 1,
      alive: true,
      resource: "raw_meat",
    },
    { id: "bob", name: "Fixture Bob", type: "npc", x: 1, z: 8 },
  ],
};

function fixture() {
  let now = 10_000;
  const state = emptyState();
  const game = new Game(structuredClone(fixtureWorld), state, () => now);
  const player = game.createPlayer("player-a", "Fixture explorer");
  game.connect(player.id);
  const enemy = state.entities.find((entity) => entity.id === "rat")!;
  const seen = new Map<number, CombatEvent>();
  const hits = () => {
    for (const event of game.snapshot(player.id).events ?? [])
      if (event.attacker === player.id && event.target === enemy.id)
        seen.set(event.id, event);
    return [...seen.values()];
  };
  return {
    game,
    state,
    player,
    enemy,
    hits,
    engage: () =>
      game.action(player.id, { action: "engage", target: enemy.id }),
    step: (milliseconds = 500) => {
      now += milliseconds;
      game.tick();
      hits();
      return now;
    },
  };
}

test("engage packets select a target without immediate damage or stamina use", () => {
  const f = fixture();
  const hp = f.enemy.hp;
  const stamina = f.player.stamina;
  for (let i = 0; i < 40; i++) f.engage();
  assert.equal(f.enemy.hp, hp);
  assert.equal(f.player.stamina, stamina);
  assert.equal(f.hits().length, 0);
  assert.equal(f.game.snapshot(f.player.id).self.combatTarget, f.enemy.id);

  f.step();
  assert.equal(f.hits().length, 1);
  const afterFirstHit = f.enemy.hp;
  for (let i = 0; i < 40; i++) f.engage();
  assert.equal(
    f.enemy.hp,
    afterFirstHit,
    "repeated selection cannot bypass the tick",
  );
  assert.equal(f.hits().length, 1);
});

test("500 ms simulation steps apply exactly one player hit every 1000 ms", () => {
  const f = fixture();
  const initialHp = f.enemy.hp!;
  f.engage();
  const expectedHitCounts = [1, 1, 2, 2, 3, 3];
  for (const expected of expectedHitCounts) {
    // Network retransmission between every step must neither speed up attacks
    // nor keep postponing an already selected target's next attack.
    for (let i = 0; i < 8; i++) f.engage();
    f.step();
    assert.equal(f.hits().length, expected);
    const hp = f.enemy.hp;
    f.game.tick();
    assert.equal(
      f.enemy.hp,
      hp,
      "another tick at the same clock must not add a hit",
    );
  }
  const hits = f.hits();
  assert.deepEqual(
    hits.map((event) => event.at),
    [10_500, 11_500, 12_500],
  );
  assert.equal(new Set(hits.map((event) => event.id)).size, 3);
  assert.equal(
    f.enemy.hp,
    initialHp - hits.reduce((sum, event) => sum + event.damage, 0),
  );
});

test("disengage stops further automatic hits", () => {
  const f = fixture();
  f.engage();
  f.step();
  const hp = f.enemy.hp;
  f.game.action(f.player.id, { action: "disengage" });
  for (let i = 0; i < 5; i++) f.step();
  assert.equal(f.enemy.hp, hp);
  assert.equal(f.hits().length, 1);
  assert.equal(f.game.snapshot(f.player.id).self.combatTarget, undefined);
});

test("leaving range cancels the target instead of resuming when the player returns", () => {
  const f = fixture();
  f.engage();
  f.step();
  const hp = f.enemy.hp;
  f.player.x = 100;
  f.step();
  assert.equal(f.game.snapshot(f.player.id).self.combatTarget, undefined);
  f.player.x = 0;
  f.step();
  f.step();
  assert.equal(f.enemy.hp, hp);
  assert.equal(f.hits().length, 1);
});

test("disconnect cancels combat and reconnecting does not restore the old target", () => {
  const f = fixture();
  f.engage();
  f.step();
  const hp = f.enemy.hp;
  f.game.disconnect(f.player.id);
  f.step();
  f.step();
  assert.equal(f.enemy.hp, hp);
  assert.equal(f.game.snapshot(f.player.id).self.combatTarget, undefined);
  f.game.connect(f.player.id);
  f.step();
  f.step();
  assert.equal(f.enemy.hp, hp);
  assert.equal(f.hits().length, 1);
});

test("NPC targets reject both engage and direct attack without creating a combat target", () => {
  const f = fixture();
  const before = structuredClone(
    f.state.entities.find((entity) => entity.id === "bob"),
  );
  for (const action of ["engage", "attack"])
    assert.throws(
      () => f.game.action(f.player.id, { action, target: "bob" }),
      GameError,
    );
  f.step();
  assert.deepEqual(
    f.state.entities.find((entity) => entity.id === "bob"),
    before,
  );
  assert.equal(f.game.snapshot(f.player.id).self.combatTarget, undefined);
  assert.equal(f.hits().length, 0);
});

test("two attackers killing the same monster create one loot bag and award its death once", () => {
  const f = fixture();
  f.enemy.hp = 1;
  const other = f.game.createPlayer("player-b", "Second explorer");
  f.game.connect(other.id);
  const otherXp = other.xp;
  const otherCredits = other.credits;
  f.engage();
  f.game.action(other.id, { action: "engage", target: f.enemy.id });
  f.step();
  assert.equal(f.enemy.hp, 0);
  assert.equal(f.enemy.alive, false);
  assert.equal(f.hits().length, 1);
  assert.equal(other.xp, otherXp);
  assert.equal(other.credits, otherCredits);
  assert.equal(f.game.snapshot(other.id).self.combatTarget, undefined);
  const bags = Object.values(f.state.bags);
  assert.equal(bags.length, 1);
  assert.equal(bags[0].owner, f.player.id);
  assert.deepEqual(bags[0].items, { raw_meat: 1 });
  assert.equal(
    f.state.entities.filter((entity) => entity.type === "loot").length,
    1,
  );
  assert.equal(
    f.state.entities.find((entity) => entity.type === "loot")?.id,
    bags[0].id,
  );
  const xp = f.player.xp;
  const credits = f.player.credits;
  const bagId = bags[0].id;
  for (let i = 0; i < 8; i++) {
    assert.throws(() => f.engage(), GameError);
    assert.throws(
      () =>
        f.game.action(f.player.id, { action: "attack", target: f.enemy.id }),
      GameError,
    );
    f.step();
  }
  assert.deepEqual(Object.keys(f.state.bags), [bagId]);
  assert.equal(f.player.xp, xp);
  assert.equal(f.player.credits, credits);
  assert.equal(f.hits().length, 1);
});
