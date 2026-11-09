package postgres

import (
	"context"
	"net/url"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestSessionWriterReturnsItsOnlyPhysicalConnection(t *testing.T) {
	parsed, err := url.Parse(scopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("pool_max_conns", "1")
	parsed.RawQuery = query.Encode()
	database, err := Open(t.Context(), parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	if database.MaxConnections() != 1 {
		t.Fatalf("physical connection witness requires capacity 1, got %d", database.MaxConnections())
	}
	_, owner, _ := testAuthRecords(t, database)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, model.TaskInProgress)
	id, claim := uuid.NewString(), uuid.NewString()
	mustQueryExec(t, database, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, project.ID, owner.UserID)
	sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
		return scope.SessionDAO().InsertTaskSession(t.Context(), store.SessionRegistration{Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID}, ClaimID: claim, OwnerID: owner.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "1"}}, Lifecycle: "active"}})
	})
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	completion, err := database.WriteSession(ctx, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
		if err := dao.ReadCredential(ctx, owner, time.Now()); err != nil {
			return err
		}
		if _, err := dao.ProjectAccess(ctx, owner.UserID, project.ID); err != nil {
			return err
		}
		metadata, err := dao.ArchiveMetadata(ctx, id)
		if err != nil {
			return err
		}
		if metadata.Owner != owner.UserID || metadata.Project != project.ID || metadata.Task != task.ID || metadata.Test || !metadata.TaskExists || !metadata.ProjectLive {
			t.Fatalf("archive metadata reads used different fixture: %+v", metadata)
		}
		if acquired := database.Pool.Stat().AcquiredConns(); acquired != 1 {
			t.Fatalf("callback did not own the physical connection: acquired=%d", acquired)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("Session read transaction: completion=%+v error=%v", completion, err)
	}
	if acquired := database.Pool.Stat().AcquiredConns(); acquired != 0 {
		t.Fatalf("completed transaction retained a physical connection: acquired=%d", acquired)
	}
	acquireCtx, stopAcquire := context.WithTimeout(ctx, time.Second)
	defer stopAcquire()
	connection, err := database.Pool.Acquire(acquireCtx)
	if err != nil {
		t.Fatal("the only physical connection was unavailable after completion", err)
	}
	defer connection.Release()
	var answer int
	if err := connection.QueryRow(acquireCtx, `SELECT 1`).Scan(&answer); err != nil || answer != 1 {
		t.Fatalf("returned lease did not provide a physical PostgreSQL connection: answer=%d error=%v", answer, err)
	}
}
