package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestProjectDeletionGitHubFailuresRollBack(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, tc := range []struct{ name, column, code string }{
		{"invalidate connection", "enabled", "P1003"},
		{"clear webhook", "hook_repository_id", "P1004"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, _, _, project := membershipFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			mustQueryExec(t, db, `INSERT INTO project_github(project_id,enabled,sync_enabled,hook_repository_id,hook_version,hook_enabled,hook_secret,hook_last_received_at) VALUES($1,true,true,10,2,true,'secret'::bytea,now())`, project.ID)
			mustQueryExec(t, db, `INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at) VALUES($1,1,1,$2,'delivery',now(),now())`, project.ID, uuid.NewString())
			var epoch string
			if err := db.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&epoch); err != nil {
				t.Fatal(err)
			}
			mustQueryExec(t, db, `CREATE FUNCTION reject_project_github_deletion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='`+tc.code+`', MESSAGE='injected deletion failure'; END $$`)
			mustQueryExec(t, db, `CREATE TRIGGER reject_project_github_deletion BEFORE UPDATE OF `+tc.column+` ON project_github FOR EACH ROW EXECUTE FUNCTION reject_project_github_deletion()`)
			completion, err := db.WriteProjectDeletion(ctx, project.ID, func(scope store.ProjectDeletionScope) error {
				marked, err := scope.ProjectDAO().MarkDeleted(ctx)
				if marked {
					t.Error("failed deletion reported a marked project")
				}
				return err
			})
			var driver *pgconn.PgError
			if completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &driver) || driver.Code != tc.code {
				t.Fatalf("deletion failure: completion=%+v error=%v", completion, err)
			}
			var intact bool
			if err := db.Pool.QueryRow(ctx, `SELECT p.deleted_at IS NULL AND p.task_cache_epoch::text=$2 AND c.enabled AND c.sync_enabled AND c.hook_repository_id=10 AND c.hook_version=2 AND c.hook_enabled AND c.hook_secret='secret'::bytea AND c.hook_last_received_at IS NOT NULL AND EXISTS(SELECT 1 FROM project_github_pending_prs WHERE project_id=p.id AND number=1) FROM projects p JOIN project_github c ON c.project_id=p.id WHERE p.id=$1`, project.ID, epoch).Scan(&intact); err != nil || !intact {
				t.Fatalf("failed deletion changed persisted state: intact=%t error=%v", intact, err)
			}
		})
	}
}
