package postgres

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestProjectGitHubWebhookMigrationPreservesExistingConnection(t *testing.T) {
	parallelRootDatabaseTest(t)
	ctx := context.Background()
	pool := emptyPool(t)
	if len(schemaMigrations) < 84 || schemaMigrations[83].version != 84 {
		t.Fatal("unexpected migration boundary")
	}
	if err := migrate(ctx, pool, schemaMigrations[:83]); err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO project_github(project_id,version,generation,revision,repository_id) VALUES($1,7,8,9,10)`, id); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:84]); err != nil {
		t.Fatal(err)
	}
	var preserved bool
	if err := pool.QueryRow(ctx, `SELECT version=7 AND generation=8 AND revision=9 AND repository_id=10 AND hook_repository_id IS NULL AND hook_version IS NULL AND NOT hook_enabled AND hook_secret IS NULL AND hook_last_received_at IS NULL FROM project_github WHERE project_id=$1`, id).Scan(&preserved); err != nil || !preserved {
		t.Fatalf("existing connection and default subscription: preserved=%t err=%v", preserved, err)
	}
}
