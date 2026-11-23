package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
)

func TestRepositoryWriteScopeRootFailures(t *testing.T) {
	for _, name := range []string{"missing project", "missing ownership", "missing team", "invalid actor", "cancelled begin"} {
		t.Run(name, func(t *testing.T) {
			db := isolatedStore(t)
			actor, _, project := testutil.ProjectMembershipFixture(t, db)
			projectID, actorID := project.ID, actor.UserID
			ctx := t.Context()
			switch name {
			case "missing project":
				projectID = uuid.NewString()
			case "missing ownership":
				if _, err := db.Pool.Exec(ctx, `DELETE FROM project_ownership WHERE project_id=$1`, projectID); err != nil {
					t.Fatal(err)
				}
			case "missing team":
				if _, err := db.Pool.Exec(ctx, `DELETE FROM teams WHERE id=$1`, project.Ownership.TeamID); err != nil {
					t.Fatal(err)
				}
			case "invalid actor":
				actorID = "invalid-uuid"
			case "cancelled begin":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			called := false
			completion, err := db.WriteProjectRepository(ctx, projectID, actorID, func(store.ProjectRepositoryWriteScope) error { called = true; return nil })
			if err == nil || called || completion.Outcome != store.TransactionNotCommitted {
				t.Fatalf("root failure %s: completion=%+v called=%v err=%v", name, completion, called, err)
			}
			if (name == "missing project" || name == "missing ownership" || name == "missing team") && !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("missing root error: %v", err)
			}
			if name == "cancelled begin" && !errors.Is(err, context.Canceled) {
				t.Fatalf("cancellation: %v", err)
			}
		})
	}
}
