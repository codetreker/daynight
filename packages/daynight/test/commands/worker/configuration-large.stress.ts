import { constants } from "node:buffer";
import { mkdir, mkdtemp, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createWorkerConfigurationManager } from "../../../src/commands/worker/configuration.js";
import { readConfigurationCache } from "../../../src/commands/worker/configuration-cache.js";

if (process.env.CI) throw new Error("CLI stress tests run only on local machines.");

const identity = { serverOrigin: "https://daynight.example", userId: "22222222-2222-4222-8222-222222222222", workerId: "33333333-3333-4333-8333-333333333333" };
const count = 1020;
const id = (index: number): string => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const argument = (index: number): string => `${String(index).padStart(4, "0")}${"x".repeat(4092)}`;
const native = (index: number) => ({ agent: "codex", model: `${String(index).padStart(4, "0")}${"m".repeat(252)}`, args: Array<string>(128).fill(argument(index)) });
const lastFailure = { code: "invalid_configuration", category: "validation", phase: "validate", occurredAt: "2026-11-04T00:00:00.000Z" };
const stored = (value: unknown, failureId: number | null = null) => ({ value, attempts: failureId === null ? 0 : 5, failureId, started: false });
const baseItem = (key: unknown, appliedValue: unknown) => ({ key, targetRevision: "100", appliedValue, state: "applied", error: null, lastFailure: null, nextAttemptAt: null });

it("migrates and rereads a multi-generation cache larger than MAX_STRING_LENGTH", async () => {
  const root = path.resolve(".tmp/worker-cloud-configuration-stress");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "run-")), file = path.join(directory, "configuration.json");
  try {
    const desired = { revision: "100", updatedAt: "2026-11-04T00:00:00Z", value: { maxConcurrent: 2, pollIntervalMs: 1200, recoveryLimit: 4, preferPlatformSpecificTasks: false, native: native(count), projects: [] } };
    const required = [
      stored(baseItem({ kind: "maxConcurrent" }, 2)),
      stored(baseItem({ kind: "pollIntervalMs" }, 1200)),
      stored(baseItem({ kind: "recoveryLimit" }, 4)),
      stored(baseItem({ kind: "preferPlatformSpecificTasks" }, false)),
      stored(baseItem({ kind: "native" }, native(count))),
    ];
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.writeFile(`{"schemaVersion":3,"identity":${JSON.stringify(identity)},"desired":${JSON.stringify(desired)},"observationRevision":"99","nextFailureId":${count + 1},"nativeModes":{"native:":"herdr"},"items":[`);
      for (const entry of required) await handle.writeFile(`${JSON.stringify(entry)},`);
      for (let index = 0; index < count; index++) {
        const value = { key: { kind: "projectNative", projectId: id(index) }, targetRevision: String(index % 99 + 1), appliedValue: native(index), state: "applied", error: null, lastFailure, nextAttemptAt: null };
        await handle.writeFile(`${index === 0 ? "" : ","}${JSON.stringify(stored(value, index + 1))}`);
      }
      await handle.writeFile("]}");
    } finally { await handle.close(); }
    const originalSize = (await stat(file)).size;
    expect(originalSize).toBeGreaterThan(constants.MAX_STRING_LENGTH);

    const inspect = async (): Promise<void> => {
      const manager = await createWorkerConfigurationManager({ file, identity, signal: new AbortController().signal, applyNative: async () => {} });
      try {
        const snapshot = manager.current();
        expect(snapshot.observationRevision).toBe("99");
        expect(snapshot.items).toHaveLength(required.length);
        const persisted = (await readConfigurationCache(file, identity, new AbortController().signal)).cache;
        expect(persisted.currentItems.length + persisted.retainedItems.length).toBe(count + required.length);
        const history = persisted.retainedItems.filter(item => item.value.key.kind === "projectNative");
        expect(history).toHaveLength(count);
        for (let index = 0; index < count; index++) {
          const record = history[index]!, item = record.value;
          expect(record.origin).toMatchObject({ source: "schema4", targetRevision: String(index % 99 + 1) });
          expect(record.actualSource).toEqual({ kind: "schema4", successRevision: null });
          expect(record.failureId).toBe(index + 1);
          expect(item.key).toEqual({ kind: "projectNative", projectId: id(index) });
          expect(item.targetRevision).toBe(String(index % 99 + 1));
          expect(item.lastFailure).toEqual(lastFailure);
          const actual = item.appliedValue;
          if (typeof actual !== "object" || actual === null) throw new Error(`Missing native value for ${index}`);
          expect(actual.agent).toBe("codex");
          expect(actual.model).toBe(native(index).model);
          expect(actual.args).toHaveLength(128);
          const expected = argument(index);
          for (const value of actual.args) expect(value).toBe(expected);
        }
      } finally { await manager.stop(); }
    };

    await inspect();
    expect((await stat(file)).size).toBeGreaterThan(constants.MAX_STRING_LENGTH);
    const migrated = await open(file, "r");
    try {
      const prefix = Buffer.alloc(18);
      await migrated.read(prefix, 0, prefix.length, 0);
      expect(prefix.toString("utf8")).toBe('{"schemaVersion":5');
    } finally { await migrated.close(); }
    await inspect();
    console.info(`Configuration stress: original ${originalSize} bytes; migrated ${(await stat(file)).size} bytes; MAX_STRING_LENGTH ${constants.MAX_STRING_LENGTH}.`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 1_200_000);
