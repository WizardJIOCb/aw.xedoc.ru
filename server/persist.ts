import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Entity, Player } from "../src/shared/types.js";

export type Account = {
  id: string;
  name: string;
  passwordHash: string;
  createdAt: number;
};
export type Session = { playerId: string; expiresAt: number };
export type Bag = {
  id: string;
  items: Record<string, number>;
  owner: string;
  privateUntil: number;
  expiresAt: number;
};
export type CraftJob = {
  playerId: string;
  recipeId: string;
  completeAt: number;
  inputs: Record<string, number>;
  outputs: Record<string, number>;
};
export type SavedState = {
  version: 1;
  accounts: Record<string, Account>;
  sessions: Record<string, Session>;
  players: Record<string, Player>;
  entities: Entity[];
  bags: Record<string, Bag>;
  jobs: Record<string, CraftJob>;
};

export function emptyState(): SavedState {
  return {
    version: 1,
    accounts: {},
    sessions: {},
    players: {},
    entities: [],
    bags: {},
    jobs: {},
  };
}

/** Writes are serialized and renamed atomically: a restart cannot read half a JSON document. */
export class JsonStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly filename: string) {}

  async read(): Promise<SavedState> {
    let contents: string;
    try {
      contents = await readFile(this.filename, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return emptyState();
      throw error;
    }
    const data = JSON.parse(contents) as SavedState;
    if (
      data.version !== 1 ||
      !data.accounts ||
      !data.players ||
      !Array.isArray(data.entities)
    ) {
      throw new Error(
        "Unsupported or damaged game state; refusing to overwrite saved progress.",
      );
    }
    data.sessions ??= {};
    data.bags ??= {};
    data.jobs ??= {};
    for (const player of Object.values(data.players)) player.online = false;
    return data;
  }

  save(state: SavedState): Promise<void> {
    // Capture now rather than after a previous write, so each requested checkpoint is complete.
    const contents = JSON.stringify(state);
    const next = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.filename), { recursive: true });
        const temporary = `${this.filename}.next`;
        await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.filename);
      });
    this.writes = next;
    return next;
  }

  flush(): Promise<void> {
    return this.writes;
  }
}
