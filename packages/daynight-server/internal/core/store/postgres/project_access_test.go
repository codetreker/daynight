package postgres

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func ordinaryProjectTeam(t *testing.T, database *Store, projectID string) string {
	t.Helper()
	teamID := uuid.NewString()
	mustQueryExec(t, database, `INSERT INTO teams(id,name) VALUES($1,'Owner team')`, teamID)
	mustQueryExec(t, database, `UPDATE project_ownership SET team_id=$2,version=version+1 WHERE project_id=$1`, projectID, teamID)
	return teamID
}

func TestScopedProjectsFilterBeforePaginationAndRequireTeamMembership(t *testing.T) {
	database, owner, person, first := membershipFixture(t)
	ctx := context.Background()
	projects := []model.Project{first}
	for i := 1; i < 6; i++ {
		project, err := database.CreatePrivateProject(ctx, owner, uuid.NewString(), "Project", "https://example.com/project")
		if err != nil {
			t.Fatal(err)
		}
		projects = append(projects, project)
	}
	for i, project := range projects {
		mustQueryExec(t, database, `UPDATE projects SET created_at='2024-01-01 00:00:00+00'::timestamptz + $2::int * interval '1 second' WHERE id=$1`, project.ID, i)
	}
	teamA := ordinaryProjectTeam(t, database, projects[0].ID)
	teamB := ordinaryProjectTeam(t, database, projects[1].ID)
	teamC := ordinaryProjectTeam(t, database, projects[5].ID)
	emptyTeam := uuid.NewString()
	mustQueryExec(t, database, `INSERT INTO teams(id,name) VALUES($1,'Empty team')`, emptyTeam)
	mustQueryExec(t, database, `UPDATE project_ownership SET team_id=$2 WHERE project_id=$1`, projects[2].ID, teamA)
	mustQueryExec(t, database, `UPDATE project_ownership SET team_id=$2 WHERE project_id=$1`, projects[4].ID, teamB)
	for _, team := range []string{teamA, teamC, emptyTeam} {
		mustQueryExec(t, database, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team, person.UserID)
	}
	for _, entry := range []struct {
		index int
		role  string
	}{{0, "member"}, {1, "admin"}, {4, "member"}} {
		mustQueryExec(t, database, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,$3)`, projects[entry.index].ID, person.UserID, entry.role)
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
	mustQueryExec(t, database, `DROP TABLE team_members`)
	err = database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		_, err := snapshot.ProjectDAO().ScopedProjects(ctx, person, ProjectScope{Kind: ProjectScopeTeam, TeamID: teamA}, Page{Limit: 1})
		return err
	})
	if err == nil || errors.Is(err, model.ErrNotFound) {
		t.Fatalf("database failure mistaken for missing membership: %v", err)
	}
}

func TestProjectAccessCombinesEveryRealSourceWithoutChangingGrants(t *testing.T) {
	database, _, person, project := membershipFixture(t)
	ctx := context.Background()
	teamID := ordinaryProjectTeam(t, database, project.ID)
	mustQueryExec(t, database, `UPDATE project_ownership SET version=9007199254740993 WHERE project_id=$1`, project.ID)
	roles := []model.ProjectRole{"", model.ProjectMemberRole, model.ProjectAdmin}
	for _, teamRole := range roles {
		for _, directRole := range roles {
			t.Run(fmt.Sprintf("team=%s/direct=%s", teamRole, directRole), func(t *testing.T) {
				mustQueryExec(t, database, `DELETE FROM team_members WHERE team_id=$1`, teamID)
				mustQueryExec(t, database, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, person.UserID)
				if teamRole != "" {
					mustQueryExec(t, database, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,$3)`, teamID, person.UserID, teamRole)
				}
				if directRole != "" {
					mustQueryExec(t, database, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,$3)`, project.ID, person.UserID, directRole)
				}
				var before *model.ProjectGrant
				if directRole != "" {
					if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
						m, err := snapshot.ProjectDAO().DirectProjectMember(ctx, person.UserID, project.ID)
						before = &m.Grant
						return err
					}); err != nil {
						t.Fatal(err)
					}
				}
				expected := model.ProjectMemberRole
				if teamRole == model.ProjectAdmin || directRole == model.ProjectAdmin {
					expected = model.ProjectAdmin
				}
				absent := teamRole == "" && directRole == ""
				if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
					access, err := snapshot.ProjectDAO().ProjectAccess(ctx, person, project.ID)
					if absent {
						if !errors.Is(err, model.ErrNotFound) {
							t.Fatalf("absent access: %#v %v", access, err)
						}
					} else if err != nil || access.Role != expected || !reflect.DeepEqual(access.DirectGrant, before) {
						t.Fatalf("source access: %#v expectedRole=%s grant=%#v %v", access, expected, before, err)
					}
					if !absent {
						if access.OwnerTeam.ID != teamID || access.OwnerTeam.Kind != "ordinary" || access.OwnerTeam.Name == nil || *access.OwnerTeam.Name != "Owner team" || access.Ownership.TeamID != teamID || access.Ownership.Version != 9007199254740993 || access.CanTransfer != (teamRole == model.ProjectAdmin) || (access.TeamRole == nil) != (teamRole == "") || access.TeamRole != nil && *access.TeamRole != teamRole {
							t.Fatalf("real ownership and actor source: %#v", access)
						}
					}
					page, err := snapshot.ProjectDAO().AccessibleProjects(ctx, person, Page{Limit: 10})
					if err != nil || len(page.Items) != btoi(!absent) {
						t.Fatalf("filtered inherited project list: %#v %v", page, err)
					}
					people, err := snapshot.ProjectDAO().ProjectParticipants(ctx, project.ID)
					if err != nil || len(people) != 1+btoi(!absent) {
						t.Fatalf("deduplicated source roster: %#v %v", people, err)
					}
					for _, p := range people {
						if p.UserID == person.UserID {
							if (p.InheritedFrom == nil) != (teamRole == "") || p.InheritedFrom != nil && (p.InheritedFrom.Team.ID != teamID || p.InheritedFrom.Team.Name == nil || *p.InheritedFrom.Team.Name != "Owner team" || p.InheritedFrom.Team.Kind != "ordinary" || p.InheritedFrom.Role != teamRole) {
								t.Fatalf("participant inheritance facts: %#v", p)
							}
						}
						if p.UserID == person.UserID && (p.EffectiveRole != expected || !reflect.DeepEqual(p.DirectGrant, before)) {
							t.Fatalf("roster source facts: %#v", p)
						}
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
				tx, err := database.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				locked, err := pg.LockProjectAuthorization(ctx, tx, person.UserID, project.ID)
				if absent {
					if !errors.Is(err, model.ErrNotFound) {
						t.Fatalf("locked absent access: %#v %v", locked, err)
					}
				} else if err != nil || locked.Role != expected || !reflect.DeepEqual(locked.DirectGrant, before) {
					t.Fatalf("locked sources: %#v %v", locked, err)
				}
				if err := tx.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
				if directRole != "" {
					if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
						m, err := snapshot.ProjectDAO().DirectProjectMember(ctx, person.UserID, project.ID)
						if !reflect.DeepEqual(m.Grant, *before) {
							t.Fatalf("effective access rewrote direct grant: %#v %#v", m.Grant, before)
						}
						return err
					}); err != nil {
						t.Fatal(err)
					}
				}
			})
		}
	}
}

func btoi(value bool) int {
	if value {
		return 1
	}
	return 0
}

func TestProjectAccessMissingOwnershipIsIntegrityFailure(t *testing.T) {
	database, owner, _, project := membershipFixture(t)
	ctx := context.Background()
	mustQueryExec(t, database, `DELETE FROM project_ownership WHERE project_id=$1`, project.ID)
	for _, locked := range []bool{false, true} {
		tx, err := database.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if locked {
			_, err = pg.LockProjectAuthorization(ctx, tx, owner.UserID, project.ID)
		} else {
			_, err = pg.ReadProjectAccess(ctx, tx, owner.UserID, project.ID)
		}
		var failure *Error
		if !errors.As(err, &failure) || errors.Is(err, model.ErrNotFound) || !strings.Contains(failure.Cause.Error(), "ownership or owner Team is missing") {
			t.Fatalf("corrupt ownership hidden: %v", err)
		}
		if err := tx.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
	}
}

func TestThreadSourceFencesBlockOnlyRealAuthorizationChanges(t *testing.T) {
	for _, source := range []string{"ownership", "team", "grant"} {
		t.Run(source, func(t *testing.T) {
			database, owner, person, project := membershipFixture(t)
			teamID := ordinaryProjectTeam(t, database, project.ID)
			mustQueryExec(t, database, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, teamID, person.UserID)
			mustQueryExec(t, database, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, project.ID, person.UserID)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			tx, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			access, err := pg.LockProjectAuthorization(ctx, tx, person.UserID, project.ID)
			if err != nil || access.Role != model.ProjectAdmin {
				t.Fatalf("source admission: %#v %v", access, err)
			}
			writer, err := database.Pool.Acquire(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer writer.Release()
			done := make(chan error, 1)
			go func() {
				var err error
				switch source {
				case "ownership":
					_, err = writer.Exec(ctx, `UPDATE project_ownership SET team_id=(SELECT id FROM teams WHERE personal_user_id=$2),version=version+1 WHERE project_id=$1`, project.ID, owner.UserID)
				case "team":
					_, err = writer.Exec(ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, teamID, person.UserID)
				case "grant":
					_, err = writer.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, person.UserID)
				}
				done <- err
			}()
			waitThreadBackendLock(t, database, writer.Conn().PgConn().PID())
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		})
	}
}

type sourceInsertTx struct {
	pgx.Tx
	beforeDirect func()
}

func (tx sourceInsertTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if strings.Contains(sql, "FROM project_grants WHERE") {
		tx.beforeDirect()
	}
	return tx.Tx.QueryRow(ctx, sql, args...)
}

func TestThreadDoesNotAdmitSourceInsertedAfterItsAbsentLockRead(t *testing.T) {
	database, _, person, project := membershipFixture(t)
	teamID := ordinaryProjectTeam(t, database, project.ID)
	ctx := context.Background()
	tx, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	wrapped := sourceInsertTx{Tx: tx, beforeDirect: func() {
		mustQueryExec(t, database, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, teamID, person.UserID)
	}}
	access, err := pg.LockProjectAuthorization(ctx, wrapped, person.UserID, project.ID)
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("unlocked inserted source admitted: %#v %v", access, err)
	}
	mustQueryExec(t, database, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, teamID, person.UserID)
}

func TestProjectAccessMissingOwnerTeamCannotAuthorizeEitherSource(t *testing.T) {
	database, owner, _, project := membershipFixture(t)
	ctx := context.Background()
	mustQueryExec(t, database, `DELETE FROM teams WHERE id=(SELECT team_id FROM project_ownership WHERE project_id=$1)`, project.ID)
	for _, locked := range []bool{false, true} {
		tx, err := database.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if locked {
			_, err = pg.LockProjectAuthorization(ctx, tx, owner.UserID, project.ID)
		} else {
			_, err = pg.ReadProjectAccess(ctx, tx, owner.UserID, project.ID)
		}
		var failure *Error
		if !errors.As(err, &failure) || errors.Is(err, model.ErrNotFound) || !strings.Contains(failure.Cause.Error(), "Team is missing") {
			t.Fatalf("orphan ownership authorized or hidden: %v", err)
		}
		if err := tx.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
	}
}

func TestThreadAuthorizationRechecksTeamSourceAfterLockWait(t *testing.T) {
	for _, mutation := range []string{"role", "delete", "delete-with-grant"} {
		t.Run(mutation, func(t *testing.T) {
			database, _, person, project := membershipFixture(t)
			teamID := ordinaryProjectTeam(t, database, project.ID)
			mustQueryExec(t, database, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, teamID, person.UserID)
			if mutation == "delete-with-grant" {
				mustQueryExec(t, database, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project.ID, person.UserID)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			writer, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer writer.Rollback(context.Background())
			if mutation == "role" {
				_, err = writer.Exec(ctx, `UPDATE team_members SET role='member',version=nextval('team_member_versions') WHERE team_id=$1 AND user_id=$2`, teamID, person.UserID)
			} else {
				_, err = writer.Exec(ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, teamID, person.UserID)
			}
			if err != nil {
				t.Fatal(err)
			}
			reader, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer reader.Rollback(context.Background())
			done := make(chan error, 1)
			var access model.ProjectAccess
			go func() {
				var err error
				access, err = pg.LockProjectAuthorization(ctx, reader, person.UserID, project.ID)
				done <- err
			}()
			waitThreadBackendLock(t, database, reader.Conn().PgConn().PID())
			if err := writer.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			err = <-done
			if mutation == "delete" {
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("deleted team source admitted: %#v %v", access, err)
				}
			} else if err != nil || access.Role != model.ProjectMemberRole {
				t.Fatalf("pre-wait Team role retained: %#v %v", access, err)
			}
		})
	}
}

type sourceInsertionTracer struct {
	matched    bool
	afterGrant func()
}

func (tracer *sourceInsertionTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	tracer.matched = strings.Contains(data.SQL, "FROM project_grants WHERE project_id=$1 AND user_id=$2 FOR SHARE")
	return ctx
}

func (tracer *sourceInsertionTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {
	if tracer.matched && tracer.afterGrant != nil {
		tracer.matched = false
		apply := tracer.afterGrant
		tracer.afterGrant = nil
		apply()
	}
}

func TestLockedProjectAccessDoesNotPublishAnUnlockedNewSource(t *testing.T) {
	database, owner, person, project := membershipFixture(t)
	teamID := ordinaryProjectTeam(t, database, project.ID)
	ctx := context.Background()
	mustQueryExec(t, database, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project.ID, person.UserID)
	config := database.Pool.Config().Copy()
	tracer := &sourceInsertionTracer{afterGrant: func() {
		mustQueryExec(t, database, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, teamID, person.UserID)
	}}
	config.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	access, err := pg.LockProjectAuthorization(ctx, tx, person.UserID, project.ID)
	if err != nil || tracer.afterGrant != nil || access.Role != model.ProjectMemberRole || access.TeamRole != nil || access.CanTransfer || access.DirectGrant == nil || access.DirectGrant.Role != model.ProjectMemberRole {
		t.Fatalf("unlocked source entered strong admission: %#v %v", access, err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		current, err := snapshot.ProjectDAO().ProjectAccess(ctx, person, project.ID)
		if err != nil || current.Role != model.ProjectAdmin || !current.CanTransfer {
			t.Fatalf("new source was not actually committed: %#v %v", current, err)
		}
		_, err = snapshot.ProjectDAO().ProjectAccess(ctx, owner, project.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
}
