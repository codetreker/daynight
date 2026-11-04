package store

import (
	"context"
	"crypto/sha256"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func identitySession(userID, subject string) (core.User, core.Session) {
	now := time.Now().UTC()
	hash := sha256.Sum256([]byte(uuid.NewString()))
	return core.User{ID: userID, UniAuthID: subject}, core.Session{ID: uuid.NewString(), TokenHash: hash[:], CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
}

func TestPersonalTeamConcurrentAndRepeatedLoginReusesCanonicalOwner(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	const logins = 6
	var wait sync.WaitGroup
	users := make(chan core.User, logins)
	failures := make(chan error, logins)
	for range logins {
		wait.Go(func() {
			user, session := identitySession(uuid.NewString(), "github:concurrent-personal")
			canonical, err := s.CreateIdentitySession(ctx, user, session)
			users <- canonical
			failures <- err
		})
	}
	wait.Wait()
	close(users)
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	var canonical string
	for user := range users {
		if canonical != "" && canonical != user.ID {
			t.Fatal("concurrent login did not use canonical user")
		}
		canonical = user.ID
	}
	var teamID string
	var memberVersion int64
	var createdAt time.Time
	if err := s.Pool.QueryRow(ctx, `SELECT t.id::text,m.version,m.created_at FROM teams t JOIN team_members m ON m.team_id=t.id
		WHERE t.personal_user_id=$1 AND m.user_id=$1 AND m.role='admin'`, canonical).Scan(&teamID, &memberVersion, &createdAt); err != nil {
		t.Fatal(err)
	}
	user, session := identitySession(uuid.NewString(), "github:concurrent-personal")
	if _, err := s.CreateIdentitySession(ctx, user, session); err != nil {
		t.Fatal(err)
	}
	var valid bool
	if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM users)=1 AND (SELECT count(*) FROM teams)=1
		AND (SELECT count(*) FROM team_members)=1 AND (SELECT count(*) FROM sessions)=$1
		AND EXISTS(SELECT 1 FROM team_members WHERE team_id=$2 AND user_id=$3 AND version=$4 AND created_at=$5)`,
		logins+1, teamID, canonical, memberVersion, createdAt).Scan(&valid); err != nil || !valid {
		t.Fatalf("repeated login changed Personal identity or owner membership: %v %v", valid, err)
	}
}

func TestPersonalInitializationAndSessionRollbackTogether(t *testing.T) {
	for _, phase := range []string{"team", "owner", "session"} {
		t.Run(phase, func(t *testing.T) {
			s := isolatedStore(t)
			table := map[string]string{"team": "teams", "owner": "team_members", "session": "sessions"}[phase]
			mustQueryExec(t, s, `CREATE FUNCTION reject_personal_insert() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN RAISE EXCEPTION 'test Personal initialization failure'; END $$;
				CREATE TRIGGER reject_personal_insert BEFORE INSERT ON `+table+` FOR EACH ROW EXECUTE FUNCTION reject_personal_insert()`)
			user, session := identitySession(uuid.NewString(), "github:rollback-personal")
			if _, err := s.CreateIdentitySession(context.Background(), user, session); err == nil {
				t.Fatal("failed Personal initialization succeeded")
			}
			var empty bool
			if err := s.Pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM users)=0
				AND (SELECT count(*) FROM teams)=0 AND (SELECT count(*) FROM team_members)=0 AND (SELECT count(*) FROM sessions)=0`).Scan(&empty); err != nil || !empty {
				t.Fatalf("login transaction left partial identity: %v %v", empty, err)
			}
		})
	}
}

func TestPersonalIntegrityFailuresAreNotRepairedByLoginOrProjectCreation(t *testing.T) {
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
			login, session := identitySession(uuid.NewString(), user.UniAuthID)
			login.Name = new("Changed")
			if _, err := s.CreateIdentitySession(ctx, login, session); err == nil || errors.Is(err, core.ErrNotFound) {
				t.Fatalf("login hid invalid Personal ownership: %v", err)
			}
			if _, err := s.CreatePrivateProject(ctx, principal, uuid.NewString(), "Invalid", "host:repo"); err == nil || errors.Is(err, core.ErrNotFound) {
				t.Fatalf("project creation hid invalid Personal ownership: %v", err)
			}
			if _, err := s.IdentityUser(ctx, user.ID); err == nil || errors.Is(err, core.ErrNotFound) {
				t.Fatalf("account read hid invalid Personal ownership: %v", err)
			}
			var name *string
			if err := s.Pool.QueryRow(ctx, `SELECT name FROM users WHERE id=$1`, user.ID).Scan(&name); err != nil || name != nil {
				t.Fatalf("failed login committed user UPSERT: %v %v", name, err)
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
			if err == nil || project != (core.Project{}) || !errors.As(err, &transaction) ||
				transaction.CommitAttempted || transaction.CleanupFailed || transaction.Outcome != TransactionNotCommitted {
				t.Fatalf("failed Personal lookup returned a project or uncertain transaction: %#v %#v %v", project, transaction, err)
			}
			if failure == "missing-team" {
				if errors.Is(err, core.ErrNotFound) || transaction.Cause.Error() != "user Personal Team is missing" {
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
	for index, read := range []func(*Snapshot) error{
		func(snapshot *Snapshot) error { _, err := snapshot.Project(ctx, project.ID); return err },
		func(snapshot *Snapshot) error { _, err := snapshot.Projects(ctx, Page{Limit: 10}); return err },
		func(snapshot *Snapshot) error {
			_, err := snapshot.AccessibleProjects(ctx, principal, Page{Limit: 10})
			return err
		},
	} {
		if err := s.ReadSnapshot(ctx, read); err == nil || errors.Is(err, core.ErrNotFound) {
			t.Fatalf("project read %d accepted missing ownership or hid corruption: %v", index, err)
		}
	}
}

func TestIdentityUserReturnsCanonicalPersonalReference(t *testing.T) {
	s := isolatedStore(t)
	user, principal, _ := testAuthRecords(t, s)
	ctx := context.Background()
	got, err := s.IdentityUser(ctx, principal.UserID)
	if err != nil || !reflect.DeepEqual(got, user) || got.PersonalTeam.ID == "" || got.PersonalTeam.Kind != "personal" || got.PersonalTeam.Name != nil {
		t.Fatalf("account Personal reference differs from canonical login: %#v %#v %v", got, user, err)
	}
	var ownedTeam string
	if err := s.Pool.QueryRow(ctx, `SELECT t.id::text FROM teams t JOIN team_members m ON m.team_id=t.id
		WHERE t.personal_user_id=$1 AND m.user_id=$1 AND m.role='admin'`, user.ID).Scan(&ownedTeam); err != nil || ownedTeam != got.PersonalTeam.ID {
		t.Fatalf("account reference does not identify the stored Personal owner: %s %v", ownedTeam, err)
	}
	mustQueryExec(t, s, `DELETE FROM teams WHERE id=$1`, ownedTeam)
	if _, err := s.IdentityUser(ctx, user.ID); err == nil || errors.Is(err, core.ErrNotFound) {
		t.Fatalf("missing Personal Team was hidden as an absent account: %v", err)
	}
}
