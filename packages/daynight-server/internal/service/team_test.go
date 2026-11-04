package service

import (
	"context"
	"errors"
	"math"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func teamFault(t *testing.T, err error, code string) {
	t.Helper()
	fault, classified := TeamResponseFault(err)
	if !classified {
		_ = errors.As(err, &fault)
	}
	if fault == nil || fault.Code != code {
		t.Fatalf("expected %s, got %v (%#v)", code, err, fault)
	}
}

func newTestTeam(t *testing.T, teams *Teams, p core.Principal, name string) core.Team {
	t.Helper()
	team, err := teams.Create(context.Background(), p, CreateTeam{Name: name, ExpectedUserID: p.UserID})
	if err != nil {
		t.Fatal(err)
	}
	return team
}

func TestTeamLifecycleUsesRealMembershipAndExactMetadata(t *testing.T) {
	_, db, _, actor := projectService(t)
	teams := NewTeams(db)
	ctx := context.Background()
	raw := " \t研发😀\u2003 " + strings.Repeat("x", 180)
	team := newTestTeam(t, teams, actor, raw)
	if team.Kind != "ordinary" || team.Name == nil || *team.Name != raw || team.Version != 1 || team.Membership.TeamID != team.ID || team.Membership.UserID != actor.UserID || team.Membership.Role != core.ProjectAdmin || team.Membership.Version < 1 || team.CreatedAt.IsZero() || !team.CreatedAt.Equal(team.UpdatedAt) {
		t.Fatalf("incomplete Team %#v", team)
	}
	duplicate := newTestTeam(t, teams, actor, raw)
	if duplicate.ID == team.ID {
		t.Fatal("name resolved existing Team")
	}
	got, err := teams.Get(ctx, actor, team.ID)
	if err != nil || !reflect.DeepEqual(got, team) {
		t.Fatalf("get %#v %v", got, err)
	}
	same, err := teams.Rename(ctx, actor, team.ID, ChangeTeam{Name: raw, Version: team.Version, ExpectedUserID: actor.UserID})
	if err != nil || !reflect.DeepEqual(same, team) {
		t.Fatalf("no-op %#v %v", same, err)
	}
	_, err = teams.Rename(ctx, actor, team.ID, ChangeTeam{Name: raw, Version: 2, ExpectedUserID: actor.UserID})
	teamFault(t, err, "version_conflict")
	changed, err := teams.Rename(ctx, actor, team.ID, ChangeTeam{Name: " Renamed ", Version: 1, ExpectedUserID: actor.UserID})
	if err != nil || changed.Version != 2 || *changed.Name != " Renamed " || !changed.UpdatedAt.After(team.UpdatedAt) || !reflect.DeepEqual(changed.Membership, team.Membership) {
		t.Fatalf("rename %#v %v", changed, err)
	}
	teamFault(t, teams.Delete(ctx, actor, team.ID, ChangeTeam{Name: raw, Version: changed.Version, ExpectedUserID: actor.UserID}), "version_conflict")
	if err := teams.Delete(ctx, actor, team.ID, ChangeTeam{Name: *changed.Name, Version: changed.Version, ExpectedUserID: actor.UserID}); err != nil {
		t.Fatal(err)
	}
	_, err = teams.Get(ctx, actor, team.ID)
	teamFault(t, err, "not_found")
	var count int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM team_members WHERE team_id=$1`, team.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("orphan members %d %v", count, err)
	}
	teamFault(t, teams.Delete(ctx, actor, team.ID, ChangeTeam{Name: *changed.Name, Version: changed.Version, ExpectedUserID: actor.UserID}), "not_found")
}

func TestTeamPermissionsPersonalAndNonemptyDeletion(t *testing.T) {
	_, db, _, actor := projectService(t)
	teams := NewTeams(db)
	ctx := context.Background()
	team := newTestTeam(t, teams, actor, "Team")
	member, outsider := servicePrincipal(t, db), servicePrincipal(t, db)
	if _, err := db.Pool.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, member.UserID); err != nil {
		t.Fatal(err)
	}
	got, err := teams.Get(ctx, member, team.ID)
	if err != nil || got.Membership.Role != core.ProjectMemberRole || got.Membership.UserID != member.UserID {
		t.Fatalf("member read %#v %v", got, err)
	}
	for _, principal := range []core.Principal{member, outsider} {
		code := "forbidden"
		if principal.UserID == outsider.UserID {
			code = "not_found"
		}
		_, err := teams.Rename(ctx, principal, team.ID, ChangeTeam{Name: "other", Version: 1, ExpectedUserID: principal.UserID})
		teamFault(t, err, code)
		teamFault(t, teams.Delete(ctx, principal, team.ID, ChangeTeam{Name: "Team", Version: 1, ExpectedUserID: principal.UserID}), code)
	}
	page, err := teams.List(ctx, actor, PageRequest{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	var personal core.Team
	for _, item := range page.Items {
		if item.Kind == "personal" {
			personal = item
		}
	}
	if personal.ID == "" || personal.Name != nil || personal.Membership.Role != core.ProjectAdmin {
		t.Fatalf("Personal %#v", personal)
	}
	_, err = teams.Rename(ctx, actor, personal.ID, ChangeTeam{Name: "Personal", Version: 1, ExpectedUserID: actor.UserID})
	teamFault(t, err, "personal_team_immutable")
	teamFault(t, teams.Delete(ctx, actor, personal.ID, ChangeTeam{Name: "Personal", Version: 1, ExpectedUserID: actor.UserID}), "personal_team_immutable")
	project, err := NewProjects(db).Create(ctx, actor, CreateProject{ExpectedUserID: actor.UserID, Name: "Owned", RepoURL: "host:repo"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE project_ownership SET team_id=$2 WHERE project_id=$1`, project.ID, team.ID); err != nil {
		t.Fatal(err)
	}
	teamFault(t, teams.Delete(ctx, actor, team.ID, ChangeTeam{Name: "Team", Version: 1, ExpectedUserID: actor.UserID}), "team_not_empty")
	got, err = teams.Get(ctx, actor, team.ID)
	if err != nil || !reflect.DeepEqual(got, team) {
		t.Fatalf("nonempty refusal changed Team %#v %v", got, err)
	}
	if _, err := NewProjects(db).Get(ctx, actor, project.ID); err != nil {
		t.Fatal("nonempty deletion changed Project", err)
	}
}

func TestTeamPaginationBindsCurrentActorAndRealVersions(t *testing.T) {
	_, db, _, actor := projectService(t)
	teams := NewTeams(db)
	ctx := context.Background()
	other := servicePrincipal(t, db)
	newTestTeam(t, teams, other, "Invisible older Team")
	first := newTestTeam(t, teams, actor, "Same")
	second := newTestTeam(t, teams, actor, "Same")
	const precise int64 = 9007199254740993
	if _, err := db.Pool.Exec(ctx, `UPDATE teams SET version=$2 WHERE id=$1;`, first.ID, precise); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE team_members SET version=$3 WHERE team_id=$1 AND user_id=$2`, first.ID, actor.UserID, precise+2); err != nil {
		t.Fatal(err)
	}
	var ids []string
	var cursor *string
	for {
		page, err := teams.List(ctx, actor, PageRequest{Limit: 1, Cursor: cursor})
		if err != nil || len(page.Items) != 1 {
			t.Fatalf("page %#v %v", page, err)
		}
		item := page.Items[0]
		ids = append(ids, item.ID)
		if item.ID == first.ID && (item.Version != precise || item.Membership.Version != precise+2) {
			t.Fatalf("rounded versions %#v", item)
		}
		if page.NextCursor == nil {
			break
		}
		if cursor == nil {
			_, err := teams.List(ctx, other, PageRequest{Limit: 1, Cursor: page.NextCursor})
			teamFault(t, err, "invalid_input")
		}
		cursor = page.NextCursor
	}
	if len(ids) != 3 || ids[1] != first.ID || ids[2] != second.ID {
		t.Fatalf("membership pagination %#v", ids)
	}
	_, err := teams.List(ctx, actor, PageRequest{Limit: 0})
	teamFault(t, err, "invalid_input")
	_, err = teams.List(ctx, actor, PageRequest{Limit: 1, Cursor: pointer("invalid")})
	teamFault(t, err, "invalid_input")
}

func TestTeamValidationAndIdentityGuardPrecedeSQL(t *testing.T) {
	_, db, url, actor := projectService(t)
	ctx := context.Background()
	other := servicePrincipal(t, db)
	var count atomic.Int32
	traced := tracedTasks(t, url, taskQueryAction{match: func(string) bool { count.Add(1); return false }})
	teams := NewTeams(traced.store)
	_, err := teams.Create(ctx, actor, CreateTeam{Name: "Good", ExpectedUserID: other.UserID})
	teamFault(t, err, "identity_mismatch")
	_, err = teams.Rename(ctx, actor, uuid.NewString(), ChangeTeam{Name: "Good", Version: 1, ExpectedUserID: other.UserID})
	teamFault(t, err, "identity_mismatch")
	teamFault(t, teams.Delete(ctx, actor, uuid.NewString(), ChangeTeam{Name: "Good", Version: 1, ExpectedUserID: other.UserID}), "identity_mismatch")
	if count.Load() != 0 {
		t.Fatalf("identity mismatch executed %d SQL queries", count.Load())
	}
	teams = NewTeams(nil)
	for _, name := range []string{"", " \t\n\u2003\u0085", "bad\x00name", "bad\xffname"} {
		_, err := teams.Create(ctx, actor, CreateTeam{Name: name, ExpectedUserID: actor.UserID})
		teamFault(t, err, "invalid_input")
		_, err = teams.Rename(ctx, actor, uuid.NewString(), ChangeTeam{Name: name, Version: 1, ExpectedUserID: actor.UserID})
		teamFault(t, err, "invalid_input")
	}
	for _, id := range []string{"invalid", strings.ToUpper("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")} {
		_, err := teams.Get(ctx, actor, id)
		teamFault(t, err, "invalid_input")
		_, err = teams.Rename(ctx, actor, id, ChangeTeam{Name: "valid", Version: 1, ExpectedUserID: actor.UserID})
		teamFault(t, err, "invalid_input")
	}
	_, err = teams.Rename(ctx, actor, uuid.NewString(), ChangeTeam{Name: "valid", Version: 0, ExpectedUserID: actor.UserID})
	teamFault(t, err, "invalid_input")
	for _, expected := range []string{"", strings.ToUpper("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")} {
		_, err := teams.Create(ctx, actor, CreateTeam{Name: "valid", ExpectedUserID: expected})
		teamFault(t, err, "invalid_input")
	}
	_, err = teams.Create(ctx, core.Principal{}, CreateTeam{Name: "valid", ExpectedUserID: actor.UserID})
	teamFault(t, err, "unauthenticated")
	_, err = teams.Get(ctx, core.Principal{}, uuid.NewString())
	teamFault(t, err, "unauthenticated")
	_, err = teams.List(ctx, core.Principal{}, PageRequest{Limit: 1})
	teamFault(t, err, "unauthenticated")
}

func TestTeamMetadataVersionExhaustionAndFaultPriority(t *testing.T) {
	_, db, _, actor := projectService(t)
	teams := NewTeams(db)
	ctx := context.Background()
	team := newTestTeam(t, teams, actor, "Full")
	if _, err := db.Pool.Exec(ctx, `UPDATE teams SET version=$2 WHERE id=$1`, team.ID, int64(math.MaxInt64)); err != nil {
		t.Fatal(err)
	}
	same, err := teams.Rename(ctx, actor, team.ID, ChangeTeam{Name: "Full", Version: math.MaxInt64, ExpectedUserID: actor.UserID})
	if err != nil || same.Version != math.MaxInt64 {
		t.Fatalf("exhausted no-op %#v %v", same, err)
	}
	_, err = teams.Rename(ctx, actor, team.ID, ChangeTeam{Name: "Changed", Version: math.MaxInt64, ExpectedUserID: actor.UserID})
	teamFault(t, err, "version_exhausted")
	sentinel := &pgconn.PgError{Code: "08006", Message: "private database failure"}
	refusal := &Fault{Code: "forbidden", Message: "refused"}
	for _, test := range []struct {
		tx   *store.TransactionError
		code string
	}{
		{&store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: sentinel}, "write_outcome_unknown"},
		{&store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.Join(refusal, sentinel)}, "internal_error"},
		{&store.TransactionError{Phase: "commit", Outcome: store.TransactionNotCommitted, CommitAttempted: true, Cause: sentinel}, "internal_error"},
	} {
		fault, ok := TeamResponseFault(test.tx)
		if !ok || fault.Code != test.code || !errors.Is(fault, sentinel) {
			t.Fatalf("completion priority %#v %v", fault, ok)
		}
	}
	if _, ok := TeamResponseFault(refusal); ok {
		t.Fatal("plain refusal gained transaction evidence")
	}
}
