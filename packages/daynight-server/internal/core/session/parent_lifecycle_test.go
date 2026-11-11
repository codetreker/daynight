package session

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
)

func TestDeletedParentRetainsTerminalStopAndFinalization(t *testing.T) {
	f, m, run, rid := terminalRunFixture(t, true)
	f.data.TaskDeleted = true
	ctx := context.Background()
	if _, err := terminalStateStep(t, f, func() (map[string]any, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTask": 1}, func(phase context.Context) (map[string]any, error) {
			return f.s.TerminalState(phase, f.p, f.project, f.task, m.SessionID)
		})
	}); err == nil {
		t.Fatal("hidden task exposed terminal state")
	}
	run = stopTerminalRun(t, f, m, run)
	final := m
	final.Type = "finalization"
	final.Payload = v2.Finalization{FinalizationID: uuid.NewString(), ClaimTerminal: true, Runs: []v2.Run{run}}
	if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.FinalizeTerminal(phase, f.p, f.project, f.task, m.SessionID, "1", final)
		})
	}); err == nil {
		t.Fatal("finalization without closed evidence")
	}
	evidence := zeroEvidence(m, rid)
	if _, err := terminalRecordingStep(t, f, evidence, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "TerminalRecordingEvidence": 1, "InsertRecordingEvidence": 1, "SaveTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", evidence)
		})
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "SaveTerminal": 1, "InvalidateTerminalOperations": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.FinalizeTerminal(phase, f.p, f.project, f.task, m.SessionID, "1", final)
		})
	}); err != nil {
		t.Fatalf("original owner cannot finalize stopped run: %v", err)
	}
}

func TestDeletedTaskAllowsWebArchiveWithoutRetiringClaim(t *testing.T) {
	f := setup(t)
	r := &record{Snapshot: sp.Snapshot{Lifecycle: "active", ControllerFence: sp.ControllerFence{Fence: sp.Fence{ClaimID: f.r.ClaimID}}}}
	live := task{Status: "in_progress", Worker: f.data.Task.Worker}
	if err := archiveStopped(r, live); err == nil {
		t.Fatal("live execution allowed to archive")
	}
	live.Deleted = true
	if active(live, r) {
		t.Fatal("hidden task remains active")
	}
	if err := archiveStopped(r, live); err != nil {
		t.Fatalf("hidden task cannot finish archive: %v", err)
	}
}

func TestGoalSessionQueriesDoNotLookupExecution(t *testing.T) {
	f := setup(t)
	f.data.Task.Type = model.TaskTypeGoal
	ctx := context.Background()
	result, err := withinRecordingPhase(f, ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1}, func(phase context.Context) (map[string]any, error) {
		return f.s.Current(phase, f.p, f.project, f.task)
	})
	if err != nil || result["status"] != "not_applicable" {
		t.Fatalf("goal current: %v %v", result, err)
	}
	page, err := withinRecordingPhase(f, ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1}, func(phase context.Context) (map[string]any, error) {
		return f.s.TerminalHistory(phase, f.p, f.project, f.task, "", 10)
	})
	if err != nil || len(page["items"].([]map[string]any)) != 0 {
		t.Fatalf("goal history: %v %v", page, err)
	}
}

func TestDeletedParentRetainsUncommittedFirstTerminalLedger(t *testing.T) {
	f, m := terminalFixture(t)
	ctx := context.Background()
	if _, err := terminalRegistrationStep(t, f, m.SessionID, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTaskRegistration": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1, "InsertTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.RegisterTerminal(phase, f.p, f.project, f.task, m)
		})
	}); err != nil {
		t.Fatal(err)
	}
	f.data.TaskDeleted = true
	reg := m.Payload.(v2.Registration)
	run := v2.Run{ExecutionGeneration: "1", Owner: reg.Owner, Binding: reg.Binding, StartedAt: "2026-01-01T00:00:00Z", SegmentIDs: []string{}}
	write := func(ledger v2.Message, save bool) error {
		_, err := terminalRecordStep(t, f, func() (v2.Message, error) {
			work := map[string]int{}
			if save {
				work["SaveTerminal"] = 1
			}
			phase := f.TerminalPhase(ctx, true, work)
			defer f.dao.FinishContext(phase)
			return f.s.UpdateTerminalLedger(phase, f.p, f.project, f.task, m.SessionID, "1", ledger)
		})
		return err
	}
	if err := write(preparedLedger(m, run), false); err == nil {
		t.Fatal("deleted task accepted an unstopped run")
	}
	run = preparedStoppedRun(run)
	if err := write(preparedLedger(m, run), true); err != nil {
		t.Fatalf("original stopped ledger rejected: %v", err)
	}
	extra := run
	extra.ExecutionGeneration = "2"
	proof := *run.StopProof
	proof.ExecutionGeneration = "2"
	extra.StopProof = &proof
	if err := write(preparedLedger(m, run, extra), false); err == nil {
		t.Fatal("deleted task accepted a replacement generation")
	}
	rid := uuid.NewString()
	responsibility := m
	responsibility.Type = "recording_responsibility"
	responsibility.Payload = v2.RecordingResponsibility{ResponsibilityID: rid, RecordingEnabled: false}
	if _, err := terminalRecordingStep(t, f, responsibility, func() (v2.Message, error) {
		phase := f.TerminalPhase(ctx, true, map[string]int{"SaveTerminal": 1})
		defer f.dao.FinishContext(phase)
		return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", responsibility)
	}); err != nil {
		t.Fatalf("recording responsibility rejected: %v", err)
	}
	evidence := zeroEvidence(m, rid)
	if _, err := terminalRecordingStep(t, f, evidence, func() (v2.Message, error) {
		phase := f.TerminalPhase(ctx, true, map[string]int{"TerminalRecordingEvidence": 1, "InsertRecordingEvidence": 1, "SaveTerminal": 1})
		defer f.dao.FinishContext(phase)
		return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", evidence)
	}); err != nil {
		t.Fatalf("closed evidence rejected: %v", err)
	}
	final := m
	final.Type = "finalization"
	final.Payload = v2.Finalization{FinalizationID: uuid.NewString(), ClaimTerminal: true, Runs: []v2.Run{run}}
	if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
		phase := f.TerminalPhase(ctx, true, map[string]int{"SaveTerminal": 1, "InvalidateTerminalOperations": 1})
		defer f.dao.FinishContext(phase)
		return f.s.FinalizeTerminal(phase, f.p, f.project, f.task, m.SessionID, "1", final)
	}); err != nil {
		t.Fatalf("finalization rejected: %v", err)
	}
}

func TestDeletedParentRetainsCurrentLaterGenerationRecording(t *testing.T) {
	f, m := terminalFixture(t)
	ctx := context.Background()
	if _, err := terminalRegistrationStep(t, f, m.SessionID, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTaskRegistration": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1, "InsertTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.RegisterTerminal(phase, f.p, f.project, f.task, m)
		})
	}); err != nil {
		t.Fatal(err)
	}
	reg := m.Payload.(v2.Registration)
	first := preparedStoppedRun(v2.Run{ExecutionGeneration: "1", Owner: reg.Owner, Binding: reg.Binding, StartedAt: "2026-01-01T00:00:00Z", SegmentIDs: []string{}})
	second := preparedStoppedRun(v2.Run{ExecutionGeneration: "2", Owner: reg.Owner, Binding: reg.Binding, StartedAt: "2026-01-01T00:01:00Z", SegmentIDs: []string{}})
	stored := f.terminal.Record(t)
	stored.Envelope.ExecutionGeneration = "2"
	stored.Runs = []v2.Run{first, second}
	f.terminal.SetRecord(t, stored)
	f.data.TaskDeleted = true
	m.ExecutionGeneration = "2"
	m.Type = "recording_responsibility"
	m.Payload = v2.RecordingResponsibility{ResponsibilityID: uuid.NewString(), RecordingEnabled: false}
	if _, err := terminalRecordingStep(t, f, m, func() (v2.Message, error) {
		phase := f.TerminalPhase(ctx, true, map[string]int{"SaveTerminal": 1})
		defer f.dao.FinishContext(phase)
		return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", m)
	}); err != nil {
		t.Fatalf("current generation responsibility rejected: %v", err)
	}
}

func TestDeletedParentRetainsStoppedUncommittedRecoveryGeneration(t *testing.T) {
	f, m, first, _ := terminalRunFixture(t, true)
	native := "native-session"
	first.Binding.NativeSessionID = &native
	first = stopTerminalRun(t, f, m, first)
	f.data.TaskDeleted = true
	next := v2.Run{ExecutionGeneration: "2", Owner: first.Owner, Binding: first.StopProof.Binding, StartedAt: "2026-01-01T00:02:00Z", SegmentIDs: []string{}}
	ctx := context.Background()
	submit := func(run v2.Run, save bool) error {
		ledger := preparedLedger(m, first, run)
		_, err := terminalRecordStep(t, f, func() (v2.Message, error) {
			work := map[string]int{}
			if save {
				work = map[string]int{"SaveTerminal": 1, "InvalidateTerminalOperations": 1}
			}
			phase := f.TerminalPhase(ctx, true, work)
			defer f.dao.FinishContext(phase)
			return f.s.UpdateTerminalLedger(phase, f.p, f.project, f.task, m.SessionID, "1", ledger)
		})
		return err
	}
	if err := submit(next, false); err == nil {
		t.Fatal("deleted task accepted an active recovery run")
	}
	next = preparedStoppedRun(next)
	if err := submit(next, true); err != nil {
		t.Fatalf("stopped recovery ledger rejected: %v", err)
	}
	r := f.terminal.Record(t)
	if len(r.Runs) != 2 || r.Runs[1].StopProof == nil || r.Envelope.ExecutionGeneration != "2" {
		t.Fatalf("stopped generation not retained: %+v", r)
	}
}
