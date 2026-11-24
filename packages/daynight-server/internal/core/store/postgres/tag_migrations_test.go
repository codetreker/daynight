package postgres

import (
	"errors"
	"slices"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

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
	if afterProjects != beforeProjects || afterTasks != beforeTasks || afterGitHub != beforeGitHub || afterPending != beforePending || retainedLedger != previousLedger || firstEpoch == uuid.Nil.String() || secondEpoch == uuid.Nil.String() || firstEpoch == secondEpoch || tags != 0 || associations != 0 {
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
	ctx, pool := t.Context(), emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:69]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	project := projectBeforeSettings(t, db, 1)
	for _, fault := range []string{"sql", "ledger"} {
		if !t.Run(fault, func(t *testing.T) {
			ctx := t.Context()
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
		}) {
			return
		}
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatalf("migration could not recover: %v", err)
	}
}

func TestTagColorMigrationPreservesHistoricalTags(t *testing.T) {
	ctx, pool := t.Context(), emptyPool(t)
	if len(schemaMigrations) < 74 || schemaMigrations[72].version != 73 || schemaMigrations[73].version != 74 {
		t.Fatal("color migration is not the successor of version 73")
	}
	if err := migrate(ctx, pool, schemaMigrations[:73]); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO project_tags(id,project_id,name,name_key,version,created_at,updated_at) VALUES ($1,$2,'old','old',7,now(),now())`, queryID(1), queryID(2)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO task_tags(project_id,task_id,tag_id) VALUES ($1,$2,$3)`, queryID(2), queryID(3), queryID(1)); err != nil {
		t.Fatal(err)
	}
	if err := initializeSchema(ctx, pool, schemaMigrations, currentSchemaSnapshot); err != nil {
		t.Fatal(err)
	}
	var color string
	var version, associations int
	if err := pool.QueryRow(ctx, `SELECT color,version,(SELECT count(*) FROM task_tags WHERE tag_id=$1) FROM project_tags WHERE id=$1`, queryID(1)).Scan(&color, &version, &associations); err != nil || color != "#9AA3B2" || version != 7 || associations != 1 {
		t.Fatalf("historical tag: color=%q version=%d associations=%d err=%v", color, version, associations, err)
	}
	var count int
	var checksum string
	if err := pool.QueryRow(ctx, `SELECT count(*),max(checksum) FILTER (WHERE version=74) FROM schema_migrations`).Scan(&count, &checksum); err != nil || count != len(schemaMigrations) || checksum != schemaMigrations[73].checksum() {
		t.Fatalf("ledger count=%d checksum=%q err=%v", count, checksum, err)
	}
	var defaultColor string
	if err := pool.QueryRow(ctx, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at) VALUES ($1,$2,'new','new',now(),now()) RETURNING color`, queryID(4), queryID(2)).Scan(&defaultColor); err != nil || defaultColor != "#9AA3B2" {
		t.Fatalf("default color=%q err=%v", defaultColor, err)
	}
	for _, color := range []string{"#000000", "#FFFFFF", "#123ABC"} {
		if _, err := pool.Exec(ctx, `UPDATE project_tags SET color=$2 WHERE id=$1`, queryID(4), color); err != nil {
			t.Fatalf("valid color %q: %v", color, err)
		}
	}
	for _, color := range []any{nil, "", "#123abc", "#12345", "#1234567", "#12345G", "123456", "#123456\n"} {
		_, err := pool.Exec(ctx, `UPDATE project_tags SET color=$2 WHERE id=$1`, queryID(4), color)
		var pg *pgconn.PgError
		if !errors.As(err, &pg) || (pg.Code != "23502" && pg.Code != "23514") {
			t.Fatalf("invalid color %v: %v", color, err)
		}
	}
	var retained string
	if err := pool.QueryRow(ctx, `SELECT color FROM project_tags WHERE id=$1`, queryID(4)).Scan(&retained); err != nil || retained != "#123ABC" {
		t.Fatalf("invalid writes changed color=%q err=%v", retained, err)
	}
}
