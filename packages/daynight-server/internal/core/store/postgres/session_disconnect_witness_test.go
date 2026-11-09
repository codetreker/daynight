package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestSessionDisconnectFailureRollsBackAndPreservesCause(t *testing.T) {
	database := isolatedStore(t)
	_, owner, _ := testAuthRecords(t, database)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, model.TaskInProgress)
	id, claim := uuid.NewString(), uuid.NewString()
	now := time.Now().UTC().Truncate(time.Microsecond)
	expiry := now.Add(time.Hour)
	sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
		if err := dao.InsertTaskSession(t.Context(), store.SessionRegistration{Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID}, ClaimID: claim, OwnerID: owner.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "1"}}, Lifecycle: "active"}}); err != nil {
			return err
		}
		return dao.ConnectSession(t.Context(), id, uuid.NewString(), now, &expiry)
	})
	mustQueryExec(t, database, `CREATE FUNCTION refuse_session_disconnect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected disconnect failure'; END $$;
 CREATE TRIGGER refuse_session_disconnect BEFORE UPDATE OF connection_expires_at ON task_sessions FOR EACH ROW EXECUTE FUNCTION refuse_session_disconnect()`)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	for attempt := range 2 {
		completion, err := database.WriteSession(ctx, func(scope store.SessionScope) error {
			return scope.SessionDAO().DisconnectSession(ctx, id)
		})
		var driver *pgconn.PgError
		var transaction *store.TransactionError
		if completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &transaction) || transaction.Outcome != store.TransactionNotCommitted || transaction.CommitAttempted || transaction.CleanupFailed || !errors.As(err, &driver) || driver.Code != "P0001" || driver.Message != "injected disconnect failure" || !errors.Is(err, driver) {
			t.Fatalf("disconnect attempt %d lost rollback outcome or driver cause: completion=%+v error=%v", attempt, completion, err)
		}
		var persisted *time.Time
		if err := database.Pool.QueryRow(ctx, `SELECT connection_expires_at FROM task_sessions WHERE id=$1`, id).Scan(&persisted); err != nil || persisted == nil || !persisted.Equal(expiry) {
			t.Fatalf("failed disconnect changed committed lease: expiry=%v error=%v", persisted, err)
		}
	}
	mustQueryExec(t, database, `DROP TRIGGER refuse_session_disconnect ON task_sessions`)
	completion, err := database.WriteSession(ctx, func(scope store.SessionScope) error {
		return scope.SessionDAO().DisconnectSession(ctx, id)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("disconnect after removing failure: completion=%+v error=%v", completion, err)
	}
	var persisted *time.Time
	if err := database.Pool.QueryRow(ctx, `SELECT connection_expires_at FROM task_sessions WHERE id=$1`, id).Scan(&persisted); err != nil || persisted != nil {
		t.Fatalf("committed disconnect retained lease: expiry=%v error=%v", persisted, err)
	}
}
