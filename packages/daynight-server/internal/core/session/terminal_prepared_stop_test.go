package session

import (
	"bytes"
	"context"
	"reflect"
	"testing"

	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
)

func preparedStoppedRun(run v2.Run) v2.Run {
	stopped := run.StartedAt
	run.StoppedAt = &stopped
	run.StopProof = &v2.StopProof{RecordID: uuid.NewString(), ExecutionGeneration: run.ExecutionGeneration, Binding: run.Binding, BootID: "boot", StoppedAt: stopped, Method: "instances_exited", TerminalStopped: true, NativeLaunch: "not_submitted", Daemon: &v2.PreparedDaemonProof{PID: 2, BirthToken: "daemon-birth", BootID: "boot"}, Processes: []v2.ProcessProof{{Role: "shell", PID: 1, BirthToken: "shell-birth", BootID: "boot"}}}
	return run
}

func preparedLedger(m v2.Message, runs ...v2.Run) v2.Message {
	m.Type = "generation_ledger"
	m.ExecutionGeneration = runs[len(runs)-1].ExecutionGeneration
	m.Payload = v2.GenerationLedger{Runs: runs}
	return m
}

func preparedTerminalRecord(t *testing.T, f fixture, id string) *terminalRecord {
	t.Helper()
	r := f.terminal.Record(t)
	if r.Envelope.SessionID != id {
		t.Fatalf("terminal fixture returned %q for %q", r.Envelope.SessionID, id)
	}
	return r
}

func TestTerminalPreparedStopRejectsRecordingConflictsInEitherOrder(t *testing.T) {
	for _, order := range []string{"evidence first", "proof first"} {
		for _, registered := range []string{"0", "1"} {
			t.Run(order+" registered="+registered, func(t *testing.T) {
				f, m, run, rid := terminalRunFixture(t, true)
				ctx := context.Background()
				ledger := preparedLedger(m, preparedStoppedRun(run))
				evidence := zeroEvidence(m, rid)
				payload := evidence.Payload.(v2.RecordingEvidence)
				payload.Closed = false
				payload.SelectedFrameCount = "1"
				payload.RegisteredFrameCount = registered
				evidence.Payload = payload
				writeProof := func() error {
					_, err := terminalRecordStep(t, f, func() (v2.Message, error) {
						work := map[string]int{}
						if order == "proof first" {
							work["SaveTerminal"] = 1
						}
						ctx := f.TerminalPhase(ctx, true, work)
						defer f.dao.FinishContext(ctx)
						return f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", ledger)
					})
					return err
				}
				writeEvidence := func() error {
					_, err := terminalRecordingStep(t, f, evidence, func() (v2.Message, error) {
						work := map[string]int{}
						if order == "evidence first" {
							work = map[string]int{"TerminalRecordingEvidence": 1, "InsertRecordingEvidence": 1, "SaveTerminal": 1}
						}
						ctx := f.TerminalPhase(ctx, true, work)
						defer f.dao.FinishContext(ctx)
						return f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", evidence)
					})
					return err
				}
				first, second := writeProof, writeEvidence
				if order == "evidence first" {
					first, second = writeEvidence, writeProof
				}
				if err := first(); err != nil {
					t.Fatal("first valid write rejected", err)
				}
				before := preparedTerminalRecord(t, f, m.SessionID)
				if err := second(); err == nil {
					t.Fatal("conflicting proof and sampling evidence both accepted")
				}
				if f.terminal.ProposedRaw != nil || !reflect.DeepEqual(before, preparedTerminalRecord(t, f, m.SessionID)) {
					t.Fatal("rejected write changed or proposed replacement state")
				}
				r := preparedTerminalRecord(t, f, m.SessionID)
				if r.Runs[0].StopProof != nil && r.Recording["1"].Evidence != nil {
					t.Fatal("contradictory proof and evidence were written")
				}
			})
		}
	}
}

func TestTerminalPreparedStopRejectsObservedContentAndFrozenContradictions(t *testing.T) {
	for _, stage := range []string{"ledger", "finalization"} {
		for _, kind := range []string{"observed content", "selected count", "registered count"} {
			t.Run(stage+" "+kind, func(t *testing.T) {
				f, m, run, rid := terminalRunFixture(t, true)
				ctx := context.Background()
				run = preparedStoppedRun(run)
				if stage == "finalization" {
					if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
						ctx := f.TerminalPhase(ctx, true, map[string]int{"SaveTerminal": 1})
						defer f.dao.FinishContext(ctx)
						return f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", preparedLedger(m, run))
					}); err != nil {
						t.Fatal(err)
					}
					evidence := zeroEvidence(m, rid)
					if _, err := terminalRecordingStep(t, f, evidence, func() (v2.Message, error) {
						ctx := f.TerminalPhase(ctx, true, map[string]int{"TerminalRecordingEvidence": 1, "InsertRecordingEvidence": 1, "SaveTerminal": 1})
						defer f.dao.FinishContext(ctx)
						return f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", evidence)
					}); err != nil {
						t.Fatal(err)
					}
					archiveTerminal(t, f)
				}
				r := preparedTerminalRecord(t, f, m.SessionID)
				rec := r.Recording["1"]
				if rec.Evidence == nil {
					e := zeroEvidence(m, rid).Payload.(v2.RecordingEvidence)
					e.Closed = false
					rec.Evidence = &e
				}
				switch kind {
				case "observed content":
					rec.ObservedContent = true
				case "selected count":
					rec.Evidence.SelectedFrameCount = "1"
				case "registered count":
					rec.Evidence.RegisteredFrameCount = "1"
				}
				r.Recording["1"] = rec
				f.terminal.SetRecord(t, r)
				before := preparedTerminalRecord(t, f, m.SessionID)
				var err error
				if stage == "ledger" {
					_, err = terminalRecordStep(t, f, func() (v2.Message, error) {
						ctx := f.TerminalPhase(ctx, true, map[string]int{})
						defer f.dao.FinishContext(ctx)
						return f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", preparedLedger(m, run))
					})
				} else {
					final := m
					final.Type = "finalization"
					final.Payload = v2.Finalization{FinalizationID: uuid.NewString(), ClaimTerminal: true, Runs: []v2.Run{run}}
					_, err = terminalRecordStep(t, f, func() (v2.Message, error) {
						ctx := f.TerminalPhase(ctx, true, map[string]int{})
						defer f.dao.FinishContext(ctx)
						return f.s.FinalizeTerminal(ctx, f.p, f.project, f.task, m.SessionID, "1", final)
					})
				}
				if err == nil {
					t.Fatal("prepared proof accepted conflicting recording evidence")
				}
				if !reflect.DeepEqual(before, preparedTerminalRecord(t, f, m.SessionID)) {
					t.Fatal("rejected decision changed original state")
				}
			})
		}
	}
}

func TestTerminalPreparedStopKeepsZeroFrameFailureAndUnavailableDistinct(t *testing.T) {
	for _, captureFailed := range []bool{false, true} {
		t.Run(map[bool]string{false: "unavailable", true: "capture failed"}[captureFailed], func(t *testing.T) {
			f, m, run, rid := terminalRunFixture(t, true)
			ctx := context.Background()
			run = preparedStoppedRun(run)
			if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
				ctx := f.TerminalPhase(ctx, true, map[string]int{"SaveTerminal": 1})
				defer f.dao.FinishContext(ctx)
				return f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", preparedLedger(m, run))
			}); err != nil {
				t.Fatal(err)
			}
			evidence := zeroEvidence(m, rid)
			if captureFailed {
				p := evidence.Payload.(v2.RecordingEvidence)
				code := "source_corrupt"
				p.CaptureError = &code
				evidence.Payload = p
			}
			if _, err := terminalRecordingStep(t, f, evidence, func() (v2.Message, error) {
				ctx := f.TerminalPhase(ctx, true, map[string]int{"TerminalRecordingEvidence": 1, "InsertRecordingEvidence": 1, "SaveTerminal": 1})
				defer f.dao.FinishContext(ctx)
				return f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", evidence)
			}); err != nil {
				t.Fatal(err)
			}
			archiveTerminal(t, f)
			final := m
			final.Type = "finalization"
			final.Payload = v2.Finalization{FinalizationID: uuid.NewString(), ClaimTerminal: true, Runs: []v2.Run{run}}
			frozen, err := terminalRecordStep(t, f, func() (v2.Message, error) {
				ctx := f.TerminalPhase(ctx, true, map[string]int{"InvalidateTerminalOperations": 1, "SaveTerminal": 1})
				defer f.dao.FinishContext(ctx)
				return f.s.FinalizeTerminal(ctx, f.p, f.project, f.task, m.SessionID, "1", final)
			})
			if err != nil {
				t.Fatal(err)
			}
			reason := "ended_before_first_sample"
			receipt, err := terminalReceipt(&terminalRecord{Envelope: m.Envelope}, v2.Receipt{FinalizationID: *frozen.Payload.(v2.GenerationLedger).FinalizationID, Disposition: "unavailable", Reason: &reason, Evidence: &v2.NoRecordingEvidence{RecordingEnabled: true, SelectedFrameCount: "0", RegisteredFrameCount: "0"}})
			if err != nil {
				t.Fatal(err)
			}
			archiveCalls := map[string]int{"TerminalArchive": 1}
			if !captureFailed {
				archiveCalls["SaveTerminalReceipt"] = 1
			}
			archiveCtx := f.TerminalPhase(ctx, true, archiveCalls)
			got, err := f.s.UpdateTerminalArchive(archiveCtx, f.p, f.project, f.task, m.SessionID, receipt)
			f.dao.FinishContext(archiveCtx)
			if captureFailed {
				if err == nil {
					t.Fatal("capture failure became unavailable")
				}
				return
			}
			if err != nil || !reflect.DeepEqual(receipt, got) {
				t.Fatal("valid prepared unavailable receipt", got, err)
			}
			selectUnavailableTerminalReceipt(t, f, got)
			f.data.Task.Worker.ClaimID = uuid.NewString()
			restarted := New(f.writer)
			restarted.Origin = f.s.Origin
			statusCtx := f.TerminalPhase(ctx, true, map[string]int{"TerminalArchive": 1})
			status, err := restarted.TerminalArchiveStatus(statusCtx, f.p, f.project, f.task, m.SessionID)
			f.dao.FinishContext(statusCtx)
			if err != nil || status.Payload.(v2.ArchiveStatus).State != "unavailable" {
				t.Fatal("fixed unavailable history lost after reclaim", status, err)
			}
		})
	}
}

func TestTerminalPreparedStopCannotGrantAnotherNativeGeneration(t *testing.T) {
	for _, persistFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "combined stop and grant", true: "persisted stop"}[persistFirst], func(t *testing.T) {
			f, m, run, _ := terminalRunFixture(t, true)
			ctx := context.Background()
			native := "known-native-conversation"
			run.Binding.NativeSessionID = &native
			if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
				ctx := f.TerminalPhase(ctx, true, map[string]int{"SaveTerminal": 1})
				defer f.dao.FinishContext(ctx)
				return f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", preparedLedger(m, run))
			}); err != nil {
				t.Fatal(err)
			}
			stopped := preparedStoppedRun(run)
			if persistFirst {
				if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
					ctx := f.TerminalPhase(ctx, true, map[string]int{"SaveTerminal": 1})
					defer f.dao.FinishContext(ctx)
					return f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", preparedLedger(m, stopped))
				}); err != nil {
					t.Fatal(err)
				}
			}
			nextRun := run
			nextRun.ExecutionGeneration = "2"
			nextRun.Binding.TerminalID = "next-terminal"
			before := preparedTerminalRecord(t, f, m.SessionID)
			if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
				ctx := f.TerminalPhase(ctx, true, map[string]int{})
				defer f.dao.FinishContext(ctx)
				return f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", preparedLedger(m, stopped, nextRun))
			}); err == nil {
				t.Fatal("prepared resource stop granted native conversation recovery")
			}
			if !reflect.DeepEqual(before, preparedTerminalRecord(t, f, m.SessionID)) {
				t.Fatal("refused generation grant changed original ledger")
			}
		})
	}
}

func TestTerminalPreparedStopCannotConsumeNativeAutomationRecovery(t *testing.T) {
	f, prepare := recoveryFixture(t)
	ctx := context.Background()
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{"TerminalAutomationAllowed": 1, "TerminalInputPending": 1, "SaveTerminal": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.UpdateTerminalRecovery(ctx, f.p, f.project, f.task, prepare.SessionID, "1", prepare)
	}); err != nil {
		t.Fatal(err)
	}
	consume := advanceRecoveryGeneration(t, f, prepare)
	r := preparedTerminalRecord(t, f.fixture, prepare.SessionID)
	old := r.Runs[0]
	r.Runs[0] = preparedStoppedRun(old)
	r.Runs[0].SegmentIDs = []string{}
	r.Runs[0].StopProof.RecordID = prepare.Payload.(v2.AutomationRecoveryPrepare).StopOperationID
	f.terminal.SetRecord(t, r)
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{"TerminalAutomationAllowed": 1, "TerminalInputPending": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.UpdateTerminalRecovery(ctx, f.p, f.project, f.task, prepare.SessionID, "2", consume)
	}); err == nil {
		t.Fatal("prepared proof consumed native automation recovery")
	}
	state, err := terminalStateStep(t, f.fixture, func() (map[string]any, error) {
		ctx := f.fixture.TerminalPhase(ctx, false, map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.TerminalState(ctx, f.p, f.project, f.task, prepare.SessionID)
	})
	if err != nil || state["control"].(*v2.ControlState).State != "suspended" {
		t.Fatal("refused recovery changed suspended control", state, err)
	}
	permit, err := terminalRecoveryRead(t, f.fixture, ctx, prepare.SessionID, prepare.Payload.(v2.AutomationRecoveryPrepare).RecoveryID)
	if err != nil || permit.Payload.(v2.AutomationRecoveryState).Consumed != nil {
		t.Fatal("refused recovery consumed original permit", permit, err)
	}
}

func TestTerminalPreparedStopAfterRecordedRunPreservesFixedArchive(t *testing.T) {
	native := "original-native-conversation"
	f, m, doc := terminalArchiveFixtureWithNative(t, &native)
	ctx := context.Background()
	run := v2.Run{ExecutionGeneration: "2", Owner: doc.Owner, Binding: doc.Runs[0].Binding, StartedAt: doc.EndedAt, SegmentIDs: []string{}}
	run.Binding.InstanceID = "prepared-second-instance"
	run.Binding.TerminalID = "prepared-second-terminal"
	if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
		ctx := f.TerminalPhase(ctx, true, map[string]int{"SaveTerminal": 1, "InvalidateTerminalOperations": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", preparedLedger(m, doc.Runs[0], run))
	}); err != nil {
		t.Fatal("ordinary stop must still grant next generation", err)
	}
	m.ExecutionGeneration = "2"
	rid := uuid.NewString()
	responsibility := m
	responsibility.Type = "recording_responsibility"
	responsibility.Payload = v2.RecordingResponsibility{ResponsibilityID: rid, RecordingEnabled: true}
	if _, err := terminalRecordingStep(t, f, responsibility, func() (v2.Message, error) {
		ctx := f.TerminalPhase(ctx, true, map[string]int{"SaveTerminal": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", responsibility)
	}); err != nil {
		t.Fatal(err)
	}
	run = preparedStoppedRun(run)
	if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
		ctx := f.TerminalPhase(ctx, true, map[string]int{"SaveTerminal": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", preparedLedger(m, doc.Runs[0], run))
	}); err != nil {
		t.Fatal("prior generation frames must not reject current prepared proof", err)
	}
	evidence := zeroEvidence(m, rid)
	if _, err := terminalRecordingStep(t, f, evidence, func() (v2.Message, error) {
		ctx := f.TerminalPhase(ctx, true, map[string]int{"TerminalRecordingEvidence": 1, "InsertRecordingEvidence": 1, "SaveTerminal": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", evidence)
	}); err != nil {
		t.Fatal(err)
	}
	doc.ExecutionGeneration = "2"
	doc.Runs = append(doc.Runs, run)
	doc.Completeness = "partial"
	doc.Gaps = []v2.Gap{{Boundary: &v2.BoundaryGap{Kind: "boundary", Reason: "restart", From: v2.BoundaryEndpoint{ExecutionGeneration: "1", SegmentID: &doc.Runs[0].SegmentIDs[0]}, To: v2.BoundaryEndpoint{ExecutionGeneration: "2"}}}}
	doc.UnavailableRuns = []v2.UnavailableRun{{ExecutionGeneration: "2", Reason: "ended_before_first_sample", Evidence: v2.NoRecordingEvidence{RecordingEnabled: true, SelectedFrameCount: "0", RegisteredFrameCount: "0"}}}
	finalizeFixture(t, f, m, doc)
	data := encode(doc)
	uploadCtx := f.TerminalPhase(ctx, true, map[string]int{"ReadCredential": 1, "ProjectAccess": 2, "ArchiveMetadata": 1, "TerminalArchive": 1, "SaveTerminalReceipt": 1})
	receipt, err := f.s.PutTerminalArchive(uploadCtx, f.p, f.project, f.task, m.SessionID, data)
	f.dao.FinishContext(uploadCtx)
	if err != nil || receipt.Payload.(v2.Receipt).Disposition != "ready" {
		t.Fatal("mixed prepared archive rejected", receipt, err)
	}
	selectTerminalArchiveReadback(t, f, m.SessionID, data, receipt.Payload.(v2.Receipt))
	f.data.Task.Worker.ClaimID = uuid.NewString()
	restarted := New(f.writer, f.s.files)
	restarted.Origin = f.s.Origin
	readCtx := f.TerminalPhase(ctx, false, map[string]int{"ReadCredential": 1, "ProjectAccess": 2, "ArchiveMetadata": 1, "TerminalArchive": 1})
	got, err := restarted.TerminalArchiveContent(readCtx, f.p, f.project, f.task, m.SessionID)
	f.dao.FinishContext(readCtx)
	if err != nil || !bytes.Equal(got.Data, data) {
		t.Fatal("fixed mixed archive changed after reclaim", err)
	}
	decoded, err := v2.DecodeArchive(got.Data)
	if err != nil || len(decoded.Files) != 1 || len(decoded.UnavailableRuns) != 1 || *decoded.Runs[1].Binding.NativeSessionID != native || decoded.Runs[1].StopProof.NativeLaunch != "not_submitted" {
		t.Fatal("mixed archive lost original native or recording history", err)
	}
	if err := got.Close(); err != nil {
		t.Fatal(err)
	}
}
