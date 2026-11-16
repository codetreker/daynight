package postgres

import (
	"errors"
	"slices"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTagMigrationBootstrap(t *testing.T) {
	ctx, pool := t.Context(), emptyPool(t)
	if err := initializeSchema(ctx, pool, schemaMigrations, currentSchemaSnapshot); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	project := projectBeforeSettings(t, db, 1)
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'New task')`, queryID(10), project.ID)
	var epoch string
	var tags, associations int
	if err := pool.QueryRow(ctx, `SELECT tag_catalog_epoch::text,(SELECT count(*) FROM project_tags),(SELECT count(*) FROM task_tags) FROM projects WHERE id=$1`, project.ID).Scan(&epoch, &tags, &associations); err != nil {
		t.Fatal(err)
	}
	if parsed, err := uuid.Parse(epoch); err != nil || parsed == uuid.Nil || tags != 0 || associations != 0 {
		t.Fatalf("bootstrap epoch=%q tags=%d associations=%d error=%v", epoch, tags, associations, err)
	}
}

func TestTagMigrationPreservesHistoricalResources(t *testing.T) {
	ctx, pool := t.Context(), emptyPool(t)
	if len(schemaMigrations) < 70 || schemaMigrations[68].version != 69 || schemaMigrations[69].version != 70 {
		t.Fatal("tag migration is not the successor of version 69")
	}
	if err := migrate(ctx, pool, schemaMigrations[:69]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	first := projectBeforeSettings(t, db, 1)
	second := projectBeforeSettings(t, db, 2)
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,title,description,status,version,type) VALUES($1,$2,'Historical task','retained','done',9,'task'),($3,$2,'Historical goal','retained','todo',3,'goal')`, queryID(10), first.ID, queryID(11))
	mustQueryExec(t, db, `INSERT INTO project_github(project_id,version,enabled,repository_full_name) VALUES($1,7,true,'owner/repo')`, first.ID)
	mustQueryExec(t, db, `INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at) VALUES($1,42,3,$2,'retained',now(),now())`, first.ID, queryID(12))
	var beforeProjects, beforeTasks, beforeGitHub, beforePending, previousLedger, previousChecksum string
	if err := pool.QueryRow(ctx, `SELECT (SELECT jsonb_agg(to_jsonb(p) ORDER BY id)::text FROM projects p), (SELECT jsonb_agg(to_jsonb(t) ORDER BY id)::text FROM tasks t), (SELECT to_jsonb(g)::text FROM project_github g WHERE project_id=$1), (SELECT to_jsonb(p)::text FROM project_github_pending_prs p WHERE project_id=$1), (SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m), (SELECT checksum FROM schema_migrations WHERE version=69)`, first.ID).Scan(&beforeProjects, &beforeTasks, &beforeGitHub, &beforePending, &previousLedger, &previousChecksum); err != nil {
		t.Fatal(err)
	}
	if previousChecksum != schemaMigrations[68].checksum() {
		t.Fatalf("previous migration checksum=%q", previousChecksum)
	}
	if err := migrate(ctx, pool, schemaMigrations[:70]); err != nil {
		t.Fatal(err)
	}
	var afterProjects, afterTasks, afterGitHub, afterPending, retainedLedger string
	var firstEpoch, secondEpoch string
	var tags, associations int
	if err := pool.QueryRow(ctx, `SELECT (SELECT jsonb_agg(to_jsonb(p)-'tag_catalog_epoch' ORDER BY id)::text FROM projects p), (SELECT jsonb_agg(to_jsonb(t) ORDER BY id)::text FROM tasks t), (SELECT to_jsonb(g)::text FROM project_github g WHERE project_id=$1), (SELECT to_jsonb(p)::text FROM project_github_pending_prs p WHERE project_id=$1), (SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m WHERE version<=69), (SELECT tag_catalog_epoch::text FROM projects WHERE id=$1), (SELECT tag_catalog_epoch::text FROM projects WHERE id=$2), (SELECT count(*) FROM project_tags), (SELECT count(*) FROM task_tags)`, first.ID, second.ID).Scan(&afterProjects, &afterTasks, &afterGitHub, &afterPending, &retainedLedger, &firstEpoch, &secondEpoch, &tags, &associations); err != nil {
		t.Fatal(err)
	}
	if afterProjects != beforeProjects || afterTasks != beforeTasks || afterGitHub != beforeGitHub || afterPending != beforePending || retainedLedger != previousLedger || firstEpoch == secondEpoch || tags != 0 || associations != 0 {
		t.Fatalf("historical state changed: projects=%v tasks=%v github=%v pending=%v ledger=%v epochs=%q/%q tags=%d associations=%d", afterProjects == beforeProjects, afterTasks == beforeTasks, afterGitHub == beforeGitHub, afterPending == beforePending, retainedLedger == previousLedger, firstEpoch, secondEpoch, tags, associations)
	}
	var checksum string
	if err := pool.QueryRow(ctx, `SELECT checksum FROM schema_migrations WHERE version=70`).Scan(&checksum); err != nil || checksum != schemaMigrations[69].checksum() {
		t.Fatalf("tag ledger checksum=%q error=%v", checksum, err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:70]); err != nil {
		t.Fatalf("repeat migration: %v", err)
	}
	var retainedEpoch string
	if err := pool.QueryRow(ctx, `SELECT tag_catalog_epoch::text FROM projects WHERE id=$1`, first.ID).Scan(&retainedEpoch); err != nil || retainedEpoch != firstEpoch {
		t.Fatalf("repeat changed epoch: %q error=%v", retainedEpoch, err)
	}
}

func TestTagMigrationFailureRollsBackSchemaAndLedger(t *testing.T) {
	for _, fault := range []string{"sql", "ledger"} {
		t.Run(fault, func(t *testing.T) {
			ctx, pool := t.Context(), emptyPool(t)
			if err := migrate(ctx, pool, schemaMigrations[:69]); err != nil {
				t.Fatal(err)
			}
			db := &Store{Pool: pool}
			project := projectBeforeSettings(t, db, 1)
			migrations := slices.Clone(schemaMigrations)
			if fault == "sql" {
				migrations[69].sql += "\nSELECT 1 / 0;"
			} else {
				mustQueryExec(t, db, `ALTER TABLE schema_migrations ADD CONSTRAINT reject_tag_migration CHECK (version <> 70)`)
			}
			err := migrate(ctx, pool, migrations)
			var pg *pgconn.PgError
			wantCode := "22012"
			if fault == "ledger" {
				wantCode = "23514"
			}
			if !errors.As(err, &pg) || pg.Code != wantCode {
				t.Fatalf("migration failure lost cause: %v", err)
			}
			var projectTags, taskTags *string
			var columns, ledger int
			if err := pool.QueryRow(ctx, `SELECT to_regclass('project_tags')::text,to_regclass('task_tags')::text, (SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='projects' AND column_name='tag_catalog_epoch'), (SELECT count(*) FROM schema_migrations WHERE version=70)`).Scan(&projectTags, &taskTags, &columns, &ledger); err != nil || projectTags != nil || taskTags != nil || columns != 0 || ledger != 0 {
				t.Fatalf("partial migration: project_tags=%v task_tags=%v column=%d ledger=%d error=%v", projectTags, taskTags, columns, ledger, err)
			}
			var present bool
			if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1)`, project.ID).Scan(&present); err != nil || !present {
				t.Fatalf("historical project lost: %v %v", present, err)
			}
			if fault == "ledger" {
				mustQueryExec(t, db, `ALTER TABLE schema_migrations DROP CONSTRAINT reject_tag_migration`)
			}
			if err := migrate(ctx, pool, schemaMigrations); err != nil {
				t.Fatalf("migration could not recover: %v", err)
			}
		})
	}
}
