//go:build startupshutdown

package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestTaskAncestorMigrationCommittedStartupFailureAndRecovery(t *testing.T) {
	values := processAPIEnvironment(t)
	values["DAYNIGHT_WEBHOOK_ENABLED"] = "0"
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, values["DAYNIGHT_DATABASE_URL"])
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := postgres.ReplaySchema122ForTest(ctx, pool); err != nil {
		t.Fatal(err)
	}
	project, goal, child := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'Ancestor migration','https://example.test/ancestor-migration')`, []any{project}},
		{`INSERT INTO tasks(id,project_id,type,title,status,version,updated_at,deleted_at) VALUES($1,$2,'goal','Deleted Goal','done',9,'2026-01-03','2026-01-03')`, []any{goal, project}},
		{`INSERT INTO tasks(id,project_id,parent_id,title,status,version,updated_at) VALUES($1,$2,$3,'Retained child','done',9007199254740993,'2026-01-02')`, []any{child, project, goal}},
	} {
		if _, err := pool.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	var epoch string
	if err := pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	occupied, err := net.Listen("tcp", values["DAYNIGHT_LISTEN_ADDR"])
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	failed := startMigrationProcess(t, values)
	select {
	case err := <-failed.finished:
		failed.stopped = true
		var exit *exec.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != 1 {
			t.Fatalf("post-migration listener failure: %v; %s", err, failed.logs.String())
		}
	case <-ctx.Done():
		t.Fatal("post-migration startup failure did not terminate")
	}
	fresh, err := pgxpool.New(ctx, values["DAYNIGHT_DATABASE_URL"])
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close()
	sql, err := os.ReadFile(filepath.Join("..", "..", "internal", "core", "store", "postgres", "schema", "migrations", "123_task_ancestor_visibility.sql"))
	if err != nil {
		t.Fatal(err)
	}
	expectedChecksum := fmt.Sprintf("%x", sha256.Sum256(sql))
	var committed bool
	if err := fresh.QueryRow(ctx, `SELECT
 (SELECT checksum=$1 FROM schema_migrations WHERE version=123)
 AND (SELECT max(version)=126 FROM schema_migrations)
 AND (SELECT ancestor_deleted_at='2026-01-03'::timestamptz AND deleted_at IS NULL AND parent_id=$3 AND version=9007199254740993 AND updated_at='2026-01-02'::timestamptz FROM tasks WHERE id=$2)
 AND (SELECT effective_deleted_at='2026-01-03'::timestamptz FROM task_resource_rows WHERE id=$2)
 AND (SELECT task_cache_epoch::text=$5 FROM projects WHERE id=$4)`, expectedChecksum, child, goal, project, epoch).Scan(&committed); err != nil || !committed {
		t.Fatalf("fresh connection did not observe committed schema, backfill, checksum and epoch: %v %v; %s", committed, err, failed.logs.String())
	}
	var ledger string
	if err := fresh.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m`).Scan(&ledger); err != nil {
		t.Fatal(err)
	}
	if err := occupied.Close(); err != nil {
		t.Fatal(err)
	}
	recovered := startPersistenceProcess(t, values)
	if _, err := fresh.Exec(ctx, `INSERT INTO tasks(id,project_id,title,status) VALUES($1,$2,'Recovery read/write','todo')`, uuid.NewString(), project); err != nil {
		t.Fatal(err)
	}
	var sameLedger bool
	if err := fresh.QueryRow(ctx, `SELECT (SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m)=$1 AND (SELECT ancestor_deleted_at='2026-01-03'::timestamptz FROM tasks WHERE id=$2)`, ledger, child).Scan(&sameLedger); err != nil || !sameLedger {
		t.Fatalf("same-artifact recovery changed ledger or inheritance: %v %v", sameLedger, err)
	}
	if err := recovered.stop(); err != nil {
		t.Fatal(err)
	}
}
