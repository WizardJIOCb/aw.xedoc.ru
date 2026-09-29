import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, chown, copyFile, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import type { SavedState } from "../server/persist.js";
import { acquireStateLock } from "../server/state-lock.js";
import type { PlayerRole } from "../src/shared/types.js";

/** Changes only one existing account role, under the same lock as the server. */
export async function setAccountRole(stateFile: string, name: string, role: PlayerRole) {
  if (!isAbsolute(stateFile)) throw new Error("State path must be absolute.");
  if (role !== "admin" && role !== "player") throw new Error("Role must be admin or player.");
  const release = await acquireStateLock(stateFile);
  const temporary = `${stateFile}.role-${randomUUID()}.next`;
  try {
    const before = await readFile(stateFile, "utf8");
    const original = await stat(stateFile);
    const state = JSON.parse(before) as SavedState;
    if (state.version !== 1 || !state.accounts || !state.players || !Array.isArray(state.entities))
      throw new Error("Unsupported or damaged state; refusing to write.");
    const accounts = Object.values(state.accounts).filter(account => account.name === name);
    if (accounts.length !== 1) throw new Error("Expected exactly one existing account with this exact name; nothing changed.");
    const account = accounts[0];
    if (!state.players[account.id]) throw new Error("Account has no saved player; refusing to write.");
    const previousRole = account.role === "admin" ? "admin" : "player";
    if (previousRole === role && account.role === role)
      return { accountId: account.id, name: account.name, previousRole, role, changed: false };
    const backup = `${stateFile}.role-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.bak`;
    await copyFile(stateFile, backup);
    await chmod(backup, 0o600);
    account.role = role;
    const after = JSON.stringify(state);
    await writeFile(temporary, after, { encoding: "utf8", mode: 0o600 });
    // Root performs production maintenance; retain the AW service user's rights.
    if (process.platform !== "win32") await chown(temporary, original.uid, original.gid);
    await chmod(temporary, original.mode & 0o777);
    // Besides locking, reject an unexpected writer rather than overwrite newer progress.
    if (await readFile(stateFile, "utf8") !== before) throw new Error("State changed during maintenance; refusing to overwrite.");
    await rename(temporary, stateFile);
    return {
      accountId: account.id, name: account.name, previousRole, role, changed: true, backup,
      beforeSha256: createHash("sha256").update(before).digest("hex"),
      afterSha256: createHash("sha256").update(after).digest("hex"),
      preservedPlayers: Object.keys(state.players).length,
    };
  } finally {
    try {
      await unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    } finally { await release(); }
  }
}

async function main() {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index], value = process.argv[index + 1];
    if (!["--state", "--name", "--role", "--service"].includes(flag) || !value || args.has(flag))
      throw new Error("Usage: tsx scripts/set-account-role.ts --state ABSOLUTE_STATE --name EXACT_NAME --role admin|player --service aw-xedoc.service");
    args.set(flag, value);
  }
  const stateFile = args.get("--state"), name = args.get("--name"), role = args.get("--role");
  if (!stateFile || !name || (role !== "admin" && role !== "player")) throw new Error("State, exact account name and role are required.");
  if (process.platform === "linux") {
    if (args.get("--service") !== "aw-xedoc.service") throw new Error("Linux maintenance requires --service aw-xedoc.service and a stopped service.");
    const status = execFileSync("systemctl", ["show", "aw-xedoc.service", "--property=ActiveState", "--value"], { encoding: "utf8" }).trim();
    if (!["inactive", "failed"].includes(status)) throw new Error(`AW service is ${status || "unknown"}; stop it before maintenance.`);
  }
  console.log(JSON.stringify(await setAccountRole(stateFile, name, role)));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
  main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
