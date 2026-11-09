package postgres

import (
	"crypto/sha256"
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestNativeSessionLedgerDoesNotCreateLegacyContentRows(t *testing.T) {
	database := isolatedStore(t)
	_, owner, _ := testAuthRecords(t, database)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, model.TaskInProgress)
	id, claim, epoch, operation := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	fence := sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "1"}
	snapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: fence, ConnectionEpoch: "1"}, Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, Identity: sp.Identity{ProjectID: project.ID, TaskID: task.ID, OwnerUserID: owner.UserID, Provider: "codex"}, SessionRevision: "3", HistoryEpoch: uuid.NewString(), LastEventSeq: "0", LastTimelineSeq: "1", InitialInputState: "confirmed", Lifecycle: "active", ConnectionState: "disconnected", Activity: "unknown"}
	now := time.Now().UTC().Truncate(time.Microsecond)
	expiry := now.Add(time.Hour)
	sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
		if err := dao.InsertTaskSession(t.Context(), store.SessionRegistration{Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID}, ClaimID: claim, OwnerID: owner.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: snapshot}); err != nil {
			return err
		}
		return dao.ConnectSession(t.Context(), id, uuid.NewString(), now, &expiry)
	})
	sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
		record, err := dao.LockSession(t.Context(), id)
		if err != nil {
			return err
		}
		record.SourceEpoch, record.SourceEpochs, record.SourceSeq = &epoch, []string{epoch}, 3
		if err := dao.SaveSession(t.Context(), record); err != nil {
			return err
		}
		return dao.TouchSession(t.Context(), id, now)
	})
	assertNoLegacyRows := func() {
		t.Helper()
		for _, table := range []string{"session_events", "session_timeline", "session_resources"} {
			var count int
			if err := database.Pool.QueryRow(t.Context(), `SELECT count(*) FROM `+table+` WHERE session_id=$1`, id).Scan(&count); err != nil || count != 0 {
				t.Fatalf("native Session stored legacy content in %s: count=%d error=%v", table, count, err)
			}
		}
	}
	assertNoLegacyRows()
	hash := sha256.Sum256([]byte("native control intent"))
	command := sp.Command{Fence: fence, Protocol: sp.Protocol, OperationID: operation, Kind: "send_message", Payload: json.RawMessage(`{}`)}
	receipt := sp.Operation{Fence: fence, Protocol: sp.Protocol, OperationID: operation, Kind: command.Kind, State: "accepted"}
	sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
		if err := dao.InsertSessionOperation(t.Context(), store.SessionOperation{SessionID: id, OperationID: operation, Seq: 1, Hash: hash[:], Actor: owner, Command: command, Receipt: receipt}); err != nil {
			return err
		}
		receipt.State = "confirmed"
		if err := dao.SetSessionOperationReceipt(t.Context(), receipt); err != nil {
			return err
		}
		record, err := dao.LockSession(t.Context(), id)
		if err != nil {
			return err
		}
		record.OperationSeq = 1
		return dao.SaveSession(t.Context(), record)
	})
	assertNoLegacyRows()
	var source, operations int64
	var state string
	if err := database.Pool.QueryRow(t.Context(), `SELECT last_source_seq,last_operation_seq,(SELECT receipt->>'state' FROM session_operations WHERE session_id=$1 AND operation_id=$2) FROM task_sessions WHERE id=$1`, id, operation).Scan(&source, &operations, &state); err != nil || source != 3 || operations != 1 || state != "confirmed" {
		t.Fatalf("native control ledger did not commit: source=%d operations=%d receipt=%s error=%v", source, operations, state, err)
	}
}
