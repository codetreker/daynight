package postgres

import (
	"slices"
	"testing"
)

func TestProjectRepositoryVersionMigrationPreservesProjects(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 95 })
	if index < 0 || schemaMigrations[index].sql != projectRepositoryVersionSQL {
		t.Fatal("repository version migration is missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	project := queryProject(t, db, 1)
	var before string
	if err := pool.QueryRow(ctx, `SELECT to_jsonb(p)::text FROM projects p WHERE id=$1`, project.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	var after string
	var version int64
	if err := pool.QueryRow(ctx, `SELECT (to_jsonb(p)-'repository_version')::text,repository_version FROM projects p WHERE id=$1`, project.ID).Scan(&after, &version); err != nil || before != after || version != 1 {
		t.Fatalf("migration changed project: preserved=%v version=%d err=%v", before == after, version, err)
	}
}
