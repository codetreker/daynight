package team

import (
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"reflect"
	"testing"
	"time"
)

func TestMCPTeamPageUsesOneBatchAndScopedCursor(t *testing.T) {
	items := []model.Team{fixtureTeam(), fixtureTeam(), fixtureTeam()}
	items[1].ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	items[2].ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	var cursor *string
	for offset := 0; offset < len(items); offset += 2 {
		f := newTeamFixture(t, listPlan()...)
		request := model.PageRequest{Limit: 2, Cursor: clonePointer(cursor)}
		end := min(offset+2, len(items))
		var next *string
		if end < len(items) {
			value, err := query.EncodeListCursor(query.ListScope{Kind: "teams", UserID: f.p.UserID}, items[end-1].CreatedAt, items[end-1].ID)
			if err != nil {
				t.Fatal(err)
			}
			next = &value
		}
		want := core.TeamPage{Items: items[offset:end], NextCursor: next}
		f.bindList(request, want, nil)
		got, err := f.service.List(f.ctx, f.p, request)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("page=%+v %v", got, err)
		}
		cursor = got.NextCursor
	}
}
func TestMCPMemberPageUsesOneBatchAndScopedCursor(t *testing.T) {
	items := []model.TeamMemberProfile{fixtureMember(), fixtureMember(), fixtureMember()}
	items[1].Membership.UserID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	items[2].Membership.UserID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	var cursor *string
	for offset := 0; offset < len(items); offset += 2 {
		f := newTeamFixture(t, readPlan("membersPage")...)
		request := model.PageRequest{Limit: 2, Cursor: clonePointer(cursor)}
		end := min(offset+2, len(items))
		var next *string
		if end < len(items) {
			value, err := query.EncodeListCursor(query.ListScope{Kind: "team_members", UserID: f.p.UserID, TeamID: f.id}, items[end-1].Membership.CreatedAt, items[end-1].Membership.UserID)
			if err != nil {
				t.Fatal(err)
			}
			next = &value
		}
		want := core.MemberPage{Items: items[offset:end], NextCursor: next}
		f.bindMembersPage(request, want, nil)
		got, err := f.service.MembersPage(f.ctx, f.p, f.rawID, request)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("member page=%+v %v", got, err)
		}
		cursor = got.NextCursor
	}
}
func TestListInvitationPageUsesOneSnapshotAndForwardsPaging(t *testing.T) {
	f := newTeamFixture(t, "validateRead", "snapshot", "reader", "invitationPage", "clock", "snapshot_done")
	f.now = time.Date(2026, 11, 6, 18, 30, 0, 0, time.FixedZone("clock", 3600))
	position := fixtureInvitation()
	position.CreatedAt = f.now.Add(-time.Hour)
	cursor, err := query.EncodeListCursor(query.ListScope{Kind: "team_invitations", UserID: f.p.UserID, ProjectID: f.id}, position.CreatedAt, position.ID)
	if err != nil {
		t.Fatal(err)
	}
	request := model.PageRequest{Limit: 2, Cursor: &cursor}
	item := fixtureInvitation()
	item.ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	item.CreatedAt = f.now.Add(-2 * time.Hour)
	next, err := query.EncodeListCursor(query.ListScope{Kind: "team_invitations", UserID: f.p.UserID, ProjectID: f.id}, item.CreatedAt, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	want := core.InvitationPage{Items: []model.TeamInvitation{item}, NextCursor: &next}
	f.bindInvitationPage(request, want, nil)
	got, err := f.service.ListInvitationPage(f.ctx, f.p, f.rawID, request)
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("invitation page=%+v %v", got, err)
	}
}
func TestListInvitationPageValidatesBeforeOpeningSnapshot(t *testing.T) {
	for _, test := range []struct{ name, id, code string }{{"unauthenticated", teamFixtureID, "unauthenticated"}, {"malformed Team", "invalid", "invalid_input"}} {
		t.Run(test.name, func(t *testing.T) {
			f := newTeamFixture(t, "validateRead")
			f.rawID = test.id
			if test.name == "unauthenticated" {
				f.p = model.Principal{}
			}
			refusal := fixtureFault(test.code)
			f.validateRead(refusal)
			got, err := f.service.ListInvitationPage(f.ctx, f.p, f.rawID, model.PageRequest{Limit: 1})
			if err != refusal || got.Items != nil || got.NextCursor != nil {
				t.Fatalf("invalid invitation page=%+v %v", got, err)
			}
		})
	}
}
func TestListInvitationPagePropagatesSnapshotAndAuthorizationErrors(t *testing.T) {
	t.Run("snapshot", func(t *testing.T) {
		f := newTeamFixture(t, "validateRead", "snapshot", "snapshot_done")
		f.validateRead(nil)
		f.runRead = false
		failure := errors.New("snapshot unavailable")
		f.readError = failure
		got, err := f.service.ListInvitationPage(f.ctx, f.p, f.rawID, model.PageRequest{Limit: 1})
		if err != failure || got.Items != nil || got.NextCursor != nil {
			t.Fatalf("snapshot failure=%+v %v", got, err)
		}
	})
	t.Run("authorization", func(t *testing.T) {
		f := newTeamFixture(t, "validateRead", "snapshot", "reader", "invitationPage", "clock", "snapshot_done")
		refusal := fixtureFault("forbidden")
		f.readCallbackError = refusal
		f.readError = refusal
		request := model.PageRequest{Limit: 1}
		f.bindInvitationPage(request, core.InvitationPage{}, refusal)
		got, err := f.service.ListInvitationPage(f.ctx, f.p, f.rawID, request)
		if err != refusal || got.Items != nil || got.NextCursor != nil {
			t.Fatalf("authorization failure=%+v %v", got, err)
		}
	})
}
func TestMemberPageBoundariesAndAccess(t *testing.T) {
	members := []model.TeamMemberProfile{fixtureMember(), fixtureMember(), fixtureMember()}
	members[1].Membership.UserID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	members[2].Membership.UserID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	t.Run("full directory", func(t *testing.T) {
		f := newTeamFixture(t, readPlan("members")...)
		f.bindMembers(members, nil)
		got, err := f.service.Members(f.ctx, f.p, f.rawID)
		if err != nil || !reflect.DeepEqual(got, members) {
			t.Fatalf("directory=%+v %v", got, err)
		}
	})
	var cursor *string
	var collected []model.TeamMemberProfile
	for i, member := range members {
		f := newTeamFixture(t, readPlan("membersPage")...)
		request := model.PageRequest{Limit: 1, Cursor: clonePointer(cursor)}
		var next *string
		if i < len(members)-1 {
			value, err := query.EncodeListCursor(query.ListScope{Kind: "team_members", UserID: f.p.UserID, TeamID: f.id}, member.Membership.CreatedAt, member.Membership.UserID)
			if err != nil {
				t.Fatal(err)
			}
			next = &value
		}
		want := core.MemberPage{Items: []model.TeamMemberProfile{member}, NextCursor: next}
		f.bindMembersPage(request, want, nil)
		got, err := f.service.MembersPage(f.ctx, f.p, f.rawID, request)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("member page=%+v %v", got, err)
		}
		collected = append(collected, got.Items...)
		cursor = got.NextCursor
	}
	if !reflect.DeepEqual(collected, members) {
		t.Fatal("member page forwarding lost directory fields")
	}
	firstCursor, err := query.EncodeListCursor(query.ListScope{Kind: "team_members", UserID: teamFixtureActor, TeamID: teamFixtureID}, members[0].Membership.CreatedAt, members[0].Membership.UserID)
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"other Team", "other actor"} {
		t.Run(kind, func(t *testing.T) {
			f := newTeamFixture(t, "validateRead")
			if kind == "other Team" {
				f.rawID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
				f.id = f.rawID
			} else {
				f.p.UserID = teamFixtureTarget
			}
			f.validateRead(nil)
			_, err := f.service.MembersPage(f.ctx, f.p, f.rawID, model.PageRequest{Limit: 1, Cursor: &firstCursor})
			teamFault(t, err, "invalid_input")
		})
	}
	for _, refused := range []bool{false, true} {
		t.Run("member", func(t *testing.T) {
			f := newTeamFixture(t, readPlan("member")...)
			want := fixtureMember().Membership
			var refusal error
			if refused {
				refusal = fixtureFault("not_found")
				want = model.TeamMember{}
			}
			f.bindMember(want, refusal)
			got, err := f.service.Member(f.ctx, f.p, f.rawID, f.target)
			if err != refusal || got != want {
				t.Fatalf("member=%+v %v", got, err)
			}
		})
	}
	t.Run("invalid member", func(t *testing.T) {
		f := newTeamFixture(t, "validateRead")
		f.target = "invalid"
		f.validateRead(nil)
		_, err := f.service.Member(f.ctx, f.p, f.rawID, f.target)
		teamFault(t, err, "invalid_input")
	})
}
