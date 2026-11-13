import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Operation } from "../../../api/operation.js";
import { syncDurableDirectory } from "../../../platform/durable-directory.js";
import { replaceFileAtomically } from "../../../platform/files.js";
import { stopWindowsBootstrapProcess } from "../../controller/windows-process-proof.js";
import { captureMappingProcessProof as captureProcessProof, inspectMappingProcessForCleanup as inspectProcessProof, validLinuxBirthToken, type MappingProcessProof as ProcessProof } from "./tool-launch-process-proof.js";
import { runHerdrCommand } from "./command.js";
import { mappingFiles, optionalOwnedJson, publishOwnedJson } from "./tool-launch-protocol.js";
import { parseToolReceipt } from "./tool-launch-protocol.js";
import type { HerdrToolLaunchManifest, HerdrToolLaunchReceipt } from "./tool-launch-protocol.js";
import { readToolStartRequest } from "./tool-launch-start.js";
import { releaseHerdrJobObserver, retainHerdrJobObserver } from "./tool-launch-windows-job.js";
import { captureWindowsProcessInventory } from "./windows-process-metadata.js";

type Inventory = { pid: number; parentPid: number; group: number | null };
type ProcessRecord = { nonce: string; proofs: ProcessProof[] };
const sameProcessIdentity = (current: ProcessProof, original: ProcessProof): boolean => current.pid === original.pid && current.parentPid === original.parentPid && current.startedAt === original.startedAt && current.commandHash === original.commandHash && current.processGroupId === original.processGroupId && current.birthToken === original.birthToken;
const validWindowsBirth = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(value)) return false;
  const seconds = Date.parse(`${value.slice(0, 19)}Z`);
  return Number.isFinite(seconds) && new Date(seconds).toISOString().slice(0, 19) === value.slice(0, 19);
};
const assertWindowsParentBirth = (child: ProcessProof, parent: ProcessProof): void => {
  // Compare canonical seven-digit timestamps directly; Date truncates their precision.
  if (child.parentPid !== parent.pid || !validWindowsBirth(child.startedAt) || !validWindowsBirth(parent.startedAt) || child.startedAt <= parent.startedAt) throw new Error("The original Windows descendant has no strictly later birth than its original parent; process ownership remains unknown.");
};
const assertWindowsBirthChain = (proofs: readonly ProcessProof[]): void => {
  const original = new Map(proofs.map(proof => [proof.pid, proof]));
  if (!validWindowsBirth(proofs[0]!.startedAt)) throw new Error("The original Windows root has no complete birth proof; process ownership remains unknown.");
  for (const proof of proofs.slice(1)) {
    const parent = original.get(proof.parentPid);
    if (parent === undefined) throw new Error("The original Windows process journal has no complete parent birth chain; process ownership remains unknown.");
    assertWindowsParentBirth(proof, parent);
  }
};
const inventory = async (environment: NodeJS.ProcessEnv, operation: Operation): Promise<Inventory[]> => {
  if (process.platform === "win32") return captureWindowsProcessInventory(operation);
  const result = await runHerdrCommand({ file: "/bin/ps", args: ["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "stat="], environment: { ...environment, LC_ALL: "C" } }, operation);
  return result.stdout.split("\n").filter(row => row.trim() !== "").flatMap(row => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(row);
    if (match === null) throw new Error("The original Herdr process inventory could not be interpreted.");
    return match[4]!.startsWith("Z") ? [] : [{ pid: Number(match[1]), parentPid: Number(match[2]), group: Number(match[3]) }];
  });
};
const parse = (value: unknown, nonce: string): ProcessRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The original Herdr process responsibility journal is missing.");
  const row = value as Record<string, unknown>;
  if (row.nonce !== nonce || Object.keys(row).sort().join() !== "nonce,proofs" || !Array.isArray(row.proofs) || row.proofs.length === 0 || row.proofs.length > 1000) throw new Error("The original Herdr process responsibility journal is invalid.");
  const ids = new Set<number>();
  for (const value of row.proofs) {
    if (!value || typeof value !== "object") throw new Error("The original Herdr process identity is invalid.");
    const item = value as ProcessProof;
    if (!Number.isSafeInteger(item.pid) || item.pid <= 0 || ids.has(item.pid) || !Number.isSafeInteger(item.parentPid) || item.parentPid < 0 || item.processGroupId !== null && (!Number.isSafeInteger(item.processGroupId) || item.processGroupId < 1) || typeof item.startedAt !== "string" || item.startedAt === "" || !/^[a-f0-9]{64}$/.test(item.commandHash)) throw new Error("The original Herdr process identity is invalid.");
    if (process.platform === "linux" && !validLinuxBirthToken(item.birthToken)) throw new Error("The original Linux Herdr process has no precise birth identity.");
    ids.add(item.pid);
  }
  const record = row as unknown as ProcessRecord;
  if (process.platform === "win32") assertWindowsBirthChain(record.proofs);
  return record;
};

/** Process identities survive workspace removal. Retirement additionally fences native groups/jobs. */
export const createMappingProcessLifecycle = (manifestPath: string, manifest: HerdrToolLaunchManifest, environment: NodeJS.ProcessEnv) => {
  const directory = path.dirname(manifestPath), file = path.join(directory, "processes.json"), retired = path.join(directory, "retired.json");
  const frozen = new Map<number, ProcessProof>();
  const retiredValue = { nonce: manifest.nonce, selectionKey: manifest.launch.selectionKey, owner: manifest.owner };
  const alreadyRetired = async (): Promise<boolean> => {
    const value = await optionalOwnedJson(retired);
    if (value === null) return false;
    if (JSON.stringify(value) !== JSON.stringify(retiredValue)) throw new Error("The original Herdr mapping retirement proof is invalid.");
    // Durable closure remains terminal. A failed local CloseHandle retains its
    // original registry owner and can be retried without reopening historical PIDs.
    if (process.platform === "win32") releaseHerdrJobObserver(manifestPath, manifest);
    return true;
  };
  const read = async (): Promise<ProcessRecord | null> => { const value = await optionalOwnedJson(file); return value === null ? null : parse(value, manifest.nonce); };
  const save = async (proofs: ProcessProof[]): Promise<void> => { const row = parse({ nonce: manifest.nonce, proofs }, manifest.nonce); await replaceFileAtomically(file, JSON.stringify(row), 0o600); syncDurableDirectory(directory); };
  const observeWindowsParent = async (proof: ProcessProof, operation: Operation): Promise<void> => {
    operation.check();
    const current = await captureProcessProof(proof.pid, Math.max(1, Math.min(5000, Math.floor(operation.remainingMs()))));
    if (!sameProcessIdentity(current, proof)) throw new Error("The original Windows descendant parent process identity changed; process ownership remains unknown.");
  };
  const assertDeclaredLaunchProofs = async (record: ProcessRecord | null): Promise<HerdrToolLaunchReceipt | null> => {
    const files = mappingFiles(manifestPath), intentValue = await optionalOwnedJson(files.intent), receiptValue = await optionalOwnedJson(files.receipt);
    const request = await readToolStartRequest(manifestPath, { nonce: manifest.nonce, selectionKey: manifest.launch.selectionKey, owner: manifest.owner });
    if (intentValue === null && receiptValue === null) {
      if (request?.state === "reserved") throw new Error("The original native launch RPC has no complete helper receipt; process ownership remains unknown.");
      return null;
    }
    if (request !== null && request.state !== "reserved") throw new Error("The unsubmitted or rejected native launch request conflicts with a helper launch intent; process ownership remains unknown.");
    const intent = parseToolReceipt(intentValue, manifest, false);
    if (receiptValue === null) throw new Error("The original launch intent has no matching receipt; complete native process ownership remains unknown.");
    const receipt = parseToolReceipt(receiptValue, manifest), { childPid: _child, ...original } = receipt;
    if (JSON.stringify(original) !== JSON.stringify(intent)) throw new Error("The original launch receipt has no matching intent; process ownership remains unknown.");
    if (request !== null && receipt.logicalArgvDigest !== request.logicalArgvDigest) throw new Error("The original helper receipt differs from the reserved native launch arguments; process ownership remains unknown.");
    const ids = new Set(record?.proofs.map(proof => proof.pid));
    for (const [role, id] of [["helper", receipt.helperPid], ["native child", receipt.childPid]] as const) {
      if (!ids.has(id)) throw new Error(`The declared original ${role} has no durable birth proof; complete native process ownership remains unknown.`);
    }
    return receipt;
  };
  const captureProcesses = async (pids: readonly number[], operation: Operation, freeze = false): Promise<number[]> => {
    operation.check();
    const previous = await read(), proofs = new Map((previous?.proofs ?? []).map(proof => [proof.pid, proof]));
    // Receipt PIDs alone cannot establish the birth of a process found during cleanup.
    let closingJob: Awaited<ReturnType<typeof retainHerdrJobObserver>> | undefined;
    if (freeze) {
      const receipt = await assertDeclaredLaunchProofs(previous);
      if (previous === null) throw new Error("The original cleanup root has no prepared process journal; process ownership remains unknown.");
      if (process.platform === "win32" && receipt !== null) {
        closingJob = await retainHerdrJobObserver(manifestPath, manifest, receipt, operation, previous!.proofs.find(proof => proof.pid === receipt.helperPid));
        closingJob.captureForeground(pids, operation);
        await closingJob.stop(operation);
      }
    }
    const freezeOriginal = async (proof: ProcessProof): Promise<void> => {
      if (!freeze || process.platform === "win32" || frozen.has(proof.pid)) return;
      const state = await inspectProcessProof(proof);
      if (state === "replaced") throw new Error("An original Herdr process identity changed before freezing.");
      if (state === "running") { process.kill(proof.pid, "SIGSTOP"); frozen.set(proof.pid, proof); }
    };
    try {
      for (const id of pids) {
        operation.check();
        if (proofs.has(id) || closingJob?.closedMember(id)) continue;
        // Only preparation can supply the first root. Further foreground IDs
        // need the same parent and birth checks as inventory discoveries.
        if (proofs.size !== 0) continue;
        // An unknown vanished helper cannot establish that its descendants exited.
        const proof = await captureProcessProof(id, Math.max(1, Math.min(5000, Math.floor(operation.remainingMs()))));
        proofs.set(id, proof); await save([...proofs.values()]);
      }
      for (const proof of proofs.values()) {
        operation.check(); const state = await inspectProcessProof(proof);
        if (state === "replaced") throw new Error("An original Herdr process identity changed before closure.");
        if (state === "running") await freezeOriginal(proof);
      }
      for (let round = 0; round < 1000; round++) {
        operation.check();
        const rows = (await inventory(environment, operation)).filter(row => !closingJob?.closedMember(row.pid));
        const anchors = new Map<number, ProcessProof>();
        for (const proof of proofs.values()) {
          operation.check();
          // Historical PID and group numbers cannot establish ownership after
          // their original process exits. Existing births still remain our responsibility.
          const state = process.platform === "win32" ? "running" : await inspectProcessProof(proof);
          if (state === "replaced") throw new Error("An original Herdr process identity changed during descendant discovery.");
          if (state === "running") anchors.set(proof.pid, proof);
        }
        const ids = new Set(anchors.keys()), groups = new Set([...anchors.values()].map(proof => proof.processGroupId).filter(group => group !== null));
        let changed = true;
        while (changed) { changed = false; for (const row of rows) if (!ids.has(row.pid) && (ids.has(row.parentPid) || row.group !== null && groups.has(row.group))) { ids.add(row.pid); changed = true; } }
        if (pids.some(id => !proofs.has(id) && !ids.has(id) && !closingJob?.closedMember(id))) throw new Error("The original foreground process has no complete original parent or process group chain; process ownership remains unknown.");
        const unseen = rows.filter(row => ids.has(row.pid) && !proofs.has(row.pid));
        if (unseen.length === 0) return [...proofs.keys()];
        while (unseen.length > 0) {
          if (proofs.size >= 1000) throw new Error("The original Herdr process tree exceeds its supported ownership bound.");
          const anchorFor = (row: Inventory): ProcessProof | undefined => anchors.get(row.parentPid) ?? (process.platform === "win32" || row.group === null ? undefined : [...anchors.values()].find(proof => proof.processGroupId === row.group));
          const index = unseen.findIndex(row => anchorFor(row) !== undefined);
          if (index < 0) throw new Error("The original descendant has no registered live parent or group birth proof; process ownership remains unknown.");
          const row = unseen.splice(index, 1)[0]!, anchor = anchorFor(row)!;
          const observeAnchor = async (): Promise<void> => {
            operation.check();
            if (process.platform === "win32") await observeWindowsParent(anchor, operation);
            else if (await inspectProcessProof(anchor) !== "running") throw new Error("The original descendant parent or group identity changed; process ownership remains unknown.");
          };
          await observeAnchor();
          const proof = await captureProcessProof(row.pid, Math.max(1, Math.min(5000, Math.floor(operation.remainingMs()))));
          if (proof.parentPid !== row.parentPid || proof.processGroupId !== row.group) throw new Error("The original Herdr descendant changed during identity registration.");
          if (process.platform === "win32") assertWindowsParentBirth(proof, anchor);
          await observeAnchor();
          proofs.set(proof.pid, proof); await save([...proofs.values()]); await freezeOriginal(proof);
          anchors.set(proof.pid, proof);
        }
      }
      throw new Error("The original Herdr process tree did not stabilize before closure.");
    } catch (cause) { await releaseFrozen(); throw cause; }
  };
  const releaseFrozen = async (): Promise<void> => {
    const failures: unknown[] = [];
    for (const proof of [...frozen.values()].reverse()) {
      try {
        const state = await inspectProcessProof(proof);
        if (state === "replaced") throw new Error("An original frozen Herdr process has conflicting birth evidence; rollback remains unknown.");
        if (state === "running") process.kill(proof.pid, "SIGCONT");
        frozen.delete(proof.pid);
      } catch (cause) { failures.push(cause); }
    }
    if (failures.length > 0) throw new AggregateError(failures, "The original Herdr process freeze rollback remains unknown.");
  };
  const confirmStopped = async (operation: Operation): Promise<boolean> => {
    operation.check();
    if (await alreadyRetired()) return true;
    const record = await read();
    if (record === null) throw new Error("The original Herdr process tree has no stopped identity proof.");
    const receipt = await assertDeclaredLaunchProofs(record);
    const job = process.platform === "win32" && receipt !== null ? await retainHerdrJobObserver(manifestPath, manifest, receipt, operation, record.proofs.find(proof => proof.pid === receipt.helperPid)) : null;
    operation.check();
    // Zombies have exited and cannot execute or spawn, even before an adopter reaps them.
    const rows = await inventory(environment, operation), ids = new Set(record.proofs.map(proof => proof.pid)), groups = new Set(record.proofs.map(proof => proof.processGroupId).filter(group => group !== null));
    if (rows.some(row => ids.has(row.pid) || ids.has(row.parentPid) || row.group !== null && groups.has(row.group))) return false;
    if (job !== null && !job.stopped()) return false;
    // The root shell is outside the helper Job. Inventory disappearance and
    // an empty Job do not prove that its original handle has become signaled.
    if (process.platform === "win32") for (const proof of record.proofs) {
      operation.check();
      const state = await inspectProcessProof(proof);
      if (state === "replaced") throw new Error("An original Herdr process has conflicting birth evidence; complete stop remains unknown.");
      if (state !== "stopped") return false;
    }
    await assertDeclaredLaunchProofs(record);
    return true;
  };
  const stopProcesses = async (operation: Operation): Promise<void> => {
    operation.check();
    if (await alreadyRetired()) return;
    const record = await read();
    if (record === null) throw new Error("The original Herdr process tree has no termination identity proof.");
    const receipt = await assertDeclaredLaunchProofs(record);
    if (process.platform === "win32" && receipt !== null) await (await retainHerdrJobObserver(manifestPath, manifest, receipt, operation, record.proofs.find(proof => proof.pid === receipt.helperPid))).stop(operation);
    const current = new Set((await inventory(environment, operation)).map(row => row.pid));
    for (const proof of [...record.proofs].reverse()) {
      operation.check();
      if (process.platform !== "win32" && !current.has(proof.pid)) continue;
      const state = await inspectProcessProof(proof);
      if (state === "replaced") throw new Error("An original Herdr process has conflicting birth evidence; termination remains unknown.");
      if (process.platform === "win32") {
        // Retain and recheck the original handle through termination and wait.
        // An exiting process cannot supply complete command identity or accept
        // another signal; only that same handle becoming signaled closes it.
        if (state !== "stopped") await stopWindowsBootstrapProcess(proof, Date.now() + Math.max(1, Math.floor(operation.remainingMs())));
        operation.check();
        continue;
      }
      if (state === "running") {
        try { process.kill(proof.pid, "SIGKILL"); }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause; }
      }
    }
    while (!await confirmStopped(operation)) {
      operation.check();
      await delay(Math.max(1, Math.min(25, operation.remainingMs())), undefined, { signal: operation.signal });
    }
    frozen.clear();
  };
  const verifyProcesses = async (input: { shellPid: number; receipt?: HerdrToolLaunchReceipt; foregroundPids?: readonly number[] }, operation: Operation): Promise<void> => {
    operation.check();
    const record = await read(), proofs = new Map((record?.proofs ?? []).map(proof => [proof.pid, proof]));
    const shell = record?.proofs[0];
    if (shell === undefined || shell.pid !== input.shellPid) throw new Error("The original shell has no process proof from workspace preparation.");
    const observe = async (proof: ProcessProof, role: string): Promise<ProcessProof> => {
      operation.check();
      const current = await captureProcessProof(proof.pid, Math.max(1, Math.min(5000, Math.floor(operation.remainingMs()))));
      if (!sameProcessIdentity(current, proof)) throw new Error(`The original ${role} process identity changed; input remains closed.`);
      return current;
    };
    await observe(shell, "shell");
    if (input.receipt === undefined) return;
    const receipt = parseToolReceipt(input.receipt, manifest);
    const capture = async (id: number, role: string, parent: ProcessProof): Promise<ProcessProof> => {
      if (process.platform === "win32") await observe(parent, "parent");
      const previous = proofs.get(id), proof = previous === undefined ? await captureProcessProof(id, Math.max(1, Math.min(5000, Math.floor(operation.remainingMs())))) : await observe(previous, role);
      if (proof.parentPid !== parent.pid) throw new Error(`The original ${role} has no continuous original helper and shell parent chain.`);
      if (process.platform === "win32") assertWindowsParentBirth(proof, parent);
      await observe(parent, "parent");
      if (previous === undefined) { proofs.set(id, proof); await save([...proofs.values()]); }
      return proof;
    };
    const helper = await capture(receipt.helperPid, "helper", shell), child = await capture(receipt.childPid, "native child", helper);
    if (process.platform !== "win32" && child.processGroupId !== helper.processGroupId) throw new Error("The original native child left its helper process group.");
    if (process.platform === "win32") (await retainHerdrJobObserver(manifestPath, manifest, receipt, operation, helper)).check();
    const rows = await inventory(environment, operation), descendants = new Set([shell.pid]);
    let changed = true;
    while (changed) { changed = false; for (const row of rows) if (!descendants.has(row.pid) && descendants.has(row.parentPid)) { descendants.add(row.pid); changed = true; } }
    if (!descendants.has(helper.pid) || !descendants.has(child.pid) || input.foregroundPids?.some(id => !descendants.has(id))) throw new Error("The original foreground process inventory has no continuous owned native chain.");
    const pending = rows.filter(row => descendants.has(row.pid) && !proofs.has(row.pid));
    while (pending.length > 0) {
      operation.check();
      if (proofs.size >= 1000) throw new Error("The original native process chain exceeds its supported ownership bound.");
      const index = pending.findIndex(row => proofs.has(row.parentPid));
      if (index < 0) throw new Error("The original native descendant parent chain is incomplete.");
      const row = pending.splice(index, 1)[0]!;
      await capture(row.pid, "native descendant", proofs.get(row.parentPid)!);
    }
    for (const proof of proofs.values()) if (descendants.has(proof.pid)) await observe(proof, "native chain");
  };
  return {
    captureProcesses, confirmStopped, stopProcesses, releaseFrozen, verifyProcesses,
    retire: async (operation: Operation): Promise<void> => {
      if (!await confirmStopped(operation)) throw new Error("The original Herdr process tree is not confirmed stopped; its mapping cannot rotate.");
      const value = retiredValue;
      try { await publishOwnedJson(retired, value); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST" || JSON.stringify(await optionalOwnedJson(retired)) !== JSON.stringify(value)) throw cause; }
      if (process.platform === "win32") releaseHerdrJobObserver(manifestPath, manifest);
      frozen.clear();
    },
  };
};
