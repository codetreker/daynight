package identity

import (
	"context"
	"errors"
	"sync"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
)

func TestPersonalTeamConcurrentAndRepeatedLoginReusesCanonicalOwner(t *testing.T) {
	f := newIdentityFixture(t)
	ctx := context.Background()
	const logins = 6
	starts := make([]core.LoginStart, logins)
	for i := range starts {
		starts[i] = startIdentityLogin(t, f, "/")
	}
	var wait sync.WaitGroup
	results := make(chan core.LoginCompletion, logins)
	failures := make(chan error, logins)
	for _, start := range starts {
		wait.Go(func() {
			result, err := f.identity.CompleteLogin(ctx, identityQuery(start, "personal"), start.BrowserBinding)
			results <- result
			failures <- err
		})
	}
	wait.Wait()
	close(results)
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	var userID, teamID string
	for result := range results {
		if userID != "" && (userID != result.User.ID || teamID != result.User.PersonalTeam.ID) {
			t.Fatal("concurrent login did not use canonical user and team")
		}
		userID, teamID = result.User.ID, result.User.PersonalTeam.ID
	}
	var memberVersion int64
	var memberCreatedAt any
	if err := f.database.Pool.QueryRow(ctx, `SELECT version,created_at FROM team_members WHERE team_id=$1 AND user_id=$2 AND role='admin'`, teamID, userID).Scan(&memberVersion, &memberCreatedAt); err != nil {
		t.Fatal(err)
	}
	again := completeIdentityLogin(t, f, "personal")
	if again.User.ID != userID || again.User.PersonalTeam.ID != teamID {
		t.Fatal("repeat login changed identity or team")
	}
	var valid bool
	if err := f.database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM users)=1 AND (SELECT count(*) FROM teams)=1 AND (SELECT count(*) FROM team_members)=1 AND (SELECT count(*) FROM sessions)=$1 AND EXISTS(SELECT 1 FROM team_members WHERE team_id=$2 AND user_id=$3 AND version=$4 AND created_at=$5)`, logins+1, teamID, userID, memberVersion, memberCreatedAt).Scan(&valid); err != nil || !valid {
		t.Fatalf("repeated login changed Personal identity or owner membership: %v %v", valid, err)
	}
}

func TestPersonalInitializationAndSessionRollbackTogether(t *testing.T) {
	for _, phase := range []string{"team", "owner", "session"} {
		t.Run(phase, func(t *testing.T) {
			f := newIdentityFixture(t)
			ctx := context.Background()
			start := startIdentityLogin(t, f, "/")
			table := map[string]string{"team": "teams", "owner": "team_members", "session": "sessions"}[phase]
			if _, err := f.database.Pool.Exec(ctx, `CREATE FUNCTION reject_personal_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test Personal initialization failure'; END $$; CREATE TRIGGER reject_personal_insert BEFORE INSERT ON `+table+` FOR EACH ROW EXECUTE FUNCTION reject_personal_insert()`); err != nil {
				t.Fatal(err)
			}
			result, err := f.identity.CompleteLogin(ctx, identityQuery(start, "rollback-personal"), start.BrowserBinding)
			if err == nil || result.Secret != "" {
				t.Fatalf("failed initialization issued a secret: %#v %v", result, err)
			}
			var empty bool
			if err := f.database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM users)=0 AND (SELECT count(*) FROM teams)=0 AND (SELECT count(*) FROM team_members)=0 AND (SELECT count(*) FROM sessions)=0`).Scan(&empty); err != nil || !empty {
				t.Fatalf("login transaction left partial identity: %v %v", empty, err)
			}
		})
	}
}

func TestPersonalIntegrityFailuresAreNotRepairedByLogin(t *testing.T) {
	for _, damage := range []string{"missing-owner", "wrong-role", "additional-member"} {
		t.Run(damage, func(t *testing.T) {
			f := newIdentityFixture(t)
			ctx := context.Background()
			first := completeIdentityLogin(t, f, "personal")
			principal := identityPrincipal(t, f, first)
			switch damage {
			case "missing-owner":
				if _, err := f.database.Pool.Exec(ctx, `DELETE FROM team_members WHERE user_id=$1`, first.User.ID); err != nil {
					t.Fatal(err)
				}
			case "wrong-role":
				if _, err := f.database.Pool.Exec(ctx, `UPDATE team_members SET role='member' WHERE user_id=$1`, first.User.ID); err != nil {
					t.Fatal(err)
				}
			case "additional-member":
				other := completeIdentityLogin(t, f, "other")
				if _, err := f.database.Pool.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, first.User.PersonalTeam.ID, other.User.ID); err != nil {
					t.Fatal(err)
				}
			}
			profile := identityProfile(first.User.UniAuthID)
			profile["name"] = "Changed"
			f.replies["updated-personal"] = identityReply{status: 200, body: profile}
			start := startIdentityLogin(t, f, "/")
			result, err := f.identity.CompleteLogin(ctx, identityQuery(start, "updated-personal"), start.BrowserBinding)
			if err == nil || errors.Is(err, model.ErrNotFound) || result.Secret != "" {
				t.Fatalf("login hid invalid Personal ownership or issued secret: %#v %v", result, err)
			}
			if _, err := f.identity.User(ctx, principal); err == nil || errors.Is(err, model.ErrNotFound) {
				t.Fatalf("account read hid invalid Personal ownership: %v", err)
			}
			if _, err := projectservice.NewProjects(f.database).Create(ctx, principal, projectcore.CreateProject{Name: "Invalid", RepoURL: "host:repo", ExpectedUserID: principal.UserID}); err == nil || errors.Is(err, model.ErrNotFound) {
				t.Fatalf("project creation hid invalid Personal ownership: %v", err)
			}
			var name string
			if err := f.database.Pool.QueryRow(ctx, `SELECT name FROM users WHERE id=$1`, first.User.ID).Scan(&name); err != nil || name != "Display name" {
				t.Fatalf("failed login committed user UPSERT: %q %v", name, err)
			}
			var projects int
			if err := f.database.Pool.QueryRow(ctx, `SELECT count(*) FROM projects`).Scan(&projects); err != nil || projects != 0 {
				t.Fatalf("invalid Personal created a project: %d %v", projects, err)
			}
		})
	}
}

func TestIdentityUserPersonalTeamReferenceAndMissingTeam(t *testing.T) {
	f := newIdentityFixture(t)
	ctx := context.Background()
	login := completeIdentityLogin(t, f, "account")
	principal := identityPrincipal(t, f, login)
	user, err := f.identity.User(ctx, principal)
	if err != nil || user.PersonalTeam.ID != login.User.PersonalTeam.ID || user.PersonalTeam.Kind != "personal" || user.PersonalTeam.Name != nil {
		t.Fatalf("account Personal reference: %#v %v", user.PersonalTeam, err)
	}
	if _, err := f.database.Pool.Exec(ctx, `DELETE FROM teams WHERE id=$1`, user.PersonalTeam.ID); err != nil {
		t.Fatal(err)
	}
	_, err = f.identity.User(ctx, principal)
	if err == nil || errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing Personal Team was hidden as an absent account: %v", err)
	}
	requireIdentityOperationalError(t, err)
}
