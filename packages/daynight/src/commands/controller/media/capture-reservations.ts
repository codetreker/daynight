import type Database from "better-sqlite3";
import { constants, closeSync, existsSync, fsyncSync, openSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { IMAGE_LIMITS, imageId } from "../../../session/image-values.js";

type Transactions = { read<T>(action: () => T): T; write<T>(action: () => T): T };
type Reservation = { captureId: string; attemptId: string; source: string; stage: string; released: boolean };
export type CaptureSourceLease = {
  readonly outputPath: string;
  runWriter<T>(writer: (outputPath: string, signal: AbortSignal) => Promise<T>): Promise<T>;
  release(): Promise<void>;
};

/** Source and staging peak allocations belong to the same execution media owner. */
export const captureSourceReservations = (options: {
  db: Database.Database; transactions: Transactions; root: string;
  checkOpen(): void; assertAttempt(captureId: string, attemptId: string): void;
  checkBudgets(next: number): void; assertMetadata(): void; sync(): void;
  acquireBlock(): { close(): void } | null;
  joinStage(captureId: string, attemptId: string): Promise<void>;
  stageRetained(captureId: string, attemptId: string): boolean;
}) => {
  const { db, transactions, root } = options;
  const active = new Map<string, { controller: AbortController; work: Promise<unknown> | null; started: boolean; releasing: Promise<void> | null; block: { close(): void } }>();
  const key = (captureId: string, attemptId: string) => `capture-source:${imageId(captureId)}:${imageId(attemptId)}`;
  const load = (captureId: string, attemptId: string): Reservation | null => transactions.read(() => {
    const row = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(key(captureId, attemptId)) as { value: string } | undefined;
    if (!row) return null;
    const value = JSON.parse(row.value) as Reservation;
    if (value.captureId !== captureId || value.attemptId !== attemptId || typeof value.released !== "boolean" || !/^[a-f0-9-]{36}\.part$/.test(value.source) || !/^[a-f0-9-]{36}\.part$/.test(value.stage) || value.source === value.stage) throw new Error("Image source reservation identity is corrupt.");
    return value;
  });
  const save = (value: Reservation) => transactions.write(() => {
    options.assertMetadata();
    db.prepare("INSERT INTO image_runtime_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key(value.captureId, value.attemptId), JSON.stringify(value));
  });
  const release = async (captureId: string, attemptId: string): Promise<void> => {
    options.checkOpen();
    const id = key(captureId, attemptId), running = active.get(id);
    if (running?.releasing) return running.releasing;
    const closeBlock = () => { active.delete(id); running?.block.close(); };
    const work = (async () => {
      if (running) { running.controller.abort(new Error("Image source reservation was released.")); await running.work?.catch(() => {}); }
      await options.joinStage(captureId, attemptId);
      const value = load(captureId, attemptId);
      if (!value) return;
      if (value.released) { closeBlock(); return; }
      if (existsSync(path.join(root, value.source))) unlinkSync(path.join(root, value.source));
      if (!options.stageRetained(captureId, attemptId) && existsSync(path.join(root, value.stage))) unlinkSync(path.join(root, value.stage));
      options.sync(); value.released = true; save(value);
      // Durable release returns the shared slot even if the remaining budget cannot be refreshed.
      try { options.checkBudgets(0); } finally { closeBlock(); }
    })();
    if (!running) return work;
    const tracked = work.finally(() => { if (running.releasing === tracked) running.releasing = null; });
    running.releasing = tracked;
    return tracked;
  };
  return {
    reservations: (): Map<string, number> => transactions.read(() => {
      const values = db.prepare("SELECT key FROM image_runtime_state WHERE key LIKE 'capture-source:%'").all() as { key: string }[];
      const out = new Map<string, number>();
      for (const row of values) {
        const parts = row.key.split(":"), value = load(parts[1]!, parts[2]!);
        if (value && !value.released) { out.set(path.join(root, value.source), IMAGE_LIMITS.imageBytes); out.set(path.join(root, value.stage), IMAGE_LIMITS.imageBytes); }
      }
      return out;
    }),
    stagePath: (captureId: string, attemptId: string, sourcePath: string): string | null => {
      const value = load(captureId, attemptId);
      if (!value) return null;
      if (value.released || sourcePath !== path.join(root, value.source)) throw new Error("Image source reservation differs from its original private path.");
      const running = active.get(key(captureId, attemptId));
      if (running?.work) throw new Error("Image source writer has not stopped.");
      return path.join(root, value.stage);
    },
    reserve: (captureId: string, attemptId: string): CaptureSourceLease => {
      options.checkOpen(); options.assertAttempt(captureId, attemptId);
      if (load(captureId, attemptId)) throw new Error("Image source already has a durable reservation; query the original capture.");
      if ([...active.values()].filter(item => !item.releasing).length >= 2) throw new Error("source_capacity: Controller source capture capacity is unavailable.");
      const block = options.acquireBlock();
      if (!block) throw Object.assign(new Error("source_capacity: Controller media block capacity is unavailable."), { code: "source_capacity" });
      try {
        options.checkBudgets(2 * IMAGE_LIMITS.imageBytes);
        const value: Reservation = { captureId, attemptId, source: `${randomUUID()}.part`, stage: `${randomUUID()}.part`, released: false };
        save(value);
        const outputPath = path.join(root, value.source);
        const fd = openSync(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { fsyncSync(fd); } finally { closeSync(fd); } options.sync();
        const state = { controller: new AbortController(), work: null as Promise<unknown> | null, started: false, releasing: null as Promise<void> | null, block };
        active.set(key(captureId, attemptId), state);
        return { outputPath,
          async runWriter<T>(writer: (outputPath: string, signal: AbortSignal) => Promise<T>): Promise<T> {
            options.checkOpen();
            if (state.started || state.releasing || state.controller.signal.aborted) throw new Error("Image source writer cannot be restarted.");
            state.started = true;
            const work = Promise.resolve().then(() => { state.controller.signal.throwIfAborted(); return writer(outputPath, state.controller.signal); });
            state.work = work;
            try { return await work; } finally { state.work = null; }
          },
          release: () => release(captureId, attemptId),
        };
      } catch (error) { block.close(); throw error; }
    },
    release,
    async stop(): Promise<void> {
      for (const state of active.values()) state.controller.abort(new Error("Controller media stopped."));
      await Promise.allSettled([...active.values()].flatMap(state => [state.work, state.releasing].filter((work): work is Promise<unknown> => work !== null)));
      for (const state of active.values()) state.block.close();
    },
  };
};
