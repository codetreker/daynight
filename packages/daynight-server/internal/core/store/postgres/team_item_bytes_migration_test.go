package postgres

import (
	"bytes"
	"context"
	"errors"
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
		(SELECT name_bytes=convert_to(name,'UTF8') AND email_bytes IS NULL AND avatar_url_bytes=''::bytea FROM users WHERE id=$1)
		AND (SELECT name_bytes=convert_to(name,'UTF8') FROM teams WHERE id=$2)
		AND (SELECT name_bytes=convert_to(name,'UTF8') AND repo_url_bytes=convert_to(repo_url,'UTF8') FROM projects WHERE id=$3),
		(SELECT bool_and(updated_at='2026-01-01Z'::timestamptz) FROM users)
		AND (SELECT bool_and(updated_at='2026-01-01Z'::timestamptz) FROM teams)
		AND (SELECT updated_at='2026-01-01Z'::timestamptz FROM projects WHERE id=$3),
		(SELECT name_bytes IS NULL AND email_bytes IS NULL AND avatar_url_bytes IS NULL FROM users WHERE id=$4)
		AND (SELECT name_bytes IS NULL FROM teams WHERE id=$5)`, queryID(1), queryID(2), queryID(3), queryID(4), queryID(5)).Scan(&projections, &times, &nulls); err != nil || !projections || !times || !nulls {
		t.Fatalf("backfill projection/time/null facts: %v %v %v: %v", projections, times, nulls, err)
	}
	var external int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_attribute WHERE attrelid IN ('users'::regclass,'teams'::regclass,'projects'::regclass)
		AND attname IN ('name_bytes','email_bytes','avatar_url_bytes','repo_url_bytes') AND attstorage='e'`).Scan(&external); err != nil || external != 6 {
		t.Fatalf("expected six EXTERNAL projections, got %d: %v", external, err)
	}
	var compression *string
	var source, part []byte
	if err := s.Pool.QueryRow(ctx, `SELECT pg_column_compression(name_bytes),convert_to(name,'UTF8'),substring(name_bytes FROM 3 FOR 7) FROM users WHERE id=$1`, queryID(1)).Scan(&compression, &source, &part); err != nil || compression != nil || !bytes.Equal(part, source[2:9]) {
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
	if err := s.Pool.QueryRow(t.Context(), `SELECT count(*),bool_and(name_bytes IS NOT DISTINCT FROM convert_to(name,'UTF8')
		AND email_bytes IS NOT DISTINCT FROM convert_to(email,'UTF8')
		AND avatar_url_bytes IS NOT DISTINCT FROM convert_to(avatar_url,'UTF8')) FROM users`).Scan(&count, &valid); err != nil || count != 515 || !valid {
		t.Fatalf("multi-batch backfill: %d %v %v", count, valid, err)
	}
}

func TestTeamItemByteProjectionNullEmptyAndChanges(t *testing.T) {
	s := itemBytesMigratedStore(t)
	for _, column := range []string{"name", "email", "avatar_url"} {
		t.Run(column, func(t *testing.T) {
			for _, value := range []*string{nil, stringPointer(""), stringPointer("名字😀\n\""), nil} {
				mustQueryExec(t, s, `UPDATE users SET `+column+`=$2 WHERE id=$1`, queryID(1), value)
				var equal bool
				if err := s.Pool.QueryRow(t.Context(), `SELECT `+column+`_bytes IS NOT DISTINCT FROM convert_to(`+column+`,'UTF8') FROM users WHERE id=$1`, queryID(1)).Scan(&equal); err != nil || !equal {
					t.Fatalf("projection differs for %s: %v", column, err)
				}
			}
		})
	}
	mustQueryExec(t, s, `INSERT INTO users(id,uniauth_id,name,name_bytes,created_at,updated_at)
		VALUES($1,'insert-derived','right','wrong'::bytea,'2026-01-01Z','2026-01-01Z')`, queryID(6))
	var inserted string
	if err := s.Pool.QueryRow(t.Context(), `SELECT convert_from(name_bytes,'UTF8') FROM users WHERE id=$1`, queryID(6)).Scan(&inserted); err != nil || inserted != "right" {
		t.Fatalf("insert did not derive projection: %q %v", inserted, err)
	}
}

func stringPointer(value string) *string { return &value }

func TestTeamItemProjectionRejectsIndependentMutation(t *testing.T) {
	s := itemBytesMigratedStore(t)
	for _, item := range []struct{ table, column, id string }{
		{"users", "name_bytes", queryID(1)}, {"users", "email_bytes", queryID(1)}, {"users", "avatar_url_bytes", queryID(1)},
		{"teams", "name_bytes", queryID(2)}, {"projects", "name_bytes", queryID(3)}, {"projects", "repo_url_bytes", queryID(3)},
	} {
		t.Run(item.table+"/"+item.column, func(t *testing.T) {
			_, err := s.Pool.Exec(t.Context(), `UPDATE `+item.table+` SET `+item.column+`='tampered'::bytea WHERE id=$1`, item.id)
			var failure *pgconn.PgError
			if !errors.As(err, &failure) || failure.Code != "23514" {
				t.Fatalf("independent projection mutation was not rejected: %v", err)
			}
		})
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

func TestTeamItemProjectionMigrationRollsBackOnFailure(t *testing.T) {
	s := itemBytesMigrationSource(t)
	broken := append([]migration(nil), schemaMigrations...)
	broken[len(broken)-1].sql += `; SELECT 1/0;`
	if err := migrate(context.Background(), s.Pool, broken); err == nil {
		t.Fatal("expected migration failure")
	}
	var absent bool
	if err := s.Pool.QueryRow(t.Context(), `SELECT NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='users'::regclass AND attname='name_bytes' AND NOT attisdropped)
		AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=45)`).Scan(&absent); err != nil || !absent {
		t.Fatalf("failed migration exposed partial projection: %v %v", absent, err)
	}
	if err := migrate(t.Context(), s.Pool, schemaMigrations); err != nil {
		t.Fatalf("migration restart failed: %v", err)
	}
}
