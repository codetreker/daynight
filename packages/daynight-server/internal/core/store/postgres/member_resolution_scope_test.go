package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/google/uuid"
)

// Resolution uses the actual credential and Team transaction and persists no business changes.
func TestMemberResolutionScopeAuthorizationAndReadOnly(t *testing.T) {
	db, actor, team := storeTeamFixture(t)
	ctx := t.Context()
	admin, _, _ := testAuthRecords(t, db)
	member, memberActor, _ := testAuthRecords(t, db)
	outsider, _, _ := testAuthRecords(t, db)
	mustQueryExec(t, db, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'member')`, team.ID, admin.ID, member.ID)
	service := directMembers(db)
	input := func(p model.Principal, external string) coreteam.ResolveTeamMember {
		return coreteam.ResolveTeamMember{ExpectedUserID: p.UserID, ExternalUserID: external}
	}
	snapshot := func() string {
		t.Helper()
		var value string
		err := db.Pool.QueryRow(ctx, `SELECT json_build_array(
 (SELECT json_agg(row_to_json(u) ORDER BY u.id) FROM users u),
 (SELECT json_agg(row_to_json(t) ORDER BY t.id) FROM teams t),
 (SELECT json_agg(row_to_json(m) ORDER BY m.team_id,m.user_id) FROM team_members m),
 (SELECT count(*) FROM sessions), (SELECT count(*) FROM personal_access_tokens),
 (SELECT count(*) FROM oauth_grants), (SELECT count(*) FROM oauth_access_tokens),
 (SELECT count(*) FROM oauth_refresh_tokens))::text`).Scan(&value)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	unchanged := func(before string) {
		t.Helper()
		if snapshot() != before {
			t.Fatal("resolution changed users, Teams, memberships or credential counts")
		}
	}
	for _, target := range []model.User{admin, member} {
		before := snapshot()
		want := readStoreTeam(t, db, target.ID, team.ID).Membership
		got, err := service.ResolveMember(ctx, actor, team.ID, input(actor, target.UniAuthID))
		if err != nil || got == nil || *got != want {
			t.Fatalf("existing member: got %#v, want %#v, error %v", got, want, err)
		}
		unchanged(before)
	}
	for _, external := range []string{outsider.UniAuthID, "missing:" + uuid.NewString()} {
		before := snapshot()
		got, err := service.ResolveMember(ctx, actor, team.ID, input(actor, external))
		if err != nil || got != nil {
			t.Fatalf("absent mapping: %#v %v", got, err)
		}
		unchanged(before)
	}
	var personalID string
	if err := db.Pool.QueryRow(ctx, `SELECT id::text FROM teams WHERE personal_user_id=$1`, actor.UserID).Scan(&personalID); err != nil {
		t.Fatal(err)
	}
	issuer := actor
	issuer.Kind = "issuer"
	wrong := input(actor, member.UniAuthID)
	wrong.ExpectedUserID = uuid.NewString()
	for _, tc := range []struct {
		name, team, code string
		principal        model.Principal
		input            coreteam.ResolveTeamMember
	}{
		{"member", team.ID, "forbidden", memberActor, input(memberActor, admin.UniAuthID)},
		{"wrong actor", team.ID, "identity_mismatch", actor, wrong},
		{"issuer", team.ID, "unauthenticated", issuer, input(issuer, member.UniAuthID)},
		{"foreign Team", outsider.PersonalTeam.ID, "not_found", actor, input(actor, member.UniAuthID)},
		{"personal Team", personalID, "personal_team_immutable", actor, input(actor, member.UniAuthID)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := snapshot()
			got, err := service.ResolveMember(ctx, tc.principal, tc.team, tc.input)
			var fault *model.Fault
			if got != nil || !errors.As(err, &fault) || fault.Code != tc.code {
				t.Fatalf("refusal: %#v %v, want %s", got, err, tc.code)
			}
			unchanged(before)
		})
	}
	before := snapshot()
	got, err := service.ResolveMember(ctx, actor, uuid.NewString(), input(actor, member.UniAuthID))
	if got != nil || !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing Team: %#v %v", got, err)
	}
	unchanged(before)
	mustQueryExec(t, db, `DELETE FROM sessions WHERE id=$1`, actor.CredentialID)
	before = snapshot()
	got, err = service.ResolveMember(ctx, actor, team.ID, input(actor, member.UniAuthID))
	var fault *model.Fault
	if got != nil || !errors.As(err, &fault) || fault.Code != "unauthenticated" {
		t.Fatalf("revoked credential: %#v %v", got, err)
	}
	unchanged(before)
}

func TestMemberResolutionScopeObservesChangesDuringTeamLockWait(t *testing.T) {
	for _, change := range []string{"admin", "credential", "membership"} {
		t.Run(change, func(t *testing.T) {
			db, actor, team := storeTeamFixture(t)
			target, _, _ := testAuthRecords(t, db)
			other, _, _ := testAuthRecords(t, db)
			mustQueryExec(t, db, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'admin')`, team.ID, target.ID, other.ID)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			tx, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			if _, err := tx.Exec(ctx, `SELECT id FROM teams WHERE id=$1 FOR UPDATE`, team.ID); err != nil {
				t.Fatal(err)
			}
			type outcome struct {
				member *model.TeamMember
				err    error
			}
			done := make(chan outcome, 1)
			go func() {
				member, err := directMembers(db).ResolveMember(ctx, actor, team.ID, coreteam.ResolveTeamMember{ExpectedUserID: actor.UserID, ExternalUserID: target.UniAuthID})
				done <- outcome{member, err}
			}()
			testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT id::text FROM teams WHERE", tx.Conn().PgConn().PID())
			switch change {
			case "admin":
				_, err = tx.Exec(ctx, `UPDATE team_members SET role='member',version=nextval('team_member_versions') WHERE team_id=$1 AND user_id=$2`, team.ID, actor.UserID)
			case "credential":
				_, err = tx.Exec(ctx, `DELETE FROM sessions WHERE id=$1`, actor.CredentialID)
			case "membership":
				_, err = tx.Exec(ctx, `UPDATE team_members SET role='admin',version=nextval('team_member_versions') WHERE team_id=$1 AND user_id=$2`, team.ID, target.ID)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			var result outcome
			select {
			case result = <-done:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if change == "membership" {
				want := readStoreTeam(t, db, target.ID, team.ID).Membership
				if result.err != nil || result.member == nil || *result.member != want || want.Role != model.ProjectAdmin {
					t.Fatalf("current membership: %#v %v, want %#v", result.member, result.err, want)
				}
				return
			}
			var fault *model.Fault
			want := "forbidden"
			if change == "credential" {
				want = "unauthenticated"
			}
			if result.member != nil || !errors.As(result.err, &fault) || fault.Code != want {
				t.Fatalf("changed authorization: %#v %v, want %s", result.member, result.err, want)
			}
		})
	}
}
