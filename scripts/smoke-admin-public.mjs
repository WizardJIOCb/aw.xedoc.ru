/** Bounded public negative test. Creates ONE ordinary QA account, never an admin.
 * Run only after deploying the feature to the explicitly selected AW service:
 * node scripts/smoke-admin-public.mjs https://aw.xedoc.ru --expected-sha=FULL_SHA
 * The account remains after the test; all issued sessions are logged out.
 * Passwords/cookies stay in memory. Evidence goes into ignored artifacts only.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const args = process.argv.slice(2);
assert.ok(args.every(arg => !arg.startsWith("--") || arg.startsWith("--expected-sha=")), "Unknown smoke option.");
assert.ok(args.filter(arg => !arg.startsWith("--")).length <= 1, "Supply at most one public AW origin.");
assert.ok(args.filter(arg => arg.startsWith("--expected-sha=")).length <= 1, "Supply one expected source SHA.");
const base = new URL(args.find(arg => !arg.startsWith("--")) ?? "https://aw.xedoc.ru");
assert.equal(base.origin, "https://aw.xedoc.ru", "This test is authorized only for the selected public AW service.");
assert.ok(!base.username && !base.password && !base.search && !base.hash, "Use an origin without credentials or query.");
base.pathname = "/";
const expectedSha = args.find(arg => arg.startsWith("--expected-sha="))?.slice("--expected-sha=".length);
assert.ok(expectedSha === undefined || /^[0-9a-f]{40}$/.test(expectedSha), "Expected SHA must be the full 40-character commit SHA.");
const root = fileURLToPath(new URL("..", import.meta.url));
const started = Date.now();
const deadline = started + 20000;
const abort = new AbortController();
const deadlineTimer = setTimeout(() => abort.abort(Error("Public smoke deadline exceeded")), 20000);
deadlineTimer.unref();
const results = [], issuedCookies = [];
const account = {
  name: "qa_tp_" + started.toString(36) + "_" + randomBytes(3).toString("hex"),
  password: randomBytes(24).toString("base64url"),
};
const report = {
  started: new Date(started).toISOString(),
  target: base.origin,
  expectedSourceCommit: expectedSha ?? null,
  checks: results,
  coverageBoundary: "Production ordinary-player negative checks only. No admin privilege was granted, no existing account was changed, and no positive admin teleport or browser UI claim is made.",
  comparisonBoundary: "Only quest.recoveryMs and quest.runDistance runtime counters are excluded. The real server tick advances its recovery clock independently of denied commands; every other quest/progression key, XP, inventory, bank, stats and vitals remains compared.",
  accountRemains: false,
};
let cookie, connection, failure;
const pause = ms => new Promise(done => setTimeout(done, ms));
function safeError(error) {
  let message = String(error?.message ?? error);
  for (const secret of [account.password, ...issuedCookies, ...issuedCookies.map(value => value.slice(value.indexOf("=") + 1))])
    if (secret) message = message.split(secret).join("[redacted]");
  return message;
}
async function check(name, fn) {
  const at = Date.now();
  try {
    const details = await fn();
    results.push({ name, status: "PASS", ms: Date.now() - at, ...(details ?? {}) });
  } catch (error) {
    results.push({ name, status: "FAIL", ms: Date.now() - at, error: safeError(error) });
    throw error;
  }
}
async function until(predicate, label) {
  const end = Math.min(deadline, Date.now() + 5000);
  while (Date.now() < end) {
    if (connection?.error) throw connection.error;
    const value = predicate();
    if (value) return value;
    if (abort.signal.aborted) throw abort.signal.reason;
    await pause(25);
  }
  throw Error("Timed out: " + label);
}
async function request(path, { method = "GET", sessionCookie, body, cleanup = false } = {}) {
  const headers = { Origin: base.origin };
  if (sessionCookie) headers.Cookie = sessionCookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(new URL(path, base), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: cleanup ? AbortSignal.timeout(4000) : AbortSignal.any([abort.signal, AbortSignal.timeout(6000)]),
  });
  const nextCookie = response.headers.getSetCookie?.().map(value => value.split(";")[0]).find(value => value.startsWith("aw_session="))
    ?? response.headers.get("set-cookie")?.split(";")[0];
  if (nextCookie && method === "POST" && path !== "/api/auth/logout") issuedCookies.push(nextCookie);
  return { status: response.status, data: await response.json(), cookie: nextCookie };
}
const position = player => ({ x: player.x, z: player.z });
const preserved = player => {
  const fields = Object.fromEntries([
    "role", "hp", "maxHp", "stamina", "maxStamina", "force", "maxForce", "credits", "level", "xp",
    "inventory", "bank", "skills", "stats", "equipment", "equipped", "quest", "mode", "pk", "clan",
  ].map(key => [key, structuredClone(player[key])]));
  delete fields.quest.recoveryMs;
  delete fields.quest.runDistance;
  return fields;
};
async function player() {
  const result = await request("/api/session", { sessionCookie: cookie });
  assert.equal(result.status, 200);
  assert.ok(result.data.player);
  assert.equal(result.data.player.role, "player");
  return result.data.player;
}
async function rejected(packet, requireAdminDenial = false) {
  const before = await player();
  const notices = connection.notices.length, acks = connection.teleports.length;
  connection.ws.send(JSON.stringify(packet));
  await until(() => connection.notices.length > notices, "server rejects forged teleport packet");
  const notice = connection.notices.at(-1);
  assert.equal(notice.kind, "error");
  if (requireAdminDenial) assert.match(notice.text, /администраторам/i, "Feature must reject authorization, not an unknown packet type.");
  assert.equal(connection.teleports.length, acks, "A denied command cannot broadcast teleport acknowledgment.");
  const count = connection.snapshots;
  await until(() => connection.snapshots > count, "fresh authoritative snapshot after denial");
  assert.equal(connection.self.role, "player");
  assert.deepEqual(position(connection.self), position(before));
  assert.deepEqual(preserved(connection.self), preserved(before));
  const after = await player();
  assert.deepEqual(position(after), position(before));
  assert.deepEqual(preserved(after), preserved(before));
  return { rejection: notice.text, unchangedPosition: position(after), acknowledgments: 0 };
}

try {
  await check("Public health identifies the expected deployed source before account creation", async () => {
    const result = await request("/api/health");
    assert.equal(result.status, 200); assert.equal(result.data.ok, true);
    assert.equal(result.data.persistence, "ok");
    if (expectedSha) assert.equal(result.data.sourceCommit, expectedSha);
    report.sourceCommit = result.data.sourceCommit;
    return { sourceCommit: result.data.sourceCommit };
  });
  await check("Registration cannot grant admin through role or isAdmin input", async () => {
    const result = await request("/api/auth/register", {
      method: "POST", body: { name: account.name, password: account.password, role: "admin", isAdmin: true, player: { role: "admin" } },
    });
    assert.equal(result.status, 201);
    assert.equal(result.data.player.role, "player");
    assert.ok(result.cookie);
    cookie = result.cookie;
    report.accountRemains = true;
    report.accountName = account.name;
    assert.equal((await player()).role, "player");
  });
  await check("Real login and session retain the ordinary server role", async () => {
    const result = await request("/api/auth/login", {
      method: "POST", body: { name: account.name, password: account.password, role: "admin", isAdmin: true },
    });
    assert.equal(result.status, 200); assert.equal(result.data.player.role, "player");
    assert.ok(result.cookie); cookie = result.cookie;
    assert.equal((await player()).role, "player");
    const url = new URL("/ws", base); url.protocol = "wss:";
    const ws = new WebSocket(url, { headers: { Cookie: cookie, Origin: base.origin }, handshakeTimeout: 5000 });
    connection = { ws, self: null, snapshots: 0, notices: [], teleports: [], error: null };
    ws.on("message", data => {
      const message = JSON.parse(data.toString());
      if (message.type === "snapshot") { connection.self = message.self; connection.snapshots++; }
      else if (message.type === "notice") connection.notices.push(message);
      else if (message.type === "teleport") connection.teleports.push(message);
    });
    ws.on("error", error => { connection.error = error; });
    await until(() => connection.self, "real authenticated public WS snapshot");
    assert.equal(connection.self.role, "player");
  });
  await check("Forged direct teleport packet is denied without position, items or XP changes", async () =>
    rejected({ type: "adminTeleport", x: 200, z: 200, role: "admin", isAdmin: true, player: "WizardJIOCb" }, true));
  await check("Nested action cannot bypass the teleport privilege boundary", async () =>
    rejected({ type: "action", action: "adminTeleport", x: 180, z: 170, value: "admin", role: "admin", player: "WizardJIOCb" }));
  await check("Public persistence stays healthy after denied packets", async () => {
    const result = await request("/api/health");
    assert.equal(result.status, 200); assert.equal(result.data.persistence, "ok");
    assert.equal(result.data.sourceCommit, report.sourceCommit);
  });
} catch (error) {
  failure = error;
} finally {
  clearTimeout(deadlineTimer);
  connection?.ws.terminate();
  const cleanupAt = Date.now();
  try {
    await Promise.all([...new Set(issuedCookies)].map(async sessionCookie => {
      const result = await request("/api/auth/logout", { method: "POST", sessionCookie, cleanup: true });
      assert.equal(result.status, 200);
      const session = await request("/api/session", { sessionCookie, cleanup: true });
      assert.equal(session.data.player, null, "Every cookie issued by this QA run must be invalidated.");
    }));
    report.sessionsLoggedOut = issuedCookies.length;
    results.push({ name: "All issued QA sessions are logged out", status: "PASS", ms: Date.now() - cleanupAt, ordinaryAccountRemains: report.accountRemains });
  } catch (error) {
    failure ??= error;
    report.cleanupError = safeError(error);
    results.push({ name: "All QA sessions are logged out", status: "FAIL", ms: Date.now() - cleanupAt, error: safeError(error) });
  }
  report.finished = new Date().toISOString();
  report.durationSeconds = (Date.now() - started) / 1000;
  report.passed = results.filter(result => result.status === "PASS").length;
  report.failed = results.filter(result => result.status === "FAIL").length;
  report.status = failure ? "FAILED" : "PASSED";
  if (failure) report.failure = safeError(failure);
  const directory = resolve(root, "artifacts/admin-verification");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "public-negative-" + started + ".json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  // Counts only: credential-bearing request headers and account data stay private.
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed }));
  if (failure) process.exitCode = 1;
}
