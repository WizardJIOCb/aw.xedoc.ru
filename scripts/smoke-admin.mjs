/** Local HTTP/WS regression for the account-admin teleport capability.
 * Run: node scripts/smoke-admin.mjs
 * Loads the shipped canonical world, starts HTTP on ephemeral localhost ports,
 * and stores private fixture saves ONLY in an OS temporary directory. Roles and
 * pending-job fixtures are seeded only after the previous service has closed.
 * No public service/account is touched; the ignored report contains no secrets.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import WebSocket from "ws";

assert.equal(process.argv.length, 2, "This smoke only supports its private local fixture; do not supply a public URL.");
const { buildServer } = await tsImport("../server/index.ts", import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "aw-admin-smoke-"));
const stateFile = join(directory, "state.json");
const started = Date.now();
const results = [], accounts = [], connections = [];
const report = {
  started: new Date(started).toISOString(),
  target: "ephemeral-localhost-only",
  world: "shipped canonical 512 x 512",
  timers: "Periodic world/save timers disabled to isolate teleport effects; combat cases call the real world tick.",
  checks: results,
  coverageBoundary: "Real HTTP authentication and WS packets against buildServer, with offline admin/job fixtures outside the checkout. No production role edits, no browser/UI assertion, and no invented original AW mechanic claim.",
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let service, base, map, admin, ordinary, adminConnection, secondConnection, ordinaryConnection;
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "production";

function safeError(error) {
  let value = String(error?.message ?? error);
  for (const account of accounts) for (const secret of [account.password, account.cookie])
    if (secret) value = value.split(secret).join("[redacted]");
  return value;
}
async function until(predicate, label, timeout = 7000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = predicate();
    if (value) return value;
    await pause(15);
  }
  throw Error("Timed out: " + label);
}
async function check(name, fn) {
  const at = Date.now();
  try {
    const details = await fn();
    results.push({ name, status: "PASS", ms: Date.now() - at, ...(details ?? {}) });
    console.log("PASS " + name);
  } catch (error) {
    results.push({ name, status: "FAIL", ms: Date.now() - at, error: safeError(error) });
    throw error;
  }
}
async function start() {
  assert.ok(!service, "Close the service before touching or reloading fixture state.");
  service = await buildServer({ stateFile, timers: false });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  base = new URL(`http://127.0.0.1:${service.server.address().port}`);
}
async function stop() {
  if (service) {
    await service.close();
    service = undefined;
  }
  connections.length = 0;
}
async function request(path, { method = "GET", cookie, body } = {}) {
  const headers = { Origin: base.origin };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(new URL(path, base), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.getSetCookie?.().map(s => s.split(";")[0]).find(s => s.startsWith("aw_session="))
      ?? response.headers.get("set-cookie")?.split(";")[0],
  };
}
async function register(prefix, extras = {}) {
  const account = {
    name: prefix + "_" + randomBytes(7).toString("hex"),
    password: randomBytes(24).toString("base64url"),
  };
  accounts.push(account);
  const result = await request("/api/auth/register", {
    method: "POST", body: { name: account.name, password: account.password, ...extras },
  });
  assert.equal(result.status, 201);
  assert.ok(result.cookie, "Registration must create an authenticated cookie.");
  assert.equal(result.data.player.role, "player", "Registration input never sets role.");
  account.id = result.data.player.id;
  account.cookie = result.cookie;
  return account;
}
async function login(account, expectedRole) {
  const result = await request("/api/auth/login", {
    method: "POST", body: { name: account.name, password: account.password, role: "admin", isAdmin: true },
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.player.role, expectedRole);
  assert.ok(result.cookie);
  account.cookie = result.cookie;
  const session = await request("/api/session", { cookie: account.cookie });
  assert.equal(session.data.player.role, expectedRole);
  assert.ok(!JSON.stringify(session.data).includes("passwordHash"));
  return session.data.player;
}
async function connect(account) {
  const url = new URL("/ws", base); url.protocol = "ws:";
  const ws = new WebSocket(url, { headers: { Cookie: account.cookie, Origin: base.origin } });
  const connection = { ws, snapshots: [], notices: [], teleports: [] };
  connections.push(connection);
  ws.on("message", data => {
    const message = JSON.parse(data.toString());
    if (message.type === "snapshot") connection.snapshots.push(message);
    else if (message.type === "notice") connection.notices.push(message);
    else if (message.type === "teleport") connection.teleports.push(message);
  });
  ws.on("error", () => {});
  await until(() => connection.snapshots[0], "authenticated WS snapshot");
  return connection;
}
const latest = (connection) => connection.snapshots.at(-1);
const position = (player) => ({ x: player.x, z: player.z });
const economic = (player) => Object.fromEntries([
  "hp", "maxHp", "stamina", "maxStamina", "force", "maxForce", "credits", "level", "xp",
  "skills", "stats", "inventory", "bank", "equipped", "equipment", "mode", "pk", "quest", "clan",
].map(key => [key, structuredClone(player[key])]));
async function authenticatedPlayer(account) {
  const result = await request("/api/session", { cookie: account.cookie });
  assert.equal(result.status, 200); assert.ok(result.data.player);
  return result.data.player;
}
async function rejectPacket(account, connection, packet) {
  const before = await authenticatedPlayer(account);
  const noticeCount = connection.notices.length, teleportCount = connection.teleports.length;
  connection.ws.send(typeof packet === "string" ? packet : JSON.stringify(packet));
  await until(() => connection.notices.length > noticeCount, "rejected teleport notice");
  assert.equal(connection.notices.at(-1).kind, "error");
  assert.equal(connection.teleports.length, teleportCount, "A rejected command cannot broadcast teleport acknowledgment.");
  const after = await authenticatedPlayer(account);
  assert.deepEqual(position(after), position(before));
  assert.deepEqual(economic(after), economic(before));
  assert.equal(after.role, before.role);
  return connection.notices.at(-1).text;
}
async function teleport(account, connection, x, z, ownConnections = [connection]) {
  const before = await authenticatedPlayer(account);
  const counters = ownConnections.map(c => ({ ack: c.teleports.length, snapshot: c.snapshots.length }));
  connection.ws.send(JSON.stringify({ type: "adminTeleport", x, z }));
  for (const [i, c] of ownConnections.entries()) {
    await until(() => c.teleports.length > counters[i].ack, "teleport acknowledgment in own session " + i);
    await until(() => c.snapshots.length > counters[i].snapshot && latest(c).self.x === x && latest(c).self.z === z,
      "authoritative teleport snapshot in own session " + i);
    assert.deepEqual(position(c.teleports.at(-1)), { x, z });
    assert.deepEqual(economic(latest(c).self), economic(before), "Teleport must preserve player economy, stats and vitals.");
    assert.equal(latest(c).self.role, "admin");
  }
  const after = await authenticatedPlayer(account);
  assert.deepEqual(position(after), { x, z });
  assert.deepEqual(economic(after), economic(before));
  return after;
}

let failure;
try {
  await start();
  await check("Shipped canonical map and healthy isolated HTTP server", async () => {
    const health = await request("/api/health");
    assert.equal(health.status, 200); assert.equal(health.data.ok, true);
    assert.equal(health.data.map.cells, 512 * 512);
    const result = await request("/api/map"); assert.equal(result.status, 200);
    map = result.data;
    assert.equal(map.terrain.length, 512 * 512);
    return { sourceSha256: health.data.map.sourceSha256, cells: map.terrain.length };
  });
  await check("HTTP registration ignores fabricated admin fields", async () => {
    ordinary = await register("qa_user", { role: "admin", isAdmin: true, player: { role: "admin" } });
    admin = await register("qa_admin");
    ordinaryConnection = await connect(ordinary);
    assert.equal(latest(ordinaryConnection).self.role, "player");
  });
  await check("Anonymous WS connection is rejected with HTTP401", async () => {
    const ws = new WebSocket(new URL("/ws", base).href.replace(/^http/, "ws"));
    try {
      const status = await new Promise((done, reject) => {
        const timeout = setTimeout(() => reject(Error("Anonymous upgrade timeout")), 5000);
        ws.once("unexpected-response", (_req, res) => { clearTimeout(timeout); res.resume(); done(res.statusCode); });
        ws.once("open", () => { clearTimeout(timeout); reject(Error("Anonymous upgrade unexpectedly succeeded")); });
        ws.on("error", () => {});
      });
      assert.equal(status, 401);
    } finally { ws.terminate(); }
  });
  await check("Ordinary authenticated WS rejects teleport despite forged role and target ID", async () => {
    const text = await rejectPacket(ordinary, ordinaryConnection, {
      type: "adminTeleport", x: 200, z: 200, role: "admin", isAdmin: true, player: admin.id,
    });
    return { rejection: text };
  });
  await check("Ordinary move packet still cannot cross the world instantly", async () => {
    const before = await authenticatedPlayer(ordinary);
    const baseline = economic(before);
    await pause(300);
    ordinaryConnection.ws.send(JSON.stringify({ type: "move", x: 240, z: 240, rotation: 0, running: true, role: "admin" }));
    await pause(30);
    const after = await authenticatedPlayer(ordinary);
    const distance = Math.hypot(after.x - before.x, after.z - before.z);
    assert.ok(distance <= .500001, "Canonical movement remains limited to at most 2m/s over .25s.");
    const afterEconomic = economic(after);
    // Legitimate running can accumulate distance without changing XP or inventory.
    delete baseline.quest.runDistance; delete afterEconomic.quest.runDistance;
    assert.deepEqual(afterEconomic, baseline);
    return { maxDistance: .5, observedDistance: distance };
  });

  await stop();
  const seeded = JSON.parse(await readFile(stateFile, "utf8"));
  seeded.accounts[admin.id].role = "admin";
  delete seeded.accounts[ordinary.id].role; // Compatibility with old accounts.
  seeded.players[ordinary.id].role = "admin"; // A persisted player field cannot grant account privileges.
  const bankItem = Object.keys(seeded.players[admin.id].inventory)[0];
  assert.ok(bankItem, "Use an actual shipped item in the bank preservation fixture.");
  seeded.players[admin.id].bank[bankItem] = 7;
  await writeFile(stateFile, JSON.stringify(seeded), { mode: 0o600 });
  await start();

  await check("Legacy missing account role and forged saved player role remain ordinary", async () => {
    await login(ordinary, "player"); ordinaryConnection = await connect(ordinary);
    assert.equal(latest(ordinaryConnection).self.role, "player");
    await rejectPacket(ordinary, ordinaryConnection, { type: "adminTeleport", x: 170, z: 160, role: "admin" });
  });
  await check("Offline account admin role survives real HTTP login and two WS sessions", async () => {
    const player = await login(admin, "admin");
    assert.equal(player.bank[bankItem], 7);
    adminConnection = await connect(admin); secondConnection = await connect(admin);
    for (const c of [adminConnection, secondConnection]) assert.equal(latest(c).self.role, "admin");
  });
  await check("Admin jumps across map components with ack and authoritative snapshot in both own sessions", async () => {
    const ordinaryAcks = ordinaryConnection.teleports.length;
    await teleport(admin, adminConnection, 126.25, 131.75, [adminConnection, secondConnection]);
    assert.equal(ordinaryConnection.teleports.length, ordinaryAcks, "Another account must not receive own-session teleport ack.");
    return { destination: { x: 126.25, z: 131.75 }, ownSessions: 2 };
  });
  await check("Full source grid accepts all four edge-cell centers and the minimum boundary", async () => {
    const destinations = [
      [-255.5, -255.5], [-255.5, 255.5], [255.5, -255.5], [255.5, 255.5], [-256, -256],
    ];
    for (const [x, z] of destinations)
      await teleport(admin, adminConnection, x, z, [adminConnection, secondConnection]);
    return { destinations: destinations.map(([x, z]) => ({ x, z })) };
  });
  await check("Admin can inspect a source solid cell without losing existing items or bank", async () => {
    const index = map.terrain.findIndex((word, i) => {
      const x = Math.floor(i / 512) - 255.5, z = i % 512 - 255.5;
      return !!(word & 0x04000000) && Math.abs(x) < 254 && Math.abs(z) < 254;
    });
    assert.ok(index >= 0);
    const x = Math.floor(index / 512) - 255.5, z = index % 512 - 255.5;
    await teleport(admin, adminConnection, x, z, [adminConnection, secondConnection]);
    return { index, destination: { x, z }, solid: true };
  });
  await check("Admin rejects out-of-grid, wrong-type and nonfinite coordinate packets without mutation", async () => {
    const invalid = [
      { type: "adminTeleport", x: 256, z: 0 },
      { type: "adminTeleport", x: -256.01, z: 0 },
      { type: "adminTeleport", x: 0, z: 256 },
      { type: "adminTeleport", x: 0, z: -256.01 },
      { type: "adminTeleport", x: "1", z: 0 },
      { type: "adminTeleport", x: null, z: 0 },
      { type: "adminTeleport", z: 0 },
      { type: "adminTeleport", x: 0, z: [1] },
      '{"type":"adminTeleport","x":1e309,"z":0}',
      '{"type":"adminTeleport","x":0,"z":-1e309}',
      '{"type":"adminTeleport","x":NaN,"z":0}',
    ];
    const secondAcks = secondConnection.teleports.length;
    for (const packet of invalid) await rejectPacket(admin, adminConnection, packet);
    assert.equal(secondConnection.teleports.length, secondAcks);
    return { cases: invalid.length };
  });
  await check("Teleport cancels a WS-selected combat target and prevents further remote attacks", async () => {
    const rat = service.state.entities.find(e => e.type === "monster" && e.originalId === 238 && e.alive !== false && e.hp > 8);
    assert.ok(rat, "Shipped Rat238 fixture required.");
    await teleport(admin, adminConnection, rat.x, rat.z, [adminConnection, secondConnection]);
    adminConnection.ws.send(JSON.stringify({ type: "action", action: "engage", target: rat.id }));
    // Observe selection without changing game time or writing live fixture state.
    await until(() => service.game.snapshot(admin.id).self.combatTarget === rat.id, "server receives WS engage packet");
    const hpBefore = rat.hp;
    service.tick();
    await until(() => latest(adminConnection).self.combatTarget === rat.id, "real tick publishes active combat target");
    assert.ok(rat.hp < hpBefore, "The selected real creature must receive a legitimate first attack.");
    assert.ok(latest(adminConnection).self.hp > 0, "Test character must survive to verify cancellation.");
    const ratHp = rat.hp;
    await teleport(admin, adminConnection, map.spawn.x, map.spawn.z, [adminConnection, secondConnection]);
    assert.equal(latest(adminConnection).self.combatTarget, undefined);
    const sequence = adminConnection.snapshots.length;
    service.tick();
    await until(() => adminConnection.snapshots.length > sequence, "tick after combat cancellation");
    assert.equal(latest(adminConnection).self.combatTarget, undefined);
    assert.equal(rat.hp, ratHp);
    return { creature: rat.id, damageBeforeTeleport: hpBefore - ratHp, destination: map.spawn };
  });
  await check("Logout invalidates admin cookie and real re-login preserves admin role and position", async () => {
    const before = await authenticatedPlayer(admin), cookie = admin.cookie;
    const result = await request("/api/auth/logout", { method: "POST", cookie });
    assert.equal(result.status, 200);
    const invalidated = await request("/api/session", { cookie });
    assert.equal(invalidated.data.player, null);
    const player = await login(admin, "admin");
    assert.deepEqual(position(player), position(before));
    assert.deepEqual(economic(player), economic(before));
    adminConnection = await connect(admin);
    assert.equal(latest(adminConnection).self.role, "admin");
  });

  await stop();
  const persisted = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(persisted.accounts[admin.id].role, "admin");
  const shippedWorld = JSON.parse(await readFile(resolve(root, "data/world.json"), "utf8"));
  const recipe = shippedWorld.recipes[0]; assert.ok(recipe);
  const job = {
    playerId: admin.id, recipeId: recipe.id, completeAt: Date.now() + 3600000,
    inputs: recipe.inputs, outputs: recipe.outputs,
  };
  persisted.jobs[admin.id] = job;
  await writeFile(stateFile, JSON.stringify(persisted), { mode: 0o600 });
  await start();
  await check("Restart retains account admin role and teleport preserves a pending crafting job", async () => {
    await login(admin, "admin"); adminConnection = await connect(admin);
    const before = latest(adminConnection).self;
    assert.match(before.action, /^Изготовление:/);
    await teleport(admin, adminConnection, map.spawn.x + .25, map.spawn.z + .25);
    assert.deepEqual(service.state.jobs[admin.id], job);
    assert.equal(latest(adminConnection).self.action, before.action, "Teleport cannot hide an active craft job.");
    return { pendingRecipe: recipe.id, restartVerified: true };
  });
  await check("Final health remains good and checkpoint durably saves teleport without losing the job", async () => {
    const after = await authenticatedPlayer(admin);
    const result = await request("/api/health");
    assert.equal(result.status, 200); assert.equal(result.data.persistence, "ok");
    await stop();
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    assert.deepEqual(position(saved.players[admin.id]), position(after));
    assert.deepEqual(economic(saved.players[admin.id]), economic(after));
    assert.deepEqual(saved.jobs[admin.id], job);
    assert.equal(saved.accounts[admin.id].role, "admin");
    for (const account of accounts) assert.ok(!JSON.stringify(saved).includes(account.password));
    return { durablySaved: true };
  });
} catch (error) {
  failure = error;
  console.error("Admin smoke failed: " + safeError(error));
} finally {
  try { await stop(); } catch (error) { report.cleanupError = safeError(error); failure ??= error; }
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  // Verify the exact resolved mkdtemp child before a recursive Windows removal.
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(resolve(directory).startsWith(join(resolve(tmpdir()), "aw-admin-smoke-")));
  await rm(directory, { recursive: true, force: true });
  report.finished = new Date().toISOString();
  report.durationSeconds = (Date.now() - started) / 1000;
  report.passed = results.filter(r => r.status === "PASS").length;
  report.failed = results.filter(r => r.status === "FAIL").length;
  report.status = failure ? "FAILED" : "PASSED";
  report.temporaryPrivateStateRemoved = true;
  if (failure) report.failure = safeError(failure);
  const reportDirectory = resolve(root, "artifacts/admin-smoke");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, started + "-localhost.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ status: report.status, passed: report.passed, failed: report.failed,
    durationSeconds: report.durationSeconds, report: reportPath }));
  if (failure) process.exitCode = 1;
}
