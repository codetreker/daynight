package session

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestHistoryLedgerWaitsForControllerCompletionBeforeTransferringReservation(t *testing.T) {
	refused := &model.Fault{Code: "forbidden", Message: "Original delegation is unavailable."}
	commitUnknown := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: refused}
	cleanupFailed := &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionCommitted, CleanupFailed: true, Cause: refused}
	archiveFailed := errors.New("archive admission unavailable")
	for _, tc := range []struct {
		name                              string
		principalError, completion, begin error
	}{
		{name: "admitted"},
		{name: "delegation rejected", principalError: refused},
		{name: "confirmed rollback", principalError: refused, completion: &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: refused}},
		{name: "commit unknown", completion: commitUnknown},
		{name: "committed cleanup failed", completion: cleanupFailed},
		{name: "archive rejected", begin: archiveFailed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			engine := core.NewEngine(nil)
			svc := New(nil, engine)
			t.Cleanup(func() {
				if e := engine.Stop(t.Context()); e != nil {
					t.Error(e)
				}
			})
			reservation, err := svc.TryReserveArchivePreflight()
			if err != nil {
				t.Fatal(err)
			}
			defer reservation.Close()
			ctx := t.Context()
			writer := core.ActiveHistoryWriter{Fence: sp.ControllerFence{Fence: sp.Fence{SessionID: "original-session", ClaimID: "original-claim", ExecutionGeneration: "2"}, ConnectionEpoch: "3"}, Credential: "original-consumed-grant"}
			principal := model.Principal{Kind: model.PATCredential, UserID: "original-owner", CredentialID: "original-parent"}
			access, expected := &core.Access{}, &core.ArchiveOperation{}
			var calls []string
			operations := historyLedgerOperations{
				controller: func(actual context.Context, fence sp.ControllerFence, work func(*core.Access) error) error {
					if actual != ctx || fence != writer.Fence {
						t.Fatal("controller identity changed")
					}
					calls = append(calls, "controller")
					err := work(access)
					if err != tc.principalError {
						t.Fatal("principal result changed before transaction completion", err)
					}
					calls = append(calls, "completed")
					if tc.completion != nil {
						return tc.completion
					}
					return err
				},
				principal: func(actual *core.Access, project, task, id string, original core.ActiveHistoryWriter) (model.Principal, error) {
					if actual != access || project != "project" || task != "task" || id != writer.Fence.SessionID || original != writer {
						t.Fatal("delegation scope changed")
					}
					calls = append(calls, "principal")
					return principal, tc.principalError
				},
				begin: func(actual context.Context, p model.Principal, project, task, id string, mode core.ArchiveMode, token *core.ArchivePreflightReservation) (*core.ArchiveOperation, error) {
					if actual != ctx || p != principal || project != "project" || task != "task" || id != writer.Fence.SessionID || mode != core.ArchiveV1Upload || token != reservation || !reflect.DeepEqual(calls, []string{"controller", "principal", "completed"}) {
						t.Fatal("archive admitted before original scope completed", calls)
					}
					calls = append(calls, "archive")
					if tc.begin != nil {
						return nil, tc.begin
					}
					return expected, nil
				},
			}
			out, err := beginHistoryLedgerReserved(ctx, "project", "task", writer.Fence.SessionID, writer, reservation, operations)
			want := tc.completion
			if want == nil {
				want = tc.principalError
			}
			if want == nil {
				want = tc.begin
			}
			if err != want {
				t.Fatal("completion error identity changed", err, want)
			}
			if tc.completion != nil || tc.principalError != nil {
				if out != nil || len(calls) != 3 {
					t.Fatal("unsafe completion entered archive admission", calls, out)
				}
				next, e := svc.TryReserveArchivePreflight()
				if e != nil {
					t.Fatal("refused controller retained capacity", e)
				}
				if e = next.Close(); e != nil {
					t.Fatal(e)
				}
			} else if len(calls) != 4 || tc.begin == nil && out != expected || tc.begin != nil && out != nil {
				t.Fatal("archive result changed", calls, out)
			}
		})
	}
}
