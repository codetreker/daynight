import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { expect, test } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { runToolExtraction, readExtractionProof, stopExtraction } from "../../../src/commands/worker/tool-extraction.js";
import { toolExtractionChildSource } from "../../../src/commands/worker/tool-extraction-child.js";
import { inspectProcessProof, type ProcessProof } from "../../../src/commands/controller/process-proof.js";

const supported = process.platform !== "win32";
async function scratch() { const directory = path.resolve(import.meta.dirname, "../../../../../.tmp/extraction-tests"); await mkdir(directory, { recursive: true }); return mkdtemp(path.join(directory, "run-")); }
async function waitMessage(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Missing helper message.")), 10_000);
    child.once("message", value => { clearTimeout(timer); resolve(value as Record<string, unknown>); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
  });
}

test.skipIf(!supported)("extraction gate persists proof before native work and closes the complete scope", async () => {
  const root = await scratch(), operation = createOperation({ limits: { totalMs: 20_000 } });
  const proofPath = path.join(root, "proof"), preparationId = randomUUID(), marker = path.join(root, "native");
  let original: ProcessProof | undefined;
  try {
    await runToolExtraction({ node: process.execPath, cwd: root, proofPath, preparationId, file: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync(process.argv[1],'started')", marker], environment: process.env,
      commit: async proof => { original = proof; expect(await readExtractionProof(proofPath, preparationId)).toEqual(proof); await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" }); },
    }, operation);
    expect(await readFile(marker, "utf8")).toBe("started"); expect(await inspectProcessProof(original!)).not.toBe("running");
  } finally { operation.dispose(); if (original) await stopExtraction(original); await rm(root, { recursive: true, force: true }); }
}, 25_000);

test.skipIf(!supported)("failed durable admission never starts extraction", async () => {
  const root = await scratch(), operation = createOperation(), marker = path.join(root, "native");
  try {
    await expect(runToolExtraction({ node: process.execPath, cwd: root, proofPath: path.join(root, "proof"), preparationId: randomUUID(), file: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync(process.argv[1],'started')", marker], environment: process.env,
      commit: async () => { throw new Error("write not confirmed"); },
    }, operation)).rejects.toThrow("write not confirmed");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { operation.dispose(); await rm(root, { recursive: true, force: true }); }
}, 25_000);

test.skipIf(!supported)("parent loss before commit exits; parent loss after commit retains the original group proof", async () => {
  const root = await scratch(); let child: ChildProcess | undefined, proof: ProcessProof | undefined;
  try {
    for (const committed of [false, true]) {
      const preparationId = randomUUID(), proofPath = path.join(root, preparationId), marker = path.join(root, `${preparationId}.native`);
      child = spawn(process.execPath, ["-e", toolExtractionChildSource, proofPath, preparationId], { cwd: root, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      expect((await waitMessage(child)).type).toBe("ready"); proof = await readExtractionProof(proofPath, preparationId);
      if (committed) {
        const response = waitMessage(child); child.send({ type: "commit", preparationId, file: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.argv[1],'started')", marker], environment: process.env });
        expect(await response).toEqual({ type: "result", ok: true });
      }
      // This fixture intentionally closes IPC itself. Node emits exit without
      // close for that detached IPC shape; all other stdio is ignored.
      const closed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Original helper did not exit.")), 12_000);
        child!.once("exit", () => { clearTimeout(timer); resolve(); });
      }); child.disconnect();
      if (committed) { expect(await readFile(marker, "utf8")).toBe("started"); expect(await inspectProcessProof(proof!)).toBe("running"); await stopExtraction(proof!); }
      else await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      await closed; expect(await inspectProcessProof(proof!)).not.toBe("running"); child = undefined; proof = undefined;
    }
  } finally { if (proof) await stopExtraction(proof); child?.kill("SIGKILL"); await rm(root, { recursive: true, force: true }); }
}, 25_000);
