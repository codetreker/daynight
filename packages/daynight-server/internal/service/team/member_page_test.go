package team_test

import (
	"context"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/google/uuid"
)

func TestMemberPageBoundariesAndAccess(t *testing.T) {
	_, db, _, actor := projectService(t)
	teams := teamservice.NewTeams(db)
	ctx := context.Background()
	team := newTestTeam(t, teams, actor, "Paged")
	otherTeam := newTestTeam(t, teams, actor, "Other")
	member := servicePrincipal(t, db)
	third := servicePrincipal(t, db)
	outsider := servicePrincipal(t, db)
	for _, user := range []string{member.UserID, third.UserID} {
		if _, err := db.Pool.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, user); err != nil {
			t.Fatal(err)
		}
	}
	// Equal timestamps exercise the UUID tie-breaker in the keyset query.
	if _, err := db.Pool.Exec(ctx, `UPDATE team_members SET created_at='2026-01-01T00:00:00Z' WHERE team_id=$1`, team.ID); err != nil {
		t.Fatal(err)
	}
	full, err := teams.Members(ctx, actor, team.ID)
	if err != nil {
		t.Fatal(err)
	}
	var all []model.TeamMemberProfile
	var cursor *string
	for {
		page, err := teams.MembersPage(ctx, actor, team.ID, model.PageRequest{Limit: 1, Cursor: cursor})
		if err != nil || len(page.Items) != 1 {
			t.Fatalf("page %#v: %v", page, err)
		}
		all = append(all, page.Items...)
		if cursor == nil {
			if page.NextCursor == nil {
				t.Fatal("first page missing cursor")
			}
			_, err := teams.MembersPage(ctx, actor, otherTeam.ID, model.PageRequest{Limit: 1, Cursor: page.NextCursor})
			teamFault(t, err, "invalid_input")
			_, err = teams.MembersPage(ctx, member, team.ID, model.PageRequest{Limit: 1, Cursor: page.NextCursor})
			teamFault(t, err, "invalid_input")
		}
		cursor = page.NextCursor
		if cursor == nil {
			break
		}
		if len(all) > len(full) {
			t.Fatal("pagination repeated")
		}
	}
	if !reflect.DeepEqual(all, full) {
		t.Fatalf("pages %#v, full %#v", all, full)
	}
	_, err = teams.MembersPage(ctx, outsider, team.ID, model.PageRequest{Limit: 1})
	teamFault(t, err, "not_found")
	found, err := teams.Member(ctx, actor, team.ID, member.UserID)
	if err != nil || found.UserID != member.UserID {
		t.Fatalf("member %#v: %v", found, err)
	}
	_, err = teams.Member(ctx, outsider, team.ID, member.UserID)
	teamFault(t, err, "not_found")
	_, err = teams.Member(ctx, actor, team.ID, uuid.NewString())
	teamFault(t, err, "not_found")
	_, err = teams.Member(ctx, actor, team.ID, "invalid")
	teamFault(t, err, "invalid_input")
}
