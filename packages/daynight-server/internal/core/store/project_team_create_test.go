package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
)

func TestProjectCreationWaitsForTeamDeletion(t *testing.T) {
	for _, rollback := range []bool{false, true} {
		t.Run(map[bool]string{false: "commit", true: "rollback"}[rollback], func(t *testing.T) {
			s, actor, team := storeTeamFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			done := make(chan error, 1)
			projectID := uuid.NewString()
			abort := errors.New("abort deletion")
			err := s.WriteTeam(ctx, team.ID, func(tx *TeamTx) error {
				if err := tx.Delete(ctx); err != nil {
					return err
				}
				go func() {
					_, _, err := s.CreateProjectInTeam(ctx, actor, projectID, "Project", "host:repo", &team.ID)
					done <- err
				}()
				waitForQueryLock(t, s, "SELECT id::text,personal_user_id::text FROM teams WHERE")
				if rollback {
					return abort
				}
				return nil
			})
			if rollback && !errors.Is(err, abort) || !rollback && err != nil {
				t.Fatalf("delete: %v", err)
			}
			result := receiveQueryResult(t, ctx, done)
			if rollback && result != nil || !rollback && !errors.Is(result, core.ErrNotFound) {
				t.Fatalf("create: %v", result)
			}
			var count int
			if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM project_ownership WHERE project_id=$1`, projectID).Scan(&count); err != nil || count != map[bool]int{false: 0, true: 1}[rollback] {
				t.Fatalf("ownership count %d: %v", count, err)
			}
		})
	}
}

func TestTeamDeletionWaitsForActualProjectCreation(t *testing.T) {
	for _, rollback := range []bool{false, true} {
		t.Run(map[bool]string{false: "commit", true: "rollback"}[rollback], func(t *testing.T) {
			s, actor, team := storeTeamFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			holder, err := s.Pool.Acquire(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Release()
			if _, err := holder.Exec(ctx, `SELECT pg_advisory_lock(1938127)`); err != nil {
				t.Fatal(err)
			}
			defer holder.Exec(context.Background(), `SELECT pg_advisory_unlock(1938127)`)
			mustQueryExec(t, s, `CREATE FUNCTION block_project_creation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(1938127); IF NEW.name='rollback' THEN RAISE EXCEPTION 'rollback creation'; END IF; RETURN NEW; END $$; CREATE TRIGGER block_project_creation BEFORE INSERT ON projects FOR EACH ROW EXECUTE FUNCTION block_project_creation()`)
			name := "Project"
			if rollback {
				name = "rollback"
			}
			created := make(chan error, 1)
			go func() {
				_, _, err := s.CreateProjectInTeam(ctx, actor, uuid.NewString(), name, "host:repo", &team.ID)
				created <- err
			}()
			waitForQueryLock(t, s, "INSERT INTO projects")
			occupied := errors.New("Team has projects")
			deleted := make(chan error, 1)
			go func() {
				deleted <- s.WriteTeam(ctx, team.ID, func(tx *TeamTx) error {
					found, err := tx.HasProjects(ctx)
					if err != nil {
						return err
					}
					if found {
						return occupied
					}
					return tx.Delete(ctx)
				})
			}()
			waitForQueryLock(t, s, "SELECT id::text FROM teams WHERE")
			if _, err := holder.Exec(ctx, `SELECT pg_advisory_unlock(1938127)`); err != nil {
				t.Fatal(err)
			}
			createErr := receiveQueryResult(t, ctx, created)
			if rollback && createErr == nil || !rollback && createErr != nil {
				t.Fatalf("create outcome %v", createErr)
			}
			deleteErr := receiveQueryResult(t, ctx, deleted)
			if rollback && deleteErr != nil || !rollback && !errors.Is(deleteErr, occupied) {
				t.Fatalf("delete outcome %v", deleteErr)
			}
		})
	}
}

func TestProjectCreationCommitResponseLoss(t *testing.T) {
	s, actor, team := storeTeamFixture(t)
	ctx := context.Background()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	lost := errors.New("commit response lost")
	id := uuid.NewString()
	_, _, err = createProjectInTeamTx(ctx, &threadCommitResponseLoss{Tx: tx, cause: lost}, actor, id, "Created", "host:repo", &team.ID)
	var failure *TransactionError
	if !errors.Is(err, lost) || !errors.As(err, &failure) || !failure.CommitAttempted || failure.Outcome != TransactionUnknown {
		t.Fatalf("unknown commit: %#v %v", failure, err)
	}
	var count int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM projects p JOIN project_ownership o ON o.project_id=p.id JOIN project_grants g ON g.project_id=p.id WHERE p.id=$1 AND o.team_id=$2 AND g.user_id=$3 AND g.role='admin'`, id, team.ID, actor.UserID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("actual committed data: %d %v", count, err)
	}
}
