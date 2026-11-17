package session_test

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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
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
	terminal := func(id, taskID, claim string) {
		mustQueryExec(t, database, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,backend,terminal_state) VALUES($1,$2,$3,$4,$5,$6,'{}',NULL,'herdr','{"generation":"1"}')`, id, project.ID, taskID, claim, owner.UserID, uuid.NewString())
	}
	finalization, digest, size, completeness, path := uuid.NewString(), strings.Repeat("c", 64), "7", "complete", "archive/original"
	receipt := v2.Receipt{FinalizationID: finalization, Disposition: "ready", SHA256: &digest, ByteLength: &size, Completeness: &completeness}
	rawReceipt, err := json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	terminal(oldID, task.ID, oldClaim)
	terminal(currentID, task.ID, currentClaim)
	terminal(otherID, other.ID, uuid.NewString())
	mustQueryExec(t, database, `INSERT INTO session_archives(session_id,state,sha256,byte_length,object_path,schema_version,completeness,finalization_id,receipt) VALUES($1,'ready',$2,$3,$4,2,$5,$6,$7)`, currentID, digest, size, path, completeness, finalization, rawReceipt)
	pendingID, unavailableID := uuid.NewString(), uuid.NewString()
	unavailableReceipt, err := json.Marshal(v2.Receipt{FinalizationID: unavailableID, Disposition: "unavailable"})
	if err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, database, `INSERT INTO session_archives(session_id,state,schema_version,finalization_id) VALUES($1,'pending',2,$2)`, oldID, pendingID)
	mustQueryExec(t, database, `INSERT INTO session_archives(session_id,state,schema_version,finalization_id,receipt) VALUES($1,'unavailable',2,$2,$3)`, otherID, unavailableID, unavailableReceipt)
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		return dao.InsertTaskSession(t.Context(), store.SessionRegistration{Location: store.SessionLocation{SessionID: webID, ProjectID: project.ID, TaskID: task.ID}, ClaimID: webClaim, OwnerID: owner.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: webID, ClaimID: webClaim, ExecutionGeneration: "1"}}, Lifecycle: "archived"}})
	})
	mustQueryExec(t, database, `UPDATE task_sessions SET created_at=$1 WHERE id IN ($2,$3)`, older, oldID, webID)
	mustQueryExec(t, database, `UPDATE task_sessions SET created_at=$1 WHERE id=$2`, now, currentID)
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {

		pending, pendingReceipt, pendingPath, err := dao.TerminalArchive(t.Context(), oldID)
		if err != nil || pending.State != "pending" || pending.FinalizationID == nil || *pending.FinalizationID != pendingID || pendingReceipt != nil || pendingPath != "" {
			t.Fatalf("pending archive: %+v %+v %q %v", pending, pendingReceipt, pendingPath, err)
		}
		unavailable, savedUnavailable, unavailablePath, err := dao.TerminalArchive(t.Context(), otherID)
		if err != nil || unavailable.State != "unavailable" || savedUnavailable == nil || savedUnavailable.Disposition != "unavailable" || savedUnavailable.FinalizationID != unavailableID || unavailablePath != "" {
			t.Fatalf("unavailable archive: %+v %+v %q %v", unavailable, savedUnavailable, unavailablePath, err)
		}
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
	terminal(newID, task.ID, newClaim)
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
