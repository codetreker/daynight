package store

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func ordinaryProjectTeam(t *testing.T, database *Store, projectID string) string {
	t.Helper()
	teamID := uuid.NewString()
	mustQueryExec(t, database, `INSERT INTO teams(id,name) VALUES($1,'Owner team')`, teamID)
	mustQueryExec(t, database, `UPDATE project_ownership SET team_id=$2,version=version+1 WHERE project_id=$1`, projectID, teamID)
	return teamID
}

func TestProjectAccessCombinesEveryRealSourceWithoutChangingGrants(t *testing.T) {
	database, _, person, project := membershipFixture(t)
	ctx := context.Background()
	teamID := ordinaryProjectTeam(t, database, project.ID)
	roles := []core.ProjectRole{"", core.ProjectMemberRole, core.ProjectAdmin}
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
				var before *core.ProjectGrant
				if directRole != "" {
					if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
						m, err := snapshot.DirectProjectMember(ctx, person.UserID, project.ID)
						before = &m.Grant
						return err
					}); err != nil {
						t.Fatal(err)
					}
				}
				expected := core.ProjectMemberRole
				if teamRole == core.ProjectAdmin || directRole == core.ProjectAdmin {
					expected = core.ProjectAdmin
				}
				absent := teamRole == "" && directRole == ""
				if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
					access, err := snapshot.ProjectAccess(ctx, person, project.ID)
					if absent {
						if !errors.Is(err, core.ErrNotFound) {
							t.Fatalf("absent access: %#v %v", access, err)
						}
					} else if err != nil || access.Role != expected || !reflect.DeepEqual(access.DirectGrant, before) {
						t.Fatalf("source access: %#v expectedRole=%s grant=%#v %v", access, expected, before, err)
					}
					page, err := snapshot.AccessibleProjects(ctx, person, Page{Limit: 10})
					if err != nil || len(page.Items) != btoi(!absent) {
						t.Fatalf("filtered inherited project list: %#v %v", page, err)
					}
					people, err := snapshot.ProjectParticipants(ctx, project.ID)
					if err != nil || len(people) != 1+btoi(!absent) {
						t.Fatalf("deduplicated source roster: %#v %v", people, err)
					}
					for _, p := range people {
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
				locked, err := LockProjectAuthorization(ctx, tx, person.UserID, project.ID)
				if absent {
					if !errors.Is(err, core.ErrNotFound) {
						t.Fatalf("locked absent access: %#v %v", locked, err)
					}
				} else if err != nil || locked.Role != expected || !reflect.DeepEqual(locked.DirectGrant, before) {
					t.Fatalf("locked sources: %#v %v", locked, err)
				}
				if err := tx.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
				if directRole != "" {
					if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
						m, err := snapshot.DirectProjectMember(ctx, person.UserID, project.ID)
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
			_, err = LockProjectAuthorization(ctx, tx, owner.UserID, project.ID)
		} else {
			_, err = ReadProjectAccess(ctx, tx, owner.UserID, project.ID)
		}
		var failure *Error
		if !errors.As(err, &failure) || errors.Is(err, core.ErrNotFound) || !strings.Contains(failure.Cause.Error(), "ownership or owner Team is missing") {
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
			access, err := LockProjectAuthorization(ctx, tx, person.UserID, project.ID)
			if err != nil || access.Role != core.ProjectAdmin {
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
	access, err := LockProjectAuthorization(ctx, wrapped, person.UserID, project.ID)
	if !errors.Is(err, core.ErrNotFound) {
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
			_, err = LockProjectAuthorization(ctx, tx, owner.UserID, project.ID)
		} else {
			_, err = ReadProjectAccess(ctx, tx, owner.UserID, project.ID)
		}
		var failure *Error
		if !errors.As(err, &failure) || errors.Is(err, core.ErrNotFound) || !strings.Contains(failure.Cause.Error(), "Team is missing") {
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
			var access core.ProjectAccess
			go func() {
				var err error
				access, err = LockProjectAuthorization(ctx, reader, person.UserID, project.ID)
				done <- err
			}()
			waitThreadBackendLock(t, database, reader.Conn().PgConn().PID())
			if err := writer.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			err = <-done
			if mutation == "delete" {
				if !errors.Is(err, core.ErrNotFound) {
					t.Fatalf("deleted team source admitted: %#v %v", access, err)
				}
			} else if err != nil || access.Role != core.ProjectMemberRole {
				t.Fatalf("pre-wait Team role retained: %#v %v", access, err)
			}
		})
	}
}
