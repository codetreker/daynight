package task_test

import (
	"context"
	"errors"
	"testing"
	"time"

	pgtask "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestAncestorAdmissionAndStartPropagateDatabaseFailure(t *testing.T) {
	db := writerStore(t)
	project := writerProject(t, db, 320)
	tx, err := db.Pool.Begin(t.Context())
	mustOK(t, err)
	mustOK(t, tx.Rollback(t.Context()))
	dao := pgtask.NewWriter(tx, project.ID)
	if _, err := dao.HasTerminalAncestorGoal(t.Context(), testutil.QueryID(321)); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("ancestor admission lost transaction error: %v", err)
	}
	if _, err := dao.TaskForStart(t.Context(), testutil.QueryID(321)); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("start planner lost transaction error: %v", err)
	}
}

func TestTaskStartLocksTargetAndDirectGoalInUUIDOrder(t *testing.T) {
	for _, goalFirst := range []bool{false, true} {
		t.Run(map[bool]string{true: "goal_first", false: "task_first"}[goalFirst], func(t *testing.T) {
			db := writerStore(t)
			project := writerProject(t, db, 300)
			goal, child := testutil.QueryID(301), testutil.QueryID(302)
			if !goalFirst {
				goal, child = child, goal
			}
			_, err := db.Pool.Exec(t.Context(), `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'goal','Goal','todo')`, goal, project.ID)
			mustOK(t, err)
			_, err = db.Pool.Exec(t.Context(), `INSERT INTO tasks(id,project_id,parent_id,type,title,status) VALUES($1,$2,$3,'task','Child','todo')`, child, project.ID, goal)
			mustOK(t, err)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			blocker, err := db.Pool.Begin(ctx)
			mustOK(t, err)
			defer blocker.Rollback(context.Background())
			first, second := child, goal
			if goalFirst {
				first, second = goal, child
			}
			_, err = blocker.Exec(ctx, `SELECT id FROM tasks WHERE id=$1 FOR SHARE`, second)
			mustOK(t, err)
			starter, err := db.Pool.Begin(ctx)
			mustOK(t, err)
			defer starter.Rollback(context.Background())
			done := make(chan error, 1)
			go func() { _, err := pgtask.NewWriter(starter, project.ID).TaskForStart(ctx, child); done <- err }()
			testutil.WaitThreadBackendLock(t, db.Pool, starter.Conn().PgConn().PID())
			probe, err := db.Pool.Begin(ctx)
			mustOK(t, err)
			_, lockErr := probe.Exec(ctx, `SELECT id FROM tasks WHERE id=$1 FOR SHARE NOWAIT`, first)
			mustOK(t, probe.Rollback(ctx))
			var fault *pgconn.PgError
			if !errors.As(lockErr, &fault) || fault.Code != "55P03" {
				t.Fatalf("lower UUID was not already locked: %v", lockErr)
			}
			mustOK(t, blocker.Rollback(ctx))
			select {
			case err := <-done:
				mustOK(t, err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		})
	}
}
