package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func repositoryFault(t *testing.T, err error, code string) {
	t.Helper()
	var fault *model.Fault
	var failure *TransactionError
	if !errors.As(err, &fault) || fault.Code != code || !errors.As(err, &failure) || failure.Outcome != TransactionNotCommitted || failure.CommitAttempted {
		t.Fatalf("expected confirmed rollback %s: %v", code, err)
	}
}

func transferRepository(t *testing.T, s *Store, ctx context.Context, actor model.Principal, project model.Project, target model.Team) error {
	t.Helper()
	return writeProjectForTest(s, ctx, project.ID, func(scope ProjectWriteScope) error {
		_, err := coreproject.Transfer(ctx, scope.ProjectDAO(), actor, project.ID, project.Ownership.TeamID, target.ID, coreproject.TransferInput{Ownership: project.Ownership, TargetTeam: coreproject.TeamVersion{ID: target.ID, Version: target.Version}, ExpectedUserID: actor.UserID})
		return err
	})
}

func TestProjectRepositoryOccupancyAndRelease(t *testing.T) {
	parallelRootDatabaseTest(t)
	s, actor, target := storeTeamFixture(t)
	ctx := t.Context()
	raw := "https://GitHub.com/Org/Repo.git/"
	first, _, err := s.CreateProjectInTeam(ctx, actor, uuid.NewString(), "First", raw, &target.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, address := range []string{raw, "git@github.com:Org/Repo", "ssh://git@github.com:22/Org/Repo.git"} {
		_, _, err := s.CreateProjectInTeam(ctx, actor, uuid.NewString(), "Different name", address, &target.ID)
		repositoryFault(t, err, "project_repository_conflict")
	}
	var stored, identity string
	if err := s.Pool.QueryRow(ctx, `SELECT repo_url,repository_identity FROM projects WHERE id=$1`, first.ID).Scan(&stored, &identity); err != nil || stored != raw || identity != "github.com/Org/Repo" {
		t.Fatalf("stored=%q identity=%q error=%v", stored, identity, err)
	}
	other, err := testCreateTeam(s, ctx, actor.UserID, uuid.NewString(), "Other")
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := s.CreateProjectInTeam(ctx, actor, uuid.NewString(), "Other Team", "git@github.com:Org/Repo", &other.ID)
	if err != nil {
		t.Fatal(err)
	}
	var before string
	if err := s.Pool.QueryRow(ctx, `SELECT (to_jsonb(p)||jsonb_build_object('ownership',to_jsonb(o)))::text FROM projects p JOIN project_ownership o ON o.project_id=p.id WHERE p.id=$1`, second.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	repositoryFault(t, transferRepository(t, s, ctx, actor, second, target), "project_repository_conflict")
	var after string
	if err := s.Pool.QueryRow(ctx, `SELECT (to_jsonb(p)||jsonb_build_object('ownership',to_jsonb(o)))::text FROM projects p JOIN project_ownership o ON o.project_id=p.id WHERE p.id=$1`, second.ID).Scan(&after); err != nil || after != before {
		t.Fatalf("refusal changed Project or ownership: equal=%t err=%v", after == before, err)
	}
	// Soft deletion releases occupancy while retaining the historical address.
	if receipt, err := projectservice.NewProjects(s).Delete(ctx, actor, first.ID); err != nil || !receipt.Deleted {
		t.Fatalf("delete occupant: %+v %v", receipt, err)
	}
	if err := transferRepository(t, s, ctx, actor, second, target); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.CreateProjectInTeam(ctx, actor, uuid.NewString(), "Released source", "https://github.com/Org/Repo", &other.ID); err != nil {
		t.Fatal(err)
	}
	longAddress := "https://host/" + strings.Repeat("x", 4096-len("https://host/"))
	if _, _, err := s.CreateProjectInTeam(ctx, actor, uuid.NewString(), "Maximum URL", longAddress, &target.ID); err != nil {
		t.Fatal(err)
	}
	legacy, _, err := s.CreateProjectInTeam(ctx, actor, uuid.NewString(), "Legacy", "host:legacy", &other.ID)
	if err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, s, `UPDATE projects SET repository_identity=NULL,repo_url='historical invalid address' WHERE id=$1`, legacy.ID)
	repositoryFault(t, transferRepository(t, s, ctx, actor, legacy, target), "project_repository_identity_unavailable")
	if err := transferRepository(t, s, ctx, actor, legacy, other); err != nil {
		t.Fatalf("legacy no-op transfer: %v", err)
	}
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		p, err := snapshot.ProjectDAO().Project(ctx, legacy.ID)
		if err == nil && p.RepoURL != "historical invalid address" {
			return errors.New("legacy raw address changed")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if receipt, err := projectservice.NewProjects(s).Delete(ctx, actor, legacy.ID); err != nil || !receipt.Deleted {
		t.Fatalf("delete legacy Project: %+v %v", receipt, err)
	}
}

func TestProjectRepositoryConcurrentOccupancy(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, pair := range [][2]bool{{false, false}, {true, true}, {false, true}, {true, false}} {
		t.Run(fmt.Sprintf("transfer=%t/%t", pair[0], pair[1]), func(t *testing.T) {
			s, actor, target := storeTeamFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			projects := [2]model.Project{}
			for i, transfer := range pair {
				if !transfer {
					projects[i] = model.Project{ID: uuid.NewString()}
					continue
				}
				source, err := testCreateTeam(s, ctx, actor.UserID, uuid.NewString(), fmt.Sprintf("Source %d", i))
				if err != nil {
					t.Fatal(err)
				}
				project, _, err := s.CreateProjectInTeam(ctx, actor, uuid.NewString(), "Source", "https://github.com/Org/Repo.git", &source.ID)
				if err != nil {
					t.Fatal(err)
				}
				projects[i] = project
			}
			ready, release := make(chan uint32, 1), make(chan struct{})
			first, second := make(chan error, 1), make(chan error, 1)
			operation := func(index int, hold bool) error {
				barrier := func(tx pgx.Tx) error {
					if !hold {
						return nil
					}
					ready <- tx.Conn().PgConn().PID()
					select {
					case <-release:
						return nil
					case <-ctx.Done():
						return ctx.Err()
					}
				}
				if pair[index] {
					return writeProjectForTest(s, ctx, projects[index].ID, func(scope ProjectWriteScope) error {
						p := projects[index]
						_, err := coreproject.Transfer(ctx, scope.ProjectDAO(), actor, p.ID, p.Ownership.TeamID, target.ID, coreproject.TransferInput{Ownership: p.Ownership, TargetTeam: coreproject.TeamVersion{ID: target.ID, Version: target.Version}})
						if err != nil {
							return err
						}
						return barrier(scope.(*ProjectTx).tx)
					})
				}
				tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
				if err != nil {
					return err
				}
				return writeProjectCreationTx(ctx, tx, actor.UserID, func(dao ProjectCreationDAO) error {
					_, _, err := coreproject.Create(ctx, dao, actor.UserID, projects[index].ID, coreproject.CreateProject{Name: "Concurrent", RepoURL: "git@github.com:Org/Repo.git", TeamID: &target.ID})
					if err != nil {
						return err
					}
					return barrier(tx)
				})
			}
			go func() { first <- operation(0, true) }()
			var pid uint32
			select {
			case pid = <-ready:
			case err := <-first:
				t.Fatalf("first missed barrier: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			go func() { second <- operation(1, false) }()
			query := "SELECT id::text,personal_user_id::text FROM teams WHERE"
			if pair[1] {
				query = "SELECT id::text,name,personal_user_id::text,version FROM teams WHERE"
			}
			waitTransferTeamLock(t, ctx, s, query, pid)
			close(release)
			if err := receiveQueryResult(t, ctx, first); err != nil {
				t.Fatal(err)
			}
			repositoryFault(t, receiveQueryResult(t, ctx, second), "project_repository_conflict")
			var count int
			if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM project_ownership o JOIN projects p ON p.id=o.project_id WHERE o.team_id=$1 AND p.deleted_at IS NULL AND p.repository_identity='github.com/Org/Repo'`, target.ID).Scan(&count); err != nil || count != 1 {
				t.Fatalf("occupants=%d err=%v", count, err)
			}
			if pair[1] {
				var team string
				var version int64
				if err := s.Pool.QueryRow(ctx, `SELECT team_id::text,version FROM project_ownership WHERE project_id=$1`, projects[1].ID).Scan(&team, &version); err != nil || team != projects[1].Ownership.TeamID || version != projects[1].Ownership.Version {
					t.Fatalf("loser ownership changed: %s %d %v", team, version, err)
				}
			} else {
				var count int
				if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM projects WHERE id=$1`, projects[1].ID).Scan(&count); err != nil || count != 0 {
					t.Fatalf("loser Project persisted: %d %v", count, err)
				}
			}
		})
	}
}
