import path from "node:path";
import { aggregateFailures } from "./failures.ts";
import { startCommand, type CommandOptions, type ManagedCommand } from "./command.ts";
import { captureProcessEvidence, inspectProcessEvidence, stopEvidenceGroup } from "./process-evidence.ts";
import { readGateReceipt, writeGateReceipt } from "./gated-record.ts";

export const gateReadyDecoder = () => {
  let pending = "", complete = false;
  return (chunk: string): string | null => {
    if (complete) return chunk;
    pending += chunk;
    const newline = pending.indexOf("\n");
    if (newline < 0) { if (pending.length > 128) throw new Error("Gate handshake is invalid."); return null; }
    if (pending.slice(0, newline + 1) !== "DAYNIGHT_GATE_READY\n") throw new Error("Gate handshake is invalid.");
    complete = true; const remainder = pending.slice(newline + 1); pending = ""; return remainder;
  };
};

// The caller durably records the gate ID before calling this function.
export const startGatedCommand = async (input: { runDirectory: string; gateId: string; command: string; args: readonly string[]; options: CommandOptions }): Promise<ManagedCommand> => {
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const decodeReady = gateReadyDecoder();
  let targetExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const gate = startCommand(process.execPath, [path.join(import.meta.dirname, "gated-runner.mjs"), input.runDirectory, input.gateId, input.command, ...input.args], {
    ...input.options, stdin: "pipe", onMessage: message => {
      if (typeof message === "object" && message !== null && "kind" in message && message.kind === "target-exit"
        && "code" in message && (message.code === null || typeof message.code === "number")
        && "signal" in message && (message.signal === null || typeof message.signal === "string")) {
        targetExit = { code: message.code, signal: message.signal as NodeJS.Signals | null };
      }
    }, stopOwnedGroup: async () => { await stopGate(input.runDirectory, input.gateId, Date.now() + 10_000); }, onOutput: (channel, chunk) => {
      if (channel === "stdout") {
        const decoded = decodeReady(chunk);
        if (decoded === null) return;
        chunk = decoded; ready();
      }
      if (chunk !== "") {
        if (input.options.onOutput) input.options.onOutput(channel, chunk);
        else process[channel].write(chunk);
      }
    },
  });
  try {
    await Promise.race([started, gate.finished.then(() => { throw new Error("Gate exited before its proof was recorded."); })]);
    const leader = await captureProcessEvidence(gate.pid);
    if (leader.pid !== leader.group) throw new Error("Gate is not its original process-group leader.");
    const receipt = { schemaVersion: 1 as const, runId: path.basename(input.runDirectory), gateId: input.gateId, state: "bound" as const, leader, child: null };
    await writeGateReceipt(input.runDirectory, receipt);
    await writeGateReceipt(input.runDirectory, { ...receipt, state: "released" });
    await gate.writeInput("GO\n");
    const finished = gate.finished.then(result => ({ ...result, stdout: result.stdout.startsWith("DAYNIGHT_GATE_READY\n") ? result.stdout.slice("DAYNIGHT_GATE_READY\n".length) : result.stdout }));
    void finished.catch(() => {});
    return { ...gate, finished, diagnostics: () => {
      const snapshot = gate.diagnostics();
      return { ...snapshot, stdout: snapshot.stdout.startsWith("DAYNIGHT_GATE_READY\n") ? snapshot.stdout.slice("DAYNIGHT_GATE_READY\n".length) : snapshot.stdout, targetExit };
    }, stop: async () => { await gate.stopProcesses(); await finished; } };
  } catch (error) {
    const failures: unknown[] = [error];
    gate.endInput();
    try { await gate.stopProcesses(); } catch (failure) { if (!failures.includes(failure)) failures.push(failure); }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([gate.finished, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Gate completion remained unconfirmed after setup failure.")), 5_000); })]);
    } catch (failure) { if (!failures.includes(failure)) failures.push(failure); }
    finally { clearTimeout(timer); }
    if (failures.length > 1) throw aggregateFailures("Gate setup and cleanup failed.", failures);
    throw error;
  }
};

// Re-read after stopping: a child proof may have been committed while the gate was running.
export const stopGate = async (runDirectory: string, gateId: string, deadline: number): Promise<"bound" | "released"> => {
  const before = await readGateReceipt(runDirectory, gateId);
  if (before.state === "released" && before.child === null && await inspectProcessEvidence(before.leader) !== "running") throw new Error("Released gate lacks a live original instance or child proof.");
  await stopEvidenceGroup(before.leader, before.child === null ? [] : [before.child], deadline);
  const after = await readGateReceipt(runDirectory, gateId);
  if (after.state !== before.state || JSON.stringify(after.leader) !== JSON.stringify(before.leader)
    || before.child !== null && JSON.stringify(after.child) !== JSON.stringify(before.child)) throw new Error("Original gate evidence changed incompatibly.");
  await stopEvidenceGroup(after.leader, after.child === null ? [] : [after.child], deadline);
  return after.state;
};
