package sessionrelay

import (
	"bytes"
	"context"
	"reflect"
	"sync"
	"testing"

	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
	var r *terminalRecord
	if err := f.s.transact(context.Background(), func(tx pgx.Tx) error {
		var err error
		r, err = loadTerminal(context.Background(), tx, id)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return r
}

func TestTerminalPreparedStopRejectsRecordingConflictsInEitherOrder(t *testing.T) {
	for _, order := range []string{"evidence first", "proof first", "concurrent"} {
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
					_, err := f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", ledger)
					return err
				}
				writeEvidence := func() error {
					_, err := f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", evidence)
					return err
				}
				if order == "concurrent" {
					start := make(chan struct{})
					var wg sync.WaitGroup
					var proofErr, evidenceErr error
					wg.Add(2)
					go func() { defer wg.Done(); <-start; proofErr = writeProof() }()
					go func() { defer wg.Done(); <-start; evidenceErr = writeEvidence() }()
					close(start)
					wg.Wait()
					if (proofErr == nil) == (evidenceErr == nil) {
						t.Fatalf("exactly one conflicting write must succeed: proof=%v evidence=%v", proofErr, evidenceErr)
					}
				} else {
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
					if !reflect.DeepEqual(before, preparedTerminalRecord(t, f, m.SessionID)) {
						t.Fatal("rejected write changed original state")
					}
				}
				r := preparedTerminalRecord(t, f, m.SessionID)
				if r.Runs[0].StopProof != nil && r.Recording["1"].Evidence != nil {
					t.Fatal("persisted contradictory proof and evidence")
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
					if _, err := f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", preparedLedger(m, run)); err != nil {
						t.Fatal(err)
					}
					if _, err := f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", zeroEvidence(m, rid)); err != nil {
						t.Fatal(err)
					}
					archiveTerminal(t, f)
				}
				// Seed persisted contradiction to exercise the freeze boundary even if
				// all current incoming write paths already reject it.
				if err := f.s.transact(ctx, func(tx pgx.Tx) error {
					r, err := loadTerminal(ctx, tx, m.SessionID)
					if err != nil {
						return err
					}
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
					return saveTerminal(ctx, tx, r)
				}); err != nil {
					t.Fatal(err)
				}
				before := preparedTerminalRecord(t, f, m.SessionID)
				var err error
				if stage == "ledger" {
					_, err = f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", preparedLedger(m, run))
				} else {
					final := m
					final.Type = "finalization"
					final.Payload = v2.Finalization{FinalizationID: uuid.NewString(), ClaimTerminal: true, Runs: []v2.Run{run}}
					_, err = f.s.FinalizeTerminal(ctx, f.p, f.project, f.task, m.SessionID, "1", final)
				}
				if err == nil {
					t.Fatal("prepared proof accepted conflicting persisted recording evidence")
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
			if _, err := f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", preparedLedger(m, run)); err != nil {
				t.Fatal(err)
			}
			evidence := zeroEvidence(m, rid)
			if captureFailed {
				p := evidence.Payload.(v2.RecordingEvidence)
				code := "source_corrupt"
				p.CaptureError = &code
				evidence.Payload = p
			}
			if _, err := f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", evidence); err != nil {
				t.Fatal(err)
			}
			archiveTerminal(t, f)
			final := m
			final.Type = "finalization"
			final.Payload = v2.Finalization{FinalizationID: uuid.NewString(), ClaimTerminal: true, Runs: []v2.Run{run}}
			frozen, err := f.s.FinalizeTerminal(ctx, f.p, f.project, f.task, m.SessionID, "1", final)
			if err != nil {
				t.Fatal(err)
			}
			reason := "ended_before_first_sample"
			receipt, err := terminalReceipt(&terminalRecord{Envelope: m.Envelope}, v2.Receipt{FinalizationID: *frozen.Payload.(v2.GenerationLedger).FinalizationID, Disposition: "unavailable", Reason: &reason, Evidence: &v2.NoRecordingEvidence{RecordingEnabled: true, SelectedFrameCount: "0", RegisteredFrameCount: "0"}})
			if err != nil {
				t.Fatal(err)
			}
			got, err := f.s.UpdateTerminalArchive(ctx, f.p, f.project, f.task, m.SessionID, receipt)
			if captureFailed {
				if err == nil {
					t.Fatal("capture failure became unavailable")
				}
				return
			}
			if err != nil || !reflect.DeepEqual(receipt, got) {
				t.Fatal("valid prepared unavailable receipt", got, err)
			}
			if _, err = f.s.DB.Pool.Exec(ctx, `UPDATE task_properties SET value=jsonb_set(value::jsonb,'{claimId}',to_jsonb($2::text))::text WHERE task_id=$1 AND name='worker'`, f.task, uuid.NewString()); err != nil {
				t.Fatal(err)
			}
			restarted := New(f.s.DB)
			restarted.Origin = f.s.Origin
			status, err := restarted.TerminalArchiveStatus(ctx, f.p, f.project, f.task, m.SessionID)
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
			if _, err := f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", preparedLedger(m, run)); err != nil {
				t.Fatal(err)
			}
			stopped := preparedStoppedRun(run)
			if persistFirst {
				if _, err := f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", preparedLedger(m, stopped)); err != nil {
					t.Fatal(err)
				}
			}
			nextRun := run
			nextRun.ExecutionGeneration = "2"
			nextRun.Binding.TerminalID = "next-terminal"
			before := preparedTerminalRecord(t, f, m.SessionID)
			if _, err := f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", preparedLedger(m, stopped, nextRun)); err == nil {
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
	if _, err := f.s.UpdateTerminalRecovery(ctx, f.p, f.project, f.task, prepare.SessionID, "1", prepare); err != nil {
		t.Fatal(err)
	}
	consume := advanceRecoveryGeneration(t, f, prepare)
	// A legacy or inconsistent persisted proof must not turn an old native
	// recovery permit into authority for a preparation-only stop.
	if err := f.s.transact(ctx, func(tx pgx.Tx) error {
		r, err := loadTerminal(ctx, tx, prepare.SessionID)
		if err != nil {
			return err
		}
		old := r.Runs[0]
		r.Runs[0] = preparedStoppedRun(old)
		r.Runs[0].SegmentIDs = []string{}
		r.Runs[0].StopProof.RecordID = prepare.Payload.(v2.AutomationRecoveryPrepare).StopOperationID
		return saveTerminal(ctx, tx, r)
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.UpdateTerminalRecovery(ctx, f.p, f.project, f.task, prepare.SessionID, "2", consume); err == nil {
		t.Fatal("prepared proof consumed native automation recovery")
	}
	state, err := f.s.TerminalState(ctx, f.p, f.project, f.task, prepare.SessionID)
	if err != nil || state["control"].(*v2.ControlState).State != "suspended" {
		t.Fatal("refused recovery changed suspended control", state, err)
	}
	permit, err := f.s.TerminalAutomationRecovery(ctx, f.p, f.project, f.task, prepare.SessionID, prepare.Payload.(v2.AutomationRecoveryPrepare).RecoveryID)
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
	if _, err := f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", preparedLedger(m, doc.Runs[0], run)); err != nil {
		t.Fatal("ordinary stop must still grant next generation", err)
	}
	m.ExecutionGeneration = "2"
	rid := uuid.NewString()
	responsibility := m
	responsibility.Type = "recording_responsibility"
	responsibility.Payload = v2.RecordingResponsibility{ResponsibilityID: rid, RecordingEnabled: true}
	if _, err := f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", responsibility); err != nil {
		t.Fatal(err)
	}
	run = preparedStoppedRun(run)
	if _, err := f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", preparedLedger(m, doc.Runs[0], run)); err != nil {
		t.Fatal("prior generation frames must not reject current prepared proof", err)
	}
	if _, err := f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", zeroEvidence(m, rid)); err != nil {
		t.Fatal(err)
	}
	doc.ExecutionGeneration = "2"
	doc.Runs = append(doc.Runs, run)
	doc.Completeness = "partial"
	doc.Gaps = []v2.Gap{{Boundary: &v2.BoundaryGap{Kind: "boundary", Reason: "restart", From: v2.BoundaryEndpoint{ExecutionGeneration: "1", SegmentID: &doc.Runs[0].SegmentIDs[0]}, To: v2.BoundaryEndpoint{ExecutionGeneration: "2"}}}}
	doc.UnavailableRuns = []v2.UnavailableRun{{ExecutionGeneration: "2", Reason: "ended_before_first_sample", Evidence: v2.NoRecordingEvidence{RecordingEnabled: true, SelectedFrameCount: "0", RegisteredFrameCount: "0"}}}
	finalizeFixture(t, f, m, doc)
	data := encode(doc)
	receipt, err := f.s.PutTerminalArchive(ctx, f.p, f.project, f.task, m.SessionID, data)
	if err != nil || receipt.Payload.(v2.Receipt).Disposition != "ready" {
		t.Fatal("mixed prepared archive rejected", receipt, err)
	}
	if _, err = f.s.DB.Pool.Exec(ctx, `UPDATE task_properties SET value=jsonb_set(value::jsonb,'{claimId}',to_jsonb($2::text))::text WHERE task_id=$1 AND name='worker'`, f.task, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	restarted := New(f.s.DB, f.s.files)
	restarted.Origin = f.s.Origin
	got, err := restarted.TerminalArchiveContent(ctx, f.p, f.project, f.task, m.SessionID)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("fixed mixed archive changed after reclaim", err)
	}
	decoded, err := v2.DecodeArchive(got)
	if err != nil || len(decoded.Files) != 1 || len(decoded.UnavailableRuns) != 1 || *decoded.Runs[1].Binding.NativeSessionID != native || decoded.Runs[1].StopProof.NativeLaunch != "not_submitted" {
		t.Fatal("mixed archive lost original native or recording history", err)
	}
}
