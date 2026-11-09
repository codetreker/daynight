package session_test

import (
	"bytes"
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
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		if err := dao.InsertTaskSession(t.Context(), store.SessionRegistration{Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID}, ClaimID: claim, OwnerID: owner.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: snapshot}); err != nil {
			return err
		}
		return dao.ConnectSession(t.Context(), id, uuid.NewString(), now, &expiry)
	})
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
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
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
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
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		if err := dao.InsertTaskSession(t.Context(), store.SessionRegistration{Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID}, ClaimID: claim, OwnerID: actor.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: fence}, Lifecycle: "active"}}); err != nil {
			return err
		}
		return dao.InsertSessionOperation(t.Context(), store.SessionOperation{SessionID: id, OperationID: operation, Seq: 1, Hash: expected[:], Actor: actor, Command: command, Receipt: sp.Operation{Fence: fence, OperationID: operation, Kind: command.Kind, State: "accepted"}})
	})
	assertHash := func() {
		t.Helper()
		sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
			loaded, err := dao.SessionOperation(t.Context(), id, operation)
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
