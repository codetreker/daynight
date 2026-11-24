package postgres

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestProjectCreationWaitsForTeamDeletion(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	for _, rollback := range []bool{false, true} {
		if !t.Run(map[bool]string{false: "commit", true: "rollback"}[rollback], func(t *testing.T) {
			actor, team := testutil.TeamFixture(t, s)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			var workers sync.WaitGroup
			defer func() {
				cancel()
				workers.Wait()
			}()
			done := make(chan error, 1)
			projectID := uuid.NewString()
			abort := errors.New("abort deletion")
			_, err := s.WriteTeam(ctx, team.ID, func(scope TeamWriteScope) error {
				tx := scope.TeamDAO()
				if err := tx.Delete(ctx); err != nil {
					return err
				}
				workers.Go(func() {
					_, _, err := s.CreateProjectInTeam(ctx, actor, projectID, "Project", "host:repo", &team.ID)
					done <- err
				})
				testutil.WaitTransferTeamLock(t, ctx, s.Pool, "SELECT id::text,personal_user_id::text FROM teams WHERE", scope.(teamWriteScope).tx.Conn().PgConn().PID())
				if rollback {
					return abort
				}
				return nil
			})
			if rollback && !errors.Is(err, abort) || !rollback && err != nil {
				t.Fatalf("delete: %v", err)
			}
			result := receiveQueryResult(t, ctx, done)
			if rollback && result != nil || !rollback && !errors.Is(result, model.ErrNotFound) {
				t.Fatalf("create: %v", result)
			}
			var projects, ownerships, grants int
			if err := s.Pool.QueryRow(ctx, `SELECT
				(SELECT count(*) FROM projects WHERE id=$1),
				(SELECT count(*) FROM project_ownership WHERE project_id=$1),
				(SELECT count(*) FROM project_grants WHERE project_id=$1)`, projectID).Scan(&projects, &ownerships, &grants); err != nil {
				t.Fatal(err)
			}
			want := map[bool]int{false: 0, true: 1}[rollback]
			if projects != want || ownerships != want || grants != want {
				t.Fatalf("Team deletion/creation left inconsistent Project resources: projects=%d ownerships=%d grants=%d want=%d", projects, ownerships, grants, want)
			}
		}) {
			return
		}
		testutil.AssertPoolReusable(t, s.Pool)
	}
}

func TestTeamDeletionWaitsForActualProjectCreation(t *testing.T) {
	parallelRootDatabaseTest(t)
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
				deleted <- testWriteTeam(s, ctx, team.ID, func(tx TeamWriteDAO) error {
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
	parallelRootDatabaseTest(t)
	s, actor, team := storeTeamFixture(t)
	ctx := context.Background()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	lost := errors.New("commit response lost")
	id := uuid.NewString()
	err = writeProjectCreationTx(ctx, &threadCommitResponseLoss{Tx: tx, cause: lost}, actor.UserID, func(dao ProjectCreationDAO) error {
		_, _, err := coreproject.Create(ctx, dao, actor.UserID, id, coreproject.CreateProject{Name: "Created", RepoURL: "host:repo", TeamID: &team.ID})
		return err
	})
	var failure *TransactionError
	if !errors.Is(err, lost) || !errors.As(err, &failure) || !failure.CommitAttempted || failure.Outcome != TransactionUnknown {
		t.Fatalf("unknown commit: %#v %v", failure, err)
	}
	var count int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM projects p JOIN project_ownership o ON o.project_id=p.id JOIN project_grants g ON g.project_id=p.id WHERE p.id=$1 AND o.team_id=$2 AND g.user_id=$3 AND g.role='admin'`, id, team.ID, actor.UserID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("actual committed data: %d %v", count, err)
	}
}

func TestTransferUpdateFailureRollsBackOwnershipAndProject(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, table := range []string{"project_ownership", "projects"} {
		t.Run(table, func(t *testing.T) {
			s, actor, _, project := membershipFixture(t)
			ctx := context.Background()
			target, err := testCreateTeam(s, ctx, actor.UserID, uuid.NewString(), "Target")
			if err != nil {
				t.Fatal(err)
			}
			var beforeUpdated time.Time
			if err := s.Pool.QueryRow(ctx, `SELECT updated_at FROM projects WHERE id=$1`, project.ID).Scan(&beforeUpdated); err != nil {
				t.Fatal(err)
			}
			mustQueryExec(t, s, `CREATE FUNCTION refuse_transfer_update() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='transfer update rejected'; END $$;
 CREATE TRIGGER refuse_transfer_update BEFORE UPDATE ON `+table+` FOR EACH ROW EXECUTE FUNCTION refuse_transfer_update()`)
			err = writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error {
				if _, err := tx.ProjectDAO().LockTransferOwnership(ctx); err != nil {
					return err
				}
				_, err := tx.ProjectDAO().MoveOwnership(ctx, target.ID)
				return err
			})
			var postgres *pgconn.PgError
			if !errors.As(err, &postgres) || postgres.Code != "P0001" {
				t.Fatalf("database rejection was lost: %v", err)
			}
			var owner string
			var version int64
			var updated time.Time
			if err := s.Pool.QueryRow(ctx, `SELECT o.team_id::text,o.version,p.updated_at FROM project_ownership o
 JOIN projects p ON p.id=o.project_id WHERE p.id=$1`, project.ID).Scan(&owner, &version, &updated); err != nil {
				t.Fatal(err)
			}
			if owner != project.Ownership.TeamID || version != project.Ownership.Version || !updated.Equal(beforeUpdated) {
				t.Fatalf("failed transfer committed partial state: owner=%s version=%d updated=%s", owner, version, updated)
			}
		})
	}
}

func TestTransferCommitResponseLossRemainsUnknown(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	ctx := context.Background()
	_, actor, _ := testAuthRecords(t, s)
	_, other, _ := testAuthRecords(t, s)
	project, err := s.CreatePrivateProject(ctx, actor, uuid.NewString(), "Project", "host:repo")
	if err != nil {
		t.Fatal(err)
	}
	target, err := testCreateTeam(s, ctx, other.UserID, uuid.NewString(), "Target")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, actor.UserID); err != nil {
		t.Fatal(err)
	}
	raw, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	lost := errors.New("commit response lost")
	err = transact(ctx, &threadCommitResponseLoss{Tx: raw, cause: lost}, func(raw pgx.Tx) error {
		var id string
		if err := raw.QueryRow(ctx, `SELECT id::text FROM projects WHERE id=$1 FOR UPDATE`, project.ID).Scan(&id); err != nil {
			return err
		}
		tx := &ProjectTx{tx: raw, projectID: project.ID}
		owner, err := tx.ProjectDAO().LockTransferOwnership(ctx)
		if err != nil {
			return err
		}
		if _, _, err = tx.ProjectDAO().LockTransferTeams(ctx, owner.TeamID, target.ID); err != nil {
			return err
		}
		_, err = tx.ProjectDAO().MoveOwnership(ctx, target.ID)
		return err
	})
	var failure *TransactionError
	if !errors.As(err, &failure) || !failure.CommitAttempted || failure.Outcome != TransactionUnknown || !errors.Is(err, lost) {
		t.Fatalf("lost COMMIT result: %#v %v", failure, err)
	}
	var actual string
	var version int64
	if err = s.Pool.QueryRow(ctx, `SELECT team_id::text,version FROM project_ownership WHERE project_id=$1`, project.ID).Scan(&actual, &version); err != nil || actual != target.ID || version != project.Ownership.Version+1 {
		t.Fatalf("committed owner %s %d %v", actual, version, err)
	}
	err = s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		_, err := snapshot.ProjectDAO().ProjectAccess(ctx, actor, project.ID)
		return err
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("actor retained access: %v", err)
	}
}

func TestTransferAndTargetTeamDeletionSerialize(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	for _, transferFirst := range []bool{false, true} {
		for _, firstCommits := range []bool{false, true} {
			if !t.Run(fmt.Sprintf("transferFirst=%t/commit=%t", transferFirst, firstCommits), func(t *testing.T) {
				actor, _, project := testutil.ProjectMembershipFixture(t, s)
				target, err := testCreateTeam(s, context.Background(), actor.UserID, uuid.NewString(), "Destination")
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
				var workers sync.WaitGroup
				defer func() {
					cancel()
					workers.Wait()
				}()
				rollback := errors.New("test rollback")
				occupied := errors.New("destination contains projects")
				missing := errors.New("destination is missing")
				ready, release := make(chan uint32, 1), make(chan struct{})
				first, second := make(chan error, 1), make(chan error, 1)
				transfer := func(hold bool) error {
					return writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error {
						ownership, err := tx.ProjectDAO().LockTransferOwnership(ctx)
						if err != nil {
							return err
						}
						_, destination, err := tx.ProjectDAO().LockTransferTeams(ctx, ownership.TeamID, target.ID)
						if err != nil {
							return err
						}
						if destination.Ref.ID == "" {
							return missing
						}
						if _, err := tx.ProjectDAO().MoveOwnership(ctx, target.ID); err != nil {
							return err
						}
						if hold {
							ready <- tx.(*ProjectTx).tx.Conn().PgConn().PID()
							select {
							case <-release:
							case <-ctx.Done():
								return ctx.Err()
							}
							if !firstCommits {
								return rollback
							}
						}
						return nil
					})
				}
				deleteTeam := func(hold bool) error {
					return testWriteTeamRaw(s, ctx, target.ID, func(tx TeamWriteDAO, raw pgx.Tx) error {
						found, err := tx.HasProjects(ctx)
						if err != nil {
							return err
						}
						if found {
							return occupied
						}
						if err := tx.Delete(ctx); err != nil {
							return err
						}
						if hold {
							ready <- raw.Conn().PgConn().PID()
							select {
							case <-release:
							case <-ctx.Done():
								return ctx.Err()
							}
							if !firstCommits {
								return rollback
							}
						}
						return nil
					})
				}
				if transferFirst {
					workers.Go(func() { first <- transfer(true) })
				} else {
					workers.Go(func() { first <- deleteTeam(true) })
				}
				var blockerPID uint32
				select {
				case blockerPID = <-ready:
				case err := <-first:
					t.Fatalf("first operation did not reach barrier: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				if transferFirst {
					workers.Go(func() { second <- deleteTeam(false) })
					waitTransferTeamLock(t, ctx, s, "SELECT id::text FROM teams WHERE", blockerPID)
				} else {
					workers.Go(func() { second <- transfer(false) })
					waitTransferTeamLock(t, ctx, s, "SELECT id::text,name,personal_user_id::text,version FROM teams WHERE", blockerPID)
				}
				close(release)
				err = receiveQueryResult(t, ctx, first)
				if firstCommits && err != nil || !firstCommits && !errors.Is(err, rollback) {
					t.Fatalf("first operation: %v", err)
				}
				err = receiveQueryResult(t, ctx, second)
				if transferFirst && firstCommits {
					if !errors.Is(err, occupied) {
						t.Fatalf("delete missed transferred project: %v", err)
					}
				} else if !transferFirst && firstCommits {
					if !errors.Is(err, missing) {
						t.Fatalf("transfer missed deleted destination: %v", err)
					}
				} else if err != nil {
					t.Fatalf("second operation after rollback: %v", err)
				}
				var owner string
				var teamExists bool
				if err := s.Pool.QueryRow(ctx, `SELECT o.team_id::text,EXISTS(SELECT 1 FROM teams WHERE id=$2)
 FROM project_ownership o WHERE o.project_id=$1`, project.ID, target.ID).Scan(&owner, &teamExists); err != nil {
					t.Fatal(err)
				}
				wantTransfer := transferFirst == firstCommits
				if wantTransfer && (owner != target.ID || !teamExists) || !wantTransfer && (owner != project.Ownership.TeamID || teamExists) {
					t.Fatalf("inconsistent owner or destination: %s exists=%t", owner, teamExists)
				}
			}) {
				return
			}
			testutil.AssertPoolReusable(t, s.Pool)
		}
	}
}

func waitTransferTeamLock(t *testing.T, ctx context.Context, s *Store, prefix string, blockerPID uint32) {
	t.Helper()
	testutil.WaitTransferTeamLock(t, ctx, s.Pool, prefix, blockerPID)
}
