import { spawn } from "node:child_process";
import type { Operation } from "../../api/operation.js";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Run only the already verified worktree path; retain ownership until close. */
export const runShellWorktreeRemoval = async (root: string, target: string, operation: Operation): Promise<void> => {
  operation.check();
  const rootUser = process.geteuid?.() === 0;
  const command = `${rootUser ? "" : "sudo -n -u root -- "}rm -rf -- ${quote(target)}`;
  const timeout = Math.max(1, Math.floor(Math.min(operation.remainingMs(), operation.limits.requestMs)));
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", `exec ${command}`], { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const errors: unknown[] = [], output: Buffer[] = [];
    let bytes = 0, stopping = false, closed = false;
    const stop = (): void => {
      if (closed) return;
      stopping = true;
      // The unprivileged parent cannot reliably signal a root descendant. Let
      // sudo wait for its child instead of killing its supervisor and losing
      // the only in-process completion evidence.
      if (!rootUser) return;
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) errors.push(error); }
    };
    const abort = (): void => { errors.push(operation.signal.reason); stop(); };
    const timer = setTimeout(() => { errors.push(new Error("Worktree shell removal deadline exceeded.")); stop(); }, timeout);
    timer.unref();
    operation.signal.addEventListener("abort", abort, { once: true });
    child.once("spawn", () => { if (stopping) stop(); });
    child.once("error", error => { errors.push(error); });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk: Buffer) => {
        if (bytes > 65536) return;
        bytes += chunk.length;
        try { operation.consume(chunk.length); }
        catch (error) { errors.push(error); stop(); return; }
        if (bytes > 65536) { errors.push(new Error("Worktree shell removal output exceeded 65536 bytes.")); stop(); return; }
        output.push(chunk);
      });
      stream.once("error", error => { errors.push(error); stop(); });
    }
    child.once("close", (code, signal) => {
      closed = true; clearTimeout(timer); operation.signal.removeEventListener("abort", abort);
      if (code !== 0 || signal !== null) errors.push(new Error(`Worktree shell removal failed (exit ${String(code)}, signal ${String(signal)}): ${Buffer.concat(output).toString("utf8")}`));
      try { operation.check(); } catch (error) { if (!errors.includes(error)) errors.push(error); }
      if (errors.length) reject(new AggregateError(errors, "Worktree shell removal failed.", { cause: errors[0] }));
      else resolve();
    });
    if (operation.signal.aborted) abort();
  });
};
