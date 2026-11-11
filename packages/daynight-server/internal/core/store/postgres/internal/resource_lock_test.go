package pg_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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

func TestResourceLockParentChangeRefusesBeforeSideEffects(t *testing.T) {
	goal, task, replacement := testutil.QueryID(1), testutil.QueryID(3), testutil.QueryID(2)
	db, project := resourceLockFixture(t, goal, task)
	testutil.MustExec(t, db.Pool, `INSERT INTO tasks(id,project_id,type,title,description,status) VALUES($1,$2,'goal','Replacement','','todo')`, replacement, project)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	blocker, err := db.Pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Release()
	tx, err := blocker.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT id FROM tasks WHERE id=$1 FOR UPDATE`, goal); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		worker, e := db.Pool.Begin(ctx)
		if e != nil {
			result <- e
			return
		}
		defer worker.Rollback(context.Background())
		_, e = pg.LockTaskResource(ctx, worker, project, task, false)
		if e == nil {
			_, e = worker.Exec(ctx, `UPDATE tasks SET title='unexpected' WHERE id=$1`, task)
		}
		if e == nil {
			e = worker.Commit(ctx)
		}
		result <- e
	}()
	testutil.WaitTransferTeamLock(t, ctx, db.Pool, `SELECT id::text FROM tasks WHERE project_id=`, blocker.Conn().PgConn().PID())
	if _, err = tx.Exec(ctx, `UPDATE tasks SET parent_id=$2 WHERE id=$1`, task, replacement); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	err = testutil.ReceiveQueryResult(t, ctx, result)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "resource_conflict" {
		t.Fatalf("changed parent error = %v", err)
	}
	var title, parent string
	if err = db.Pool.QueryRow(ctx, `SELECT title,parent_id::text FROM tasks WHERE id=$1`, task).Scan(&title, &parent); err != nil || title != "Task" || parent != replacement {
		t.Fatalf("persisted task title=%q parent=%q err=%v", title, parent, err)
	}
}

func TestResourceLockRegistrationAndGoalDeletion(t *testing.T) {
	for _, tc := range []struct{ name, goal, task string }{
		{"parent_first", testutil.QueryID(1), testutil.QueryID(2)},
		{"target_first", testutil.QueryID(2), testutil.QueryID(1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, project := resourceLockFixture(t, tc.goal, tc.task)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
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
			presence, err := pg.LockTaskResource(ctx, tx, project, tc.task, true)
			if err != nil || !presence.Found || presence.DeletedAt != nil {
				t.Fatalf("first registration: %+v %v", presence, err)
			}
			result := make(chan error, 1)
			go func() {
				other, e := db.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
				if e != nil {
					result <- e
					return
				}
				defer other.Rollback(context.Background())
				p, e := pg.LockTaskResource(ctx, other, project, tc.task, true)
				if e == nil && (!p.Found || p.DeletedAt != nil) {
					e = errors.New("second registration lost resource")
				}
				if e == nil {
					e = other.Commit(ctx)
				}
				result <- e
			}()
			testutil.WaitTransferTeamLock(t, ctx, db.Pool, `SELECT id::text FROM tasks WHERE project_id=`, first.Conn().PgConn().PID())
			if err = tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err = testutil.ReceiveQueryResult(t, ctx, result); err != nil {
				t.Fatalf("second registration: %v", err)
			}
			// The same lock plan reports the parent's effective deletion after it commits.
			testutil.MustExec(t, db.Pool, `UPDATE tasks SET deleted_at=now() WHERE id=$1`, tc.goal)
			read, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer read.Rollback(context.Background())
			presence, err = pg.LockTaskResource(ctx, read, project, tc.task, false)
			if err != nil || !presence.Found || presence.DeletedAt == nil {
				t.Fatalf("deleted parent: %+v %v", presence, err)
			}
		})
	}
}

func TestResourceLockRejectsMissingAndInvalidResources(t *testing.T) {
	goal, task := testutil.QueryID(1), testutil.QueryID(2)
	db, project := resourceLockFixture(t, goal, task)
	ctx := t.Context()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	presence, err := pg.LockTaskResource(ctx, tx, project, uuid.NewString(), false)
	if err != nil || presence.Found {
		t.Fatalf("missing resource: %+v %v", presence, err)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	testutil.MustExec(t, db.Pool, `UPDATE tasks SET parent_id=$2 WHERE id=$1`, task, uuid.NewString())
	tx, err = db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pg.LockTaskResource(ctx, tx, project, task, false); err == nil {
		t.Fatal("missing parent accepted")
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	testutil.MustExec(t, db.Pool, `UPDATE tasks SET parent_id=$1 WHERE id=$1`, task)
	tx, err = db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pg.LockTaskResource(ctx, tx, project, task, true); err == nil {
		t.Fatal("non-Goal parent accepted")
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	tx, err = db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pg.LockTaskResource(ctx, tx, project, "invalid", false); err == nil {
		t.Fatal("invalid UUID accepted")
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	testutil.MustExec(t, db.Pool, `UPDATE tasks SET parent_id=$2 WHERE id=$1`, task, goal)
	testutil.MustExec(t, db.Pool, `DROP VIEW task_resource_rows`)
	tx, err = db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pg.LockTaskResource(ctx, tx, project, task, false); err == nil {
		t.Fatal("missing resource view accepted")
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
}
