package task_test

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/google/uuid"
)

func assignmentHTTPUser(t *testing.T, database *postgres.Store) string {
	t.Helper()
	id := uuid.NewString()
	if _, err := database.Pool.Exec(context.Background(), `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, id, "assignment-"+id); err != nil {
		t.Fatal(err)
	}
	return id
}

func assignmentHTTPMember(t *testing.T, database *postgres.Store, projectID string) string {
	t.Helper()
	id := assignmentHTTPUser(t, database)
	if _, err := database.WriteProject(context.Background(), projectID, func(tx store.ProjectWriteScope) error {
		_, err := tx.ProjectDAO().AddInvitedMember(context.Background(), id)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return id
}
