package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
)

func TestProjectDirectMemberScopeResults(t *testing.T) {
	parallelRootDatabaseTest(t)
	db, _, target, p := membershipFixture(t)
	ctx := t.Context()
	called := false
	callback := func(store.ProjectDirectMemberScope) error { called = true; return nil }
	c, err := db.WriteProjectDirectMember(ctx, uuid.NewString(), callback)
	if c.Outcome != store.TransactionNotCommitted || !errors.Is(err, model.ErrNotFound) || called {
		t.Fatalf("missing project: %+v %v called=%t", c, err, called)
	}
	c, err = db.WriteProjectDirectMember(ctx, "malformed", callback)
	failed, _ := store.DatabaseErrorFacts(err)
	if c.Outcome != store.TransactionNotCommitted || !failed || called {
		t.Fatalf("invalid database input: %+v %v", c, err)
	}
	orphan := uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Orphan','https://example.test/orphan')`, orphan)
	c, err = db.WriteProjectDirectMember(ctx, orphan, callback)
	if c.Outcome != store.TransactionNotCommitted || err == nil || !strings.Contains(errChainText(err), "project ownership is missing") || called {
		t.Fatalf("missing ownership: %+v %v", c, err)
	}
	mustQueryExec(t, db, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, orphan, uuid.NewString())
	c, err = db.WriteProjectDirectMember(ctx, orphan, callback)
	if c.Outcome != store.TransactionNotCommitted || err == nil || !strings.Contains(errChainText(err), "project owner Team is missing") || called {
		t.Fatalf("missing Team: %+v %v", c, err)
	}
	cause := errors.New("abort after grant")
	c, err = db.WriteProjectDirectMember(ctx, p.ID, func(s store.ProjectDirectMemberScope) error {
		if _, e := s.ProjectDAO().CreateGrant(ctx, target.UserID, model.ProjectMemberRole); e != nil {
			return e
		}
		return cause
	})
	if c.Outcome != store.TransactionNotCommitted || !errors.Is(err, cause) {
		t.Fatalf("rollback: %+v %v", c, err)
	}
	var count int
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2`, p.ID, target.UserID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rollback persisted %d %v", count, err)
	}
	c, err = db.WriteProjectDirectMember(ctx, p.ID, func(s store.ProjectDirectMemberScope) error {
		if e := s.DirectMemberDAO().LockUser(ctx, target.UserID); e != nil {
			return e
		}
		_, e := s.ProjectDAO().CreateGrant(ctx, target.UserID, model.ProjectMemberRole)
		return e
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("commit %+v %v", c, err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2 AND role='member'`, p.ID, target.UserID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("commit persisted %d %v", count, err)
	}
	closed := closedStore(t)
	c, err = closed.WriteProjectDirectMember(ctx, p.ID, callback)
	if err == nil || c.Outcome != store.TransactionNotCommitted || called {
		t.Fatalf("closed pool %+v %v", c, err)
	}
}

func errChainText(err error) string {
	if err == nil {
		return ""
	}
	if multi, ok := err.(interface{ Unwrap() []error }); ok {
		var out string
		for _, e := range multi.Unwrap() {
			out += errChainText(e)
		}
		return err.Error() + out
	}
	return err.Error() + errChainText(errors.Unwrap(err))
}

func TestProjectDirectMemberScopeCancelsRootLockWaits(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, tc := range []struct{ name, table, prefix string }{
		{"project", "projects", "SELECT id::text FROM projects"},
		{"ownership", "project_ownership", "SELECT team_id::text FROM project_ownership"},
		{"team", "teams", "SELECT id::text FROM teams"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, _, _, p := membershipFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			holder, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback(context.Background())
			if _, err = holder.Exec(ctx, `LOCK TABLE `+tc.table+` IN ACCESS EXCLUSIVE MODE`); err != nil {
				t.Fatal(err)
			}
			query, stop := context.WithCancel(ctx)
			defer stop()
			done := make(chan error, 1)
			go func() {
				c, e := db.WriteProjectDirectMember(query, p.ID, func(store.ProjectDirectMemberScope) error { return errors.New("unexpected callback") })
				if c.Outcome == store.TransactionCommitted {
					done <- errors.New("canceled operation reported commit")
					return
				}
				done <- e
			}()
			testutil.WaitTransferTeamLock(t, ctx, db.Pool, tc.prefix, holder.Conn().PgConn().PID())
			stop()
			select {
			case e := <-done:
				if !errors.Is(e, context.Canceled) {
					t.Fatalf("cancellation: %v", e)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if err = holder.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			testutil.AssertPoolReusable(t, db.Pool)
		})
	}
}
