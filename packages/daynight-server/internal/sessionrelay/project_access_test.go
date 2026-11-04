package sessionrelay

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestProjectAdmissionUsesCallerTransaction(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	tx, err := f.s.DB.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `UPDATE project_grants SET role='member' WHERE project_id=$1 AND user_id=$2`, f.project, f.p.UserID); err != nil {
		t.Fatal(err)
	}
	admin, err := member(ctx, tx, f.p, f.project, time.Now())
	if err != nil || admin {
		t.Fatal("admission ignored the caller's uncommitted role", admin, err)
	}
	if _, err = tx.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, f.project, f.p.UserID); err != nil {
		t.Fatal(err)
	}
	_, err = member(ctx, tx, f.p, f.project, time.Now())
	assertAdmissionDenied(t, err)
}

func TestProjectAdmissionDoesNotHoldGrantUntilCommit(t *testing.T) {
	f := setup(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := f.s.DB.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if admin, err := member(ctx, tx, f.p, f.project, time.Now()); err != nil || !admin {
		t.Fatal("initial admission failed", admin, err)
	}
	// Revocation must commit while the admitted Session transaction remains open.
	if _, err = f.s.DB.Pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, f.project, f.p.UserID); err != nil {
		t.Fatal("Session admission blocked grant revocation", err)
	}
	_, err = member(ctx, tx, f.p, f.project, time.Now())
	assertAdmissionDenied(t, err)
}

func TestProjectAdmissionRequiresCanonicalProjectAndUser(t *testing.T) {
	for _, table := range []string{"projects", "users"} {
		t.Run(table, func(t *testing.T) {
			f, _ := connectFixture(t)
			ctx := context.Background()
			id := f.project
			if table == "users" {
				id = f.p.UserID
			}
			// No foreign keys: a surviving grant alone cannot authorize a resource.
			if _, err := f.s.DB.Pool.Exec(ctx, `DELETE FROM `+table+` WHERE id=$1`, id); err != nil {
				t.Fatal(err)
			}
			_, err := f.s.Current(ctx, f.p, f.project, f.task)
			if table == "users" {
				var query *store.Error
				var refusal *service.Fault
				if !errors.As(err, &query) || errors.As(err, &refusal) {
					t.Fatal("missing canonical access profile was hidden as a refusal", err)
				}
			} else {
				assertAdmissionDenied(t, err)
			}
		})
	}
}

func TestProjectAdmissionPreservesQueryFailure(t *testing.T) {
	f, _ := connectFixture(t)
	ctx := context.Background()
	if _, err := f.s.DB.Pool.Exec(ctx, `ALTER TABLE project_grants RENAME TO unavailable_project_grants`); err != nil {
		t.Fatal(err)
	}
	_, err := f.s.Current(ctx, f.p, f.project, f.task)
	var query *store.Error
	var database *pgconn.PgError
	var refusal *service.Fault
	if !errors.As(err, &query) || !errors.As(err, &database) || database.Code != "42P01" || errors.As(err, &refusal) {
		t.Fatal("admission query failure lost its cause or became a refusal", err)
	}
}

func assertAdmissionDenied(t *testing.T, err error) {
	t.Helper()
	var refusal *service.Fault
	if !errors.As(err, &refusal) || refusal.Code != "forbidden" {
		t.Fatal("expected forbidden admission", err)
	}
}
