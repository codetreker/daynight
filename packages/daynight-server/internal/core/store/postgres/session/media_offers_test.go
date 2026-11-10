package session_test

import (
	"bytes"
	"fmt"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestPendingMediaOffersFilterCurrentFenceBeforeLimitAndRetainOriginalRows(t *testing.T) {
	for _, kind := range []string{"task", "test execution"} {
		t.Run(kind, func(t *testing.T) {
			db, sessionID, _ := imageLedgerSession(t)
			current := sp.Fence{SessionID: sessionID, ExecutionGeneration: "2"}
			if kind == "task" {
				current.ClaimID = uuid.NewString()
			} else {
				current.TestExecutionID = uuid.NewString()
			}
			rows := make([]store.SessionMediaRequest, 7)
			for i := range rows {
				rows[i] = store.SessionMediaRequest{SessionID: sessionID, RequestID: fmt.Sprintf("00000000-0000-4000-8000-%012d", i+1), Action: "prepare", Fence: sp.ControllerFence{Fence: current, ConnectionEpoch: "1"}, Body: []byte(`{}`)}
			}
			rows[0].Fence.ExecutionGeneration = "1"
			rows[1].Fence.ExecutionGeneration = "1"
			if kind == "task" {
				rows[2].Fence.ClaimID = uuid.NewString()
				rows[3].Fence.TestExecutionID = uuid.NewString()
			} else {
				rows[2].Fence.TestExecutionID = uuid.NewString()
				rows[3].Fence.ClaimID = uuid.NewString()
			}
			rows[5].Fence.ConnectionEpoch = "2"
			rows[6].Fence.ConnectionEpoch = "3"
			sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
				media := base.(store.SessionMediaDAO)
				for _, row := range rows {
					if err := media.SaveSessionMediaRequest(t.Context(), row); err != nil {
						return err
					}
				}
				return nil
			})
			sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
				media := base.(store.SessionMediaDAO)
				pending, err := media.PendingSessionMediaRequests(t.Context(), current)
				if err != nil {
					return err
				}
				if len(pending) != 2 || pending[0].RequestID != rows[4].RequestID || pending[1].RequestID != rows[5].RequestID {
					t.Fatalf("current media requests were starved by stale fences before the offer limit: %+v", pending)
				}
				if pending[0].Fence.ConnectionEpoch != "1" || pending[1].Fence.ConnectionEpoch != "2" {
					t.Fatal("same-generation reconnect candidates lost their original connection epochs", pending)
				}
				return nil
			})
			sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
				for _, original := range rows {
					loaded, err := base.(store.SessionMediaDAO).SessionMediaRequest(t.Context(), sessionID, original.RequestID)
					if err != nil {
						return err
					}
					if loaded.Fence != original.Fence || loaded.Complete || loaded.Error != nil || loaded.Result != nil || !bytes.Equal(loaded.Body, original.Body) {
						t.Fatal("offer selection changed an original unknown request", loaded)
					}
				}
				return nil
			})
		})
	}
}
