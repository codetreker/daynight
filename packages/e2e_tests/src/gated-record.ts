import { open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { ProcessEvidence } from "./process-evidence.ts";

export type GateReceipt = { schemaVersion: 1; runId: string; gateId: string; state: "bound" | "released"; leader: ProcessEvidence; child: ProcessEvidence | null };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const gatePath = (runDirectory: string, gateId: string): string => {
  if (!uuid.test(path.basename(runDirectory)) || !uuid.test(gateId)) throw new Error("Gate identity is invalid.");
  return path.join(runDirectory, "results", `gate-${gateId}.json`);
};
export const writeGateReceipt = async (runDirectory: string, receipt: GateReceipt): Promise<void> => {
  if (receipt.runId !== path.basename(runDirectory) || !uuid.test(receipt.gateId)) throw new Error("Gate receipt identity conflicts.");
  const file = gatePath(runDirectory, receipt.gateId), temp = `${file}.${process.pid}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(receipt)}\n`); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temp, file); } finally { await rm(temp, { force: true }); }
  const parent = await open(path.dirname(file), "r"); try { await parent.sync(); } finally { await parent.close(); }
};
export const readGateReceipt = async (runDirectory: string, gateId: string): Promise<GateReceipt> => {
  let value: GateReceipt;
  try { value = JSON.parse(await readFile(gatePath(runDirectory, gateId), "utf8")) as GateReceipt; }
  catch { throw new Error("Original gate receipt is unavailable or invalid."); }
  if (value === null || typeof value !== "object" || Object.keys(value).sort().join() !== "child,gateId,leader,runId,schemaVersion,state"
    || value.schemaVersion !== 1 || value.runId !== path.basename(runDirectory) || value.gateId !== gateId
    || !["bound", "released"].includes(value.state) || value.leader == null || !(value.child === null || typeof value.child === "object")) throw new Error("Original gate receipt conflicts with its run.");
  return value;
};
