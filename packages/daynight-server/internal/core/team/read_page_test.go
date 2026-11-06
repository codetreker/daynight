package team

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type boundedReader struct {
	store.TeamReader
	team                      model.Team
	teamErr                   error
	oversized                 bool
	teams                     store.TeamPage
	pageErr                   error
	members                   store.TeamMemberPage
	accessErr                 error
	member                    model.TeamMember
	memberErr                 error
	calls                     []string
	actorID, teamID, memberID string
	page                      store.Page
	limit                     int
}

func (r *boundedReader) TeamBounded(_ context.Context, actor, id string, limit int) (model.Team, bool, error) {
	r.calls = append(r.calls, "team")
	r.actorID, r.teamID, r.limit = actor, id, limit
	return r.team, r.oversized, r.teamErr
}
func (r *boundedReader) TeamsBounded(_ context.Context, actor string, page store.Page, limit int) (store.TeamPage, error) {
	r.calls = append(r.calls, "teams")
	r.actorID, r.page, r.limit = actor, page, limit
	return r.teams, r.pageErr
}
func (r *boundedReader) TeamAccess(_ context.Context, actor, id string) error {
	r.calls = append(r.calls, "access")
	r.actorID, r.teamID = actor, id
	return r.accessErr
}
func (r *boundedReader) TeamMembersPage(_ context.Context, id string, page store.Page) (store.TeamMemberPage, error) {
	r.calls = append(r.calls, "members")
	r.teamID, r.page = id, page
	return r.members, r.pageErr
}
func (r *boundedReader) InvitationTeamMember(_ context.Context, id, userID string) (model.TeamMember, error) {
	r.calls = append(r.calls, "member")
	r.teamID, r.memberID = id, userID
	return r.member, r.memberErr
}

func TestGetBoundedPreservesActorAndBudget(t *testing.T) {
	p := principal()
	team := namedTeam(p)
	failure := errors.New("read failed")
	for _, tc := range []struct {
		name      string
		err       error
		oversized bool
		code      string
	}{
		{name: "found"},
		{name: "not found", err: model.ErrNotFound, code: "not_found"},
		{name: "read failure", err: failure},
		{name: "oversized", oversized: true, code: "payload_too_large"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &boundedReader{team: team, teamErr: tc.err, oversized: tc.oversized}
			got, err := GetBounded(t.Context(), r, p, team.ID, 128)
			if r.actorID != p.UserID || r.teamID != team.ID || r.limit != 128 {
				t.Fatalf("wrong bounded lookup: %#v", r)
			}
			if tc.code != "" {
				faultCode(t, err, tc.code)
				if got.ID != "" {
					t.Fatalf("refusal returned Team: %#v", got)
				}
				if tc.err != nil && !errors.Is(err, tc.err) {
					t.Fatalf("cause lost: %v", err)
				}
			} else if tc.err != nil {
				if err != tc.err {
					t.Fatalf("error=%v; want %v", err, tc.err)
				}
			} else if err != nil || !reflect.DeepEqual(got, team) {
				t.Fatalf("bounded team=%#v, err=%v", got, err)
			}
		})
	}
}

func TestListBoundedPagesBindCursorToActorAndPosition(t *testing.T) {
	p := principal()
	first := namedTeam(p)
	second := namedTeam(p)
	r := &boundedReader{teams: store.TeamPage{Items: []model.Team{first}, HasMore: true}}
	page, err := ListBounded(t.Context(), r, p, model.PageRequest{Limit: 1}, 256)
	if err != nil || !reflect.DeepEqual(page.Items, r.teams.Items) || page.NextCursor == nil || r.actorID != p.UserID || r.page.Limit != 1 || r.limit != 256 {
		t.Fatalf("first page=%#v, reader=%#v, err=%v", page, r, err)
	}
	r.teams = store.TeamPage{Items: []model.Team{second}}
	last, err := ListBounded(t.Context(), r, p, model.PageRequest{Limit: 1, Cursor: page.NextCursor}, 256)
	if err != nil || !reflect.DeepEqual(last.Items, r.teams.Items) || last.NextCursor != nil || r.page.After == nil || r.page.After.ID != first.ID || !r.page.After.CreatedAt.Equal(first.CreatedAt) {
		t.Fatalf("last page=%#v, position=%#v, err=%v", last, r.page.After, err)
	}
	before := len(r.calls)
	_, err = ListBounded(t.Context(), r, principal(), model.PageRequest{Limit: 1, Cursor: page.NextCursor}, 256)
	faultCode(t, err, "invalid_input")
	if len(r.calls) != before {
		t.Fatal("cursor for another actor reached DAO")
	}
}

func TestListBoundedRejectsInvalidPagesAndReadFailures(t *testing.T) {
	p := principal()
	failure := errors.New("list failed")
	for _, tc := range []struct {
		name    string
		request model.PageRequest
		page    store.TeamPage
		err     error
		code    string
	}{
		{name: "invalid limit", request: model.PageRequest{Limit: 0}, code: "invalid_input"},
		{name: "read failure", request: model.PageRequest{Limit: 1}, err: failure},
		{name: "oversized team", request: model.PageRequest{Limit: 1}, page: store.TeamPage{OversizedTeamID: uuid.NewString()}, code: "payload_too_large"},
		{name: "empty", request: model.PageRequest{Limit: 1}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &boundedReader{teams: tc.page, pageErr: tc.err}
			page, err := ListBounded(t.Context(), r, p, tc.request, 128)
			if tc.code != "" {
				faultCode(t, err, tc.code)
			} else if err != tc.err {
				t.Fatalf("error=%v; want %v", err, tc.err)
			}
			if len(page.Items) != 0 || page.NextCursor != nil {
				t.Fatalf("unexpected page: %#v", page)
			}
			if tc.request.Limit == 0 && len(r.calls) != 0 {
				t.Fatal("invalid request reached DAO")
			}
		})
	}
	bad := namedTeam(p)
	bad.CreatedAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
	r := &boundedReader{teams: store.TeamPage{Items: []model.Team{bad}, HasMore: true}}
	_, err := ListBounded(t.Context(), r, p, model.PageRequest{Limit: 1}, 128)
	if err == nil || !strings.Contains(err.Error(), "encode Team cursor") {
		t.Fatalf("cursor encoding failure=%v", err)
	}
}

func TestMembersPageUsesScopedCursorAndAccessBeforePageRead(t *testing.T) {
	p := principal()
	id := uuid.NewString()
	member := model.TeamMemberProfile{Membership: model.TeamMember{TeamID: id, UserID: uuid.NewString(), Role: model.ProjectAdmin, Version: 2, CreatedAt: time.Now().UTC()}}
	r := &boundedReader{members: store.TeamMemberPage{Items: []model.TeamMemberProfile{member}, HasMore: true}}
	page, err := MembersPage(t.Context(), r, p, id, model.PageRequest{Limit: 1})
	if err != nil || !reflect.DeepEqual(page.Items, r.members.Items) || page.NextCursor == nil || !reflect.DeepEqual(r.calls, []string{"access", "members"}) || r.actorID != p.UserID || r.teamID != id {
		t.Fatalf("first members page=%#v, reader=%#v, err=%v", page, r, err)
	}
	position, err := query.ListPage(model.PageRequest{Limit: 1, Cursor: page.NextCursor}, query.ListScope{Kind: "team_members", UserID: p.UserID, TeamID: id})
	if err != nil || position.After == nil || position.After.ID != member.Membership.UserID || !position.After.CreatedAt.Equal(member.Membership.CreatedAt) {
		t.Fatalf("cursor position=%#v, err=%v", position, err)
	}
	r.members = store.TeamMemberPage{}
	last, err := MembersPage(t.Context(), r, p, id, model.PageRequest{Limit: 1, Cursor: page.NextCursor})
	if err != nil || len(last.Items) != 0 || last.NextCursor != nil || !reflect.DeepEqual(r.page, position) {
		t.Fatalf("last page=%#v, err=%v", last, err)
	}
	for _, scope := range []struct {
		p  model.Principal
		id string
	}{{principal(), id}, {p, uuid.NewString()}} {
		before := len(r.calls)
		_, err := MembersPage(t.Context(), r, scope.p, scope.id, model.PageRequest{Limit: 1, Cursor: page.NextCursor})
		faultCode(t, err, "invalid_input")
		if len(r.calls) != before {
			t.Fatal("cursor from another actor or Team reached DAO")
		}
	}
}

func TestMembersPageRejectsAccessFailuresAndOversizedProfiles(t *testing.T) {
	p := principal()
	id := uuid.NewString()
	failure := errors.New("read failed")
	for _, tc := range []struct {
		name               string
		request            model.PageRequest
		accessErr, pageErr error
		oversized          string
		code               string
		calls              []string
	}{
		{name: "invalid page", request: model.PageRequest{Limit: 0}, code: "invalid_input"},
		{name: "missing Team", request: model.PageRequest{Limit: 1}, accessErr: model.ErrNotFound, code: "not_found", calls: []string{"access"}},
		{name: "access error", request: model.PageRequest{Limit: 1}, accessErr: failure, calls: []string{"access"}},
		{name: "page error", request: model.PageRequest{Limit: 1}, pageErr: failure, calls: []string{"access", "members"}},
		{name: "oversized", request: model.PageRequest{Limit: 1}, oversized: uuid.NewString(), code: "payload_too_large", calls: []string{"access", "members"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &boundedReader{accessErr: tc.accessErr, pageErr: tc.pageErr, members: store.TeamMemberPage{OversizedUserID: tc.oversized}}
			page, err := MembersPage(t.Context(), r, p, id, tc.request)
			if tc.code != "" {
				faultCode(t, err, tc.code)
			} else if err != failure {
				t.Fatalf("error=%v; want original failure", err)
			}
			if !reflect.DeepEqual(r.calls, tc.calls) || len(page.Items) != 0 || page.NextCursor != nil {
				t.Fatalf("calls=%v, page=%#v", r.calls, page)
			}
			if tc.accessErr == model.ErrNotFound && !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("lookup cause lost: %v", err)
			}
		})
	}
	bad := model.TeamMemberProfile{Membership: model.TeamMember{UserID: uuid.NewString(), CreatedAt: time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)}}
	r := &boundedReader{members: store.TeamMemberPage{Items: []model.TeamMemberProfile{bad}, HasMore: true}}
	_, err := MembersPage(t.Context(), r, p, id, model.PageRequest{Limit: 1})
	if err == nil || !strings.Contains(err.Error(), "encode Team member cursor") {
		t.Fatalf("cursor encoding error=%v", err)
	}
}

func TestMemberRequiresTeamAccessAndPreservesMemberResult(t *testing.T) {
	p := principal()
	id, userID := uuid.NewString(), uuid.NewString()
	member := model.TeamMember{TeamID: id, UserID: userID, Role: model.ProjectMemberRole, Version: 7}
	failure := errors.New("membership read failed")
	for _, tc := range []struct {
		name                 string
		accessErr, memberErr error
		code                 string
		calls                []string
	}{
		{name: "found", calls: []string{"access", "member"}},
		{name: "missing Team", accessErr: model.ErrNotFound, code: "not_found", calls: []string{"access"}},
		{name: "access failure", accessErr: failure, calls: []string{"access"}},
		{name: "missing member", memberErr: model.ErrNotFound, code: "not_found", calls: []string{"access", "member"}},
		{name: "member failure", memberErr: failure, calls: []string{"access", "member"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &boundedReader{member: member, accessErr: tc.accessErr, memberErr: tc.memberErr}
			got, err := Member(t.Context(), r, p, id, userID)
			if !reflect.DeepEqual(r.calls, tc.calls) || r.actorID != p.UserID || r.teamID != id {
				t.Fatalf("lookup routing: %#v", r)
			}
			if tc.code != "" {
				faultCode(t, err, tc.code)
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("cause lost: %v", err)
				}
			} else if tc.accessErr != nil || tc.memberErr != nil {
				if err != failure {
					t.Fatalf("error=%v; want original failure", err)
				}
			} else if err != nil || got != member || r.memberID != userID {
				t.Fatalf("member=%#v, err=%v", got, err)
			}
		})
	}
}
