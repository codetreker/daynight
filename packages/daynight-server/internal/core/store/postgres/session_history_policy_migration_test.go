package postgres

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
)

func TestSessionHistoryPolicyMigration(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 114 })
	if index < 1 {
		t.Fatal("history policy migration missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	id := queryID(921)
	snapshot, err := json.Marshal(sp.Snapshot{SessionID: id, Lifecycle: "archived"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO task_sessions(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,'test',$2,$3,$4,'{}',$5)`, id, queryID(922), queryID(923), queryID(924), snapshot); err != nil {
		t.Fatal(err)
	}
	if err = migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	read := func(want *string) {
		t.Helper()
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(context.Background())
		record, err := pgsession.New(tx).LockSession(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		if (record.HistoryContentPolicy == nil) != (want == nil) || want != nil && *record.HistoryContentPolicy != *want {
			t.Fatalf("policy readback: got=%v want=%v", record.HistoryContentPolicy, want)
		}
		if record.Snapshot.SessionID != id || record.Snapshot.Lifecycle != "archived" {
			t.Fatalf("migration changed original snapshot: %+v", record.Snapshot)
		}
	}
	read(nil)
	for _, policy := range []string{"legacy", "task_body"} {
		if _, err = pool.Exec(ctx, `UPDATE task_sessions SET history_content_policy=$2 WHERE id=$1`, id, policy); err != nil {
			t.Fatal(err)
		}
		read(&policy)
	}
	for _, policy := range []string{"", "unknown", "TASK_BODY"} {
		if _, err = pool.Exec(ctx, `UPDATE task_sessions SET history_content_policy=$2 WHERE id=$1`, id, policy); err == nil {
			t.Fatalf("migration accepted invalid policy %q", policy)
		}
	}
	want := "task_body"
	read(&want)
	// Ordinary Session saves do not overwrite the separately bound policy.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	dao := pgsession.New(tx)
	record, err := dao.LockSession(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	replacement := "legacy"
	record.HistoryContentPolicy = &replacement
	if err = dao.SaveSession(ctx, record); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	read(&want)
}
