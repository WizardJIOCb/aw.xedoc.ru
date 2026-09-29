import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { connect } from "node:net";
import { buildServer } from "./index.js";

test("malformed anonymous HTTP Upgrade returns 400 and the game server stays healthy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aw-upgrade-"));
  const service = await buildServer({
    world: { items: [], recipes: [], professions: [], entities: [] },
    stateFile: join(directory, "state.json"),
    timers: false,
  });
  try {
    service.server.listen(0, "127.0.0.1");
    await once(service.server, "listening");
    const port = (service.server.address() as { port: number }).port;
    const response = await new Promise<string>((done, reject) => {
      const socket = connect(port, "127.0.0.1");
      let text = "";
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("Malformed Upgrade did not close within three seconds."));
      }, 3000);
      socket.on("data", data => { text += data.toString(); });
      socket.once("connect", () => {
        // Node accepts this request target, while WHATWG URL rejects its invalid hostname.
        socket.write("GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      });
      socket.once("error", error => { clearTimeout(timeout); reject(error); });
      socket.once("close", () => { clearTimeout(timeout); done(text); });
    });
    assert.match(response, /^HTTP\/1\.1 400 Bad Request\r\n/);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    const session = await fetch(`http://127.0.0.1:${port}/api/session`);
    assert.equal(session.status, 200);
    assert.equal((await session.json()).player, null);
  } finally {
    await service.close();
    assert.ok(directory.startsWith(join(tmpdir(), "aw-upgrade-")));
    await rm(directory, { recursive: true, force: true });
  }
});
