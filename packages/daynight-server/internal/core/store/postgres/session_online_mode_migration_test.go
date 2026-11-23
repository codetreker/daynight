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

func TestSessionOnlineModeMigrationAndPersistence(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 117 })
	if index < 1 {
		t.Fatal("online mode migration missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	oldID, newID, invalidID := queryID(925), queryID(926), queryID(927)
	insert := func(id string, offset int) {
		t.Helper()
		snapshot, err := json.Marshal(sp.Snapshot{SessionID: id, Lifecycle: "archived"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, `INSERT INTO task_sessions(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,'test',$2,$3,$4,'{}',$5)`, id, queryID(offset), queryID(offset+1), queryID(offset+2), snapshot); err != nil {
			t.Fatal(err)
		}
	}
	insert(oldID, 930)
	if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	insert(newID, 933)
	insert(invalidID, 936)
	if _, err := pool.Exec(ctx, `UPDATE task_sessions SET online_mode='' WHERE id=$1`, invalidID); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	dao := pgsession.New(tx)
	if _, err := dao.LockSession(ctx, invalidID); err == nil {
		t.Fatal("empty persisted mode was treated as unbound")
	}
	old, err := dao.LockSession(ctx, oldID)
	if err != nil || old.OnlineMode != "legacy" || old.HistoryContentPolicy != nil || old.Snapshot.Lifecycle != "archived" {
		t.Fatalf("old = %+v, %v", old, err)
	}
	fresh, err := dao.LockSession(ctx, newID)
	if err != nil || fresh.OnlineMode != "" || fresh.HistoryContentPolicy != nil {
		t.Fatalf("new = %+v, %v", fresh, err)
	}
	policy := "task_body"
	fresh.OnlineMode, fresh.HistoryContentPolicy = "relay", &policy
	if err = dao.SaveSession(ctx, fresh); err != nil {
		t.Fatal(err)
	}
	// Existing executions retain their old policy even if a later save supplies
	// different values; new executions acquire both fields only once.
	oldPolicy := "legacy"
	old.OnlineMode, old.HistoryContentPolicy = "relay", &oldPolicy
	if err = dao.SaveSession(ctx, old); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	migrated, err := pgsession.New(tx).LockSession(ctx, oldID)
	if err != nil || migrated.OnlineMode != "legacy" || migrated.HistoryContentPolicy != nil {
		t.Fatalf("old save changed binding: %+v, %v", migrated, err)
	}
	saved, err := pgsession.New(tx).LockSession(ctx, newID)
	if err != nil || saved.OnlineMode != "relay" || saved.HistoryContentPolicy == nil || *saved.HistoryContentPolicy != policy {
		t.Fatalf("saved = %+v, %v", saved, err)
	}
	saved.OnlineMode, saved.HistoryContentPolicy = "legacy", &oldPolicy
	if err = pgsession.New(tx).SaveSession(ctx, saved); err != nil {
		t.Fatal(err)
	}
	again, err := pgsession.New(tx).LockSession(ctx, newID)
	if err != nil || again.OnlineMode != "relay" || again.HistoryContentPolicy == nil || *again.HistoryContentPolicy != policy {
		t.Fatalf("binding overwritten: %+v, %v", again, err)
	}
}
