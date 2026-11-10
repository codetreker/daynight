package session

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
)

func TestArchiveTypedUpdateRejectsInvalidInputBeforeScope(t *testing.T) {
	base := sp.ArchiveUpdate{Fence: sp.Fence{SessionID: uuid.NewString(), ClaimID: uuid.NewString(), ExecutionGeneration: "1"}, ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), State: "pending"}
	code := "upload_failed"
	invalidCode := "UPLOAD FAILED"
	for name, mutate := range map[string]func(*sp.ArchiveUpdate){
		"ready":               func(in *sp.ArchiveUpdate) { in.State = "ready" },
		"unavailable":         func(in *sp.ArchiveUpdate) { in.State = "unavailable" },
		"unknown state":       func(in *sp.ArchiveUpdate) { in.State = "other" },
		"pending with error":  func(in *sp.ArchiveUpdate) { in.ErrorCode = &code },
		"invalid error":       func(in *sp.ArchiveUpdate) { in.State, in.ErrorCode = "failed", &invalidCode },
		"invalid controller":  func(in *sp.ArchiveUpdate) { in.ControllerID = "other" },
		"invalid generation":  func(in *sp.ArchiveUpdate) { in.ExecutionGeneration = "0" },
		"mixed task and test": func(in *sp.ArchiveUpdate) { in.TestExecutionID = uuid.NewString() },
	} {
		t.Run(name, func(t *testing.T) {
			in := base
			mutate(&in)
			called := false
			s := &Execution{archiveRun: func(context.Context, model.Principal, string, string, string, bool, func(*Access) error) error {
				called = true
				return errors.New("unexpected archive scope")
			}}
			out, err := s.UpdateArchive(t.Context(), model.Principal{}, "", "", base.SessionID, in)
			var refusal *model.Fault
			if called || !errors.As(err, &refusal) || refusal.Code != "invalid_input" || !reflect.DeepEqual(out, sp.ArchiveStatus{}) {
				t.Fatalf("invalid typed update entered scope or returned a result: called=%v out=%+v err=%v", called, out, err)
			}
		})
	}
}

func TestArchiveTypedFailedUpdateKeepsOptionalError(t *testing.T) {
	f, snapshot, _ := archiveFixture(t)
	in := sp.ArchiveUpdate{Fence: snapshot.Fence, ControllerID: snapshot.Identity.ControllerID, ControllerInstanceID: snapshot.Identity.ControllerInstanceID, State: "failed"}
	out, err := fixtureArchiveUpdate(f, f.s, t.Context(), f.p, f.project, f.task, snapshot.SessionID, in, map[string]int{"SetSessionArchiveState": 1})
	if err != nil || !reflect.DeepEqual(out, sp.ArchiveStatus{State: "failed"}) {
		t.Fatalf("failed update without error code: out=%+v err=%v", out, err)
	}
}

func TestTerminalArchiveTypedPointersUseDecodedPayload(t *testing.T) {
	for _, kind := range []string{"archive_status", "receipt"} {
		t.Run(kind, func(t *testing.T) {
			defer func() {
				if value := recover(); value != nil {
					t.Errorf("valid typed pointer panicked: %v", value)
				}
			}()
			f, registration := terminalFixture(t)
			input := registration
			input.Type = kind
			registered := registration.Payload.(v2.Registration)
			r := &terminalRecord{Envelope: registration.Envelope, Registration: registered, Owner: registered.Owner, Binding: registered.Binding, Runs: []v2.Run{}}
			work := map[string]int{"TerminalArchive": 1}
			var expected v2.Payload
			if kind == "archive_status" {
				status := v2.ArchiveStatus{State: "pending"}
				input.Payload, expected = &status, status
				work["SaveTerminalArchiveStatus"] = 1
			} else {
				finalization := uuid.NewString()
				r.FinalizationID = &finalization
				stopped := "2026-01-01T00:01:00Z"
				run := v2.Run{ExecutionGeneration: "1", Owner: registered.Owner, Binding: registered.Binding, StartedAt: "2026-01-01T00:00:00Z", StoppedAt: &stopped, SegmentIDs: []string{}, StopProof: &v2.StopProof{RecordID: uuid.NewString(), ExecutionGeneration: "1", Binding: registered.Binding, BootID: "boot", StoppedAt: stopped, Method: "instances_exited", TerminalStopped: true, Processes: []v2.ProcessProof{{Role: "shell", PID: 1, BirthToken: "shell-birth", BootID: "boot"}, {Role: "agent", PID: 2, BirthToken: "agent-birth", BootID: "boot"}}}}
				r.Runs = []v2.Run{run}
				responsibility := uuid.NewString()
				r.Recording = map[string]terminalRecording{"1": {Responsibility: &v2.RecordingResponsibility{ResponsibilityID: responsibility, RecordingEnabled: false}, Evidence: &v2.RecordingEvidence{ResponsibilityID: responsibility, EvidenceID: uuid.NewString(), Revision: "1", Closed: true, SelectedFrameCount: "0", RegisteredFrameCount: "0", JournalSHA256: v2.HashBytes([]byte("closed zero journal")), SourceSHA256: v2.EmptySourceDigest()}}}
				reason := "recording_not_enabled"
				receipt := v2.Receipt{FinalizationID: finalization, Disposition: "unavailable", Reason: &reason, Evidence: &v2.NoRecordingEvidence{RecordingEnabled: false, SelectedFrameCount: "0", RegisteredFrameCount: "0"}}
				input.Payload = receipt
				var err error
				receipt.DispositionDigest, err = v2.ReceiptDigest(input)
				if err != nil {
					t.Fatal(err)
				}
				input.Payload, expected = &receipt, receipt
				work["SaveTerminalReceipt"] = 1
			}
			f.terminal.SetRecord(t, r)
			phase := f.TerminalPhase(t.Context(), true, work)
			defer f.dao.FinishContext(phase)
			out, err := f.s.UpdateTerminalArchive(phase, f.p, f.project, f.task, input.SessionID, input)
			if err != nil || out.Envelope != input.Envelope || !reflect.DeepEqual(out.Payload, expected) {
				t.Fatalf("typed pointer result: out=%+v err=%v", out, err)
			}
			if kind == "archive_status" && (f.terminal.ProposedStatus == nil || !reflect.DeepEqual(*f.terminal.ProposedStatus, expected)) {
				t.Fatal("decoded status was not proposed to the DAO")
			}
			if kind == "receipt" && (f.terminal.ProposedReceipt == nil || !reflect.DeepEqual(*f.terminal.ProposedReceipt, expected) || f.terminal.ProposedPath != nil) {
				t.Fatal("decoded unavailable receipt changed its content or acquired a body path")
			}
		})
	}
}

func TestTerminalArchiveTypedInvalidPointersRejectBeforeScope(t *testing.T) {
	hash := strings.Repeat("a", 64)
	reason := "recording_not_enabled"
	for name, payload := range map[string]v2.Payload{
		"nil status":     (*v2.ArchiveStatus)(nil),
		"pending body":   &v2.ArchiveStatus{State: "pending", SHA256: &hash},
		"nil receipt":    (*v2.Receipt)(nil),
		"invalid digest": &v2.Receipt{FinalizationID: uuid.NewString(), Disposition: "unavailable", DispositionDigest: hash, Reason: &reason, Evidence: &v2.NoRecordingEvidence{SelectedFrameCount: "0", RegisteredFrameCount: "0"}},
	} {
		t.Run(name, func(t *testing.T) {
			_, registration := terminalFixture(t)
			input := registration
			input.Type = "archive_status"
			if _, receipt := payload.(*v2.Receipt); receipt {
				input.Type = "receipt"
			}
			input.Payload = payload
			called := false
			s := &Execution{terminalRun: func(context.Context, model.Principal, string, string, string, bool, func(*TerminalAccess) error) error {
				called = true
				return errors.New("unexpected terminal scope")
			}}
			out, err := s.UpdateTerminalArchive(t.Context(), model.Principal{}, "", "", input.SessionID, input)
			var refusal *model.Fault
			if called || !errors.As(err, &refusal) || refusal.Code != "invalid_payload" || !reflect.DeepEqual(out, v2.Message{}) {
				t.Fatalf("invalid pointer entered scope or returned a result: called=%v out=%+v err=%v", called, out, err)
			}
		})
	}
}
