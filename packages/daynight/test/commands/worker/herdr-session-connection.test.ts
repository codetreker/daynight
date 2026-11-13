import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { HerdrLifecycleRecord } from "../../../src/commands/worker/herdr/lifecycle-types.js";
import { connectHerdrSession, publishHerdrLedger } from "../../../src/commands/worker/herdr/session-connection.js";
import type { SessionV2Message } from "../../../src/session/v2/types.js";
import { canonicalSessionJson } from "../../../src/session/v2/values.js";
import { createHerdrSessionConnectionFixtures } from "./herdr-session-connection.fixtures.js";
import { ConfigurationAdmissionWaiting } from "../../../src/commands/worker/configuration-admission.js";

type Registration = Extract<SessionV2Message, { type: "registration" }>;
type Ledger = Extract<SessionV2Message, { type: "generation_ledger" }>;

const { uuid, requestFor, stateFor, fixture, stop } = createHerdrSessionConnectionFixtures("memory");

it.each(["support", "current"] as const)("checks first registration admission after awaited %s", async stage => {
  const f = await fixture(); let complete = true;
  if (stage === "support") {
    const verify = f.api.verifySupport;
    f.api.verifySupport = async signal => { await verify(signal); complete = false; };
  } else {
    const current = f.api.current;
    f.api.current = async (...args) => { const result = await current(...args); complete = false; return result; };
  }
  await expect(connectHerdrSession(f.store, f.identity, f.api, undefined, { observe: false, control: false, archive: false }, () => complete)).rejects.toBeInstanceOf(ConfigurationAdmissionWaiting);
  expect(f.registrations).toEqual([]);
  expect(f.store.get(f.identity)).toMatchObject({ connectionEpoch: null, registrationRequest: null });
  complete = true; f.api.verifySupport = async () => {};
  if (stage === "current") f.api.current = async () => ({ status: "not_registered", protocol: "daynight.session.v2", claimId: f.identity.claimId, agentControlMode: "herdr" });
  await connectHerdrSession(f.store, f.identity, f.api, undefined, { observe: false, control: false, archive: false }, () => complete);
  expect(f.registrations).toHaveLength(1);
});

it("keeps pending registration reconciliation and an existing reconnect available when admission closes", async () => {
  const f = await fixture(); f.configure({ loseRegistration: true });
  await connectHerdrSession(f.store, f.identity, f.api);
  f.configure({ loseRegistration: false });
  await connectHerdrSession(f.store, f.identity, f.api, undefined, { observe: false, control: false, archive: false }, () => false);
  expect(f.registrations.map(value => value.payload.mode)).toEqual(["register", "reconnect"]);
  const g = await fixture(); g.configure({ loseRegistration: true, commitRegistration: false });
  await expect(connectHerdrSession(g.store, g.identity, g.api)).rejects.toThrow();
  const original = g.store.get(g.identity)!.registrationRequest;
  await expect(connectHerdrSession(g.store, g.identity, g.api, undefined, { observe: false, control: false, archive: false }, () => false)).rejects.not.toBeInstanceOf(ConfigurationAdmissionWaiting);
  expect(g.registrations).toHaveLength(1);
  expect(g.store.get(g.identity)!.registrationRequest).toEqual(original);
});

it("commits the exact registration before its first HTTP write", async () => {
    const f = await fixture(); let persisted: Registration | null = null;
    f.configure({ beforeRegistration: () => { persisted = f.store.get(f.identity)!.registrationRequest; } });
    await connectHerdrSession(f.store, f.identity, f.api);
    expect(persisted).toEqual(f.registrations[0]); expect(f.registrations).toHaveLength(1);
    expect(f.store.get(f.identity)).toMatchObject({ connectionEpoch: "1", registrationRequest: null });
  });

it("reconciles a lost registration response without posting it again", async () => {
    const f = await fixture(); f.configure({ loseRegistration: true });
    await connectHerdrSession(f.store, f.identity, f.api);
    expect(f.registrations).toHaveLength(1); expect(f.store.get(f.identity)!.connectionEpoch).toBe("1");
  });

it("only reads back a registration persisted before a crash", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.registrationRequest = requestFor(draft); }); f.state = stateFor(f.record);
    await connectHerdrSession(f.store, f.identity, f.api);
    expect(f.registrations).toHaveLength(0); expect(f.store.get(f.identity)!.connectionEpoch).toBe("1");
  });

it("retains unknown registration when no matching result is observable", async () => {
    const f = await fixture(); f.configure({ loseRegistration: true, commitRegistration: false });
    await expect(connectHerdrSession(f.store, f.identity, f.api)).rejects.toThrow();
    await expect(connectHerdrSession(f.store, f.identity, f.api)).rejects.toThrow();
    expect(f.registrations).toHaveLength(1); expect(f.store.get(f.identity)!.registrationRequest).not.toBeNull();
  });

it("rejects an observed epoch which cannot confirm the pending registration", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.registrationRequest = requestFor(draft); }); f.state = stateFor(f.record, "2");
    await expect(connectHerdrSession(f.store, f.identity, f.api)).rejects.toThrow();
    expect(f.registrations).toHaveLength(0); expect(f.store.get(f.identity)!.connectionEpoch).toBeNull();
  });

it("reconnects the service generation before granting the locally prepared successor", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.connectionEpoch = "1"; }); const stopped = stop(f); f.state = stateFor(stopped);
    f.store.update(stopped, draft => { const next = structuredClone(f.record.runs[0]!); next.run.executionGeneration = "2"; next.run.startedAt = "2026-11-04T00:01:00.000Z"; next.run.binding.instanceId = "daemon-two"; next.run.binding.terminalId = "terminal-two"; draft.runs.push(next); });
    await connectHerdrSession(f.store, f.identity, f.api); await publishHerdrLedger(f.store, f.identity, f.api);
    expect(f.registrations[0]).toMatchObject({ executionGeneration: "1", payload: { mode: "reconnect", connectionEpoch: "1", binding: stopped.runs[0]!.run.binding } });
    expect(f.ledgers[0]!.executionGeneration).toBe("2"); expect(f.epochs).toEqual(["2"]);
  });

it("submits a stopped ledger on the original epoch without registering again", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.connectionEpoch = "3"; }); f.state = stateFor(f.record, "3"); stop(f);
    await publishHerdrLedger(f.store, f.identity, f.api);
    expect(f.registrations).toHaveLength(0); expect(f.epochs).toEqual(["3"]); expect(f.state!.ledger.runs[0]!.stopProof).not.toBeNull();
    expect(f.store.get(f.identity)!.publishedLedgerHash).toBe(createHash("sha256").update(canonicalSessionJson(f.state!.ledger)).digest("hex"));
  });

it("confirms a lost ledger response only by the complete original fence and ledger", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.connectionEpoch = "1"; }); f.state = stateFor(f.record); stop(f); f.configure({ loseLedger: true });
    await publishHerdrLedger(f.store, f.identity, f.api);
    expect(f.ledgers).toHaveLength(1);
    expect(f.store.get(f.identity)!.publishedLedgerHash).toBe(createHash("sha256").update(canonicalSessionJson(f.state!.ledger)).digest("hex"));
    await publishHerdrLedger(f.store, f.identity, f.api); expect(f.ledgers).toHaveLength(1);
  });

it("retains publication responsibility after a stopped ledger write is unconfirmed", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.connectionEpoch = "1"; }); f.state = stateFor(f.record); stop(f); f.configure({ loseLedger: true, commitLedger: false });
    await expect(publishHerdrLedger(f.store, f.identity, f.api)).rejects.toThrow();
    expect(f.store.get(f.identity)!.publishedLedgerHash).toBeNull();
    await expect(publishHerdrLedger(f.store, f.identity, f.api)).rejects.toThrow();
    expect(f.ledgers).toHaveLength(1);
    f.state = stateFor(f.store.get(f.identity)!); await publishHerdrLedger(f.store, f.identity, f.api);
    expect(f.ledgers).toHaveLength(1);
    expect(f.store.get(f.identity)!.publishedLedgerHash).toBe(createHash("sha256").update(canonicalSessionJson(f.state!.ledger)).digest("hex"));
  });

it("publishes a deleted task's first stopped ledger after a definitive state 404", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.connectionEpoch = "3"; }); f.state = stateFor(f.record, "3"); stop(f);
    let persisted: HerdrLifecycleRecord["ledgerRequest"] | undefined;
    f.configure({ stateStatus: 404, beforeLedger: () => { persisted = f.store.get(f.identity)!.ledgerRequest; } });
    await publishHerdrLedger(f.store, f.identity, f.api);
    expect(persisted).toEqual({ message: f.ledgers[0], connectionEpoch: "3" });
    expect(f.store.get(f.identity)!.ledgerRequest).toBeNull();
    expect(f.store.get(f.identity)!.publishedLedgerHash).toBe(createHash("sha256").update(canonicalSessionJson(f.state!.ledger)).digest("hex"));
    await publishHerdrLedger(f.store, f.identity, f.api); expect(f.ledgers).toHaveLength(1); expect(f.registrations).toHaveLength(0);
  });

it("never bypasses an unavailable state read for an unstopped run or non-404 failure", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.connectionEpoch = "1"; }); f.state = stateFor(f.record); f.configure({ stateStatus: 404 });
    await expect(publishHerdrLedger(f.store, f.identity, f.api)).rejects.toThrow(); expect(f.ledgers).toHaveLength(0);
    stop(f); f.configure({ stateStatus: 503 });
    await expect(publishHerdrLedger(f.store, f.identity, f.api)).rejects.toThrow(); expect(f.ledgers).toHaveLength(0);
    expect(f.store.get(f.identity)!.ledgerRequest).toBeNull();
  });

it("reconciles an earlier pending ledger before publishing a subsequently confirmed stop", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.connectionEpoch = "1"; }); f.state = { ...stateFor(f.record), ledger: { runs: [], finalizationId: null } };
    f.configure({ loseLedger: true, beforeLedger: () => { f.configure({ stateStatus: 503 }); } });
    await expect(publishHerdrLedger(f.store, f.identity, f.api)).rejects.toThrow();
    expect(f.ledgers).toHaveLength(1); expect(f.ledgers[0]!.payload.runs[0]!.stopProof).toBeNull();
    stop(f);
    f.configure({ stateStatus: 0, loseLedger: false, beforeLedger: () => {} });
    await publishHerdrLedger(f.store, f.identity, f.api);
    expect(f.ledgers).toHaveLength(2); expect(f.ledgers[1]!.payload.runs[0]!.stopProof).not.toBeNull();
    expect(f.store.get(f.identity)!.ledgerRequest).toBeNull();
    expect(f.store.get(f.identity)!.publishedLedgerHash).toBe(createHash("sha256").update(canonicalSessionJson(f.state!.ledger)).digest("hex"));
  });

it("rejects a finalized or conflicting service ledger without another write", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.connectionEpoch = "1"; }); const stopped = stop(f); f.state = { ...stateFor(stopped), ledger: { runs: stopped.runs.map(r => r.run), finalizationId: uuid(30) } };
    await expect(publishHerdrLedger(f.store, f.identity, f.api)).rejects.toThrow(); expect(f.ledgers).toHaveLength(0);
    f.state = stateFor(stopped, "2"); await expect(publishHerdrLedger(f.store, f.identity, f.api)).rejects.toThrow(); expect(f.ledgers).toHaveLength(0);
  });

it("persists combined recording capability intent and reconciles its original connection", async () => {
  const f = await fixture();
  const capabilities = { observe: true, control: true, archive: true };
  await connectHerdrSession(f.store, f.identity, f.api, undefined, capabilities);
  expect(f.registrations[0]!.payload.capabilities).toEqual(capabilities);
  f.state = { ...f.state!, capabilities };
  await connectHerdrSession(f.store, f.identity, f.api, undefined, capabilities);
  expect(f.registrations[1]!.payload.capabilities).toEqual(capabilities);
  expect(f.store.get(f.identity)!.connectionEpoch).toBe("2");
});
