package postgres

import (
	"errors"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestTagColorMigrationAndBootstrap(t *testing.T) {
	for _, bootstrap := range []bool{false, true} {
		name := "upgrade"
		if bootstrap {
			name = "bootstrap"
		}
		t.Run(name, func(t *testing.T) {
			ctx, pool := t.Context(), emptyPool(t)
			if len(schemaMigrations) < 74 || schemaMigrations[72].version != 73 || schemaMigrations[73].version != 74 {
				t.Fatal("color migration is not the successor of version 73")
			}
			if bootstrap {
				if err := initializeSchema(ctx, pool, schemaMigrations, currentSchemaSnapshot); err != nil {
					t.Fatal(err)
				}
			} else {
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
		})
	}
}

func TestTagColorMigrationFailureRollsBack(t *testing.T) {
	ctx, pool := t.Context(), emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:73]); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at) VALUES ($1,$2,'old','old',now(),now())`, queryID(1), queryID(2)); err != nil {
		t.Fatal(err)
	}
	migrations := slices.Clone(schemaMigrations)
	migrations[73].sql += "\nSELECT 1 / 0;"
	if err := migrate(ctx, pool, migrations); err == nil {
		t.Fatal("expected migration failure")
	}
	var columns, ledger, rows int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='project_tags' AND column_name='color'),(SELECT count(*) FROM schema_migrations WHERE version=74),(SELECT count(*) FROM project_tags)`).Scan(&columns, &ledger, &rows); err != nil || columns != 0 || ledger != 0 || rows != 1 {
		t.Fatalf("partial migration: column=%d ledger=%d rows=%d err=%v", columns, ledger, rows, err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatalf("migration recovery: %v", err)
	}
}
