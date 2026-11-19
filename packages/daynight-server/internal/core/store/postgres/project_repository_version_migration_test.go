package postgres

import "testing"

func TestProjectRepositoryVersionMigrationPreservesProjects(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	if len(schemaMigrations) == 0 || schemaMigrations[len(schemaMigrations)-1].version != 94 {
		t.Fatal("repository version migration is missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:len(schemaMigrations)-1]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	project := queryProject(t, db, 1)
	var before string
	if err := pool.QueryRow(ctx, `SELECT to_jsonb(p)::text FROM projects p WHERE id=$1`, project.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var after string
	var version int64
	if err := pool.QueryRow(ctx, `SELECT (to_jsonb(p)-'repository_version')::text,repository_version FROM projects p WHERE id=$1`, project.ID).Scan(&after, &version); err != nil || before != after || version != 1 {
		t.Fatalf("migration changed project: preserved=%v version=%d err=%v", before == after, version, err)
	}
}
