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
		var policy *string
		var raw []byte
		if err := pool.QueryRow(ctx, `SELECT history_content_policy, snapshot FROM task_sessions WHERE id=$1`, id).Scan(&policy, &raw); err != nil {
			t.Fatal(err)
		}
		if (policy == nil) != (want == nil) || want != nil && *policy != *want {
			t.Fatalf("policy readback: got=%v want=%v", policy, want)
		}
		var saved sp.Snapshot
		if err := json.Unmarshal(raw, &saved); err != nil || saved.SessionID != id || saved.Lifecycle != "archived" {
			t.Fatalf("migration changed original snapshot: %+v, %v", saved, err)
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
	// The current DAO must preserve the migrated execution's established policy.
	if err = migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	dao := pgsession.New(tx)
	record, err := dao.LockSession(ctx, id)
	if err != nil || record.OnlineMode != "legacy" || record.HistoryContentPolicy == nil || *record.HistoryContentPolicy != want {
		t.Fatalf("current DAO: %+v %v", record, err)
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
