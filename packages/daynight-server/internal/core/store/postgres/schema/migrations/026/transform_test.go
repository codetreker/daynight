package store

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func legacyPropertyTransaction(t *testing.T) pgx.Tx {
	t.Helper()
	conn, err := pgx.Connect(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	tx, err := conn.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	if _, err := tx.Exec(t.Context(), `CREATE TABLE tasks (id uuid PRIMARY KEY, properties text NOT NULL, title text NOT NULL);`+SQL()); err != nil {
		t.Fatal(err)
	}
	return tx
}

func TestApplyMigratesEveryBatchAndPreservesLegacyValues(t *testing.T) {
	tx := legacyPropertyTransaction(t)
	expected := make(map[string]map[string]any)
	for i := 1; i <= 101; i++ {
		var worker any
		if i%2 == 0 {
			value := legacyWorker026Fixture()
			delete(value, "agentControlMode")
			worker = value
		}
		properties := map[string]any{
			"pullRequests": []any{map[string]any{"url": "opaque\x00", "title": "Unicode 中文"}, map[string]any{"url": "same", "title": "duplicate"}, map[string]any{"url": "same", "title": "duplicate"}},
			"worker":       worker,
		}
		raw, err := json.Marshal(properties)
		if err != nil {
			t.Fatal(err)
		}
		id := queryID(i)
		if _, err := tx.Exec(t.Context(), `INSERT INTO tasks(id,properties,title) VALUES($1,$2,'Preserved')`, id, string(raw)); err != nil {
			t.Fatal(err)
		}
		if worker == nil {
			delete(properties, "worker")
		} else {
			worker.(map[string]any)["agentControlMode"] = "herdr"
		}
		expected[id] = properties
	}
	if err := Apply(t.Context(), tx); err != nil {
		t.Fatal(err)
	}
	rows, err := tx.Query(t.Context(), `SELECT task_id::text,name,value FROM task_properties ORDER BY task_id,name`)
	if err != nil {
		t.Fatal(err)
	}
	actual := make(map[string]map[string]any)
	for rows.Next() {
		var id, name, raw string
		if err := rows.Scan(&id, &name, &raw); err != nil {
			t.Fatal(err)
		}
		var value any
		if err := json.Unmarshal([]byte(raw), &value); err != nil {
			t.Fatal(err)
		}
		if actual[id] == nil {
			actual[id] = make(map[string]any)
		}
		actual[id][name] = value
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("migrated values differ: got %#v; want %#v", actual, expected)
	}
	var preserved int
	if err := tx.QueryRow(t.Context(), `SELECT count(*) FROM tasks WHERE title='Preserved'`).Scan(&preserved); err != nil || preserved != len(expected) {
		t.Fatalf("parent rows changed: count=%d, error=%v", preserved, err)
	}
	var oldColumn bool
	if err := tx.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='tasks' AND column_name='properties')`).Scan(&oldColumn); err != nil || oldColumn {
		t.Fatalf("legacy properties column remains: %v, %v", oldColumn, err)
	}
}

func TestApplyRejectsInvalidLegacyValueBeforeDroppingColumn(t *testing.T) {
	tx := legacyPropertyTransaction(t)
	id := queryID(1)
	if _, err := tx.Exec(t.Context(), `INSERT INTO tasks(id,properties,title) VALUES($1,'{"pullRequests":null,"worker":null}','Invalid')`, id); err != nil {
		t.Fatal(err)
	}
	if err := Apply(t.Context(), tx); err == nil || !strings.Contains(err.Error(), "migrate task "+id+" properties:") || !strings.Contains(err.Error(), "must be an array") {
		t.Fatalf("legacy decode error lost task context: %v", err)
	}
	var original string
	if err := tx.QueryRow(t.Context(), `SELECT properties FROM tasks WHERE id=$1`, id).Scan(&original); err != nil || original != `{"pullRequests":null,"worker":null}` {
		t.Fatalf("legacy data changed after validation failure: %q, %v", original, err)
	}
}

func TestApplyPreservesPropertyInsertFailure(t *testing.T) {
	tx := legacyPropertyTransaction(t)
	id := queryID(1)
	if _, err := tx.Exec(t.Context(), `INSERT INTO tasks(id,properties,title) VALUES($1,'{"pullRequests":[],"worker":null}','Conflict')`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests','[]')`, id); err != nil {
		t.Fatal(err)
	}
	err := Apply(t.Context(), tx)
	var databaseError *pgconn.PgError
	if !errors.As(err, &databaseError) || databaseError.Code != "23505" || databaseError.ConstraintName != "task_properties_pkey" {
		t.Fatalf("property insertion error was changed: %v", err)
	}
}
