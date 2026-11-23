package session_test

import (
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"testing"
)

func TestSessionOperationRetainsOriginalWorkerIntent(t *testing.T) {
	db := isolatedStore(t)
	ctx := t.Context()
	_, actor, _ := testAuthRecords(t, db)
	id, operation := uuid.NewString(), uuid.NewString()
	version := int64(9007199254740993)
	worker := uuid.NewString()
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if err := dao.InsertTestSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: id}, OwnerID: actor.UserID, TestExecutionID: uuid.NewString(), RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{}, ParentCredentialID: actor.CredentialID}); err != nil {
			return err
		}
		return dao.InsertSessionOperation(ctx, store.SessionOperation{SessionID: id, OperationID: operation, Seq: 1, Hash: []byte("intent"), Actor: actor, Command: sp.Command{Payload: []byte(`{}`)}, Receipt: sp.Operation{State: "accepted"}, WorkerID: &worker, WorkerIntentVersion: &version})
	})
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		stored, err := dao.SessionOperation(ctx, id, operation)
		if err != nil {
			return err
		}
		if stored.WorkerID == nil || *stored.WorkerID != worker || stored.WorkerIntentVersion == nil || *stored.WorkerIntentVersion != version {
			t.Fatalf("intent version lost: %+v", stored)
		}
		stored.Receipt.State = "rejected"
		stored.Receipt.SessionID = id
		stored.Receipt.OperationID = operation
		return dao.SetSessionOperationReceipt(ctx, stored.Receipt)
	})
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		stored, err := dao.SessionOperation(ctx, id, operation)
		if err != nil {
			return err
		}
		if stored.WorkerID == nil || *stored.WorkerID != worker || stored.WorkerIntentVersion == nil || *stored.WorkerIntentVersion != version || stored.Receipt.State != "rejected" {
			t.Fatalf("receipt update altered intent: %+v", stored)
		}
		return nil
	})
}
