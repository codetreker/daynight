import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { controllerMetadataBudget } from "./metadata-budget.js";
import { inspectProcessProof, type ProcessProof } from "../process-proof.js";

type Transactions = { read<T>(action: () => T): T; write<T>(action: () => T): T };

/** Native aliases, receipts and cursors share the execution's durable metadata owner. */
export const createNativeImageState = (db: Database.Database, transactions: Transactions, budget: ReturnType<typeof controllerMetadataBudget>) => {
  const key = (value: string): string => {
    if (typeof value !== "string" || !value.isWellFormed() || value.length === 0 || Buffer.byteLength(value) > 512 || /[\0\r\n]/u.test(value)) throw new Error("Invalid native image metadata key.");
    return `native_provider:${value}`;
  };
  return {
    reconcileNativeIndexReservation: async (): Promise<void> => {
      const saved = transactions.read(() => db.prepare("SELECT value FROM image_runtime_state WHERE key='native_index_reservation'").get() as { value: string } | undefined);
      if (!saved) return;
      const reservation = JSON.parse(saved.value) as { id: string; owner?: ProcessProof };
      if (!reservation.owner || await inspectProcessProof(reservation.owner) === "running") throw new Error("The original native index writer has not been proven stopped.");
      transactions.write(() => {
        const current = db.prepare("SELECT value FROM image_runtime_state WHERE key='native_index_reservation'").get() as { value: string } | undefined;
        if (current?.value !== saved.value) throw new Error("Native index writer reservation changed during recovery.");
        db.prepare("DELETE FROM image_runtime_state WHERE key='native_index_reservation'").run();
      });
    },
    acquireNativeIndexReservation: (additionalBytes: number, owner?: ProcessProof): { release(): void } => transactions.write(() => {
      if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw new Error("Invalid native index metadata reservation.");
      if (db.prepare("SELECT value FROM image_runtime_state WHERE key='native_index_reservation'").get()) throw new Error("A native index writer still owns its reservation.");
      budget.assert(additionalBytes + 16_384);
      const id = randomUUID(), maximumBytes = budget.nativeIndexBytes() + additionalBytes;
      db.prepare("INSERT INTO image_runtime_state VALUES('native_index_reservation',?)").run(JSON.stringify({ id, maximumBytes, ...(owner ? { owner } : {}) }));
      return { release: () => transactions.write(() => {
        const row = db.prepare("SELECT value FROM image_runtime_state WHERE key='native_index_reservation'").get() as { value: string } | undefined;
        if (!row) return;
        if ((JSON.parse(row.value) as { id: string }).id !== id) throw new Error("Native index writer reservation identity changed.");
        db.prepare("DELETE FROM image_runtime_state WHERE key='native_index_reservation'").run();
      }) };
    }),
    readNativeImageState: (name: string): unknown => transactions.read(() => {
      const row = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(key(name)) as { value: string } | undefined;
      return row ? JSON.parse(row.value) as unknown : null;
    }),
    writeNativeImageState: (name: string, value: unknown): void => transactions.write(() => {
      const id = key(name);
      let encoded: string | undefined;
      try { encoded = JSON.stringify(value); } catch { throw new Error("Invalid native image metadata."); }
      if (encoded === undefined || !encoded.isWellFormed() || Buffer.byteLength(encoded) > 1_048_576) throw new Error("Native image metadata exceeds its bound or is not JSON.");
      budget.assert(Buffer.byteLength(encoded) * 2 + 16_384);
      db.prepare("INSERT INTO image_runtime_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(id, encoded);
    }),
  };
};
