package postgres

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestSessionTerminalHistoryRetainsMixedBackendsAndOriginalArchive(t *testing.T) {
	database := isolatedStore(t)
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
	sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
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
	sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
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
	sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
		return terminal(scope.SessionDAO(), newID, task.ID, newClaim)
	})
	mustQueryExec(t, database, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, task.ID)
	sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
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
