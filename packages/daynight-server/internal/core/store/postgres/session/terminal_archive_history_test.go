package session_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
)

func testSessionTerminalHistoryRetainsMixedBackendsAndOriginalArchive(t *testing.T, db *postgres.Store) {
	database := db
	_, owner, _ := testAuthRecords(t, database)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, model.TaskDone)
	other := queryTask(t, database, project.ID, 3, model.TaskDone)
	now := time.Now().UTC().Truncate(time.Microsecond)
	older := now.Add(-time.Hour)
	oldID, webID, currentID, otherID, newID := queryID(501), queryID(502), queryID(503), queryID(504), queryID(505)
	oldClaim, webClaim, currentClaim, newClaim := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	terminal := func(dao store.SessionDAO, id, taskID, claim string) error {
		return dao.InsertTerminal(t.Context(), store.TerminalRegistration{SessionID: id, ProjectID: project.ID, TaskID: taskID, ClaimID: claim, OwnerID: owner.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), State: []byte(`{"generation":"1"}`), LastSeen: now, ServerInstance: uuid.NewString()})
	}
	finalization, digest, size, completeness, path := uuid.NewString(), strings.Repeat("c", 64), "7", "complete", "archive/original"
	receipt := v2.Receipt{FinalizationID: finalization, Disposition: "ready", SHA256: &digest, ByteLength: &size, Completeness: &completeness}
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		if err := terminal(dao, oldID, task.ID, oldClaim); err != nil {
			return err
		}
		if err := terminal(dao, currentID, task.ID, currentClaim); err != nil {
			return err
		}
		if err := terminal(dao, otherID, other.ID, uuid.NewString()); err != nil {
			return err
		}
		if err := dao.InsertTaskSession(t.Context(), store.SessionRegistration{Location: store.SessionLocation{SessionID: webID, ProjectID: project.ID, TaskID: task.ID}, ClaimID: webClaim, OwnerID: owner.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: webID, ClaimID: webClaim, ExecutionGeneration: "1"}}, Lifecycle: "archived"}}); err != nil {
			return err
		}
		return dao.SaveTerminalReceipt(t.Context(), currentID, receipt, &path)
	})
	mustQueryExec(t, database, `UPDATE task_sessions SET created_at=$1 WHERE id IN ($2,$3)`, older, oldID, webID)
	mustQueryExec(t, database, `UPDATE task_sessions SET created_at=$1 WHERE id=$2`, now, currentID)
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		rows, err := dao.TerminalHistory(t.Context(), project.ID, task.ID, nil, nil, 2)
		if err != nil || len(rows) != 2 || rows[0].ID != currentID || rows[0].Claim != currentClaim || rows[0].Backend != "herdr" || len(rows[0].Snapshot) != 0 || len(rows[0].Terminal) == 0 || rows[1].ID != webID || rows[1].Claim != webClaim || rows[1].Backend != "web" || len(rows[1].Terminal) != 0 {
			t.Fatalf("mixed backend history and nullable content: %+v %v", rows, err)
		}
		var snapshot sp.Snapshot
		if err := json.Unmarshal(rows[1].Snapshot, &snapshot); err != nil || snapshot.SessionID != webID || snapshot.ClaimID != webClaim {
			t.Fatalf("web snapshot mapping: %+v %v", snapshot, err)
		}
		rows, err = dao.TerminalHistory(t.Context(), project.ID, task.ID, &older, &webID, 2)
		if err != nil || len(rows) != 1 || rows[0].ID != oldID || rows[0].Claim != oldClaim {
			t.Fatalf("tied history cursor: %+v %v", rows, err)
		}
		for claim, id := range map[string]string{oldClaim: oldID, currentClaim: currentID} {
			actual, err := dao.CurrentTerminalSession(t.Context(), project.ID, task.ID, claim)
			if err != nil || actual != id {
				t.Fatalf("current terminal bound to claim: claim=%s id=%s error=%v", claim, actual, err)
			}
		}
		if _, err := dao.CurrentTerminalSession(t.Context(), project.ID, task.ID, webClaim); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("web backend returned as terminal: %v", err)
		}
		return nil
	})
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		return terminal(dao, newID, task.ID, newClaim)
	})
	mustQueryExec(t, database, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, task.ID)
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		actual, err := dao.CurrentTerminalSession(t.Context(), project.ID, task.ID, newClaim)
		if err != nil || actual != newID {
			t.Fatalf("new claim did not select its terminal: %s %v", actual, err)
		}
		status, saved, object, err := dao.TerminalArchive(t.Context(), currentID)
		if err != nil || status.State != "ready" || saved == nil || saved.FinalizationID != finalization || saved.SHA256 == nil || *saved.SHA256 != digest || saved.ByteLength == nil || *saved.ByteLength != size || saved.Completeness == nil || *saved.Completeness != completeness || object != path {
			t.Fatalf("new claim or deletion replaced original archive: %+v %+v %q %v", status, saved, object, err)
		}
		return nil
	})
}

func TestSessionTerminalWritersReadCommittedPredecessor(t *testing.T) {
	database := isolatedStore(t)
	_, owner, _ := testAuthRecords(t, database)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, model.TaskInProgress)
	id, instance := uuid.NewString(), uuid.NewString()
	now := time.Now().UTC().Truncate(time.Microsecond)
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		return dao.InsertTerminal(t.Context(), store.TerminalRegistration{SessionID: id, ProjectID: project.ID, TaskID: task.ID, ClaimID: uuid.NewString(), OwnerID: owner.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), State: []byte(`{"revision":1}`), LastSeen: now, ServerInstance: instance})
	})
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	first, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Rollback(context.Background())
	dao := pgsession.New(first)
	if _, err := dao.LockTerminal(ctx, id); err != nil {
		t.Fatal(err)
	}
	if err := dao.SaveTerminal(ctx, id, []byte(`{"revision":2}`), &now, instance); err != nil {
		t.Fatal(err)
	}
	second, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Rollback(context.Background())
	blocker, reader := first.Conn().PgConn().PID(), second.Conn().PgConn().PID()
	done := make(chan struct{})
	var raw []byte
	var readErr error
	go func() {
		defer close(done)
		raw, readErr = pgsession.New(second).LockTerminal(ctx, id)
	}()
	waitErr := awaitSessionStoreBlock(ctx, database, blocker, reader, done)
	commitErr := first.Commit(ctx)
	<-done
	if waitErr != nil || commitErr != nil || readErr != nil {
		t.Fatalf("terminal write serialization: wait=%v commit=%v read=%v", waitErr, commitErr, readErr)
	}
	var state struct {
		Revision int `json:"revision"`
	}
	if err := json.Unmarshal(raw, &state); err != nil || state.Revision != 2 {
		t.Fatalf("second writer loaded obsolete terminal state: %s %v", raw, err)
	}
	if err := second.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func testSessionDAOTerminalLedgerEvidenceAndHistory(t *testing.T, db *postgres.Store) {
	ctx := context.Background()
	_, principal, _ := testAuthRecords(t, db)
	project := queryProject(t, db, 1)
	task := queryTask(t, db, project.ID, 2, model.TaskInProgress)
	mustQueryExec(t, db, `UPDATE tasks SET allow_agents=true WHERE id=$1`, task.ID)
	id, claim, registration, instance := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	operationID, evidenceID, finalID, client := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	now := time.Now().UTC().Truncate(time.Microsecond)
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if _, err := dao.LockTaskRegistration(ctx, project.ID, task.ID); err != nil {
			return err
		}
		if err := dao.InsertTerminal(ctx, store.TerminalRegistration{SessionID: id, ProjectID: project.ID, TaskID: task.ID, ClaimID: claim, OwnerID: principal.UserID, RegistrationID: registration, Registration: []byte(`{}`), State: []byte(`{"revision":1}`), LastSeen: now, ServerInstance: instance}); err != nil {
			return err
		}
		found, err := dao.FindTerminalRegistration(ctx, id, project.ID, registration, task.ID, claim)
		if err != nil || found != id {
			t.Fatalf("terminal registration: %q %v", found, err)
		}
		found, err = dao.CurrentTerminalSession(ctx, project.ID, task.ID, claim)
		if err != nil || found != id {
			t.Fatalf("current terminal: %q %v", found, err)
		}
		state, err := dao.LockTerminal(ctx, id)
		if err != nil || !strings.Contains(string(state), `"revision": 1`) {
			t.Fatalf("terminal state: %s %v", state, err)
		}
		if err := dao.SaveTerminal(ctx, id, []byte(`{"revision":2}`), &now, instance); err != nil {
			return err
		}
		allowed, err := dao.TerminalAutomationAllowed(ctx, task.ID)
		if err != nil || !allowed {
			t.Fatalf("automation permission: %v %v", allowed, err)
		}
		op := store.TerminalOperation{SessionID: id, OperationID: operationID, Seq: 1, Hash: []byte("terminal"), Actor: principal, Command: []byte(`{"request":{"browserClientId":"` + client + `"}}`), Result: v2.OperationResult{OperationID: operationID, State: "queued"}, Deadline: now.Add(time.Minute)}
		if err := dao.InsertTerminalOperation(ctx, op); err != nil {
			return err
		}
		pending, err := dao.TerminalInputPending(ctx, id)
		if err != nil || !pending {
			t.Fatalf("pending input: %v %v", pending, err)
		}
		pending, err = dao.TerminalViewerOperationPending(ctx, id, principal.UserID, client)
		if err != nil || !pending {
			t.Fatalf("viewer input: %v %v", pending, err)
		}
		queued, err := dao.QueuedTerminalOperation(ctx, id)
		if err != nil || !reflect.DeepEqual(queued, []string{operationID}) {
			t.Fatalf("queued: %v %v", queued, err)
		}
		loaded, err := dao.TerminalOperation(ctx, id, operationID)
		if err != nil || loaded.Result.State != "queued" || loaded.Actor.UserID != principal.UserID {
			t.Fatalf("terminal operation: %+v %v", loaded, err)
		}
		if err := dao.SetSessionOperationEpoch(ctx, id, operationID, 1); err != nil {
			return err
		}
		if err := dao.SetTerminalOperationResult(ctx, id, v2.OperationResult{OperationID: operationID, State: "dispatching"}); err != nil {
			return err
		}
		if err := dao.InvalidateTerminalOperations(ctx, id); err != nil {
			return err
		}
		loaded, err = dao.TerminalOperation(ctx, id, operationID)
		if err != nil || loaded.Result.State != "unknown" {
			t.Fatalf("dispatch uncertainty: %+v %v", loaded, err)
		}
		op.OperationID = uuid.NewString()
		op.Seq = 2
		op.Result = v2.OperationResult{OperationID: op.OperationID, State: "queued"}
		op.Deadline = now.Add(-time.Second)
		if err := dao.InsertTerminalOperation(ctx, op); err != nil {
			return err
		}
		if err := dao.ExpireTerminalOperations(ctx, id, now); err != nil {
			return err
		}
		loaded, err = dao.TerminalOperation(ctx, id, op.OperationID)
		if err != nil || loaded.Result.State != "rejected" {
			t.Fatalf("queued expiry: %+v %v", loaded, err)
		}
		hash := strings.Repeat("b", 64)
		if err := dao.InsertRecordingEvidence(ctx, id, 1, evidenceID, 7, hash); err != nil {
			return err
		}
		gotHash, revision, err := dao.TerminalRecordingEvidence(ctx, id, 1, evidenceID)
		if err != nil || gotHash != hash || revision != "7" {
			t.Fatalf("evidence: %s %s %v", gotHash, revision, err)
		}
		if err := dao.SaveTerminalArchiveStatus(ctx, id, v2.ArchiveStatus{State: "pending", FinalizationID: &finalID}); err != nil {
			return err
		}
		status, receipt, path, err := dao.TerminalArchive(ctx, id)
		if err != nil || status.State != "pending" || receipt != nil || path != "" {
			t.Fatalf("pending archive: %+v %+v %q %v", status, receipt, path, err)
		}
		saved := v2.Receipt{FinalizationID: finalID, Disposition: "unavailable"}
		if err := dao.SaveTerminalReceipt(ctx, id, saved, nil); err != nil {
			return err
		}
		status, receipt, _, err = dao.TerminalArchive(ctx, id)
		if err != nil || status.State != "unavailable" || receipt == nil || receipt.FinalizationID != finalID {
			t.Fatalf("archive receipt: %+v %+v %v", status, receipt, err)
		}
		history, err := dao.TerminalHistory(ctx, project.ID, task.ID, nil, nil, 10)
		if err != nil || len(history) != 1 || history[0].ID != id || history[0].Backend != "herdr" {
			t.Fatalf("history: %+v %v", history, err)
		}
		return nil
	})
}
