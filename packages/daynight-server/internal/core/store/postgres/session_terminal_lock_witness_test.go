package postgres

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
)

func TestSessionTerminalWritersReadCommittedPredecessor(t *testing.T) {
	database := isolatedStore(t)
	_, owner, _ := testAuthRecords(t, database)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, model.TaskInProgress)
	id, instance := uuid.NewString(), uuid.NewString()
	now := time.Now().UTC().Truncate(time.Microsecond)
	sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
		return scope.SessionDAO().InsertTerminal(t.Context(), store.TerminalRegistration{SessionID: id, ProjectID: project.ID, TaskID: task.ID, ClaimID: uuid.NewString(), OwnerID: owner.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), State: []byte(`{"revision":1}`), LastSeen: now, ServerInstance: instance})
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
