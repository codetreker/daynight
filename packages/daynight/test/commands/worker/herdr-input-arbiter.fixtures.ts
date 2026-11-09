import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { createHerdrInputArbiter } from "../../../src/commands/worker/herdr/input-arbiter.js";
import { openHerdrInputStore } from "../../../src/commands/worker/herdr/input-store.js";
import type { HerdrInputBatch, HerdrInputTarget, HerdrInputWriteContext } from "../../../src/commands/worker/herdr/input-types.js";
import { canonicalSessionJson } from "../../../src/session/v2/values.js";
import type { SessionV2Message, SessionV2Payloads } from "../../../src/session/v2/types.js";
import { createMemoryDatabase } from "../../helpers/sqlite.js";

export const createHerdrInputArbiterFixtures = (storage: "memory" | "file") => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  const root = fileURLToPath(new URL("../../../../../.tmp/herdr-input/", import.meta.url));

  const cleanups: (() => void)[] = [];

  afterEach(() => { vi.useRealTimers(); cleanups.splice(0).reverse().forEach(fn => fn()); });

  const fixture = () => {
    mkdirSync(root, { recursive: true }); const dir = mkdtempSync(path.join(root, "test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const filename = path.join(dir, "input.sqlite"); const store = openHerdrInputStore(storage === "memory" ? createMemoryDatabase() : filename, { onMigration: () => {} }); let closed = false; const close = () => { if (!closed) { store.close(); closed = true; } }; cleanups.push(close);
    const target: HerdrInputTarget = { sessionId: id(1), claimId: id(2), executionGeneration: "1", connectionEpoch: "1", segmentId: id(3), binding: { instanceId: id(4), sessionId: "w", workspaceId: "workspace", paneId: "pane", terminalId: "terminal", nativeSessionId: null } };
    store.bind(target); let time = 1000, wall = 1_800_000_000_000;
    const writes: HerdrInputBatch[] = [];
    let execute = async (batch: HerdrInputBatch, context: HerdrInputWriteContext) => { await context.beforeWrite(); context.markWritten(); writes.push(batch); };
    let verify = async () => {};
    const arbiter = createHerdrInputArbiter({ store, sessionId: target.sessionId, now: () => wall, monotonic: () => time, execute: (batch, context) => execute(batch, context), verify: async () => verify() });
    const envelope = () => ({ protocol: "daynight.session.v2" as const, schemaVersion: 2 as const, projectionVersion: 1 as const, agentControlMode: "herdr" as const, contentKind: "terminal_recording" as const, sessionId: target.sessionId, claimId: target.claimId, executionGeneration: target.executionGeneration });
    let sequence = 20;
    const control = (action: SessionV2Payloads["control_request"]["action"], overrides: Partial<SessionV2Payloads["control_request"]> = {}): Extract<SessionV2Message, { type: "control_dispatch" }> => {
      const state = arbiter.state();
      const request: SessionV2Payloads["control_request"] = { operationId: id(sequence++), connectionEpoch: target.connectionEpoch, controlEpoch: state.controlEpoch, browserClientId: id(9), action, leaseId: state.lease?.leaseId ?? null, draftHandled: action === "resume_automation", initialUnknownDisposition: null, ...overrides };
      const actorUserId = id(8), requestDigest = createHash("sha256").update(canonicalSessionJson({ actorUserId, request })).digest("hex");
      return { ...envelope(), type: "control_dispatch", payload: { actorUserId, requestDigest, request } };
    };
    const input = (text = "人工草稿\n第二行"): Extract<SessionV2Message, { type: "operation" }> => ({ ...envelope(), type: "operation", payload: { operationId: id(sequence++), connectionEpoch: target.connectionEpoch, segmentId: target.segmentId, binding: target.binding, controlEpoch: arbiter.state().controlEpoch, leaseId: arbiter.state().lease!.leaseId, leaseSeq: "1", kind: "paste", payload: { text } } });
    const initial = () => arbiter.submit({ operationId: arbiter.record().initialOperationId, source: "initial", text: "original assignment" });
    return { store, filename, close, target, arbiter, writes, initial, control, input, advance: (ms: number) => { time += ms; wall += ms; }, execute: (fn: typeof execute) => { execute = fn; }, verify: (fn: typeof verify) => { verify = fn; } };
  };
  return { id, cleanups, fixture };
};
