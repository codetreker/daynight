package postgres

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestSessionOperationPreservesStoredHashBytes(t *testing.T) {
	database := isolatedStore(t)
	_, actor, _ := testAuthRecords(t, database)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, model.TaskInProgress)
	id, claim, operation := uuid.NewString(), uuid.NewString(), uuid.NewString()
	fence := sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "1"}
	command := sp.Command{Fence: fence, Protocol: sp.Protocol, RequestID: "hash", OperationID: operation, Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"<script>&\u2028"}],"expectedTurnId":null}`)}
	expected := [32]byte{
		0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
		0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe,
		0x02, 0x46, 0x8a, 0xce, 0x13, 0x57, 0x9b, 0xdf,
		0x20, 0x64, 0xa8, 0xec, 0x31, 0x75, 0xb9, 0xfd,
	}
	sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
		if err := dao.InsertTaskSession(t.Context(), store.SessionRegistration{Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID}, ClaimID: claim, OwnerID: actor.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: fence}, Lifecycle: "active"}}); err != nil {
			return err
		}
		return dao.InsertSessionOperation(t.Context(), store.SessionOperation{SessionID: id, OperationID: operation, Seq: 1, Hash: expected[:], Actor: actor, Command: command, Receipt: sp.Operation{Fence: fence, OperationID: operation, Kind: command.Kind, State: "accepted"}})
	})
	assertHash := func() {
		t.Helper()
		sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
			loaded, err := scope.SessionDAO().SessionOperation(t.Context(), id, operation)
			if err != nil || !bytes.Equal(loaded.Hash, expected[:]) {
				t.Fatalf("stored hash bytes changed on read: got=%x want=%x error=%v", loaded.Hash, expected, err)
			}
			return nil
		})
	}
	assertHash()
	expected[0] ^= 0xff
	mustQueryExec(t, database, `UPDATE session_operations SET body_hash=$1 WHERE session_id=$2 AND operation_id=$3`, expected[:], id, operation)
	assertHash()
}
