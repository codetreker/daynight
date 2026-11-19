package project_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pgproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/project"
	pgtask "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func rollbackAuthorizationTransaction(t *testing.T, tx pgx.Tx) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := tx.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		t.Errorf("roll back authorization transaction: %v", err)
	}
}

func rollbackAuthorizationReader(t *testing.T, readCtx context.Context, tx pgx.Tx) {
	t.Helper()
	cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn := tx.Conn().PgConn()
	closedBefore, cleanupDone := conn.IsClosed(), conn.CleanupDone()
	err := tx.Rollback(cleanup)
	if err == nil {
		return
	}
	if errors.Is(err, pgconn.ErrConnClosed) && (closedBefore || readCtx.Err() != nil) {
		select {
		case <-cleanupDone:
			return
		case <-cleanup.Done():
			err = errors.Join(err, cleanup.Err())
		}
	}
	t.Errorf("roll back authorization reader: %v", err)
}

func authorizationAfterWriterCommit(t *testing.T, ctx context.Context, pool *pgxpool.Pool, writer pgx.Tx,
	principal model.Principal, projectID, taskID, waitQuery string,
) (model.ProjectAccess, error) {
	t.Helper()
	writerPID := writer.Conn().PgConn().PID()
	readerCtx, cancel := context.WithCancel(ctx)
	started := make(chan uint32, 1)
	finished := make(chan struct{})
	var access model.ProjectAccess
	var readErr error
	go func() {
		defer close(finished)
		reader, err := pool.BeginTx(readerCtx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
		if err != nil {
			readErr = err
			return
		}
		defer rollbackAuthorizationReader(t, readerCtx, reader)
		started <- reader.Conn().PgConn().PID()
		dao := pgtask.NewThreadDAO(reader)
		if _, readErr = dao.LockTaskPresence(readerCtx, projectID, taskID); readErr != nil {
			return
		}
		if _, readErr = dao.Credential(readerCtx, principal); readErr != nil {
			return
		}
		access, readErr = pgproject.NewThreadDAO(reader).LockProjectAuthorization(readerCtx, principal, projectID)
	}()
	defer func() {
		cancel()
		rollbackAuthorizationTransaction(t, writer)
		<-finished
	}()

	var readerPID uint32
	select {
	case readerPID = <-started:
	case <-finished:
		t.Fatalf("thread finished before waiting for %s: %v", waitQuery, readErr)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	for {
		select {
		case <-finished:
			t.Fatalf("thread finished before waiting for %s: %v", waitQuery, readErr)
		default:
		}
		var waiting bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT FROM pg_stat_activity WHERE pid=$1
 AND query LIKE $3 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid)))`, readerPID, writerPID, "%"+waitQuery+"%").Scan(&waiting); err != nil {
			t.Fatalf("inspect %s lock wait for thread backend %d and writer %d: %v", waitQuery, readerPID, writerPID, err)
		}
		if waiting {
			break
		}
		if err := testutil.WaitThreadClock(ctx); err != nil {
			t.Fatalf("thread backend %d did not wait for writer %d on %s: %v", readerPID, writerPID, waitQuery, err)
		}
	}
	if err := writer.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-finished:
		return access, readErr
	case <-ctx.Done():
		t.Fatal(ctx.Err())
		return model.ProjectAccess{}, ctx.Err()
	}
}

func TestThreadAuthorizationRechecksGrantAfterLockWait(t *testing.T) {
	database := testutil.OpenStore(t, postgres.Open)
	for index, mutation := range []string{"role", "delete"} {
		if !t.Run(mutation, func(t *testing.T) {
			_, principal, project := testutil.ProjectMembershipFixture(t, database)
			if err := testutil.WriteProject(context.Background(), database, project.ID, func(tx ProjectWriteScope) error {
				_, err := tx.ProjectDAO().AddInvitedMember(context.Background(), principal.UserID)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			task := testutil.QueryTask(t, database, project.ID, 10+index, model.TaskTodo)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			writer, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer rollbackAuthorizationTransaction(t, writer)
			var version int64
			if mutation == "role" {
				err = writer.QueryRow(ctx, `UPDATE project_grants SET role='member',version=nextval('project_grant_versions')
 WHERE project_id=$1 AND user_id=$2 RETURNING version`, project.ID, principal.UserID).Scan(&version)
			} else {
				_, err = writer.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, principal.UserID)
			}
			if err != nil {
				t.Fatal(err)
			}
			access, err := authorizationAfterWriterCommit(t, ctx, database.Pool, writer, principal, project.ID, task.ID, "FROM project_grants")
			if mutation == "delete" {
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("revoked grant admitted: %#v %v", access, err)
				}
			} else if err != nil || access.ProjectID != project.ID || access.UserID != principal.UserID || access.Role != model.ProjectMemberRole ||
				access.DirectGrant == nil || access.DirectGrant.ProjectID != project.ID || access.DirectGrant.UserID != principal.UserID ||
				access.DirectGrant.Role != access.Role || access.DirectGrant.Version != version {
				t.Fatalf("authorization retained pre-wait grant: %#v %v", access, err)
			}
			testutil.AssertPoolReusable(t, database.Pool)
		}) {
			return
		}
	}
}

func TestThreadAuthorizationUsesDestinationAfterOwnershipLockWait(t *testing.T) {
	database := testutil.OpenStore(t, postgres.Open)
	for lateIndex, destinationCreatedLate := range []bool{false, true} {
		for memberIndex, destinationMember := range []bool{false, true} {
			if !t.Run(fmt.Sprintf("late=%t/member=%t", destinationCreatedLate, destinationMember), func(t *testing.T) {
				_, principal, project := testutil.ProjectMembershipFixture(t, database)
				sourceID := testutil.OrdinaryProjectTeam(t, database.Pool, project.ID)
				testutil.MustExec(t, database.Pool, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, sourceID, principal.UserID)
				task := testutil.QueryTask(t, database, project.ID, 10+2*lateIndex+memberIndex, model.TaskTodo)
				destinationID := uuid.NewString()
				if !destinationCreatedLate {
					testutil.MustExec(t, database.Pool, `INSERT INTO teams(id,name) VALUES($1,'Destination')`, destinationID)
					if destinationMember {
						testutil.MustExec(t, database.Pool, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, destinationID, principal.UserID)
					}
				}
				ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
				defer cancel()
				writer, err := database.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer rollbackAuthorizationTransaction(t, writer)
				var locked string
				if err := writer.QueryRow(ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1 FOR UPDATE`, project.ID).Scan(&locked); err != nil || locked != sourceID {
					t.Fatalf("lock source ownership: %s %v", locked, err)
				}
				if destinationCreatedLate {
					if _, err := writer.Exec(ctx, `INSERT INTO teams(id,name) VALUES($1,'Destination')`, destinationID); err != nil {
						t.Fatal(err)
					}
					if destinationMember {
						if _, err := writer.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, destinationID, principal.UserID); err != nil {
							t.Fatal(err)
						}
					}
				}
				var destinationVersion int64
				if err := writer.QueryRow(ctx, `UPDATE project_ownership SET team_id=$2,version=version+1 WHERE project_id=$1 RETURNING version`, project.ID, destinationID).Scan(&destinationVersion); err != nil {
					t.Fatal(err)
				}
				// The blocked ownership statement has its old snapshot before
				// the writer publishes the destination.
				access, err := authorizationAfterWriterCommit(t, ctx, database.Pool, writer, principal, project.ID, task.ID, "FROM project_ownership")
				if !destinationMember {
					if !errors.Is(err, model.ErrNotFound) {
						t.Fatalf("source-only access retained: %#v %v", access, err)
					}
				} else if err != nil || access.OwnerTeam.ID != destinationID || access.OwnerTeam.Name == nil || *access.OwnerTeam.Name != "Destination" ||
					access.Ownership.TeamID != destinationID || access.Ownership.Version != destinationVersion || access.Role != model.ProjectMemberRole ||
					access.DirectGrant != nil || access.TeamRole == nil || *access.TeamRole != model.ProjectMemberRole || access.CanTransfer {
					t.Fatalf("destination-only access: %#v %v", access, err)
				}
				testutil.AssertPoolReusable(t, database.Pool)
			}) {
				return
			}
		}
	}
}

func TestScopedProjectsFilterBeforePaginationAndRequireTeamMembership(t *testing.T) {
	database := testutil.OpenStore(t, postgres.Open)
	owner, person, first := testutil.ProjectMembershipFixture(t, database)
	ctx := context.Background()
	projects := []model.Project{first}
	for i := 1; i < 6; i++ {
		project, err := testutil.CreatePrivateProject(ctx, database, owner, uuid.NewString(), "Project", fmt.Sprintf("https://example.com/project-%d", i))
		if err != nil {
			t.Fatal(err)
		}
		projects = append(projects, project)
	}
	for i, project := range projects {
		testutil.MustExec(t, database.Pool, `UPDATE projects SET created_at='2024-01-01 00:00:00+00'::timestamptz + $2::int * interval '1 second' WHERE id=$1`, project.ID, i)
	}
	teamA := testutil.OrdinaryProjectTeam(t, database.Pool, projects[0].ID)
	teamB := testutil.OrdinaryProjectTeam(t, database.Pool, projects[1].ID)
	teamC := testutil.OrdinaryProjectTeam(t, database.Pool, projects[5].ID)
	emptyTeam := uuid.NewString()
	testutil.MustExec(t, database.Pool, `INSERT INTO teams(id,name) VALUES($1,'Empty team')`, emptyTeam)
	testutil.MustExec(t, database.Pool, `UPDATE project_ownership SET team_id=$2 WHERE project_id=$1`, projects[2].ID, teamA)
	testutil.MustExec(t, database.Pool, `UPDATE project_ownership SET team_id=$2 WHERE project_id=$1`, projects[4].ID, teamB)
	for _, team := range []string{teamA, teamC, emptyTeam} {
		testutil.MustExec(t, database.Pool, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team, person.UserID)
	}
	for _, entry := range []struct {
		index int
		role  string
	}{{0, "member"}, {1, "admin"}, {4, "member"}} {
		testutil.MustExec(t, database.Pool, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,$3)`, projects[entry.index].ID, person.UserID, entry.role)
	}
	for _, test := range []struct {
		name  string
		scope ProjectScope
		want  []int
	}{
		{"all", ProjectScope{Kind: ProjectScopeAll}, []int{0, 1, 2, 4, 5}},
		{"team", ProjectScope{Kind: ProjectScopeTeam, TeamID: teamA}, []int{0, 2}},
		{"other team", ProjectScope{Kind: ProjectScopeTeam, TeamID: teamC}, []int{5}},
		{"shared", ProjectScope{Kind: ProjectScopeShared}, []int{1, 4}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var ids []string
			var after *Position
			for {
				var page ProjectPage
				err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
					var err error
					page, err = snapshot.ProjectDAO().ScopedProjects(ctx, person, test.scope, Page{Limit: 1, After: after})
					return err
				})
				if err != nil || len(page.Items) != 1 {
					t.Fatalf("page: %#v %v", page, err)
				}
				ids = append(ids, page.Items[0].ID)
				if !page.HasMore {
					break
				}
				if len(ids) > len(test.want) {
					t.Fatal("pagination did not terminate")
				}
				after = &Position{ID: page.Items[0].ID, CreatedAt: page.Items[0].CreatedAt}
			}
			want := make([]string, 0, len(test.want))
			for _, i := range test.want {
				want = append(want, projects[i].ID)
			}
			if !slices.Equal(ids, want) {
				t.Fatalf("got %v, want %v", ids, want)
			}
		})
	}
	err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		_, err := snapshot.ProjectDAO().ScopedProjects(ctx, person, ProjectScope{Kind: ProjectScopeTeam, TeamID: teamB}, Page{Limit: 1})
		return err
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("direct grants must not imply team membership: %v", err)
	}
	err = database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		page, err := snapshot.ProjectDAO().ScopedProjects(ctx, person, ProjectScope{Kind: ProjectScopeTeam, TeamID: emptyTeam}, Page{Limit: 1})
		if err != nil || page.Items == nil || len(page.Items) != 0 || page.HasMore {
			t.Fatalf("member's empty team: %#v %v", page, err)
		}
		_, err = snapshot.ProjectDAO().ScopedProjects(ctx, person, ProjectScope{Kind: ProjectScopeTeam, TeamID: uuid.NewString()}, Page{Limit: 1})
		return err
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing team: %v", err)
	}
	for _, scope := range []ProjectScope{{}, {Kind: ProjectScopeTeam}, {Kind: ProjectScopeAll, TeamID: teamA}, {Kind: ProjectScopeShared, TeamID: teamA}} {
		err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
			_, err := snapshot.ProjectDAO().ScopedProjects(ctx, person, scope, Page{Limit: 1})
			return err
		})
		if err == nil || errors.Is(err, model.ErrNotFound) {
			t.Fatalf("invalid scope %#v: %v", scope, err)
		}
	}
	var memberships int
	if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM team_members WHERE team_id=$1 AND user_id=$2`, teamB, person.UserID).Scan(&memberships); err != nil || memberships != 0 {
		t.Fatalf("shared list altered membership: %d %v", memberships, err)
	}
	_, outsider, _ := testutil.AuthRecords(t, database)
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		page, err := snapshot.ProjectDAO().ScopedProjects(ctx, outsider, ProjectScope{Kind: ProjectScopeAll}, Page{Limit: 1})
		if err != nil || page.Items == nil || len(page.Items) != 0 || page.HasMore {
			t.Fatalf("outsider's all-projects page: %#v %v", page, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	testutil.MustExec(t, database.Pool, `DROP TABLE team_members`)
	err = database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		_, err := snapshot.ProjectDAO().ScopedProjects(ctx, person, ProjectScope{Kind: ProjectScopeTeam, TeamID: teamA}, Page{Limit: 1})
		return err
	})
	var operational *Error
	var cause *pgconn.PgError
	if !errors.As(err, &operational) || !errors.As(err, &cause) || cause.Code != "42P01" || errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing Team membership relation lost its database cause: %v", err)
	}
}
