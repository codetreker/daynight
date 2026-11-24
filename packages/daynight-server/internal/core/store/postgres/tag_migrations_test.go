package postgres

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestTagColorDefaultAndConstraint(t *testing.T) {
	ctx, pool := t.Context(), isolatedStore(t).Pool
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
