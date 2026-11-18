import { readWindowsBootIdentity, type WindowsBootIdentity } from "../../platform/windows-boot.js";

export type WindowsRebootWitness = WindowsBootIdentity & { version: 1; ticketHash: string; snapshotHash: string };
declare const rebootBrand: unique symbol;
export type WindowsRebootProof = { readonly [rebootBrand]: true };
const proofs = new WeakMap<WindowsRebootProof, { witness: WindowsRebootWitness; current: WindowsBootIdentity }>();

export const parseWindowsRebootWitness = (value: unknown): WindowsRebootWitness => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Windows reboot checkpoint is invalid.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== "bootId,machineHash,snapshotHash,ticketHash,version" || record.version !== 1
    || !["machineHash", "ticketHash", "snapshotHash"].every(key => typeof record[key] === "string" && /^[0-9a-f]{64}$/.test(record[key]))
    || typeof record.bootId !== "string" || !/^[0-9a-f]{32}$/.test(record.bootId) || /^0+$/.test(record.bootId)) throw new Error("Windows reboot checkpoint is invalid.");
  return { version: 1, machineHash: record.machineHash as string, bootId: record.bootId, ticketHash: record.ticketHash as string, snapshotHash: record.snapshotHash as string };
};

export const proveWindowsReboot = async (witness: WindowsRebootWitness, ticketHash: string, snapshotHash: string, deadline: number): Promise<WindowsRebootProof> => {
  const saved = parseWindowsRebootWitness(witness), current = await readWindowsBootIdentity(deadline);
  if (saved.ticketHash !== ticketHash || saved.snapshotHash !== snapshotHash) throw new Error("Windows reboot checkpoint conflicts with the original execution; its resources were retained.");
  if (current.machineHash !== saved.machineHash) throw new Error("Windows reboot recovery requires the original Windows installation.");
  if (current.bootId === saved.bootId) throw new Error("A full Windows restart is required after preparing this checkpoint; restarting the Worker or signing in again is insufficient.");
  const proof = {} as WindowsRebootProof;
  proofs.set(proof, { witness: saved, current });
  return proof;
};

export const verifyWindowsRebootProof = async (proof: WindowsRebootProof, ticketHash: string, snapshotHash: string, deadline: number): Promise<void> => {
  const entry = proofs.get(proof);
  if (entry === undefined || entry.witness.ticketHash !== ticketHash || entry.witness.snapshotHash !== snapshotHash) throw new Error("Windows reboot proof does not identify this original controller snapshot.");
  const current = await readWindowsBootIdentity(deadline);
  if (current.machineHash !== entry.current.machineHash || current.bootId !== entry.current.bootId || current.bootId === entry.witness.bootId) throw new Error("Windows boot identity changed during stop verification.");
};
