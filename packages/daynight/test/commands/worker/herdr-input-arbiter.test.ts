import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { canonicalSessionJson, SessionV2Error } from "../../../src/session/v2/values.js";
import { HerdrInputBlockedError } from "../../../src/commands/worker/herdr/agents.js";
import { createHerdrInputArbiterFixtures } from "./herdr-input-arbiter.fixtures.js";

const { id, fixture } = createHerdrInputArbiterFixtures("memory");

it("persists known-menu no-write refusals while allowing a fresh initial attempt after dismissal", async () => {
    const f = fixture(); const blocked = new HerdrInputBlockedError("menu");
    f.verify(async () => { throw blocked; });
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(f.initial()).rejects.toBe(blocked);
      expect(f.arbiter.record()).toMatchObject({ state: "automation", initialOutcome: "pending", unknownInput: false });
      expect(f.arbiter.record().operations.at(-1)?.result).toMatchObject({ state: "rejected", errorCode: "automation_suspended" });
    }
    expect(f.writes).toEqual([]);
    expect(new Set(f.arbiter.record().operations.map(op => op.operationId)).size).toBe(5);
    f.verify(async () => {});
    expect((await f.initial()).state).toBe("transport_completed");
    expect((await f.initial()).state).toBe("transport_completed");
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.payload).toMatchObject({ text: "original assignment" });
  });

it("keeps a blocker discovered after native writing unknown without replay", async () => {
    const f = fixture(); const blocked = new HerdrInputBlockedError("menu");
    f.execute(async (batch, ctx) => { ctx.markWritten(); f.writes.push(batch); throw blocked; });
    expect((await f.initial()).state).toBe("unknown");
    expect(f.arbiter.record()).toMatchObject({ state: "suspended", initialOutcome: "unknown", unknownInput: true });
    expect((await f.initial()).state).toBe("unknown");
    expect(f.writes).toHaveLength(1);
  });

it("retains manual control across paste and Detach and suppresses automatic continuation", async () => {
    const f = fixture(); await f.initial();
    expect((await f.arbiter.control(f.control("acquire_control"))).result.state).toBe("transport_completed");
    expect((await f.arbiter.input(f.input())).state).toBe("transport_completed");
    expect(f.arbiter.state().state).toBe("manual");
    expect((await f.arbiter.submit({ operationId: id(80), source: "continuation", text: "continue" })).state).toBe("rejected");
    await f.arbiter.control(f.control("release_control"));
    expect(f.arbiter.state().state).toBe("suspended"); expect(f.writes).toHaveLength(2);
  });

it("returns busy immediately when lease acquisition races the initial dispatch", async () => {
    const f = fixture(); let release!: () => void;
    f.execute(async (batch, ctx) => { await new Promise<void>(resolve => { release = resolve; }); await ctx.beforeWrite(); ctx.markWritten(); f.writes.push(batch); });
    const initial = f.initial(); await Promise.resolve(); await Promise.resolve();
    const ack = await f.arbiter.control(f.control("acquire_control"));
    expect(ack.result).toMatchObject({ state: "rejected", errorCode: "input_busy" });
    release(); expect((await initial).state).toBe("transport_completed");
  });

it("does not replay a duplicate operation and rejects a different body under its ID", async () => {
    const f = fixture(); await f.initial(); await f.arbiter.control(f.control("acquire_control"));
    const input = f.input(); await f.arbiter.input(input); await f.arbiter.input(input);
    const changed = structuredClone(input); if (changed.payload.kind === "paste") changed.payload.payload.text = "different";
    await expect(f.arbiter.input(changed)).rejects.toThrow(/different|digest/i); expect(f.writes).toHaveLength(2);
  });

it("expires a lease on monotonic time and requires explicit handback", async () => {
    const f = fixture(); await f.initial(); await f.arbiter.control(f.control("acquire_control")); const input = f.input();
    f.advance(30_000); expect(f.arbiter.state().state).toBe("suspended");
    expect((await f.arbiter.input(input)).state).toBe("rejected");
    expect((await f.arbiter.control(f.control("resume_automation"))).result.state).toBe("transport_completed");
  });

it("refuses initial disposition outside an unresolved suspended execution", async () => {
    const f = fixture();
    const resolve = () => f.control("resolve_initial_assignment", { initialUnknownDisposition: "delivered_continue" });
    expect((await f.arbiter.control(resolve())).result.state).toBe("rejected");
    f.store.update(f.arbiter.record(), draft => { draft.state = "suspended"; draft.initialOutcome = "unconfirmed"; draft.unknownInput = true; });
    const stale = resolve();
    await f.arbiter.control(f.control("acquire_control"));
    expect(f.arbiter.state().availableActions).not.toContain("resolve_initial_assignment");
    await expect(f.arbiter.control(resolve())).rejects.toThrow();
    await f.arbiter.control(f.control("release_control"));
    expect((await f.arbiter.control(stale)).result).toMatchObject({ state: "rejected", errorCode: "stale_fence" });
    const ack = await f.arbiter.control(resolve());
    expect(ack.controlState).toMatchObject({ state: "suspended", initialAssignment: "transport_completed" });
    expect(f.arbiter.record()).toMatchObject({ initialOutcome: "unconfirmed", unknownInput: true });
    expect((await f.arbiter.control(resolve())).result.state).toBe("rejected");
    f.arbiter.beginClosing();
    expect((await f.arbiter.control(resolve())).result.state).toBe("rejected");
    expect(f.writes).toEqual([]);
  });

it("revoke wins before native write and an already written batch stays unknown", async () => {
    for (const written of [false, true]) {
      const f = fixture(); let release!: () => void, entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
      f.execute(async (_batch, ctx) => { if (written) { await ctx.beforeWrite(); ctx.markWritten(); } await new Promise<void>(resolve => { release = resolve; entered(); }); await ctx.beforeWrite(); });
      const pending = f.initial(); await ready;
      expect(f.arbiter.beginClosing().canNotify).toBe(false); release();
      expect((await pending).state).toBe(written ? "unknown" : "rejected"); expect(f.arbiter.state().state).toBe("closing");
    }
  });

it.each(["suspend", "beginClosing"] as const)("aborts native input and closes admission when %s cannot persist revocation", async action => {
    for (const written of [false, true]) {
      const f = fixture(); let release!: () => void, entered!: () => void, signal!: AbortSignal;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      f.execute(async (batch, ctx) => {
        signal = ctx.signal;
        if (written) { await ctx.beforeWrite(); ctx.markWritten(); f.writes.push(batch); }
        await new Promise<void>(resolve => { release = resolve; entered(); });
        await ctx.beforeWrite(); ctx.markWritten(); f.writes.push(batch);
      });
      const pending = f.initial(); await ready;
      const takeover = f.control("acquire_control");
      const journal = vi.spyOn(f.store, "update").mockImplementationOnce(() => { throw new Error("Journal is unavailable"); });
      expect(() => f.arbiter[action]()).toThrow("Journal is unavailable"); journal.mockRestore();
      const aborted = signal.aborted; release();
      const receipt = await pending;
      expect(aborted).toBe(true);
      expect(receipt.state).toBe(written ? "unknown" : "rejected");
      expect(f.writes).toHaveLength(written ? 1 : 0);
      expect(() => f.arbiter.submit({ operationId: id(89), source: "continuation", text: "continue" })).toThrow(/journal/i);
      await expect(f.arbiter.control(takeover)).rejects.toThrow(/journal/i);
      expect(() => f.arbiter.state()).toThrow(/journal/i);
    }
  });

it("never sends cleanup text after manual draft and sends a clean notification at most once", async () => {
    const dirty = fixture(); await dirty.initial(); await dirty.arbiter.control(dirty.control("acquire_control"));
    expect(dirty.arbiter.beginClosing().canNotify).toBe(false);
    expect((await dirty.arbiter.submit({ operationId: dirty.arbiter.record().cleanupOperationId, source: "cleanup", text: "cleanup" })).state).toBe("rejected");
    const clean = fixture(); await clean.initial(); expect(clean.arbiter.beginClosing().canNotify).toBe(true);
    const request = { operationId: clean.arbiter.record().cleanupOperationId, source: "cleanup" as const, text: "cleanup" };
    await clean.arbiter.submit(request); await clean.arbiter.submit(request); expect(clean.writes).toHaveLength(2);
  });

it("keeps rejected initial attempts immutable while permitting a new definitely unsent attempt", async () => {
    const f = fixture(); f.verify(async () => { throw new Error("Trust menu requires interaction"); });
    const rejected = await f.initial(); expect(rejected.state).toBe("rejected"); expect(f.arbiter.record().initialOutcome).toBe("pending");
    f.verify(async () => {}); const delivered = await f.initial();
    expect(delivered.state).toBe("transport_completed"); expect(delivered.operationId).not.toBe(rejected.operationId);
    expect(f.arbiter.record().operations.find(op => op.operationId === rejected.operationId)!.result.state).toBe("rejected");
    expect(f.writes).toHaveLength(1);
    expect(() => f.arbiter.submit({ operationId: f.arbiter.record().initialOperationId, source: "initial", text: "changed assignment" })).toThrow(/digest/);
  });

it("preserves clean automatic reconnects but never revives a manual lease", async () => {
    const f = fixture(); await f.initial(); const originalId = f.arbiter.record().initialOperationId;
    f.arbiter.recover(); f.arbiter.bind({ ...f.target, connectionEpoch: "2", segmentId: id(90) });
    expect(f.arbiter.state().state).toBe("automation"); expect(f.arbiter.record().initialOperationId).toBe(originalId);
    const g = fixture(); await g.initial(); await g.arbiter.control(g.control("acquire_control")); g.arbiter.recover();
    expect(g.arbiter.state()).toMatchObject({ state: "suspended", lease: null });
  });

it("reopens only a clean confirmed replacement generation and retains old operation receipts", async () => {
    const f = fixture(); await f.initial(); f.arbiter.bind({ ...f.target, binding: { ...f.target.binding, nativeSessionId: "native-original" } }); f.arbiter.beginClosing(); const previous = f.arbiter.record();
    f.arbiter.bind({ ...f.target, executionGeneration: "2", segmentId: id(90), binding: { ...f.target.binding, instanceId: id(91), terminalId: "replacement", nativeSessionId: "native-original" } }, { allowRecovery: true });
    expect(f.arbiter.state().state).toBe("automation"); expect(f.arbiter.record().cleanupOperationId).not.toBe(previous.cleanupOperationId);
    expect(f.arbiter.record().operations).toEqual(previous.operations); expect(f.arbiter.record().initialOperationId).toBe(previous.initialOperationId);
  });

it("retains control acknowledgements across duplicate requests and rejects stale input sequences", async () => {
    const f = fixture(); await f.initial(); const request = f.control("acquire_control"); const ack = await f.arbiter.control(request);
    expect(await f.arbiter.control(request)).toEqual(ack);
    const first = f.input(); await f.arbiter.input(first); const next = f.input("second");
    expect((await f.arbiter.input(next)).state).toBe("rejected"); next.payload.operationId = id(99); next.payload.leaseSeq = "2";
    expect((await f.arbiter.input(next)).state).toBe("transport_completed"); expect(f.writes).toHaveLength(3);
  });

it("bounds a noncooperative native adapter and distinguishes write attempts at timeout", async () => {
    vi.useFakeTimers();
    for (const written of [false, true]) {
      const f = fixture(); let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
      f.execute(async (_batch, context) => { if (written) { await context.beforeWrite(); context.markWritten(); } entered(); await new Promise<void>(() => {}); });
      const pending = f.initial(); await ready; await vi.advanceTimersByTimeAsync(10_000);
      expect((await pending).state).toBe(written ? "unknown" : "rejected");
      expect(f.arbiter.record().initialOutcome).toBe(written ? "unknown" : "pending");
    }
  });

it("cancels lease acquisition before a slow identity check can grant control", async () => {
    const f = fixture(); let release!: () => void, entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    f.verify(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    const pending = f.arbiter.control(f.control("acquire_control")); await ready; f.arbiter.beginClosing();
    expect((await pending).result.state).toBe("rejected"); release(); await Promise.resolve();
    expect(f.arbiter.state()).toMatchObject({ state: "closing", lease: null });
  });

it("preserves precise authority failures and refuses a false native success", async () => {
    const f = fixture(); f.verify(async () => { throw new SessionV2Error("permission_denied"); });
    expect(await f.initial()).toMatchObject({ state: "rejected", errorCode: "permission_denied" });
    f.verify(async () => {}); f.execute(async () => {}); expect((await f.initial()).state).toBe("rejected");
  });

it("enforces SQLite compare-and-swap and immutable initial and operation evidence", async () => {
    const f = fixture(), stale = f.arbiter.record(); await f.initial();
    expect(() => f.store.update(stale, draft => { draft.controlEpoch = "99"; })).toThrow(/version/);
    expect(() => f.store.update(f.arbiter.record(), draft => { draft.initialOutcome = "pending"; })).toThrow(/outcome/);
    expect(() => f.store.update(f.arbiter.record(), draft => { draft.operations[0]!.digest = "0".repeat(64); })).toThrow(/identity/);
  });

it("preserves unknown control receipts on crash recovery without applying the action", async () => {
    const f = fixture(), request = f.control("acquire_control");
    f.store.update(f.arbiter.record(), draft => { draft.operations.push({ operationId: request.payload.request.operationId, source: "control", digest: createHash("sha256").update(canonicalSessionJson(request)).digest("hex"), target: draft.target, controlEpoch: draft.controlEpoch, leaseId: null, leaseSeq: null, result: { operationId: request.payload.request.operationId, state: "dispatching", errorCode: null }, controlAck: null }); });
    f.arbiter.recover(); const ack = await f.arbiter.control(request);
    expect(ack.result.state).toBe("unknown"); expect(f.arbiter.state()).toMatchObject({ state: "suspended", lease: null });
    expect(await f.arbiter.control(request)).toEqual(ack);
  });

it("keeps pending assignment paused through manual menu handling until explicit handback", async () => {
    const f = fixture(); await f.arbiter.control(f.control("acquire_control"));
    expect((await f.initial()).state).toBe("rejected"); expect(f.arbiter.record().initialOutcome).toBe("pending");
    await f.arbiter.input(f.input("menu choice")); await f.arbiter.control(f.control("release_control"));
    const count = f.arbiter.record().operations.length; await f.initial(); expect(f.arbiter.record().operations).toHaveLength(count);
    await f.arbiter.control(f.control("resume_automation")); expect((await f.initial()).state).toBe("transport_completed");
    expect(f.writes.map(batch => batch.source)).toEqual(["web", "initial"]);
  });

it("retains the original lease fence even for a refused stale request", async () => {
    const f = fixture(); await f.initial(); await f.arbiter.control(f.control("acquire_control"));
    const request = f.input(); const oldEpoch = request.payload.controlEpoch, oldLease = request.payload.leaseId;
    await f.arbiter.control(f.control("release_control")); expect((await f.arbiter.input(request)).state).toBe("rejected");
    expect(f.arbiter.record().operations.at(-1)).toMatchObject({ controlEpoch: oldEpoch, leaseId: oldLease, leaseSeq: "1" });
  });

it("permits manual control of a recovered generation without handing automation back", async () => {
    const f = fixture(); await f.initial(); await f.arbiter.control(f.control("acquire_control"));
    f.arbiter.bind({ ...f.target, binding: { ...f.target.binding, nativeSessionId: "native-original" } });
    f.arbiter.beginClosing();
    f.arbiter.bind({ ...f.target, executionGeneration: "2", segmentId: id(91), binding: { ...f.target.binding, instanceId: id(92), terminalId: "replacement", nativeSessionId: "native-original" } }, { allowRecovery: true });
    expect(f.arbiter.state()).toMatchObject({ state: "suspended", lease: null });
    expect(f.arbiter.state().availableActions).toContain("acquire_control");
  });
