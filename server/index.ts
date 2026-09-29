import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { createServer as httpServer, type IncomingMessage } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import type { WorldData } from "../src/shared/types.js";
import type { CanonicalMapData } from "../src/shared/canonical-map.js";
import { populateCanonicalWorld } from "./canonical-world.js";
import { Game, GameError, type ActionMessage } from "./game.js";
import { JsonStore } from "./persist.js";
import { acquireStateLock } from "./state-lock.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const SESSION_MS = 7 * 86400000;
const COOKIE_NAME = "aw_session";
const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

function cookies(header?: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    if (key !== COOKIE_NAME) continue;
    try {
      result[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      /* Invalid cookies are unauthenticated. */
    }
  }
  return result;
}

export async function buildServer(
  options: { world?: WorldData; stateFile?: string; timers?: boolean } = {},
) {
  const map: CanonicalMapData | undefined = options.world ? undefined : JSON.parse(await readFile(resolve(root, "data/canonical-map.json"), "utf8"));
  const sourceWorld =
    options.world ??
    (JSON.parse(
      await readFile(resolve(root, "data/world.json"), "utf8"),
    ) as WorldData);
  const world = map ? populateCanonicalWorld(sourceWorld, map) : sourceWorld;
  if (
    !Array.isArray(world.items) ||
    !Array.isArray(world.recipes) ||
    !Array.isArray(world.entities) ||
    !Array.isArray(world.professions)
  ) {
    throw new Error(
      "data/world.json must contain items, recipes, entities and professions.",
    );
  }
  const store = new JsonStore(
    options.stateFile ??
      process.env.STATE_FILE ??
      resolve(root, ".runtime/state.json"),
  );
  const releaseStateLock = await acquireStateLock(store.filename);
  try {
  const state = await store.read();
  let dirty = true;
  let saveError: string | null = null;
  const clients = new Map<string, Set<WebSocket>>();
  const connectionSessions = new Map<WebSocket, string>();
  const checkpoints = () => {
    // A mutation during the write must remain dirty for the following checkpoint.
    dirty = false;
    return store
      .save(state)
      .then(() => {
        saveError = null;
      })
      .catch((error) => {
        dirty = true;
        saveError = "save_failed";
        console.error("Game checkpoint failed:", (error as Error).message);
        throw error;
      });
  };
  const game = new Game(
    world,
    state,
    Date.now,
    (id, notice) => {
      for (const ws of clients.get(id) ?? [])
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(notice));
    },
    () => {
      dirty = true;
    },
    map,
  );
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use(express.json({ limit: "8kb", strict: true }));
  app.use((_req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "same-origin");
    next();
  });

  const sessionFor = (req: IncomingMessage) => {
    const token = cookies(req.headers.cookie)[COOKIE_NAME];
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    const key = tokenHash(token);
    const session = state.sessions[key];
    if (
      !session ||
      session.expiresAt <= Date.now() ||
      !state.players[session.playerId]
    )
      return undefined;
    return { key, ...session };
  };
  const allowedOrigin = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const host = new URL(origin).host;
      if (host === req.headers.host) return true;
      if (
        process.env.PUBLIC_ORIGIN &&
        host === new URL(process.env.PUBLIC_ORIGIN).host
      )
        return true;
      return (
        process.env.NODE_ENV !== "production" &&
        /^(localhost|127\.0\.0\.1):(5173|5188|5190)$/.test(host)
      );
    } catch {
      return false;
    }
  };
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.method !== "GET" && req.method !== "HEAD" && !allowedOrigin(req)) {
      res.status(403).json({ error: "Недопустимый источник запроса." });
      return;
    }
    next();
  });
  const rateLimits = new Map<string, { count: number; until: number }>();
  const authLimit: express.RequestHandler = (req, res, next) => {
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    let entry = rateLimits.get(key);
    if (!entry || entry.until < Date.now()) {
      entry = { count: 0, until: Date.now() + 60000 };
      rateLimits.set(key, entry);
    }
    if (++entry.count > 20) {
      res
        .status(429)
        .json({ error: "Слишком много попыток. Подождите минуту." });
      return;
    }
    next();
  };
  const issueSession = async (
    id: string,
    req: express.Request,
    res: express.Response,
  ) => {
    const token = randomBytes(32).toString("hex");
    state.sessions[tokenHash(token)] = {
      playerId: id,
      expiresAt: Date.now() + SESSION_MS,
    };
    await checkpoints();
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: req.secure,
      maxAge: SESSION_MS,
      path: "/",
    });
  };
  const credentials = (body: unknown) => {
    const { name, password } = (body ?? {}) as {
      name?: unknown;
      password?: unknown;
    };
    if (
      typeof name !== "string" ||
      !/^[\p{L}\p{N}_ -]{2,24}$/u.test(name.trim())
    )
      throw new GameError(
        "Имя: 2–24 буквы, цифры, пробелы, дефис или подчёркивание.",
      );
    if (
      typeof password !== "string" ||
      password.length < 8 ||
      Buffer.byteLength(password, "utf8") > 72
    )
      throw new GameError("Пароль: от 8 символов, максимум 72 байта.");
    return { name: name.trim(), password };
  };
  const accountByName = (name: string) =>
    Object.values(state.accounts).find(
      (account) =>
        account.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
  app.post("/api/auth/register", authLimit, async (req, res) => {
    const { name, password } = credentials(req.body);
    if (accountByName(name)) {
      res.status(409).json({ error: "Это имя уже занято." });
      return;
    }
    const passwordHash = await bcrypt.hash(password, 12);
    if (accountByName(name)) {
      res.status(409).json({ error: "Это имя уже занято." });
      return;
    }
    const id = randomUUID();
    state.accounts[id] = { id, name, passwordHash, createdAt: Date.now() };
    const player = game.createPlayer(id, name);
    await issueSession(id, req, res);
    res.status(201).json({ player });
  });
  const dummyPasswordHash = await bcrypt.hash(
    randomBytes(24).toString("hex"),
    12,
  );
  app.post("/api/auth/login", authLimit, async (req, res) => {
    const { name, password } = credentials(req.body);
    const account = accountByName(name);
    const matches = await bcrypt.compare(
      password,
      account?.passwordHash ?? dummyPasswordHash,
    );
    if (!account || !matches) {
      res.status(401).json({ error: "Неверное имя или пароль." });
      return;
    }
    await issueSession(account.id, req, res);
    res.json({ player: game.player(account.id) });
  });
  app.post("/api/auth/logout", async (req, res) => {
    const session = sessionFor(req);
    if (session) {
      delete state.sessions[session.key];
      for (const [ws, key] of connectionSessions)
        if (key === session.key) ws.close(1000, "Logged out");
      await checkpoints();
    }
    res.clearCookie(COOKIE_NAME, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: req.secure,
    });
    res.json({ ok: true });
  });
  app.get("/api/session", (req, res) => {
    const session = sessionFor(req);
    res.json({ player: session ? game.player(session.playerId) : null });
  });
  app.get("/api/world", (_req, res) => {
    res.json({ ...world, entities: world.entities });
  });
  app.get("/api/map", (_req, res) => {
    if (!map) { res.status(404).json({ error: "Карта не задана." }); return; }
    res.json(map);
  });
  app.get("/api/health", (_req, res) => {
    res.status(saveError ? 503 : 200).json({
      ok: !saveError,
      service: "aw-xedoc",
      version: "0.2.0",
      simulationHz: 2,
      snapshotHz: 5,
      progression: "forever-v1",
      map: map ? { cells: map.terrain.length, placements: map.placements.length, types: map.definitions.length, activeEntities: world.entities.length, sourceSha256: map.sha256 } : null,
      sourceCommit: process.env.SOURCE_COMMIT ?? "development",
      online: clients.size,
      players: Object.keys(state.players).length,
      items: world.items.length,
      recipes: world.recipes.length,
      persistence: saveError ?? "ok",
      uptime: Math.floor(process.uptime()),
    });
  });
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Метод не найден." });
  });
  const distDirectory = resolve(root, "dist");
  if (existsSync(distDirectory)) {
    app.use(express.static(distDirectory, { maxAge: "1h", index: false }));
    app.get("/{*splat}", (_req, res) => {
      res.set("Cache-Control", "no-cache");
      res.sendFile(resolve(distDirectory, "index.html"));
    });
  } else
    app.get("/", (_req, res) => {
      res.json({
        service: "aw-xedoc",
        message: "Run npm run build to serve the game client.",
      });
    });
  app.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof GameError) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof SyntaxError) {
        res.status(400).json({ error: "Неверный JSON." });
        return;
      }
      console.error("Request failed:", error.message);
      res.status(500).json({ error: "Ошибка сервера. Попробуйте позже." });
    },
  );

  const server = httpServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  server.on("upgrade", (req, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const session = sessionFor(req);
    if (pathname !== "/ws" || !session || !allowedOrigin(req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    if (
      (clients.get(session.playerId)?.size ?? 0) >= 3 ||
      clients.size >= 200
    ) {
      socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const id = session.playerId;
      let set = clients.get(id);
      if (!set) {
        set = new Set();
        clients.set(id, set);
      }
      set.add(ws);
      connectionSessions.set(ws, session.key);
      game.connect(id);
      ws.send(JSON.stringify(game.snapshot(id)));
      let count = 0;
      let windowAt = Date.now();
      let alive = true;
      ws.on("pong", () => {
        alive = true;
      });
      const heartbeat = setInterval(() => {
        if (!alive) ws.terminate();
        else {
          alive = false;
          ws.ping();
        }
      }, 30000);
      heartbeat.unref();
      ws.on("message", (data) => {
        if (Date.now() - windowAt > 1000) {
          count = 0;
          windowAt = Date.now();
        }
        if (++count > 45) {
          ws.close(1008, "Rate limit");
          return;
        }
        try {
          if (
            !state.sessions[session.key] ||
            state.sessions[session.key].expiresAt <= Date.now()
          ) {
            ws.close(1008, "Session expired");
            return;
          }
          const message = JSON.parse(data.toString()) as ActionMessage & {
            x?: unknown;
            z?: unknown;
            rotation?: unknown;
            running?: unknown;
            text?: unknown;
          };
          if (!message || typeof message !== "object")
            throw new GameError("Некорректное сообщение.");
          if (message.type === "move")
            game.move(id, message.x, message.z, message.rotation, message.running === true);
          else if (message.type === "adminTeleport") {
            const destination = game.adminTeleport(id, message.x, message.z);
            const acknowledgement = JSON.stringify({ type: "teleport", ...destination });
            const snapshot = JSON.stringify(game.snapshot(id));
            // Other tabs belonging to this same authenticated account must reset
            // prediction too; nearby players never receive a teleport command.
            for (const ownSocket of clients.get(id) ?? []) {
              const ownSession = state.sessions[connectionSessions.get(ownSocket) ?? ""];
              if (!ownSession || ownSession.expiresAt <= Date.now()) ownSocket.close(1008, "Session expired");
              else if (ownSocket.readyState === WebSocket.OPEN) {
                ownSocket.send(acknowledgement);
                ownSocket.send(snapshot);
              }
            }
          }
          else if (message.type === "action") game.action(id, message);
          else if (message.type === "chat") game.chat(id, message.text);
          else throw new GameError("Неизвестный тип сообщения.");
        } catch (error) {
          ws.send(
            JSON.stringify({
              type: "notice",
              text:
                error instanceof GameError
                  ? error.message
                  : "Некорректное сообщение.",
              kind: "error",
            }),
          );
        }
      });
      ws.on("error", () => {});
      ws.on("close", () => {
        clearInterval(heartbeat);
        connectionSessions.delete(ws);
        set!.delete(ws);
        if (!set!.size) {
          clients.delete(id);
          game.disconnect(id);
        }
      });
    });
  });
  const broadcast = () => {
    for (const [id, sockets] of clients) {
      const snapshot = JSON.stringify(game.snapshot(id));
      for (const ws of sockets) {
        const session = state.sessions[connectionSessions.get(ws) ?? ""];
        if (!session || session.expiresAt <= Date.now())
          ws.close(1008, "Session expired");
        else if (
          ws.readyState === WebSocket.OPEN &&
          ws.bufferedAmount < 1024 * 1024
        )
          ws.send(snapshot);
      }
    }
  };
  const tick = () => {
    game.tick();
    broadcast();
  };
  // Forever's update loop and Von Raven's 2010 Classic interview both confirm
  // a 0.5-second world step. Client snapshots use a separate, smoother cadence.
  const tickTimer =
    options.timers === false ? undefined : setInterval(() => game.tick(), 500);
  const snapshotTimer =
    options.timers === false ? undefined : setInterval(broadcast, 200);
  const saveTimer =
    options.timers === false
      ? undefined
      : setInterval(() => {
          if (dirty) void checkpoints().catch(() => {});
        }, 1000);
  const fullSaveTimer =
    options.timers === false
      ? undefined
      : setInterval(() => {
          for (const [key, session] of Object.entries(state.sessions))
            if (session.expiresAt <= Date.now()) delete state.sessions[key];
          for (const [key, entry] of rateLimits)
            if (entry.until <= Date.now()) rateLimits.delete(key);
          void checkpoints().catch(() => {});
        }, 15000);
  tickTimer?.unref();
  snapshotTimer?.unref();
  saveTimer?.unref();
  fullSaveTimer?.unref();
  const close = async () => {
    if (tickTimer) clearInterval(tickTimer);
    if (snapshotTimer) clearInterval(snapshotTimer);
    if (saveTimer) clearInterval(saveTimer);
    if (fullSaveTimer) clearInterval(fullSaveTimer);
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((done) => wss.close(() => done()));
    if (server.listening)
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    for (const player of Object.values(state.players)) player.online = false;
    try {
      await checkpoints();
      await store.flush();
    } finally {
      await releaseStateLock();
    }
  };
  return { app, server, game, store, state, close, tick };
  } catch (error) {
    await releaseStateLock();
    throw error;
  }
}

// argv retains /current while the module URL resolves to the real release path.
// Comparing canonical filesystem paths keeps the production entrypoint alive.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const running = await buildServer();
  const port = Number(process.env.PORT ?? 3190);
  const host = process.env.HOST ?? "127.0.0.1";
  running.server.listen(port, host, () => {
    const address = running.server.address();
    const listeningPort =
      address && typeof address === "object" ? address.port : port;
    console.log(`AW world listening on http://${host}:${listeningPort}`);
  });
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void running
        .close()
        .then(() => process.exit(0))
        .catch((error) => {
          console.error("Shutdown checkpoint failed:", error.message);
          process.exit(1);
        });
    });
}
