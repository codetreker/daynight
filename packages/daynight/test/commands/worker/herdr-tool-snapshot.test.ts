import { expect, test } from "vitest";
import { recordedHerdrTool as launch, recordedHerdrTools as tools } from "./herdr-tool-snapshot.fixtures.js";
import { createHerdrLifecycleStoreFixtures } from "./herdr-lifecycle-store.fixtures.js";

const { fixture, identity, prepared } = createHerdrLifecycleStoreFixtures("file");

test("persists both frozen launches through preparation and rejects changing their original selection", () => {
  const f = fixture(), launches = tools();
  let record = f.store.update(f.record, draft => { draft.preparation = { instanceId: "daemon-one", instanceDirectory: f.directory, phase: "prepared", daemon: null, launches }; });
  expect(f.store.get(identity)!.preparation!.launches).toEqual(launches);
  expect(() => f.store.update(record, draft => { draft.preparation!.launches!.herdr = launch("herdr", "B"); })).toThrow(/launch|selection|preparation/i);
  record = f.store.update(record, draft => { draft.runs.push({ ...prepared(f.directory), launches }); draft.preparation = null; });
  expect(f.store.get(identity)!.runs[0]!.launches).toEqual(launches);
  expect(() => f.store.update(record, draft => { draft.runs[0]!.launches!.agent = launch("codex", "B"); })).toThrow(/launch|selection/i);
});

test("cannot clear preparation into a run that changes its frozen daemon or agent", () => {
  const f = fixture(), launches = tools();
  const record = f.store.update(f.record, draft => { draft.preparation = { instanceId: "daemon-one", instanceDirectory: f.directory, phase: "prepared", daemon: null, launches }; });
  expect(() => f.store.update(record, draft => { draft.runs.push({ ...prepared(f.directory), launches: { ...launches, agent: launch("codex", "B") } }); draft.preparation = null; })).toThrow(/launch|selection|preparation/i);
  expect(f.store.get(identity)).toEqual(record);
});


test("does not backfill a historical run with the current tool selection", () => {
  const f = fixture();
  const record = f.store.update(f.record, draft => { draft.runs.push(prepared(f.directory)); });
  expect(() => f.store.update(record, draft => { draft.runs[0]!.launches = tools(); })).toThrow(/launch|selection/i);
  expect(f.store.get(identity)!.runs[0]!.launches).toBeUndefined();
});
