export type PlatformProcessIdentity = { pid: number; parent: number; token: string };

const identityKey = (row: PlatformProcessIdentity) => `${row.pid}:${row.token}`;

const validateIdentity = (row: PlatformProcessIdentity) => {
  if (!Number.isSafeInteger(row.pid) || row.pid < 0 || !Number.isSafeInteger(row.parent) || row.parent < 0 || typeof row.token !== "string" || !/^[0-9]+$/.test(row.token)) throw new Error("The process inventory contains an unknown identity.");
};

export const createPlatformProcessCapture = ({ immutableParents = true }: { immutableParents?: boolean } = {}) => {
  let originals = new Map<string, PlatformProcessIdentity>();
  const capture = (inventory: PlatformProcessIdentity[], requiredPids: number[], rootPid?: number): PlatformProcessIdentity[] => {
    if ([...requiredPids, ...(rootPid === undefined ? [] : [rootPid])].some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error("Owned process identities require positive PIDs.");
    const captured = new Map(originals);
    const current = new Map<number, PlatformProcessIdentity>();
    for (const row of inventory) {
      validateIdentity(row);
      if (current.has(row.pid)) throw new Error(`The process inventory contains conflicting identities for PID ${row.pid}.`);
      current.set(row.pid, row);
    }
    if (rootPid !== undefined) {
      if (originals.size !== 0) throw new Error("The original process root was already captured.");
      const root = current.get(rootPid);
      if (!root) throw new Error(`The original process root ${rootPid} is missing from the inventory.`);
      captured.set(identityKey(root), { ...root });
    }
    if (captured.size === 0) throw new Error("The original process root has not been captured.");
    const owned = new Map<number, PlatformProcessIdentity>();
    for (const original of captured.values()) {
      const row = current.get(original.pid);
      if (row?.token === original.token) {
        if (immutableParents && row.parent !== original.parent) throw new Error(`The original process ${row.pid} has contradictory parent evidence.`);
        owned.set(row.pid, row);
      }
    }
    // Windows retains a parent's numeric PID after it exits. Birth order must
    // hold at every edge before a current incarnation can supply descendants.
    for (let changed = true; changed;) {
      changed = false;
      for (const row of current.values()) {
        if (owned.has(row.pid)) continue;
        const parent = owned.get(row.parent);
        if (parent && BigInt(row.token) >= BigInt(parent.token)) {
          owned.set(row.pid, row); changed = true;
        }
      }
    }
    for (const pid of requiredPids) {
      if (!owned.has(pid) && ![...captured.values()].some(original => original.pid === pid)) throw new Error(`The required original process ${pid} has no verified ownership chain.`);
    }
    for (const row of owned.values()) if (!captured.has(identityKey(row))) captured.set(identityKey(row), { ...row });
    originals = captured;
    return [...originals.values()].map(row => ({ ...row }));
  };
  return { capture };
};
