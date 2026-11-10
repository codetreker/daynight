package pg_test

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"

	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestProjectAccessCombinesEveryRealSourceWithoutChangingGrants(t *testing.T) {
	database := testutil.OpenStore(t, postgres.Open)
	_, person, project := testutil.ProjectMembershipFixture(t, database)
	ctx := context.Background()
	teamID := testutil.OrdinaryProjectTeam(t, database.Pool, project.ID)
	testutil.MustExec(t, database.Pool, `UPDATE project_ownership SET version=9007199254740993 WHERE project_id=$1`, project.ID)
	roles := []model.ProjectRole{"", model.ProjectMemberRole, model.ProjectAdmin}
	for _, teamRole := range roles {
		for _, directRole := range roles {
			t.Run(fmt.Sprintf("team=%s/direct=%s", teamRole, directRole), func(t *testing.T) {
				testutil.MustExec(t, database.Pool, `DELETE FROM team_members WHERE team_id=$1`, teamID)
				testutil.MustExec(t, database.Pool, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, person.UserID)
				if teamRole != "" {
					testutil.MustExec(t, database.Pool, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,$3)`, teamID, person.UserID, teamRole)
				}
				if directRole != "" {
					testutil.MustExec(t, database.Pool, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,$3)`, project.ID, person.UserID, directRole)
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
	database := testutil.OpenStore(t, postgres.Open)
	owner, _, project := testutil.ProjectMembershipFixture(t, database)
	ctx := context.Background()
	testutil.MustExec(t, database.Pool, `DELETE FROM project_ownership WHERE project_id=$1`, project.ID)
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
			database := testutil.OpenStore(t, postgres.Open)
			owner, person, project := testutil.ProjectMembershipFixture(t, database)
			teamID := testutil.OrdinaryProjectTeam(t, database.Pool, project.ID)
			testutil.MustExec(t, database.Pool, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, teamID, person.UserID)
			testutil.MustExec(t, database.Pool, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, project.ID, person.UserID)
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
			testutil.WaitThreadBackendLock(t, database.Pool, writer.Conn().PgConn().PID())
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
	database := testutil.OpenStore(t, postgres.Open)
	_, person, project := testutil.ProjectMembershipFixture(t, database)
	teamID := testutil.OrdinaryProjectTeam(t, database.Pool, project.ID)
	ctx := context.Background()
	tx, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	wrapped := sourceInsertTx{Tx: tx, beforeDirect: func() {
		testutil.MustExec(t, database.Pool, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, teamID, person.UserID)
	}}
	access, err := pg.LockProjectAuthorization(ctx, wrapped, person.UserID, project.ID)
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("unlocked inserted source admitted: %#v %v", access, err)
	}
	testutil.MustExec(t, database.Pool, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, teamID, person.UserID)
}

func TestProjectAccessMissingOwnerTeamCannotAuthorizeEitherSource(t *testing.T) {
	database := testutil.OpenStore(t, postgres.Open)
	owner, _, project := testutil.ProjectMembershipFixture(t, database)
	ctx := context.Background()
	testutil.MustExec(t, database.Pool, `DELETE FROM teams WHERE id=(SELECT team_id FROM project_ownership WHERE project_id=$1)`, project.ID)
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
			database := testutil.OpenStore(t, postgres.Open)
			_, person, project := testutil.ProjectMembershipFixture(t, database)
			teamID := testutil.OrdinaryProjectTeam(t, database.Pool, project.ID)
			testutil.MustExec(t, database.Pool, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, teamID, person.UserID)
			if mutation == "delete-with-grant" {
				testutil.MustExec(t, database.Pool, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project.ID, person.UserID)
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
			testutil.WaitThreadBackendLock(t, database.Pool, reader.Conn().PgConn().PID())
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
	database := testutil.OpenStore(t, postgres.Open)
	owner, person, project := testutil.ProjectMembershipFixture(t, database)
	teamID := testutil.OrdinaryProjectTeam(t, database.Pool, project.ID)
	ctx := context.Background()
	testutil.MustExec(t, database.Pool, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project.ID, person.UserID)
	config := database.Pool.Config().Copy()
	tracer := &sourceInsertionTracer{afterGrant: func() {
		testutil.MustExec(t, database.Pool, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, teamID, person.UserID)
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
