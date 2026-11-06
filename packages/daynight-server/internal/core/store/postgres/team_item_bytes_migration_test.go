package postgres

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func itemBytesMigrationSource(t *testing.T) *Store {
	t.Helper()
	pool := emptyPool(t)
	if err := migrate(t.Context(), pool, schemaMigrations[:44]); err != nil {
		t.Fatal(err)
	}
	s := &Store{Pool: pool}
	mustQueryExec(t, s, `INSERT INTO users(id,uniauth_id,name,email,avatar_url,created_at,updated_at) VALUES
		($1,'item-source',repeat('名字😀',1024),NULL,'','2026-01-01Z','2026-01-01Z'),
		($2,'item-null',NULL,NULL,NULL,'2026-01-01Z','2026-01-01Z')`, queryID(1), queryID(4))
	mustQueryExec(t, s, `INSERT INTO teams(id,name,created_at,updated_at) VALUES($1,'名字 Team','2026-01-01Z','2026-01-01Z')`, queryID(2))
	mustQueryExec(t, s, `INSERT INTO teams(id,personal_user_id,name,created_at,updated_at) VALUES($1,$2,NULL,'2026-01-01Z','2026-01-01Z')`, queryID(5), queryID(4))
	mustQueryExec(t, s, `INSERT INTO team_members(team_id,user_id,role,created_at,updated_at) VALUES($1,$2,'admin','2026-01-01Z','2026-01-01Z')`, queryID(2), queryID(1))
	mustQueryExec(t, s, `INSERT INTO projects(id,name,repo_url,created_at,updated_at) VALUES($1,'名字 Project','ssh://example/repo','2026-01-01Z','2026-01-01Z')`, queryID(3))
	mustQueryExec(t, s, `INSERT INTO project_ownership(project_id,team_id,updated_at) VALUES($1,$2,'2026-01-01Z')`, queryID(3), queryID(2))
	return s
}

func itemBytesMigratedStore(t *testing.T) *Store {
	t.Helper()
	s := itemBytesMigrationSource(t)
	if err := migrate(t.Context(), s.Pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestTeamItemByteMigrationBackfillsWithoutChangingBusinessTime(t *testing.T) {
	s := itemBytesMigratedStore(t)
	ctx := t.Context()
	var projections, times, nulls bool
	if err := s.Pool.QueryRow(ctx, `SELECT
		(SELECT f.content=convert_to(u.name,'UTF8') FROM team_item_fields f JOIN users u ON u.id=f.object_id
		 WHERE f.kind='member' AND f.object_id=$1 AND f.field='profile.name')
		AND (SELECT f.content=convert_to(t.name,'UTF8') FROM team_item_fields f JOIN teams t ON t.id=f.object_id
		 WHERE f.kind='team' AND f.object_id=$2 AND f.field='name')
		AND (SELECT bool_and(CASE f.field WHEN 'name' THEN f.content=convert_to(p.name,'UTF8')
		 ELSE f.content=convert_to(p.repo_url,'UTF8') END) FROM team_item_fields f JOIN projects p ON p.id=f.object_id
		 WHERE f.kind='project' AND f.object_id=$3),
		(SELECT bool_and(updated_at='2026-01-01Z'::timestamptz) FROM users)
		AND (SELECT bool_and(updated_at='2026-01-01Z'::timestamptz) FROM teams)
		AND (SELECT updated_at='2026-01-01Z'::timestamptz FROM projects WHERE id=$3),
		(SELECT count(*)=3 AND bool_and(content IS NULL) FROM team_item_fields WHERE kind='member' AND object_id=$4)
		AND (SELECT content IS NULL FROM team_item_fields WHERE kind='team' AND object_id=$5 AND field='name')
		AND (SELECT content=''::bytea FROM team_item_fields WHERE kind='member' AND object_id=$1 AND field='profile.avatarUrl')`, queryID(1), queryID(2), queryID(3), queryID(4), queryID(5)).Scan(&projections, &times, &nulls); err != nil || !projections || !times || !nulls {
		t.Fatalf("backfill projection/time/null facts: %v %v %v: %v", projections, times, nulls, err)
	}
	var external bool
	if err := s.Pool.QueryRow(ctx, `SELECT attstorage='e' FROM pg_attribute WHERE attrelid='team_item_fields'::regclass AND attname='content'`).Scan(&external); err != nil || !external {
		t.Fatalf("projection content is not EXTERNAL: %v %v", external, err)
	}
	var compression *string
	var source, part []byte
	if err := s.Pool.QueryRow(ctx, `SELECT pg_column_compression(f.content),convert_to(u.name,'UTF8'),substring(f.content FROM 3 FOR 7)
		FROM users u JOIN team_item_fields f ON f.object_id=u.id AND f.kind='member' AND f.field='profile.name' WHERE u.id=$1`, queryID(1)).Scan(&compression, &source, &part); err != nil || compression != nil || !bytes.Equal(part, source[2:9]) {
		t.Fatalf("byte range/compression: %v %x: %v", compression, part, err)
	}
	if err := migrate(ctx, s.Pool, schemaMigrations); err != nil {
		t.Fatalf("migration reentry: %v", err)
	}
}

func TestTeamItemProjectionBackfillTraversesEveryBatch(t *testing.T) {
	s := itemBytesMigrationSource(t)
	mustQueryExec(t, s, `INSERT INTO users(id,uniauth_id,name,email,avatar_url,created_at,updated_at)
		SELECT md5('item-byte-batch:'||n)::uuid,'item-byte-batch:'||n,
		CASE WHEN n%3=0 THEN NULL ELSE '名字:'||n END,
		CASE WHEN n%3=1 THEN NULL ELSE '' END,
		CASE WHEN n%3=2 THEN NULL ELSE 'https://example/'||n END,
		'2026-01-01Z','2026-01-01Z' FROM generate_series(1,513) n`)
	if err := migrate(t.Context(), s.Pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var count int
	var valid bool
	if err := s.Pool.QueryRow(t.Context(), `SELECT count(*),bool_and(f.content IS NOT DISTINCT FROM convert_to(
		CASE f.field WHEN 'profile.name' THEN u.name WHEN 'profile.email' THEN u.email ELSE u.avatar_url END,'UTF8'))
		FROM users u JOIN team_item_fields f ON f.kind='member' AND f.object_id=u.id`).Scan(&count, &valid); err != nil || count != 1545 || !valid {
		t.Fatalf("multi-batch backfill: %d %v %v", count, valid, err)
	}
}

func TestTeamItemByteProjectionNullEmptyAndChanges(t *testing.T) {
	s := itemBytesMigratedStore(t)
	for _, item := range []struct{ table, column, kind, field, id string }{
		{"users", "name", "member", "profile.name", queryID(1)},
		{"users", "email", "member", "profile.email", queryID(1)},
		{"users", "avatar_url", "member", "profile.avatarUrl", queryID(1)},
		{"teams", "name", "team", "name", queryID(2)},
		{"projects", "name", "project", "name", queryID(3)},
		{"projects", "repo_url", "project", "repoUrl", queryID(3)},
	} {
		t.Run(item.table+"/"+item.column, func(t *testing.T) {
			values := []*string{stringPointer("first"), stringPointer("名字😀\n\""), stringPointer("last")}
			if item.table == "users" {
				values = append(values, nil, stringPointer(""), nil)
			}
			for _, value := range values {
				mustQueryExec(t, s, `UPDATE `+item.table+` SET `+item.column+`=$2 WHERE id=$1`, item.id, value)
				var equal bool
				if err := s.Pool.QueryRow(t.Context(), `SELECT f.content IS NOT DISTINCT FROM convert_to(s.`+item.column+`,'UTF8')
					FROM `+item.table+` s JOIN team_item_fields f ON f.object_id=s.id AND f.kind=$2 AND f.field=$3 WHERE s.id=$1`, item.id, item.kind, item.field).Scan(&equal); err != nil || !equal {
					t.Fatalf("projection differs for %s: %v", item.column, err)
				}
			}
		})
	}
	mustQueryExec(t, s, `INSERT INTO users(id,uniauth_id,name,created_at,updated_at)
		VALUES($1,'insert-derived','right','2026-01-01Z','2026-01-01Z')`, queryID(6))
	var inserted string
	if err := s.Pool.QueryRow(t.Context(), `SELECT convert_from(content,'UTF8') FROM team_item_fields
		WHERE kind='member' AND object_id=$1 AND field='profile.name'`, queryID(6)).Scan(&inserted); err != nil || inserted != "right" {
		t.Fatalf("insert did not derive projection: %q %v", inserted, err)
	}
	mustQueryExec(t, s, `INSERT INTO users(id,uniauth_id,name,created_at,updated_at)
		VALUES($1,'insert-derived','updated','2026-01-01Z','2026-01-01Z')
		ON CONFLICT(uniauth_id) DO UPDATE SET name=EXCLUDED.name,updated_at=EXCLUDED.updated_at`, queryID(7))
	var conflictValid bool
	if err := s.Pool.QueryRow(t.Context(), `SELECT
		(SELECT convert_from(content,'UTF8')='updated' FROM team_item_fields WHERE kind='member' AND object_id=$1 AND field='profile.name')
		AND NOT EXISTS(SELECT 1 FROM team_item_fields WHERE kind='member' AND object_id=$2)`, queryID(6), queryID(7)).Scan(&conflictValid); err != nil || !conflictValid {
		t.Fatalf("upsert published discarded insert identity: %v %v", conflictValid, err)
	}
}

func stringPointer(value string) *string { return &value }

func TestTeamItemProjectionRejectsIndependentMutation(t *testing.T) {
	s := itemBytesMigratedStore(t)
	for _, statement := range []string{
		`INSERT INTO team_item_fields VALUES('member','` + queryID(7) + `','profile.name','tampered'::bytea)`,
		`UPDATE team_item_fields SET content='tampered'::bytea`,
		`DELETE FROM team_item_fields`,
		`TRUNCATE team_item_fields`,
	} {
		_, err := s.Pool.Exec(t.Context(), statement)
		var failure *pgconn.PgError
		if !errors.As(err, &failure) || failure.Code != "23514" {
			t.Fatalf("independent projection mutation was not rejected: %s: %v", statement, err)
		}
	}
}

func TestTeamItemModifiedTimeStrictlyAdvancesAndNeverRegresses(t *testing.T) {
	s := itemBytesMigratedStore(t)
	ctx := t.Context()
	original := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, item := range []struct{ name, mutation, noChange, read string }{
		{"profile", `UPDATE users SET name='changed',updated_at=$1 WHERE id='` + queryID(1) + `'`, `UPDATE users SET name=name,updated_at=$1 WHERE id='` + queryID(1) + `'`, `SELECT updated_at FROM users WHERE id='` + queryID(1) + `'`},
		{"team", `UPDATE teams SET name='changed',updated_at=$1 WHERE id='` + queryID(2) + `'`, `UPDATE teams SET name=name,updated_at=$1 WHERE id='` + queryID(2) + `'`, `SELECT updated_at FROM teams WHERE id='` + queryID(2) + `'`},
		{"member", `UPDATE team_members SET role='member',updated_at=$1 WHERE team_id='` + queryID(2) + `'`, `UPDATE team_members SET role=role,updated_at=$1 WHERE team_id='` + queryID(2) + `'`, `SELECT updated_at FROM team_members WHERE team_id='` + queryID(2) + `'`},
		{"settings", `UPDATE projects SET settings_version=settings_version+1,updated_at=$1 WHERE id='` + queryID(3) + `'`, `UPDATE projects SET settings_version=settings_version,updated_at=$1 WHERE id='` + queryID(3) + `'`, `SELECT updated_at FROM projects WHERE id='` + queryID(3) + `'`},
		{"ownership", `UPDATE project_ownership SET version=version+1,updated_at=$1 WHERE project_id='` + queryID(3) + `'`, `UPDATE project_ownership SET version=version,updated_at=$1 WHERE project_id='` + queryID(3) + `'`, `SELECT updated_at FROM project_ownership WHERE project_id='` + queryID(3) + `'`},
	} {
		t.Run(item.name, func(t *testing.T) {
			mustQueryExec(t, s, item.mutation, original)
			var changed time.Time
			if err := s.Pool.QueryRow(ctx, item.read).Scan(&changed); err != nil || !changed.Equal(original.Add(time.Microsecond)) {
				t.Fatalf("same assigned timestamp did not advance: %s %v", changed, err)
			}
			mustQueryExec(t, s, item.noChange, original.Add(-time.Hour))
			var retained time.Time
			if err := s.Pool.QueryRow(ctx, item.read).Scan(&retained); err != nil || !retained.Equal(changed) {
				t.Fatalf("late unchanged write regressed timestamp: %s %s %v", changed, retained, err)
			}
		})
	}
	mustQueryExec(t, s, `UPDATE users SET email_verified=true WHERE id=$1`, queryID(1))
	var actual time.Time
	if err := s.Pool.QueryRow(ctx, `SELECT updated_at FROM users WHERE id=$1`, queryID(1)).Scan(&actual); err != nil || !actual.Equal(original.Add(time.Microsecond)) {
		t.Fatalf("unrelated field caused a read revision advance: %s %v", actual, err)
	}
}

func TestTeamItemProjectionSourceRollbackAndCleanup(t *testing.T) {
	s := itemBytesMigratedStore(t)
	tx, err := s.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	if _, err := tx.Exec(t.Context(), `UPDATE users SET name='rolled back' WHERE id=$1`, queryID(1)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	var retained bool
	if err := s.Pool.QueryRow(t.Context(), `SELECT f.content=convert_to(u.name,'UTF8') AND u.name<>'rolled back'
		FROM users u JOIN team_item_fields f ON f.kind='member' AND f.object_id=u.id AND f.field='profile.name' WHERE u.id=$1`, queryID(1)).Scan(&retained); err != nil || !retained {
		t.Fatalf("rolled-back source left published projection: %v %v", retained, err)
	}
	for _, item := range []struct{ table, kind, id string }{{"users", "member", queryID(1)}, {"teams", "team", queryID(2)}, {"projects", "project", queryID(3)}} {
		mustQueryExec(t, s, `DELETE FROM `+item.table+` WHERE id=$1`, item.id)
		var absent bool
		if err := s.Pool.QueryRow(t.Context(), `SELECT NOT EXISTS(SELECT 1 FROM team_item_fields WHERE kind=$1 AND object_id=$2)`, item.kind, item.id).Scan(&absent); err != nil || !absent {
			t.Fatalf("physical source deletion retained projection: %s %v %v", item.table, absent, err)
		}
	}
	mustQueryExec(t, s, `TRUNCATE users,teams,projects CASCADE`)
	var empty bool
	if err := s.Pool.QueryRow(t.Context(), `SELECT NOT EXISTS(SELECT 1 FROM team_item_fields)`).Scan(&empty); err != nil || !empty {
		t.Fatalf("source truncation retained projections: %v %v", empty, err)
	}
}

func TestTeamItemProjectionMigrationRollsBackOnFailure(t *testing.T) {
	s := itemBytesMigrationSource(t)
	broken := append([]migration(nil), schemaMigrations...)
	broken[len(broken)-1].sql += `; SELECT 1/0;`
	if err := migrate(context.Background(), s.Pool, broken); err == nil {
		t.Fatal("expected migration failure")
	}
	var absent bool
	if err := s.Pool.QueryRow(t.Context(), `SELECT to_regclass('team_item_fields') IS NULL
		AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=45)`).Scan(&absent); err != nil || !absent {
		t.Fatalf("failed migration exposed partial projection: %v %v", absent, err)
	}
	if err := migrate(t.Context(), s.Pool, schemaMigrations); err != nil {
		t.Fatalf("migration restart failed: %v", err)
	}
}

func TestTeamItemMigrationSerializesConcurrentSourceWrite(t *testing.T) {
	s := itemBytesMigrationSource(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	blocker, err := s.Pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Release()
	const barrier int64 = 7814501
	if _, err := blocker.Exec(ctx, "SELECT pg_advisory_lock($1)", barrier); err != nil {
		t.Fatal(err)
	}
	held := true
	defer func() {
		if held {
			_, _ = blocker.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", barrier)
		}
	}()
	migrations := append([]migration(nil), schemaMigrations...)
	migrations[len(migrations)-1].sql = strings.Replace(migrations[len(migrations)-1].sql,
		"DO $$", "SELECT pg_advisory_xact_lock(7814501); DO $$", 1)
	migrator, migrationApplication := migrationInstance(t, s.Pool)
	writer, writerApplication := migrationInstance(t, s.Pool)
	migrated, written := make(chan error, 1), make(chan error, 1)
	go func() { migrated <- migrate(ctx, migrator, migrations) }()
	waitForMigration(t, func() bool {
		var blocked bool
		return s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a USING(pid)
			WHERE l.locktype='advisory' AND l.objid=7814501 AND NOT l.granted AND a.application_name=$1)`, migrationApplication).Scan(&blocked) == nil && blocked
	})
	go func() {
		_, err := writer.Exec(ctx, `UPDATE users SET name='concurrent field' WHERE id=$1`, queryID(1))
		written <- err
	}()
	waitForMigration(t, func() bool {
		var blocked bool
		return s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity w
			JOIN pg_stat_activity m ON m.pid=ANY(pg_blocking_pids(w.pid))
			WHERE w.application_name=$1 AND m.application_name=$2 AND w.wait_event_type='Lock')`, writerApplication, migrationApplication).Scan(&blocked) == nil && blocked
	})
	if _, err := blocker.Exec(ctx, "SELECT pg_advisory_unlock($1)", barrier); err != nil {
		t.Fatal(err)
	}
	held = false
	if err := receiveQueryResult(t, ctx, migrated); err != nil {
		t.Fatalf("migration failed: %v", err)
	}
	if err := receiveQueryResult(t, ctx, written); err != nil {
		t.Fatalf("concurrent source update failed: %v", err)
	}
	var coherent bool
	if err := s.Pool.QueryRow(ctx, `SELECT u.name='concurrent field' AND f.content=convert_to(u.name,'UTF8')
		FROM users u JOIN team_item_fields f ON f.kind='member' AND f.object_id=u.id AND f.field='profile.name'
		WHERE u.id=$1`, queryID(1)).Scan(&coherent); err != nil || !coherent {
		t.Fatalf("write after migration missed projection maintenance: %v %v", coherent, err)
	}
}
