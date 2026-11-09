package session

import (
	"context"
	"errors"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestHistoryLedgerAdmissionFailureReturnsOriginalErrorAndReleasesReservation(t *testing.T) {
	cause := errors.New("controller scope unavailable")
	calls := 0
	svc := New(archiveCompletionOrderWriter(func(ctx context.Context, _ func(store.SessionScope) error) (store.Completion, error) {
		calls++
		if ctx != t.Context() {
			t.Fatal("controller context changed")
		}
		return store.Completion{Outcome: store.TransactionNotCommitted}, cause
	}), core.NewEngine(nil))
	for _, reserved := range []bool{false, true} {
		var reservation *core.ArchivePreflightReservation
		if reserved {
			var e error
			reservation, e = svc.TryReserveArchivePreflight()
			if e != nil {
				t.Fatal(e)
			}
		}
		op, e := svc.BeginHistoryLedgerReserved(t.Context(), "project", "task", "session", core.ActiveHistoryWriter{Fence: sp.ControllerFence{Fence: sp.Fence{SessionID: "session"}}, Credential: "original-grant"}, reservation)
		if op != nil || !errors.Is(e, cause) {
			t.Fatal("controller refusal changed", op, e)
		}
		next, e := svc.TryReserveArchivePreflight()
		if e != nil {
			t.Fatal("failed controller admission leaked reservation", e)
		}
		if e = next.Close(); e != nil {
			t.Fatal(e)
		}
	}
	if calls != 2 {
		t.Fatal("controller failure continued to archive admission", calls)
	}
}
