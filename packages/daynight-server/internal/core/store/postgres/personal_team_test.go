package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"reflect"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func identitySession(userID, subject string) (model.User, model.Session) {
	now := time.Now().UTC()
	hash := sha256.Sum256([]byte(uuid.NewString()))
	return model.User{ID: userID, UniAuthID: subject}, model.Session{ID: uuid.NewString(), TokenHash: hash[:], CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
}

func TestPersonalIntegrityFailuresAreNotRepairedByProjectCreation(t *testing.T) {
	for _, damage := range []string{"missing-owner", "wrong-role", "additional-member"} {
		t.Run(damage, func(t *testing.T) {
			s := isolatedStore(t)
			user, principal, _ := testAuthRecords(t, s)
			ctx := context.Background()
			switch damage {
			case "missing-owner":
				mustQueryExec(t, s, `DELETE FROM team_members WHERE user_id=$1`, user.ID)
			case "wrong-role":
				mustQueryExec(t, s, `UPDATE team_members SET role='member' WHERE user_id=$1`, user.ID)
			case "additional-member":
				other, _, _ := testAuthRecords(t, s)
				mustQueryExec(t, s, `INSERT INTO team_members(team_id,user_id,role)
					SELECT id,$2,'member' FROM teams WHERE personal_user_id=$1`, user.ID, other.ID)
			}
			if _, err := s.CreatePrivateProject(ctx, principal, uuid.NewString(), "Invalid", "host:repo"); err == nil || errors.Is(err, model.ErrNotFound) {
				t.Fatalf("project creation hid invalid Personal ownership: %v", err)
			}
			_, facts, err := testIdentityUser(s, ctx, user.ID)
			if err != nil || facts.ID == "" {
				t.Fatalf("account team facts: %#v %v", facts, err)
			}
			if damage == "missing-owner" && (facts.MemberCount != 0 || facts.OwnerAdminCount != 0) ||
				damage == "wrong-role" && (facts.MemberCount != 1 || facts.OwnerAdminCount != 0) ||
				damage == "additional-member" && (facts.MemberCount != 2 || facts.OwnerAdminCount != 1) {
				t.Fatalf("account member facts for %s: %#v", damage, facts)
			}
			var projects int
			if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM projects`).Scan(&projects); err != nil || projects != 0 {
				t.Fatalf("invalid Personal created a project: %d %v", projects, err)
			}
		})
	}
}

func TestProjectCreationPersonalLookupFailuresPreserveStateAndCause(t *testing.T) {
	for _, failure := range []string{"missing-team", "team-query", "owner-query"} {
		t.Run(failure, func(t *testing.T) {
			s := isolatedStore(t)
			user, principal, session := testAuthRecords(t, s)
			ctx := context.Background()
			switch failure {
			case "missing-team":
				mustQueryExec(t, s, `DELETE FROM teams WHERE personal_user_id=$1`, user.ID)
			case "team-query":
				mustQueryExec(t, s, `DROP TABLE teams`)
			case "owner-query":
				mustQueryExec(t, s, `DROP TABLE team_members`)
			}
			project, err := s.CreatePrivateProject(ctx, principal, uuid.NewString(), "Rejected", "host:repo")
			var transaction *TransactionError
			if err == nil || project != (model.Project{}) || !errors.As(err, &transaction) ||
				transaction.CommitAttempted || transaction.CleanupFailed || transaction.Outcome != TransactionNotCommitted {
				t.Fatalf("failed Personal lookup returned a project or uncertain transaction: %#v %#v %v", project, transaction, err)
			}
			if failure == "missing-team" {
				if errors.Is(err, model.ErrNotFound) || transaction.Cause.Error() != "user Personal Team is missing" {
					t.Fatalf("missing Personal Team did not retain its integrity error: %v", err)
				}
				var teams int
				if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM teams`).Scan(&teams); err != nil || teams != 0 {
					t.Fatalf("project creation repaired missing Personal Team: %d %v", teams, err)
				}
			} else {
				var databaseError *pgconn.PgError
				if !errors.As(err, &databaseError) || databaseError.Code != "42P01" || !errors.Is(transaction.Cause, databaseError) {
					t.Fatalf("Personal lookup lost original database cause: %#v %v", databaseError, err)
				}
			}
			var unchanged bool
			if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM projects)=0
				AND (SELECT count(*) FROM project_ownership)=0 AND (SELECT count(*) FROM project_grants)=0
				AND (SELECT count(*) FROM sessions)=1
				AND EXISTS(SELECT 1 FROM sessions WHERE id=$1 AND user_id=$2)`, session.ID, user.ID).Scan(&unchanged); err != nil || !unchanged {
				t.Fatalf("failed Personal lookup changed project, ownership, grant or session rows: %v %v", unchanged, err)
			}
		})
	}
}

func TestProjectOwnershipCreationAndRequiredReads(t *testing.T) {
	for _, missing := range []string{"ownership", "team"} {
		t.Run(missing, func(t *testing.T) { testProjectOwnershipCreationAndRequiredReads(t, missing) })
	}
}

func testProjectOwnershipCreationAndRequiredReads(t *testing.T, missing string) {
	s := isolatedStore(t)
	user, principal, _ := testAuthRecords(t, s)
	ctx := context.Background()
	project, err := s.CreatePrivateProject(ctx, principal, uuid.NewString(), " Raw name ", "git@example.com:owner/repo.git")
	if err != nil {
		t.Fatal(err)
	}
	var owner string
	var grants int
	if err := s.Pool.QueryRow(ctx, `SELECT t.personal_user_id::text,
		(SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2 AND role='admin')
		FROM project_ownership o JOIN teams t ON t.id=o.team_id WHERE o.project_id=$1`, project.ID, user.ID).Scan(&owner, &grants); err != nil || owner != user.ID || grants != 1 || project.Ownership.TeamID == "" || project.Ownership.Version != 1 || project.Name != " Raw name " || project.RepoURL != "git@example.com:owner/repo.git" {
		t.Fatalf("incomplete project writer: %#v %s %d %v", project, owner, grants, err)
	}
	if missing == "ownership" {
		mustQueryExec(t, s, `DELETE FROM project_ownership WHERE project_id=$1`, project.ID)
	} else {
		mustQueryExec(t, s, `DELETE FROM teams WHERE id=$1`, project.Ownership.TeamID)
	}
	for index, read := range []func(SnapshotScope) error{
		func(snapshot SnapshotScope) error {
			_, err := snapshot.ProjectDAO().Project(ctx, project.ID)
			return err
		},
		func(snapshot SnapshotScope) error {
			_, err := snapshot.ProjectDAO().Projects(ctx, Page{Limit: 10})
			return err
		},
		func(snapshot SnapshotScope) error {
			_, err := snapshot.ProjectDAO().AccessibleProjects(ctx, principal, Page{Limit: 10})
			return err
		},
	} {
		if err := s.ReadSnapshot(ctx, read); err == nil || errors.Is(err, model.ErrNotFound) {
			t.Fatalf("project read %d accepted missing ownership or hid corruption: %v", index, err)
		}
	}
}

func TestIdentityUserReturnsCanonicalPersonalReference(t *testing.T) {
	s := isolatedStore(t)
	user, principal, _ := testAuthRecords(t, s)
	ctx := context.Background()
	got, facts, err := testIdentityUser(s, ctx, principal.UserID)
	got.PersonalTeam.ID, got.PersonalTeam.Kind = facts.ID, "personal"
	if err != nil || !reflect.DeepEqual(got, user) || got.PersonalTeam.ID == "" || got.PersonalTeam.Kind != "personal" || got.PersonalTeam.Name != nil {
		t.Fatalf("account Personal reference differs from canonical login: %#v %#v %v", got, user, err)
	}
	if facts.MemberCount != 1 || facts.OwnerAdminCount != 1 {
		t.Fatalf("account member facts: %#v", facts)
	}
	var ownedTeam string
	if err := s.Pool.QueryRow(ctx, `SELECT t.id::text FROM teams t JOIN team_members m ON m.team_id=t.id
		WHERE t.personal_user_id=$1 AND m.user_id=$1 AND m.role='admin'`, user.ID).Scan(&ownedTeam); err != nil || ownedTeam != got.PersonalTeam.ID {
		t.Fatalf("account reference does not identify the stored Personal owner: %s %v", ownedTeam, err)
	}
	mustQueryExec(t, s, `DELETE FROM teams WHERE id=$1`, ownedTeam)
	if _, facts, err := testIdentityUser(s, ctx, user.ID); err != nil || facts.ID != "" || facts.MemberCount != 0 || facts.OwnerAdminCount != 0 {
		t.Fatalf("missing Personal Team facts: %#v %v", facts, err)
	}
}
