import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocket } from "ws";
import type { WorldData } from "../src/shared/types.js";
import { Game, GameError } from "./game.js";
import { emptyState, JsonStore } from "./persist.js";
import { buildServer } from "./index.js";

const world: WorldData = {
  items: [
    {
      id: "dagger",
      name: "Кинжал",
      kind: "weapon",
      weight: 1,
      value: 20,
      damage: 6,
      skill: "piercing",
    },
    { id: "pickaxe", name: "Кирка", kind: "tool", weight: 2, value: 15 },
    {
      id: "bread",
      name: "Хлеб",
      kind: "food",
      weight: 0.2,
      value: 4,
      healing: 20,
    },
    {
      id: "copper_ore",
      name: "Медная руда",
      kind: "resource",
      weight: 1,
      value: 3,
      skill: "geology",
    },
    {
      id: "copper_ingot",
      name: "Медный слиток",
      kind: "material",
      weight: 1,
      value: 8,
    },
    { id: "raw_meat", name: "Сырое мясо", kind: "food", weight: 1, value: 2 },
    {
      id: "bronze_helmet",
      name: "Бронзовый шлем",
      kind: "armor",
      weight: 3,
      value: 65,
      requires: { combat: 1 },
    },
    {
      id: "bronze_armour",
      name: "Бронзовая броня",
      kind: "armor",
      weight: 3,
      value: 65,
      requires: { combat: 1 },
    },
    {
      id: "iron_armour",
      name: "Железная броня",
      kind: "armor",
      weight: 3,
      value: 80,
      requires: { combat: 15 },
    },
  ],
  recipes: [
    {
      id: "smelt_copper",
      name: "Медный слиток",
      inputs: { copper_ore: 2 },
      outputs: { copper_ingot: 1 },
      skill: "metallurgy",
      level: 2,
      station: "furnace",
      seconds: 2,
    },
  ],
  professions: [
    { id: "geology", name: "Геология", description: "" },
    { id: "metallurgy", name: "Металлургия", description: "" },
  ],
  entities: [
    {
      id: "ore",
      name: "Месторождение",
      type: "resource",
      x: 2,
      z: 0,
      resource: "copper_ore",
      stock: 3,
      alive: true,
    },
    { id: "bank", name: "Банк", type: "npc", x: 0, z: 0 },
    { id: "trader", name: "Торговец", type: "npc", x: -2, z: 0 },
    {
      id: "station_furnace",
      name: "Печь",
      type: "station",
      state: "furnace",
      x: 4,
      z: 0,
    },
    { id: "bob", name: "Боб", type: "npc", x: 0, z: 1 },
    {
      id: "rat",
      name: "Крыса",
      type: "monster",
      x: 40,
      z: 0,
      maxHp: 20,
      hp: 20,
      level: 8,
      alive: true,
    },
  ],
};

function fixture() {
  let at = 100000;
  const state = emptyState();
  const game = new Game(structuredClone(world), state, () => at);
  const player = game.createPlayer("p1", "Лось");
  const second = game.createPlayer("p2", "Рысь");
  game.connect(player.id);
  game.connect(second.id);
  player.x = 0;
  player.z = 0;
  second.x = 1;
  second.z = 0;
  return {
    game,
    state,
    player,
    second,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

test("gathering requires proximity and a server cooldown; resources exhaust", () => {
  const { game, player, state, advance } = fixture();
  player.x = 20;
  assert.throws(
    () => game.action(player.id, { action: "gather", target: "ore" }),
    /ближе/,
  );
  assert.equal(player.inventory.copper_ore ?? 0, 0);
  player.x = 0;
  game.action(player.id, { action: "gather", target: "ore" });
  assert.equal(player.inventory.copper_ore, 1);
  assert.throws(
    () => game.action(player.id, { action: "gather", target: "ore" }),
    /восстанавливается/,
  );
  assert.equal(player.inventory.copper_ore, 1);
  for (let i = 0; i < 2; i++) {
    advance(1200);
    game.action(player.id, { action: "gather", target: "ore" });
  }
  assert.equal(state.entities.find((e) => e.id === "ore")!.alive, false);
  advance(61000);
  game.tick();
  assert.equal(state.entities.find((e) => e.id === "ore")!.stock, 3);
});

test("movement clamps speed, world bounds and reconnect budget; rejects non-finite input", () => {
  const { game, player, advance } = fixture();
  game.move(player.id, 100, 0, 0);
  assert.equal(player.x, 0);
  advance(100);
  game.move(player.id, 100, 0, 0);
  assert.ok(Math.abs(player.x - 0.7) < 1e-9);
  game.move(player.id, 100, 0, 0);
  assert.ok(Math.abs(player.x - 0.7) < 1e-9);
  game.disconnect(player.id);
  game.connect(player.id);
  game.move(player.id, 100, 0, 0);
  assert.ok(Math.abs(player.x - 0.7) < 1e-9);
  advance(10000);
  player.x = 119.8;
  game.move(player.id, 1e10, 0, 0);
  assert.equal(player.x, 120);
  assert.throws(() => game.move(player.id, Infinity, 0, 0), GameError);
});

test("craft reserves exact inputs, checks skill/station and gives each output once", () => {
  const { game, player, state, advance } = fixture();
  player.inventory.copper_ore = 4;
  assert.throws(
    () => game.action(player.id, { action: "craft", recipe: "smelt_copper" }),
    /уровень 2/,
  );
  assert.equal(player.inventory.copper_ore, 4);
  player.skills.metallurgy = 2;
  player.x = 30;
  assert.throws(
    () => game.action(player.id, { action: "craft", recipe: "smelt_copper" }),
    /станку/,
  );
  player.x = 4;
  game.action(player.id, { action: "craft", recipe: "smelt_copper" });
  assert.equal(player.inventory.copper_ore, 2);
  assert.equal(player.inventory.copper_ingot ?? 0, 0);
  assert.throws(
    () => game.action(player.id, { action: "craft", recipe: "smelt_copper" }),
    /завершения/,
  );
  assert.ok(state.jobs[player.id]);
  advance(2100);
  game.tick();
  game.tick();
  assert.equal(player.inventory.copper_ingot, 1);
  assert.equal(state.jobs[player.id], undefined);
});

test("bank, shop and transfers conserve inventory/credits and reject forged quantities", () => {
  const { game, player, second } = fixture();
  player.inventory.copper_ore = 10;
  game.action(player.id, {
    action: "bankDeposit",
    item: "copper_ore",
    quantity: 4,
  });
  assert.equal(player.inventory.copper_ore, 6);
  assert.equal(player.bank.copper_ore, 4);
  game.action(player.id, {
    action: "bankWithdraw",
    item: "copper_ore",
    quantity: 3,
  });
  assert.equal(player.inventory.copper_ore, 9);
  assert.equal(player.bank.copper_ore, 1);
  assert.throws(
    () =>
      game.action(player.id, {
        action: "bankWithdraw",
        item: "copper_ore",
        quantity: 2,
      }),
    /Недостаточно/,
  );
  assert.throws(
    () =>
      game.action(player.id, {
        action: "bankDeposit",
        item: "copper_ore",
        quantity: -2,
      }),
    /Количество/,
  );
  assert.throws(
    () =>
      game.action(player.id, {
        action: "buy",
        item: "copper_ore",
        quantity: NaN,
      }),
    /Количество/,
  );
  const credits = player.credits;
  game.action(player.id, { action: "buy", item: "copper_ore", quantity: 2 });
  assert.equal(player.credits, credits - 6);
  assert.equal(player.inventory.copper_ore, 11);
  game.action(player.id, { action: "sell", item: "copper_ore", quantity: 2 });
  assert.equal(player.credits, credits - 4);
  assert.equal(player.inventory.copper_ore, 9);
  game.action(player.id, {
    action: "trade",
    player: second.id,
    item: "copper_ore",
    quantity: 5,
  });
  assert.equal(player.inventory.copper_ore, 4);
  assert.equal(second.inventory.copper_ore, 5);
  assert.throws(
    () =>
      game.action(player.id, {
        action: "trade",
        player: second.id,
        item: "copper_ore",
        quantity: 5,
      }),
    /Недостаточно/,
  );
  assert.equal(second.inventory.copper_ore, 5);
});

test("other players receive public state, never private inventory, bank or quest data", () => {
  const { game, player, second } = fixture();
  second.bank.dagger = 20;
  second.quest.secret = 99;
  const snapshot = game.snapshot(player.id);
  assert.deepEqual(snapshot.players[0].inventory, {});
  assert.deepEqual(snapshot.players[0].bank, {});
  assert.deepEqual(snapshot.players[0].quest, {});
  assert.equal(snapshot.self.inventory.dagger, 1);
});

test("armor checks levels, occupies independent slots, reduces server damage and clears on transfer/death", () => {
  const naked = fixture();
  naked.player.level = naked.second.level = 10;
  naked.player.x = 50;
  naked.second.x = 51;
  naked.game.action(naked.player.id, {
    action: "attack",
    target: naked.second.id,
  });
  const nakedDamage = naked.second.maxHp - naked.second.hp;
  const { game, player, second } = fixture();
  second.inventory.bronze_helmet = 1;
  second.inventory.bronze_armour = 1;
  second.inventory.iron_armour = 1;
  assert.throws(
    () => game.action(second.id, { action: "equip", item: "iron_armour" }),
    /уровень 15/,
  );
  game.action(second.id, { action: "equip", item: "bronze_helmet" });
  game.action(second.id, { action: "equip", item: "bronze_armour" });
  assert.deepEqual(second.equipment, {
    helmet: "bronze_helmet",
    body: "bronze_armour",
  });
  assert.equal(second.equipped, "dagger");
  assert.equal(second.inventory.bronze_armour, 1);
  assert.deepEqual(
    game.snapshot(player.id).players[0].equipment,
    second.equipment,
  );
  assert.deepEqual(game.snapshot(player.id).players[0].inventory, {});
  player.level = second.level = 10;
  player.x = 50;
  second.x = 51;
  game.action(player.id, { action: "attack", target: second.id });
  const armoredDamage = second.maxHp - second.hp;
  assert.ok(
    armoredDamage > 0 && armoredDamage < nakedDamage,
    `${armoredDamage} should be less than ${nakedDamage}`,
  );
  player.x = 0;
  second.x = 1;
  game.action(second.id, {
    action: "trade",
    player: player.id,
    item: "bronze_armour",
    quantity: 1,
  });
  assert.equal(second.equipment?.body, undefined);
  assert.equal(player.inventory.bronze_armour, 1);
  game.action(second.id, { action: "equip", item: "bronze_helmet" });
  assert.equal(second.equipment?.helmet, undefined);
  game.action(second.id, { action: "equip", item: "bronze_helmet" });
  game.die(second);
  assert.deepEqual(second.equipment, {});
});

test("PvP checks both levels and safe-zone position; death loses inventory and one eighth XP", () => {
  const { game, player, second, state } = fixture();
  assert.throws(
    () => game.action(player.id, { action: "attack", target: second.id }),
    /уровня 10/,
  );
  player.level = second.level = 10;
  assert.throws(
    () => game.action(player.id, { action: "attack", target: second.id }),
    /безопасная/,
  );
  player.x = 50;
  second.x = 51;
  player.z = second.z = 0;
  second.hp = 1;
  second.xp = 800;
  second.inventory.copper_ore = 4;
  const held = structuredClone(second.inventory);
  game.action(player.id, { action: "attack", target: second.id });
  assert.equal(player.pk, 1);
  assert.equal(second.xp, 700);
  assert.equal(second.x, 0);
  assert.equal(second.z, 8);
  assert.deepEqual(second.inventory, {});
  const bag = Object.values(state.bags)[0];
  assert.deepEqual(bag.items, held);
  assert.equal(state.entities.find((e) => e.id === bag.id)!.x, 51);
});

test("death during crafting preserves reserved ingredients exactly once in dropped bag", () => {
  const { game, player, state, advance } = fixture();
  player.skills.metallurgy = 2;
  player.inventory.copper_ore = 2;
  game.action(player.id, { action: "craft", recipe: "smelt_copper" });
  game.die(player);
  assert.equal(state.jobs[player.id], undefined);
  assert.equal(Object.values(state.bags)[0].items.copper_ore, 2);
  advance(3000);
  game.tick();
  assert.equal(player.inventory.copper_ingot ?? 0, 0);
});

test("atomic persistence restores a death bag, bank, jobs and offline players", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aw-state-"));
  try {
    const { game, player, second, state } = fixture();
    player.inventory.copper_ore = 7;
    player.bank.dagger = 2;
    game.die(player);
    second.inventory.copper_ore = 2;
    second.skills.metallurgy = 2;
    game.action(second.id, { action: "craft", recipe: "smelt_copper" });
    const store = new JsonStore(join(directory, "state.json"));
    await Promise.all([store.save(state), store.save(state)]);
    const restored = await store.read();
    assert.equal(restored.players[player.id].online, false);
    assert.equal(restored.players[player.id].bank.dagger, 2);
    assert.equal(Object.values(restored.bags)[0].items.copper_ore, 7);
    assert.ok(restored.jobs[second.id]);
    const running = new Game(world, restored, () => 110000);
    running.tick();
    running.tick();
    assert.equal(restored.players[second.id].inventory.copper_ingot, 1);
    assert.equal(restored.jobs[second.id], undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP registration hashes passwords, cookie authenticates WS, and logout invalidates it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aw-http-"));
  const filename = join(directory, "state.json");
  const service = await buildServer({
    world,
    stateFile: filename,
    timers: false,
  });
  try {
    service.server.listen(0, "127.0.0.1");
    await once(service.server, "listening");
    const port = (service.server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;
    const register = await fetch(`${origin}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        name: "Лось Тест",
        password: "safe-password-123",
      }),
    });
    assert.equal(register.status, 201);
    const setCookie = register.headers.get("set-cookie")!;
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    const cookie = setCookie.split(";")[0];
    const saved = await readFile(filename, "utf8");
    assert.ok(!saved.includes("safe-password-123"));
    assert.match(saved, /\$2[aby]\$12\$/);
    assert.equal(
      (await (await fetch(`${origin}/api/session`)).json()).player,
      null,
    );
    const session = await (
      await fetch(`${origin}/api/session`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(session.player.name, "Лось Тест");
    const wrong = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Лось Тест", password: "wrong-password" }),
    });
    assert.equal(wrong.status, 401);
    const devOrigin = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:5188",
      },
      body: JSON.stringify({
        name: "Лось Тест",
        password: "safe-password-123",
      }),
    });
    assert.equal(devOrigin.status, 200);
    const blocked = await fetch(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: { Origin: "https://untrusted.example", Cookie: cookie },
    });
    assert.equal(blocked.status, 403);
    const unauthenticated = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((done, reject) => {
      unauthenticated.once("unexpected-response", (_request, response) => {
        assert.equal(response.statusCode, 401);
        response.resume();
        done();
      });
      unauthenticated.once("open", () =>
        reject(new Error("Anonymous websocket was accepted")),
      );
      unauthenticated.once("error", () => {});
    });
    unauthenticated.terminate();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Cookie: cookie, Origin: origin },
    });
    const [raw] = await once(ws, "message");
    const initial = JSON.parse(raw.toString());
    assert.equal(initial.type, "snapshot");
    assert.equal(initial.self.name, "Лось Тест");
    assert.equal(initial.self.online, true);
    const closed = once(ws, "close");
    const logout = await fetch(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
    });
    assert.equal(logout.status, 200);
    await closed;
    assert.equal(
      (
        await (
          await fetch(`${origin}/api/session`, { headers: { Cookie: cookie } })
        ).json()
      ).player,
      null,
    );
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("shipped world is playable: starter sword, chicken loot and cooking use real catalog IDs", async () => {
  const shipped = JSON.parse(
    await readFile(new URL("../data/world.json", import.meta.url), "utf8"),
  ) as WorldData;
  let at = 100000;
  const state = emptyState();
  const game = new Game(shipped, state, () => at);
  const player = game.createPlayer("real_world", "Следопыт");
  game.connect(player.id);
  assert.equal(player.equipped, "bronze_sword");
  assert.equal(player.inventory.bread, 3);
  const chicken = state.entities.find((e) => e.id === "chicken_0")!;
  player.x = chicken.x;
  player.z = chicken.z;
  game.action(player.id, { action: "attack", target: chicken.id });
  at += 1000;
  game.action(player.id, { action: "attack", target: chicken.id });
  assert.equal(chicken.alive, false);
  const bag = Object.values(state.bags)[0];
  assert.equal(bag.items.raw_chicken, 1);
  game.action(player.id, { action: "gather", target: bag.id });
  const fire = state.entities.find((e) => e.id === "station_campfire")!;
  player.x = fire.x;
  player.z = fire.z;
  game.action(player.id, { action: "craft", recipe: "cook_chicken" });
  assert.equal(player.inventory.raw_chicken, undefined);
  at += 4000;
  game.tick();
  assert.equal(player.inventory.chicken, 1);
  const furnace = state.entities.find((e) => e.id === "station_furnace")!;
  player.x = furnace.x;
  player.z = furnace.z;
  player.inventory.copper_ore = 1;
  player.inventory.tin_ore = 1;
  assert.throws(
    () => game.action(player.id, { action: "craft", recipe: "alloy_bronze" }),
    /уровень 10/,
  );
  player.skills.metallurgy = 10;
  game.action(player.id, { action: "craft", recipe: "alloy_bronze" });
  at += 6000;
  game.tick();
  assert.equal(player.inventory.bronze_bar, 1);
});

test("production entrypoint starts through a current-directory symlink and serves health", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aw-current-"));
  const project = fileURLToPath(new URL("..", import.meta.url));
  const current = join(directory, "current");
  // Windows directory junctions need no elevation; Unix ignores the type argument.
  await symlink(project, current, "junction");
  const child = spawn(process.execPath, ["--import", "tsx", join(current, "server", "index.ts")], {
    cwd: project,
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0", NODE_ENV: "test", SOURCE_COMMIT: "symlink-regression-test", STATE_FILE: join(directory, "state.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", data => { output += data.toString(); });
  child.stderr.on("data", data => { errors += data.toString(); });
  try {
    const origin = await new Promise<string>((done, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Symlink entrypoint did not listen: ${output}\n${errors}`)), 8000);
      const complete = (error?: Error, url?: string) => { clearTimeout(timeout); error ? reject(error) : done(url!); };
      child.once("error", error => complete(error));
      child.once("exit", code => complete(new Error(`Symlink entrypoint exited before listening (${code}): ${errors}`)));
      child.stdout.on("data", () => {
        const match = output.match(/AW world listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) complete(undefined, match[1]);
      });
    });
    const response = await fetch(`${origin}/api/health`);
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.equal(health.ok, true);
    assert.equal(health.sourceCommit, "symlink-regression-test");
    assert.ok(health.items > 0);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    assert.ok(directory.startsWith(join(tmpdir(), "aw-current-")));
    await rm(directory, { recursive: true, force: true });
  }
});
