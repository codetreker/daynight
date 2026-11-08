package session

import "github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgconn"
)

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
			if _, err := f.db.Pool.Exec(ctx, `DELETE FROM `+table+` WHERE id=$1`, id); err != nil {
				t.Fatal(err)
			}
			_, err := f.s.Current(ctx, f.p, f.project, f.task)
			if table == "users" {
				var query *store.Error
				var refusal *model.Fault
				if !errors.As(err, &query) || errors.As(err, &refusal) {
					t.Fatal("missing canonical access profile was hidden as a refusal", err)
				}
			} else {
				var refusal *model.Fault
				if !errors.As(err, &refusal) || refusal.Code != "not_found" {
					t.Fatal("missing Project was not hidden as not found", err)
				}
			}
		})
	}
}

func TestProjectAdmissionPreservesQueryFailure(t *testing.T) {
	f, _ := connectFixture(t)
	ctx := context.Background()
	if _, err := f.db.Pool.Exec(ctx, `ALTER TABLE project_grants RENAME TO unavailable_project_grants`); err != nil {
		t.Fatal(err)
	}
	_, err := f.s.Current(ctx, f.p, f.project, f.task)
	var query *store.Error
	var database *pgconn.PgError
	var refusal *model.Fault
	if !errors.As(err, &query) || !errors.As(err, &database) || database.Code != "42P01" || errors.As(err, &refusal) {
		t.Fatal("admission query failure lost its cause or became a refusal", err)
	}
}

func assertAdmissionDenied(t *testing.T, err error) {
	t.Helper()
	var refusal *model.Fault
	if !errors.As(err, &refusal) || refusal.Code != "forbidden" {
		t.Fatal("expected forbidden admission", err)
	}
}
