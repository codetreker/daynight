package postgres

import (
	"slices"
	"testing"
)

func TestRepositoryDefaultBranchMigrationPreservesExistingConnection(t *testing.T) {
	pool := emptyPool(t)
	ctx := t.Context()
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 106 })
	if index < 1 {
		t.Fatal("migration missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO project_github(project_id,version,repository_id,repository_full_name) VALUES('00000000-0000-0000-0000-000000000001',7,42,'owner/repo')`); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var ok bool
	if err := pool.QueryRow(ctx, `SELECT count(*)=1 AND bool_and(version=7 AND repository_id=42 AND repository_full_name='owner/repo' AND repository_default_branch IS NULL) FROM project_github`).Scan(&ok); err != nil || !ok {
		t.Fatalf("existing connection or unknown default: %v %v", ok, err)
	}
}
