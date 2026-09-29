import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CanonicalMapData } from "../src/shared/canonical-map.js";
import { mapIndex } from "../src/shared/canonical-map.js";
import type { WorldData } from "../src/shared/types.js";
import { setAccountRole } from "../scripts/set-account-role.js";
import { Game } from "./game.js";
import { emptyState, JsonStore } from "./persist.js";
import { acquireStateLock } from "./state-lock.js";

const world: WorldData = {
  items: [
    { id: "ore", name: "Ore", kind: "resource", value: 1, weight: 1 },
    { id: "bar", name: "Bar", kind: "material", value: 2, weight: 1 },
  ],
  recipes: [{ id: "bar", name: "Bar", inputs: { ore: 2 }, outputs: { bar: 1 }, skill: "metallurgy", level: 1, station: "furnace", seconds: 2 }],
  professions: [{ id: "metallurgy", name: "Metallurgy", description: "" }],
  entities: [
    { id: "furnace", name: "Furnace", type: "station", state: "furnace", x: -100, z: -100 },
    { id: "rat", name: "Rat", type: "monster", x: -100, z: -100, hp: 500, maxHp: 500, alive: true, attackRange: 1 },
  ],
};

function fixture(admin = true) {
  let at = 10_000;
  const map: CanonicalMapData = {
    version: 1, source: "Admin fixture", sha256: "admin-fixture",
    layout: { width: 512, height: 512, origin: 256, limit: 255, unit: 1 },
    spawn: { x: -100, z: -100 }, terrain: Array<number>(512 * 512).fill(0), definitions: [], placements: [],
  };
  const state = emptyState();
  state.accounts.p1 = { id: "p1", name: "WizardJIOCb", passwordHash: "fixture-only", createdAt: 1, ...(admin ? { role: "admin" } : {}) };
  const game = new Game(structuredClone(world), state, () => at, undefined, undefined, map);
  const player = game.createPlayer("p1", "WizardJIOCb");
  game.connect(player.id);
  return { game, state, player, map, advance: (milliseconds: number) => { at += milliseconds; } };
}

test("only a saved admin account authorizes teleport; player mirror and missing account cannot grant it", () => {
  const { game, player, state } = fixture(false);
  const position = { x: player.x, z: player.z };
  player.role = "admin";
  assert.throws(() => game.adminTeleport(player.id, 100, 100), /администраторам/);
  assert.equal(game.snapshot(player.id).self.role, "player");
  assert.deepEqual({ x: player.x, z: player.z }, position);
  state.accounts.p1.role = "admin";
  game.adminTeleport(player.id, 100, 100);
  state.accounts.p1.role = "player";
  assert.throws(() => game.adminTeleport(player.id, 0, 0), /администраторам/);
  delete state.accounts.p1;
  player.role = "admin";
  assert.throws(() => game.adminTeleport(player.id, 0, 0), /администраторам/);
});

test("admin warps cover all source grid cells including solids and edges, and reject invalid coordinates atomically", () => {
  const { game, player, map, advance } = fixture();
  map.terrain[mapIndex(17.5, 10.5)] = 0x04000000;
  for (const [x, z] of [[-255.5, -255.5], [255.5, 255.5], [-255.5, 255.5], [255.5, -255.5], [-256, -256], [17.5, 10.5]]) {
    game.adminTeleport(player.id, x, z);
    assert.deepEqual({ x: player.x, z: player.z }, { x, z });
    advance(200);
    game.move(player.id, x, z, 0);
    assert.deepEqual({ x: player.x, z: player.z }, { x, z }, "stationary packets must preserve edge warps");
  }
  const before = structuredClone(player);
  for (const [x, z] of [[256, 0], [-256.01, 0], [0, 256], [0, -256.01], [NaN, 0], [0, Infinity], ["0", 0], [null, 0], [0, undefined]])
    assert.throws(() => game.adminTeleport(player.id, x, z), /Координаты/);
  assert.deepEqual(player, before);
  game.disconnect(player.id);
  assert.throws(() => game.adminTeleport(player.id, 0, 0), /Подключитесь/);
});

test("teleport cancels combat and resets movement budget without granting inventory, health or XP", () => {
  const { game, player, advance } = fixture();
  game.action(player.id, { action: "engage", target: "rat" });
  assert.equal(game.snapshot(player.id).self.combatTarget, "rat");
  player.hp = 3;
  player.stamina = 1;
  player.credits = 123;
  player.inventory.ore = 7;
  player.bank.bar = 4;
  const before = structuredClone(player);
  advance(10_000);
  game.adminTeleport(player.id, -10.5, -10.5);
  assert.equal(game.snapshot(player.id).self.combatTarget, undefined);
  const { x: _x, z: _z, action: _action, ...preserved } = player;
  const { x: _beforeX, z: _beforeZ, action: _beforeAction, ...expected } = before;
  assert.deepEqual(preserved, expected);
  game.move(player.id, -100, -100, player.rotation);
  assert.deepEqual({ x: player.x, z: player.z }, { x: -10.5, z: -10.5 }, "old packet cannot spend pre-warp elapsed time");
  advance(200);
  game.move(player.id, -9.5, -10.5, player.rotation);
  assert.ok(Math.abs(player.x - -10.3) < 1e-9, "ordinary walking limit still applies after a warp");
});

test("warp keeps reserved crafting inputs and the job completes only once", () => {
  const { game, state, player, advance } = fixture();
  player.inventory.ore = 4;
  game.action(player.id, { action: "craft", recipe: "bar" });
  const job = structuredClone(state.jobs[player.id]);
  const action = player.action;
  game.adminTeleport(player.id, 255.5, -255.5);
  assert.deepEqual(state.jobs[player.id], job);
  assert.equal(player.action, action);
  assert.equal(player.inventory.ore, 2);
  assert.equal(player.inventory.bar ?? 0, 0);
  advance(2100);
  game.tick();
  assert.equal(player.inventory.bar, 1);
  assert.equal(state.jobs[player.id], undefined);
  game.tick();
  assert.equal(player.inventory.bar, 1);
});

test("offline role maintenance changes only the exact account role, backs up state and persists an admin solid-cell warp", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aw-admin-role-"));
  const filename = join(directory, "state.json");
  const { state, map } = fixture(false);
  const store = new JsonStore(filename);
  try {
    state.players.p1.inventory.ore = 9;
    state.players.p1.bank.bar = 2;
    await store.save(state);
    const before = JSON.parse(await readFile(filename, "utf8"));
    await assert.rejects(setAccountRole(filename, "wizardjiocb", "admin"), /exact name/);
    assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), before);
    const result = await setAccountRole(filename, "WizardJIOCb", "admin");
    assert.equal(result.changed, true);
    assert.deepEqual(JSON.parse(await readFile(result.backup!, "utf8")), before);
    const after = JSON.parse(await readFile(filename, "utf8"));
    const expected = structuredClone(before);
    expected.accounts.p1.role = "admin";
    assert.deepEqual(after, expected);
    map.terrain[mapIndex(17.5, 10.5)] = 0x04000000;
    const loaded = await store.read();
    const restarted = new Game(structuredClone(world), loaded, undefined, undefined, undefined, map);
    restarted.connect("p1");
    restarted.adminTeleport("p1", 17.5, 10.5);
    await store.save(loaded);
    const loadedAgain = await store.read();
    const restartedAgain = new Game(structuredClone(world), loadedAgain, undefined, undefined, undefined, map);
    assert.equal(restartedAgain.snapshot("p1").self.role, "admin");
    assert.deepEqual({ x: loadedAgain.players.p1.x, z: loadedAgain.players.p1.z }, { x: 17.5, z: 10.5 });
    assert.equal(loadedAgain.players.p1.inventory.ore, 9);
    assert.equal(loadedAgain.players.p1.bank.bar, 2);
    await setAccountRole(filename, "WizardJIOCb", "player");
    assert.equal((await store.read()).accounts.p1.role, "player");
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), "aw-admin-role-")));
    await rm(directory, { recursive: true, force: true });
  }
});

test("live state lock prevents offline role edits and a second server writer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aw-admin-lock-"));
  const filename = join(directory, "state.json");
  const { state } = fixture(false);
  await new JsonStore(filename).save(state);
  const release = await acquireStateLock(filename);
  try {
    await assert.rejects(setAccountRole(filename, "WizardJIOCb", "admin"), /running process/);
    await assert.rejects(acquireStateLock(filename), /running process/);
    assert.equal((await new JsonStore(filename).read()).accounts.p1.role, undefined);
  } finally {
    await release();
    assert.ok(directory.startsWith(join(tmpdir(), "aw-admin-lock-")));
    await rm(directory, { recursive: true, force: true });
  }
});

test("role CLI executes through a production-style symlink rather than silently succeeding", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "aw-admin-cli-"));
  try {
    const linked = join(directory, "set-account-role.ts");
    try {
      await symlink(fileURLToPath(new URL("../scripts/set-account-role.ts", import.meta.url)), linked, "file");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("Windows requires symlink privileges; Linux production exercises this entrypoint.");
        return;
      }
      throw error;
    }
    const result = spawnSync(process.execPath, ["--import", "tsx", linked], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /State, exact account name and role are required/);
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), "aw-admin-cli-")));
    await rm(directory, { recursive: true, force: true });
  }
});
