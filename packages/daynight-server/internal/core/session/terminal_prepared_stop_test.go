package session

import (
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
