package team

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type invitationPageReader struct {
	store.TeamReader
	team                 model.Team
	teamErr, pageErr     error
	teamCalls, pageCalls int
	page                 store.TeamInvitationPage
}

func (r *invitationPageReader) Team(context.Context, string, string) (model.Team, error) {
	r.teamCalls++
	return r.team, r.teamErr
}
func (r *invitationPageReader) TeamInvitationPage(context.Context, string, time.Time, store.Page) (store.TeamInvitationPage, error) {
	r.pageCalls++
	return r.page, r.pageErr
}

func TestInvitationPageRejectsInvalidScopeAndReadFailures(t *testing.T) {
	ctx := t.Context()
	principal := model.Principal{UserID: "00000000-0000-4000-8000-000000000001"}
	id := "00000000-0000-4000-8000-000000000002"
	clock := func() time.Time { return time.Now() }
	failure := errors.New("storage failure")
	reader := &invitationPageReader{team: model.Team{TeamRef: model.TeamRef{Kind: "ordinary"}, Membership: model.TeamMember{Role: model.ProjectAdmin}}}
	if _, err := ListInvitationPage(ctx, reader, principal, id, model.PageRequest{Limit: 0}, clock); err == nil || reader.teamCalls != 0 {
		t.Fatal("invalid limit reached Team lookup")
	}
	badCursor := "bad-cursor"
	if _, err := ListInvitationPage(ctx, reader, principal, id, model.PageRequest{Limit: 1, Cursor: &badCursor}, clock); err == nil || reader.teamCalls != 0 {
		t.Fatal("invalid cursor reached Team lookup")
	}
	reader.teamErr = model.ErrNotFound
	_, err := ListInvitationPage(ctx, reader, principal, id, model.PageRequest{Limit: 1}, clock)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "not_found" || reader.pageCalls != 0 {
		t.Fatal("missing Team was not safely rejected")
	}
	reader.teamErr = failure
	if _, err := ListInvitationPage(ctx, reader, principal, id, model.PageRequest{Limit: 1}, clock); !errors.Is(err, failure) || reader.pageCalls != 0 {
		t.Fatal("Team lookup failure was not propagated")
	}
	reader.teamErr = nil
	reader.team.Membership.Role = model.ProjectMemberRole
	_, err = ListInvitationPage(ctx, reader, principal, id, model.PageRequest{Limit: 1}, clock)
	if !errors.As(err, &fault) || fault.Code != "forbidden" || reader.pageCalls != 0 {
		t.Fatal("non-admin read invitation page")
	}
	reader.team.Membership.Role = model.ProjectAdmin
	reader.team.Kind = "personal"
	_, err = ListInvitationPage(ctx, reader, principal, id, model.PageRequest{Limit: 1}, clock)
	if !errors.As(err, &fault) || fault.Code != "personal_team_immutable" || reader.pageCalls != 0 {
		t.Fatal("Personal Team read invitation page")
	}
	reader.team.Kind = "ordinary"
	reader.pageErr = failure
	if _, err := ListInvitationPage(ctx, reader, principal, id, model.PageRequest{Limit: 1}, clock); !errors.Is(err, failure) || reader.pageCalls != 1 {
		t.Fatal("page read failure was not propagated")
	}
	reader.pageErr = nil
	page, err := ListInvitationPage(ctx, reader, principal, id, model.PageRequest{Limit: 1}, clock)
	if err != nil || len(page.Items) != 0 || page.NextCursor != nil {
		t.Fatalf("empty page: %#v %v", page, err)
	}
	reader.page = store.TeamInvitationPage{Items: []model.TeamInvitation{{ID: id, CreatedAt: clock()}}, HasMore: true}
	page, err = ListInvitationPage(ctx, reader, principal, id, model.PageRequest{Limit: 1}, clock)
	if err != nil || len(page.Items) != 1 || page.NextCursor == nil {
		t.Fatalf("page cursor: %#v %v", page, err)
	}
}
