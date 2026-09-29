import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/** Coordinate a running server and offline account maintenance on one host. */
export async function acquireStateLock(stateFile: string): Promise<() => Promise<void>> {
  const filename = `${stateFile}.lock`;
  const contents = JSON.stringify({ pid: process.pid, token: randomUUID() });
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(filename, "wx", 0o600);
      try { await handle.writeFile(contents, "utf8"); }
      finally { await handle.close(); }
      return async () => {
        try {
          // Never remove a replacement lock belonging to a different process.
          if (await readFile(filename, "utf8") === contents) await unlink(filename);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let previous: string;
      try { previous = await readFile(filename, "utf8"); }
      catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw readError;
      }
      let pid: number | undefined;
      try { pid = JSON.parse(previous).pid; } catch { /* A new writer may still be filling its lock. */ }
      if (!Number.isSafeInteger(pid) || pid! <= 0) throw new Error("State is locked; refusing concurrent maintenance.");
      try { process.kill(pid!, 0); }
      catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code === "ESRCH") {
          // SIGKILL can leave a lock behind. Recover only a provably dead local PID.
          if (await readFile(filename, "utf8") === previous) await unlink(filename);
          continue;
        }
      }
      throw new Error("State is locked by a running process; stop the AW service first.");
    }
  }
  throw new Error("Could not obtain exclusive state lock.");
}
