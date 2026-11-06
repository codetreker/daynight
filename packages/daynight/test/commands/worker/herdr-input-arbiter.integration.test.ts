import { expect, it } from "vitest";
import { createHerdrInputArbiter } from "../../../src/commands/worker/herdr/input-arbiter.js";
import { openHerdrInputStore } from "../../../src/commands/worker/herdr/input-store.js";
import { createHerdrInputArbiterFixtures } from "./herdr-input-arbiter.fixtures.js";

const { id, cleanups, fixture } = createHerdrInputArbiterFixtures("file");

it("recovers dispatching as unknown without replay and records human disposition separately", async () => {
    const f = fixture();
    f.store.update(f.arbiter.record(), draft => {
      draft.initialOutcome = "dispatching";
      draft.operations.push({ operationId: draft.initialOperationId, source: "initial", digest: "a".repeat(64), target: draft.target, controlEpoch: draft.controlEpoch, leaseId: null, leaseSeq: null, result: { operationId: draft.initialOperationId, state: "dispatching", errorCode: null }, controlAck: null });
    });
    f.arbiter.recover(); expect(f.arbiter.record().initialOutcome).toBe("unknown"); expect(f.arbiter.state().state).toBe("suspended");
    const denied = await f.arbiter.control(f.control("resume_automation")); expect(denied.result.state).toBe("rejected");
    expect(f.arbiter.state().availableActions).toContain("resolve_initial_assignment");
    expect(f.arbiter.state().availableActions).not.toContain("resume_automation");
    const request = f.control("resolve_initial_assignment", { initialUnknownDisposition: "delivered_continue" });
    const ack = await f.arbiter.control(request);
    expect(ack.result.state).toBe("transport_completed"); expect(f.arbiter.record().initialOutcome).toBe("unknown");
    expect(f.arbiter.record().initialDisposition).toMatchObject({ actorUserId: id(8), disposition: "delivered_continue" });
    expect(f.arbiter.state()).toMatchObject({ state: "suspended", initialAssignment: "transport_completed" });
    expect(await f.arbiter.control(request)).toEqual(ack);
    expect((await f.arbiter.submit({ operationId: id(80), source: "continuation", text: "continue" })).state).toBe("rejected");
    expect(f.arbiter.state().availableActions).not.toContain("resolve_initial_assignment");
    expect(f.arbiter.state().availableActions).toContain("resume_automation");
    expect(f.arbiter.record().operations[0]!.result.state).toBe("unknown"); expect(f.writes).toHaveLength(0);
    const resume = f.control("resume_automation");
    f.close();
    const reopened = openHerdrInputStore(f.filename, { onMigration: () => {} }); cleanups.push(() => reopened.close());
    expect(reopened.get(f.target.sessionId)).toMatchObject({ state: "suspended", initialOutcome: "unknown", initialDisposition: { operationId: request.payload.request.operationId } });
    const recovered = createHerdrInputArbiter({ store: reopened, sessionId: f.target.sessionId, execute: async () => { throw new Error("Control decisions must not write native input"); }, verify: async () => {} });
    expect((await recovered.control(resume)).result.state).toBe("transport_completed");
    expect(recovered.state()).toMatchObject({ state: "automation", initialAssignment: "transport_completed" });
    expect(recovered.record().initialOutcome).toBe("unknown");
  });

it("retains clean shutdown admission after actually reopening the SQLite journal", async () => {
    const f = fixture(); await f.initial();
    f.arbiter.bind({ ...f.target, binding: { ...f.target.binding, nativeSessionId: "native-original" } });
    f.arbiter.beginClosing(); f.close();
    const reopened = openHerdrInputStore(f.filename, { onMigration: () => {} }); cleanups.push(() => reopened.close());
    const recovered = reopened.recover(f.target.sessionId);
    const next = reopened.bind({ ...f.target, executionGeneration: "2", segmentId: id(95), binding: { ...f.target.binding, instanceId: id(96), terminalId: "replacement", nativeSessionId: "native-original" } }, recovered.initialOutcome, recovered.controlEpoch, { allowRecovery: true });
    expect(next.state).toBe("automation"); expect(next.lease).toBeNull();
  });
