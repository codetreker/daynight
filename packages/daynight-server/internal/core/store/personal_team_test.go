package store

import (
	"context"
	"crypto/sha256"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
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
			after, err := s.IdentityUser(ctx, user.ID)
			if err != nil || after.Name != nil {
				t.Fatalf("failed login committed user UPSERT: %#v %v", after, err)
			}
			var projects int
			if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM projects`).Scan(&projects); err != nil || projects != 0 {
				t.Fatalf("invalid Personal created a project: %d %v", projects, err)
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
