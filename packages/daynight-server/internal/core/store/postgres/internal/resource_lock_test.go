package pg_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func resourceLockFixture(t *testing.T, goal, task string) (*postgres.Store, string) {
	t.Helper()
	db, err := postgres.Open(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	project := uuid.NewString()
	testutil.MustExec(t, db.Pool, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Project','repo')`, project)
	testutil.MustExec(t, db.Pool, `INSERT INTO tasks(id,project_id,type,title,description,status,parent_id) VALUES($1,$3,'goal','Goal','','todo',NULL),($2,$3,'task','Task','','todo',$1)`, goal, task, project)
	return db, project
}

func TestResourceLockDoesNotWaitForParent(t *testing.T) {
	goal, task := testutil.QueryID(1), testutil.QueryID(2)
	db, project := resourceLockFixture(t, goal, task)
	testutil.MustExec(t, db.Pool, `UPDATE tasks SET type='task' WHERE id=$1`, goal)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	parent, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Rollback(context.Background())
	if _, err = parent.Exec(ctx, `SELECT id FROM tasks WHERE id=$1 FOR UPDATE`, goal); err != nil {
		t.Fatal(err)
	}
	for _, update := range []bool{false, true} {
		target, err := db.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		presence, err := pg.LockTaskResource(ctx, target, project, task, update)
		if err != nil || !presence.Found || presence.DeletedAt != nil {
			t.Fatalf("resource admission: %+v %v", presence, err)
		}
		if err = target.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
	}
}

func TestResourceLockSerializesInheritedDeletion(t *testing.T) {
	for _, update := range []bool{false, true} {
		for _, deletionFirst := range []bool{false, true} {
			t.Run(fmt.Sprintf("update=%v/deletionFirst=%v", update, deletionFirst), func(t *testing.T) {
				goal, task := testutil.QueryID(1), testutil.QueryID(2)
				db, project := resourceLockFixture(t, goal, task)
				ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
				defer cancel()
				first, err := db.Pool.Acquire(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer first.Release()
				tx, err := first.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(context.Background())
				stamp := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
				if deletionFirst {
					_, err = tx.Exec(ctx, `UPDATE tasks SET ancestor_deleted_at=$2 WHERE id=$1`, task, stamp)
				} else {
					var presence store.TaskPresence
					presence, err = pg.LockTaskResource(ctx, tx, project, task, update)
					if err == nil && (!presence.Found || presence.DeletedAt != nil) {
						t.Fatalf("first admission: %+v", presence)
					}
				}
				if err != nil {
					t.Fatal(err)
				}
				result := make(chan error, 1)
				go func() {
					other, e := db.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
					if e != nil {
						result <- e
						return
					}
					defer other.Rollback(context.Background())
					if deletionFirst {
						var presence store.TaskPresence
						presence, e = pg.LockTaskResource(ctx, other, project, task, update)
						if e == nil && (!presence.Found || presence.DeletedAt == nil || !presence.DeletedAt.Equal(stamp)) {
							e = fmt.Errorf("post-delete admission: %+v", presence)
						}
					} else {
						_, e = other.Exec(ctx, `UPDATE tasks SET ancestor_deleted_at=$2 WHERE id=$1`, task, stamp)
					}
					if e == nil {
						e = other.Commit(ctx)
					}
					result <- e
				}()
				query := "UPDATE tasks SET ancestor_deleted_at="
				if deletionFirst {
					query = "SELECT COALESCE(deleted_at, ancestor_deleted_at) FROM tasks"
				}
				testutil.WaitTransferTeamLock(t, ctx, db.Pool, query, first.Conn().PgConn().PID())
				if err = tx.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				if err = testutil.ReceiveQueryResult(t, ctx, result); err != nil {
					t.Fatal(err)
				}
				var physical *time.Time
				var version int64
				if err = db.Pool.QueryRow(ctx, `SELECT deleted_at,version FROM tasks WHERE id=$1`, task).Scan(&physical, &version); err != nil || physical != nil || version != 1 {
					t.Fatalf("hidden row physical=%v version=%d err=%v", physical, version, err)
				}
			})
		}
	}
}

func TestResourceLockMissingAndDriverFailures(t *testing.T) {
	tx := helperTransaction(t)
	project, task := helperTask(t, tx)
	ctx := t.Context()
	for _, update := range []bool{false, true} {
		presence, err := pg.LockTaskResource(ctx, tx, project, uuid.NewString(), update)
		if err != nil || presence.Found {
			t.Fatalf("missing presence: %+v %v", presence, err)
		}
		cause := &pgconn.PgError{Code: "08006", Message: "connection lost"}
		_, err = pg.LockTaskResource(ctx, failedHelperTx{cause: cause}, project, task, update)
		if !errors.Is(err, cause) {
			t.Fatalf("lost lock cause: %v", err)
		}
	}
	if _, err := pg.LockTaskResource(ctx, tx, project, "invalid", false); err == nil {
		t.Fatal("invalid UUID accepted")
	}
}
