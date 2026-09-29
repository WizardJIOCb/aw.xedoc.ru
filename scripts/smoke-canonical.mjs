/** Real canonical-world HTTP/WS smoke. No state edits, clock changes or teleport.
 * node scripts/smoke-canonical.mjs http://127.0.0.1:3190 [--max-route=75]
 * --plan-only performs read-only HTTP/map/navigation checks without an account.
 * --bank-only verifies a longer bank route directly from spawn.
 * --combat-only [--combat-target=aw:65054] tests automatic attacks from spawn.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { tsImport } from "tsx/esm/api";
import WebSocket from "ws";

const { NavigationGrid } = await tsImport(
  "../src/client/navigation.ts",
  import.meta.url,
);
const { terrainWalkable, terrainSegmentClear } = await tsImport(
  "../src/shared/canonical-map.ts",
  import.meta.url,
);
const args = process.argv.slice(2);
const base = new URL(
  args.find((a) => !a.startsWith("--")) ?? "http://127.0.0.1:3190",
);
if (
  !["http:", "https:"].includes(base.protocol) ||
  base.username ||
  base.password
)
  throw Error("Supply an HTTP(S) origin without credentials");
base.pathname = "/";
base.search = "";
base.hash = "";
const maxRoute = Number(
  args.find((a) => a.startsWith("--max-route="))?.split("=")[1] ?? 75,
);
assert.ok(
  Number.isFinite(maxRoute) && maxRoute >= 5 && maxRoute <= 250,
  "max-route must be 5..250 metres",
);
const planOnly = args.includes("--plan-only");
const bankOnly = args.includes("--bank-only");
const combatOnly = args.includes("--combat-only");
assert.ok(!(bankOnly && combatOnly), "Choose one focused smoke scenario");
const combatTarget = args
  .find((a) => a.startsWith("--combat-target="))
  ?.slice(16);
const root = fileURLToPath(new URL("..", import.meta.url));
const started = Date.now();
const results = [],
  routes = [],
  moves = [];
const accounts = [],
  connections = [];
const report = {
  started: new Date(started).toISOString(),
  target: base.origin,
  planOnly,
  scenario: bankOnly ? "bank-only" : combatOnly ? "combat-only" : "full",
  maxRoute,
  checks: results,
  routes,
  movement: moves,
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
let map, world, grid, health, account, connection, bob, purchasedOre;

async function until(predicate, label, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = predicate();
    if (value) return value;
    await pause(40);
  }
  throw Error("Timed out: " + label);
}
async function check(name, fn) {
  const at = Date.now();
  try {
    const details = await fn();
    results.push({
      name,
      status: "PASS",
      ms: Date.now() - at,
      ...(details ?? {}),
    });
    console.log("PASS " + name);
  } catch (error) {
    results.push({
      name,
      status: "FAIL",
      ms: Date.now() - at,
      error: safeError(error),
    });
    throw error;
  }
}
function skip(name, reason) {
  results.push({ name, status: "SKIP", reason });
  console.log("SKIP " + name + ": " + reason);
}
function safeError(error) {
  let message = String(error?.message ?? error);
  for (const a of accounts)
    for (const secret of [a.password, a.cookie])
      if (secret) message = message.split(secret).join("[redacted]");
  return message;
}
async function request(path, { method = "GET", cookie, body } = {}) {
  const headers = { Origin: base.origin };
  if (cookie) headers.Cookie = cookie;
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(new URL(path, base), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json();
  const cookieValue =
    response.headers
      .getSetCookie?.()
      .map((s) => s.split(";")[0])
      .find((s) => s.startsWith("aw_session=")) ??
    response.headers.get("set-cookie")?.split(";")[0];
  return { status: response.status, data, cookie: cookieValue };
}
async function register() {
  const name =
    "qa_map_" + Date.now().toString(36) + "_" + randomBytes(3).toString("hex");
  const password = randomBytes(24).toString("base64url");
  const result = await request("/api/auth/register", {
    method: "POST",
    body: { name, password },
  });
  assert.equal(result.status, 201, "registration must succeed");
  assert.ok(result.cookie, "authenticated cookie required");
  const a = {
    name,
    password,
    cookie: result.cookie,
    id: result.data.player.id,
  };
  accounts.push(a);
  return a;
}
async function connect(a) {
  const url = new URL("/ws", base);
  url.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url, {
    headers: { Cookie: a.cookie, Origin: base.origin },
  });
  const c = {
    ws,
    snapshot: null,
    sequence: 0,
    notices: [],
    events: new Map(),
    receivedAt: 0,
    times: [],
    sent: 0,
  };
  connections.push(c);
  ws.on("message", (bytes) => {
    const message = JSON.parse(bytes.toString());
    if (message.type === "snapshot") {
      c.snapshot = message;
      c.sequence++;
      c.receivedAt = Date.now();
      c.times.push(c.receivedAt);
      for (const event of message.events ?? []) c.events.set(event.id, event);
    } else if (message.type === "notice") c.notices.push(message);
  });
  ws.on("error", () => {});
  await until(() => c.snapshot, "initial authenticated WebSocket snapshot");
  return c;
}
function send(c, message) {
  assert.equal(c.ws.readyState, WebSocket.OPEN, "socket must be open");
  c.ws.send(JSON.stringify(message));
  c.sent++;
}
async function notice(c, message, kind) {
  const before = c.notices.length;
  send(c, { type: "action", ...message });
  const result = await until(
    () => c.notices[before],
    "notice for " + message.action,
  );
  if (kind)
    assert.equal(result.kind, kind, message.action + ": " + result.text);
  return result;
}
const amount = (c, item, storage = "inventory") =>
  c.snapshot.self[storage][item] ?? 0;
function routeLength(start, route) {
  let length = 0,
    previous = start;
  for (const p of route) {
    length += distance(previous, p);
    previous = p;
  }
  return length;
}

// Interactions need proximity rather than standing inside an NPC/wall tile.
// Try near-side approach points first, then use shared A* when terrain walls
// require a detour. No manual fallback crosses an unwalkable segment.
function approach(
  start,
  target,
  range = 5.2,
  limit = maxRoute,
  planner = grid,
) {
  const dx = start.x - target.x,
    dz = start.z - target.z,
    len = Math.hypot(dx, dz) || 1;
  const candidates = [
    {
      x: target.x + (dx / len) * Math.min(range - 0.6, len),
      z: target.z + (dz / len) * Math.min(range - 0.6, len),
    },
  ];
  for (const radius of [range - 0.6, Math.min(2.5, range - 0.6), 0.6])
    for (let i = 0; i < 12; i++)
      candidates.push({
        x: target.x + Math.cos((i * Math.PI) / 6) * radius,
        z: target.z + Math.sin((i * Math.PI) / 6) * radius,
      });
  let best,
    detours = 0;
  for (const point of candidates) {
    if (!planner.walkable(point)) continue;
    const direct = planner.segmentClear(start, point) ? [point] : undefined;
    if (!direct && ++detours > 6) break;
    // Avoid running A* against dozens of distant/blocked goal candidates.
    const route = direct ?? planner.findRoute(start, point);
    if (!route.length) continue;
    const end = route.at(-1),
      length = routeLength(start, route);
    if (distance(end, target) > range || length > limit) continue;
    if (!best || length < best.length)
      best = {
        target: { id: target.id, name: target.name, x: target.x, z: target.z },
        range,
        route,
        length,
      };
    if (best) break;
  }
  return best;
}
function nearest(
  kind,
  matcher,
  start = connection?.snapshot.self ?? map.spawn,
) {
  // Plan static NPCs beyond the intentionally culled55m snapshot radius.
  return (
    kind === "npc"
      ? world.entities
      : (connection?.snapshot.entities ?? world.entities)
  )
    .filter((e) => e.type === kind && matcher(e))
    .sort((a, b) => distance(start, a) - distance(start, b));
}
function knownAggressive(ignoredTarget) {
  const known = new Map(world.entities.map((e) => [e.id, e]));
  for (const entity of connection?.snapshot.entities ?? [])
    known.set(entity.id, entity);
  return [...known.values()].filter(
    (e) =>
      e.type === "monster" &&
      e.id !== ignoredTarget &&
      e.alive !== false &&
      e.state === "aggressive",
  );
}
function avoidingGrid(ignoredTarget) {
  const enemies = knownAggressive(ignoredTarget);
  const buckets = new Map();
  for (const enemy of enemies) {
    const key = Math.floor(enemy.x / 8) + ":" + Math.floor(enemy.z / 8);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(enemy);
  }
  const safe = (p) => {
    if ((p.x - map.spawn.x) ** 2 + (p.z - map.spawn.z) ** 2 <= 144) return true;
    const bx = Math.floor(p.x / 8),
      bz = Math.floor(p.z / 8);
    for (let x = bx - 1; x <= bx + 1; x++)
      for (let z = bz - 1; z <= bz + 1; z++)
        for (const enemy of buckets.get(x + ":" + z) ?? [])
          if ((p.x - enemy.x) ** 2 + (p.z - enemy.z) ** 2 < 7.5 ** 2)
            return false;
    return true;
  };
  return new NavigationGrid([], map.layout.limit, 1, 0, {
    walkable: (p) => terrainWalkable(map, p.x, p.z) && safe(p),
    segmentClear: (a, b) => {
      if (!terrainSegmentClear(map, a, b)) return false;
      const steps = Math.max(1, Math.ceil(distance(a, b) * 2));
      for (let i = 0; i <= steps; i++)
        if (
          !safe({
            x: a.x + ((b.x - a.x) * i) / steps,
            z: a.z + ((b.z - a.z) * i) / steps,
          })
        )
          return false;
      return true;
    },
  });
}
function dangerousRoute(plan, ignoredTarget) {
  const enemies = knownAggressive(ignoredTarget);
  let previous = connection?.snapshot.self ?? map.spawn;
  for (const point of plan.route) {
    const steps = Math.max(1, Math.ceil(distance(previous, point)));
    for (let i = 0; i <= steps; i++) {
      const p = {
        x: previous.x + ((point.x - previous.x) * i) / steps,
        z: previous.z + ((point.z - previous.z) * i) / steps,
      };
      const danger =
        distance(p, map.spawn) > 12
          ? enemies.find((e) => distance(p, e) < 7.5)
          : undefined;
      if (danger) {
        report.routeRejections ??= [];
        report.routeRejections.push({
          target: plan.target.id,
          reason: "aggressive creature within avoidance radius",
          sample: p,
          monster: {
            id: danger.id,
            name: danger.name,
            x: danger.x,
            z: danger.z,
          },
        });
        return true;
      }
    }
    previous = point;
  }
  return false;
}
function planNearby(
  kind,
  matcher,
  range = 5.2,
  { avoidDanger = true, maxCandidates = 5, routeLimit = maxRoute } = {},
) {
  const start = connection?.snapshot.self ?? map.spawn;
  for (const entity of nearest(kind, matcher, start).slice(0, maxCandidates)) {
    if (distance(start, entity) > routeLimit + range) continue;
    const plan = approach(
      start,
      entity,
      range,
      routeLimit,
      avoidDanger ? avoidingGrid(entity.id) : grid,
    );
    if (plan && (!avoidDanger || !dangerousRoute(plan, entity.id)))
      return { entity, plan };
  }
  return undefined;
}

async function walk(c, plan, label) {
  const record = {
    label,
    length: plan.length,
    waypoints: plan.route,
    target: plan.target,
    started: new Date().toISOString(),
    requestedSpeed: 1.8,
    maxRequestedStep: 0,
    packets: 0,
  };
  routes.push(record);
  // Running tone can expire on a long route; authoritative walking then limits
  // movement to 1m/s. Leave room for snapshot reconciliation and wall corners.
  const deadline = Date.now() + (plan.length / 0.65) * 1000 + 20_000;
  let progressAt = Date.now(),
    lastMoveAt = Date.now(),
    lastNotice = c.notices.length;
  for (const point of plan.route) {
    let stalledAt = Date.now(),
      lastPosition = { x: c.snapshot.self.x, z: c.snapshot.self.z };
    while (distance(c.snapshot.self, point) > 0.035) {
      if (Date.now() > deadline)
        throw Error(label + ": ordinary route exceeded its time budget");
      await pause(120);
      const self = c.snapshot.self;
      if (c.notices.slice(lastNotice).some((n) => n.kind === "error"))
        throw Error(
          label +
            ": " +
            c.notices.slice(lastNotice).find((n) => n.kind === "error").text,
        );
      lastNotice = c.notices.length;
      if (distance(self, lastPosition) > 0.03) {
        stalledAt = Date.now();
        lastPosition = { x: self.x, z: self.z };
      }
      if (Date.now() - stalledAt > 7000)
        throw Error(
          label + ": server did not advance along the checked terrain route",
        );
      const remaining = distance(self, point);
      if (remaining <= 0.035) break;
      const at = Date.now(),
        elapsed = Math.min(0.2, (at - lastMoveAt) / 1000);
      lastMoveAt = at;
      const step = Math.min(remaining, 1.8 * elapsed);
      const next = {
        x: self.x + ((point.x - self.x) / remaining) * step,
        z: self.z + ((point.z - self.z) / remaining) * step,
      };
      assert.ok(
        step <= 2 * elapsed + 1e-6,
        "movement request stays at or below source-confirmed run speed",
      );
      if (!terrainSegmentClear(map, self, next)) {
        report.blockedMovement = {
          label,
          from: { x: self.x, z: self.z },
          requested: next,
          waypoint: point,
          at: at - started,
        };
        throw Error("every transmitted movement segment must be traversable");
      }
      send(c, {
        type: "move",
        ...next,
        rotation: Math.atan2(point.x - self.x, point.z - self.z),
        running: true,
      });
      record.maxRequestedStep = Math.max(record.maxRequestedStep, step);
      record.packets++;
      moves.push({
        at: at - started,
        from: { x: self.x, z: self.z },
        to: next,
        elapsed,
        speed: step / elapsed,
      });
      if (Date.now() - progressAt > 10_000) {
        console.log(
          "WALK " +
            label +
            ": " +
            distance(c.snapshot.self, plan.target).toFixed(1) +
            "m from target",
        );
        progressAt = Date.now();
      }
    }
  }
  assert.ok(
    distance(c.snapshot.self, plan.target) <= plan.range + 0.2,
    label + ": authoritative proximity",
  );
  record.finished = new Date().toISOString();
  record.actualEnd = { x: c.snapshot.self.x, z: c.snapshot.self.z };
}

async function checkBank() {
  const bank = planNearby(
    "npc",
    (e) => e.role === "bank" || /банк|bank/i.test(e.name + e.id),
  );
  const name = "Reachable bank deposit and withdrawal preserve the item total";
  if (!bank) {
    skip(
      name,
      "No route within " + maxRoute + "m that avoids hostile aggro areas",
    );
    return;
  }
  await check(name, async () => {
    await walk(connection, bank.plan, "bank");
    await notice(
      connection,
      { action: "talk", target: bank.entity.id },
      "info",
    );
    const item =
      purchasedOre ?? Object.keys(connection.snapshot.self.inventory)[0];
    assert.ok(item);
    const inventory = amount(connection, item),
      stored = amount(connection, item, "bank");
    await notice(
      connection,
      { action: "bankDeposit", item, quantity: 1 },
      "success",
    );
    await until(
      () =>
        amount(connection, item) === inventory - 1 &&
        amount(connection, item, "bank") === stored + 1,
      "deposit",
    );
    await notice(
      connection,
      { action: "bankWithdraw", item, quantity: 1 },
      "success",
    );
    await until(
      () =>
        amount(connection, item) === inventory &&
        amount(connection, item, "bank") === stored,
      "withdrawal",
    );
    return { target: bank.entity.id, item };
  });
}

async function checkCombat() {
  if (combatTarget) {
    const entity = connection.snapshot.entities.find(
      (e) => e.id === combatTarget,
    );
    const geometry =
      entity && approach(connection.snapshot.self, entity, 0.85, maxRoute);
    report.combatPlanning = {
      target: combatTarget,
      entity: entity && {
        id: entity.id,
        x: entity.x,
        z: entity.z,
        hp: entity.hp,
        maxHp: entity.maxHp,
        alive: entity.alive,
        state: entity.state,
        level: entity.level,
      },
      geometricRoute: geometry && {
        length: geometry.length,
        waypoints: geometry.route,
      },
    };
  }
  const combat = planNearby(
    "monster",
    (e) =>
      (!combatTarget || e.id === combatTarget) &&
      e.alive !== false &&
      (e.hp ?? 0) > 0 &&
      (e.maxHp ?? e.hp ?? 0) <= 40 &&
      (e.level ?? 1) <= 10,
    0.85,
    {
      avoidDanger: !combatTarget,
      maxCandidates: 12,
      routeLimit: Math.min(maxRoute, 75),
    },
  );
  if (combat)
    await check(
      "One engage command produces several server-driven attacks",
      async () => {
        await notice(
          connection,
          { action: "mode", value: "defensive" },
          "info",
        );
        await walk(connection, combat.plan, "nearby monster");
        const enemyId = combat.entity.id,
          id = account.id,
          seenBefore = new Set(connection.events.keys()),
          deathNotice = connection.notices.length;
        send(connection, {
          type: "action",
          action: "engage",
          target: enemyId,
        });
        const attacks = () =>
          [...connection.events.values()].filter(
            (e) =>
              !seenBefore.has(e.id) &&
              e.attacker === id &&
              e.target === enemyId,
          );
        const untilAt = Date.now() + 10_000;
        let lastUse = 0;
        while (attacks().length < 2 && Date.now() < untilAt) {
          const self = connection.snapshot.self;
          if (
            connection.notices
              .slice(deathNotice)
              .some((n) => /воскресли/i.test(n.text))
          )
            throw Error(
              "QA player died before observing two automatic attacks",
            );
          if (self.hp < self.maxHp && Date.now() - lastUse > 1200) {
            const food = world.items.find(
              (i) => (i.healing ?? 0) > 0 && amount(connection, i.id) > 0,
            );
            if (food) {
              send(connection, {
                type: "action",
                action: "use",
                item: food.id,
              });
              lastUse = Date.now();
            }
          }
          await pause(80);
        }
        send(connection, { type: "action", action: "disengage" });
        assert.ok(
          attacks().length >= 2,
          "one engage must resolve at least two server-driven attacks",
        );
        const hits = attacks().sort((a, b) => a.at - b.at);
        assert.ok(
          hits[1].at - hits[0].at >= 1000,
          "attacks respect at least1000ms cooldown",
        );
        await until(
          () => !connection.snapshot.self.combatTarget,
          "disengage reflected in snapshot",
        );
        return {
          target: enemyId,
          engagePackets: 1,
          automaticHits: hits.map((e) => ({ at: e.at, damage: e.damage })),
          firstIntervalMs: hits[1].at - hits[0].at,
        };
      },
    );
  else
    skip(
      "One engage command produces several server-driven attacks",
      "No weak reachable live monster within the bounded route that avoids other hostile groups",
    );
}

let failure;
try {
  await check(
    "Health declares canonical simulation and snapshot cadence",
    async () => {
      const r = await request("/api/health");
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);
      assert.equal(r.data.simulationHz, 2);
      assert.equal(r.data.snapshotHz, 5);
      assert.equal(r.data.persistence, "ok");
      health = r.data;
      report.health = {
        simulationHz: health.simulationHz,
        snapshotHz: health.snapshotHz,
        map: health.map,
        sourceCommit: health.sourceCommit,
        progression: health.progression,
      };
    },
  );
  await check(
    "API map contains the source-confirmed 512 grid and 13085 placements",
    async () => {
      const r = await request("/api/map");
      assert.equal(r.status, 200);
      map = r.data;
      assert.equal(map.layout.width, 512);
      assert.equal(map.layout.height, 512);
      assert.equal(map.terrain.length, 512 * 512);
      assert.equal(map.placements.length, 13085);
      assert.equal(health.map?.cells, map.terrain.length);
      assert.equal(health.map?.placements, map.placements.length);
      assert.equal(health.map?.sourceSha256, map.sha256);
      assert.ok(terrainWalkable(map, map.spawn.x, map.spawn.z));
      const w = await request("/api/world");
      assert.equal(w.status, 200);
      world = w.data;
      grid = new NavigationGrid([], map.layout.limit, 1, 0, {
        walkable: (p) => terrainWalkable(map, p.x, p.z),
        segmentClear: (a, b) => terrainSegmentClear(map, a, b),
      });
      report.map = {
        sha256: map.sha256,
        layout: map.layout,
        spawn: map.spawn,
        placements: map.placements.length,
        activeEntities: world.entities.length,
      };
    },
  );
  bob = world.entities.find(
    (e) =>
      e.type === "npc" && (e.role === "bob" || /bob|боб/i.test(e.id + e.name)),
  );
  assert.ok(bob, "canonical world exposes Bob");
  if (planOnly) {
    report.plans = ["bank", "trader"].map((role) => {
      const p = planNearby(
        "npc",
        (e) =>
          e.role === role ||
          new RegExp(
            role === "bank" ? "банк|bank" : "торгов|trader|shop",
            "i",
          ).test(e.name + e.id),
      );
      return {
        role,
        reachable: !!p,
        ...(p
          ? {
              entity: p.entity.id,
              length: p.plan.length,
              waypoints: p.plan.route,
            }
          : {}),
        policy: "shared terrain navigation; dangerous/distant routes excluded",
      };
    });
    await check("Bob is within ordinary spawn interaction range", async () => {
      assert.ok(distance(map.spawn, bob) < 6);
      return { bobId: bob.id, distance: distance(map.spawn, bob) };
    });
  } else {
    await check(
      "Random account and authenticated WebSocket spawn beside canonical Bob",
      async () => {
        account = await register();
        connection = await connect(account);
        assert.equal(connection.snapshot.self.id, account.id);
        assert.ok(distance(connection.snapshot.self, map.spawn) < 0.01);
        assert.ok(distance(connection.snapshot.self, bob) < 6);
        report.account = { name: account.name, id: account.id };
        report.spawn = {
          x: connection.snapshot.self.x,
          z: connection.snapshot.self.z,
          bobId: bob.id,
          distanceToBob: distance(connection.snapshot.self, bob),
        };
      },
    );
    await check("WebSocket actually delivers periodic snapshots", async () => {
      const first = connection.times.length;
      await pause(1300);
      const times = connection.times.slice(first);
      assert.ok(times.length >= 4, "expected several periodic snapshots");
      const intervals = times
        .slice(1)
        .map((t, i) => t - times[i])
        .sort((a, b) => a - b);
      const median = intervals[Math.floor(intervals.length / 2)];
      assert.ok(
        median >= 100 && median <= 400,
        "snapshot cadence should be near200ms",
      );
      return { samples: times.length, medianIntervalMs: median };
    });
    await check(
      "Bob quest acceptance and repeated talk cannot grant an unearned reward",
      async () => {
        const credits = connection.snapshot.self.credits,
          xp = connection.snapshot.self.xp;
        await notice(connection, { action: "talk", target: bob.id }, "info");
        await until(
          () => connection.snapshot.self.quest.bobStarted === 1,
          "Bob quest accepted",
        );
        assert.equal(connection.snapshot.self.quest.bobComplete ?? 0, 0);
        await notice(connection, { action: "talk", target: bob.id }, "info");
        await pause(250);
        assert.equal(connection.snapshot.self.credits, credits);
        assert.equal(connection.snapshot.self.xp, xp);
      },
    );
    if (bankOnly || combatOnly) {
      if (bankOnly) await checkBank();
      else await checkCombat();
      for (const name of [
        "Ordinary terrain-checked movement and nearby resource gathering",
        "Reachable trader purchase through ordinary movement",
        "Real Bob hand-in gives one reward and repeated hand-in cannot duplicate it",
        ...(bankOnly
          ? ["One engage command produces several server-driven attacks"]
          : ["Reachable bank deposit and withdrawal preserve the item total"]),
      ])
        skip(name, "Outside the explicit " + report.scenario + " scenario");
    } else {
      const resourcePlan = planNearby(
        "resource",
        (e) => e.resource && e.alive !== false,
        3.2,
        { routeLimit: 15 },
      );
      if (resourcePlan)
        await check(
          "Ordinary terrain-checked movement and nearby resource gathering",
          async () => {
            await walk(connection, resourcePlan.plan, "nearby resource");
            const item = resourcePlan.entity.resource,
              before = amount(connection, item);
            await notice(
              connection,
              { action: "gather", target: resourcePlan.entity.id },
              "success",
            );
            await until(
              () => amount(connection, item) === before + 1,
              "one gathered resource",
            );
            return { target: resourcePlan.entity.id, item };
          },
        );
      else
        skip(
          "Ordinary terrain-checked movement and nearby resource gathering",
          "No accessible nearby resource in the current snapshot",
        );
      const trader = planNearby(
        "npc",
        (e) => e.role === "trader" || /торгов|trader|shop/i.test(e.name + e.id),
      );
      if (trader)
        await check(
          "Reachable trader purchase through ordinary movement",
          async () => {
            await walk(connection, trader.plan, "trader");
            await notice(
              connection,
              { action: "talk", target: trader.entity.id },
              "info",
            );
            const ore = world.items
              .filter((i) => /ore|руда/i.test(i.id + i.name) && i.value > 0)
              .sort((a, b) => a.value - b.value)
              .find((i) => i.value * 5 <= connection.snapshot.self.credits);
            assert.ok(ore, "affordable ore for a real Bob transaction");
            const before = amount(connection, ore.id),
              credits = connection.snapshot.self.credits;
            await notice(
              connection,
              { action: "buy", item: ore.id, quantity: 5 },
              "success",
            );
            await until(
              () => amount(connection, ore.id) === before + 5,
              "ore purchase",
            );
            assert.equal(
              connection.snapshot.self.credits,
              credits - Math.max(1, Math.ceil(ore.value)) * 5,
            );
            purchasedOre = ore.id;
            return { target: trader.entity.id, item: ore.id, quantity: 5 };
          },
        );
      else
        skip(
          "Reachable trader purchase through ordinary movement",
          "No route within " + maxRoute + "m that avoids hostile aggro areas",
        );
      await checkBank();
      if (purchasedOre) {
        const back = approach(connection.snapshot.self, bob, 5.2);
        if (back && !dangerousRoute(back))
          await check(
            "Real Bob hand-in gives one reward and repeated hand-in cannot duplicate it",
            async () => {
              await walk(connection, back, "return to Bob");
              const credits = connection.snapshot.self.credits,
                ore = amount(connection, purchasedOre),
                xp = connection.snapshot.self.xp;
              await notice(
                connection,
                { action: "talk", target: bob.id },
                "success",
              );
              await until(
                () => connection.snapshot.self.quest.bobComplete === 1,
                "Bob quest completion",
              );
              assert.equal(connection.snapshot.self.credits, credits + 75);
              assert.equal(amount(connection, purchasedOre), ore - 5);
              assert.ok(connection.snapshot.self.xp > xp);
              const after = {
                credits: connection.snapshot.self.credits,
                xp: connection.snapshot.self.xp,
                inventory: structuredClone(connection.snapshot.self.inventory),
              };
              await notice(
                connection,
                { action: "talk", target: bob.id },
                "info",
              );
              await pause(250);
              assert.equal(connection.snapshot.self.credits, after.credits);
              assert.equal(connection.snapshot.self.xp, after.xp);
              assert.deepEqual(
                connection.snapshot.self.inventory,
                after.inventory,
              );
            },
          );
        else
          skip(
            "Real Bob hand-in gives one reward and repeated hand-in cannot duplicate it",
            "Return route currently crosses hostile territory or is unavailable",
          );
      } else
        skip(
          "Real Bob hand-in gives one reward and repeated hand-in cannot duplicate it",
          "No ore was acquired through a reachable trader; reward remains untested",
        );
      await checkCombat();
    }
    await check(
      "Health remains healthy after ordinary gameplay mutations",
      async () => {
        const r = await request("/api/health");
        assert.equal(r.status, 200);
        assert.equal(r.data.persistence, "ok");
      },
    );
  }
} catch (error) {
  failure = error;
  console.error("Canonical smoke failed: " + safeError(error));
} finally {
  for (const c of connections) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.close();
  }
  for (const a of accounts)
    try {
      await request("/api/auth/logout", { method: "POST", cookie: a.cookie });
    } catch (error) {
      report.cleanupError = safeError(error);
    }
  report.finished = new Date().toISOString();
  report.durationSeconds = (Date.now() - started) / 1000;
  report.passed = results.filter((r) => r.status === "PASS").length;
  report.failed = results.filter((r) => r.status === "FAIL").length;
  report.skipped = results.filter((r) => r.status === "SKIP").length;
  report.status = failure ? "FAILED" : report.skipped ? "PARTIAL" : "PASSED";
  report.coverageBoundary =
    "SKIP is untested, not success. Browser dialogue, mouse selection, rendering/FPS and restart durability are separate checks. Accounts remain; sessions are logged out. No persisted state was edited, no player was teleported and every move used running=true with at most2m/s request speed.";
  if (failure) report.failure = safeError(failure);
  const directory = resolve(root, "artifacts/canonical-smoke");
  await mkdir(directory, { recursive: true });
  const path = resolve(
    directory,
    started + "-" + base.hostname.replace(/[^a-z0-9.-]/gi, "_") + ".json",
  );
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(
    JSON.stringify({
      status: report.status,
      passed: report.passed,
      failed: report.failed,
      skipped: report.skipped,
      durationSeconds: report.durationSeconds,
      report: path,
      account: report.account?.name,
    }),
  );
  if (failure) process.exitCode = 1;
}
