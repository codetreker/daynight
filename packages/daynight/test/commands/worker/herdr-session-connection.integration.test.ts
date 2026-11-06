import path from "node:path";
import { expect, it } from "vitest";
import { openHerdrLifecycleStore } from "../../../src/commands/worker/herdr/lifecycle-store.js";
import { connectHerdrSession, publishHerdrLedger } from "../../../src/commands/worker/herdr/session-connection.js";
import type { SessionV2Message } from "../../../src/session/v2/types.js";
import { createHerdrSessionConnectionFixtures } from "./herdr-session-connection.fixtures.js";

type Registration = Extract<SessionV2Message, { type: "registration" }>;
type Ledger = Extract<SessionV2Message, { type: "generation_ledger" }>;

const { uuid, stores, base, stateFor, fixture, stop } = createHerdrSessionConnectionFixtures("file");

it.each(["withdrawn", "replaced"])("recovers the original reconnect after its claim is %s before publishing the stop", async claimState => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.connectionEpoch = "1"; }); f.state = stateFor(f.record);
    f.configure({ loseRegistration: true, beforeRegistration: () => { f.configure({ stateStatus: 503 }); } });
    await expect(connectHerdrSession(f.store, f.identity, f.api)).rejects.toThrow();
    const pending = f.store.get(f.identity)!.registrationRequest;
    expect(pending).toMatchObject({ sessionId: f.record.sessionId, claimId: f.identity.claimId, payload: { mode: "reconnect", connectionEpoch: "1" } });
    expect(f.state!.connectionEpoch).toBe("2");
    f.configure({ stateStatus: 0, currentResponse: claimState === "withdrawn"
      ? { status: "not_applicable", protocol: "daynight.session.v2" }
      : { ...stateFor(f.record), sessionId: uuid(99), claimId: uuid(98) } });
    const stopped = stop(f);
    const reopened = openHerdrLifecycleStore(path.join(f.record.cwd, "journal.sqlite")); stores.push(reopened);
    expect(reopened.get(f.identity)!.registrationRequest).toEqual(pending);
    f.reads.length = 0;
    await publishHerdrLedger(reopened, f.identity, f.api);
    expect(f.registrations).toHaveLength(1); expect(f.epochs).toEqual(["2"]);
    expect(f.ledgers).toEqual([{ ...base(stopped), type: "generation_ledger", payload: { runs: stopped.runs.map(run => run.run), finalizationId: null } }]);
    expect(reopened.get(f.identity)).toMatchObject({ connectionEpoch: "2", registrationRequest: null, ledgerRequest: null });
    expect(reopened.get(f.identity)!.publishedLedgerHash).not.toBeNull();
    expect(f.reads.length).toBeGreaterThan(0);
    expect(f.reads.every(url => url.endsWith(`/${f.record.sessionId}/state`))).toBe(true);
  });

it("does not replay an unknown stopped publication when deleted task readback remains 404", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.connectionEpoch = "1"; }); f.state = stateFor(f.record); stop(f); f.configure({ stateStatus: 404, loseLedger: true });
    await expect(publishHerdrLedger(f.store, f.identity, f.api)).rejects.toThrow();
    const pending = f.store.get(f.identity)!.ledgerRequest; expect(pending).not.toBeNull();
    const reopened = openHerdrLifecycleStore(path.join(f.record.cwd, "journal.sqlite")); stores.push(reopened);
    await expect(publishHerdrLedger(reopened, f.identity, f.api)).rejects.toThrow();
    await expect(connectHerdrSession(reopened, f.identity, f.api)).rejects.toThrow();
    expect(f.ledgers).toHaveLength(1); expect(f.registrations).toHaveLength(0);
    expect(reopened.get(f.identity)).toMatchObject({ ledgerRequest: pending, publishedLedgerHash: null, connectionEpoch: "1" });
  });
