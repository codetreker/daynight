package session

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
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
