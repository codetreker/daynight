package team

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
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

type invitationPageContractDAO struct {
	store.TeamReader
	team func(context.Context, string, string) (model.Team, error)
	page func(context.Context, string, time.Time, store.Page) (store.TeamInvitationPage, error)
}

func (d invitationPageContractDAO) Team(ctx context.Context, user, id string) (model.Team, error) {
	return d.team(ctx, user, id)
}
func (d invitationPageContractDAO) TeamInvitationPage(ctx context.Context, id string, now time.Time, page store.Page) (store.TeamInvitationPage, error) {
	return d.page(ctx, id, now, page)
}
func clonePageInvitation(v model.TeamInvitation) model.TeamInvitation {
	v.TokenHash = append([]byte(nil), v.TokenHash...)
	if v.ConsumedBy != nil {
		s := *v.ConsumedBy
		v.ConsumedBy = &s
	}
	if v.ConsumedAt != nil {
		at := *v.ConsumedAt
		v.ConsumedAt = &at
	}
	if v.RevokedAt != nil {
		at := *v.RevokedAt
		v.RevokedAt = &at
	}
	return v
}

func TestInvitationPagesPreserveCompleteRowsAndScopedPositions(t *testing.T) {
	ctx := t.Context()
	p := model.Principal{UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: "b2222222-2222-4222-8222-222222222222", Kind: model.PATCredential}
	id, other := "e5555555-5555-4555-8555-555555555555", "f6666666-6666-4666-8666-666666666666"
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	now := at.Add(time.Hour)
	clockCalls := 0
	clock := func() time.Time { clockCalls++; return now }
	name := "Invitation Team"
	team := model.Team{TeamRef: model.TeamRef{ID: id, Kind: "ordinary", Name: &name}, Version: 1, CreatedAt: at, UpdatedAt: at, Membership: model.TeamMember{TeamID: id, UserID: p.UserID, Role: model.ProjectAdmin, Version: 1, CreatedAt: at, UpdatedAt: at}}
	rows := make([]model.TeamInvitation, 3)
	for i := range rows {
		rows[i] = model.TeamInvitation{ID: fmt.Sprintf("%08x-aaaa-4aaa-8aaa-aaaaaaaaaaaa", i+1), TeamID: id, CreatedBy: p.UserID, TokenHash: secretutil.Hash("dnteam_" + strings.Repeat(string(rune('A'+i)), 42) + "A"), CreatedAt: at, ExpiresAt: at.Add(7 * 24 * time.Hour)}
	}
	var cursor *string
	var after *store.Position
	for i, row := range rows {
		calls := []string{}
		dao := invitationPageContractDAO{team: func(c context.Context, user, teamID string) (model.Team, error) {
			calls = append(calls, "team")
			if c != ctx || user != p.UserID || teamID != id || len(calls) != 1 {
				t.Fatalf("Team lookup: ctx=%v user=%q Team=%q calls=%v", c, user, teamID, calls)
			}
			value := team
			copyName := name
			value.Name = &copyName
			return value, nil
		}, page: func(c context.Context, teamID string, observed time.Time, page store.Page) (store.TeamInvitationPage, error) {
			calls = append(calls, "page")
			if c != ctx || teamID != id || observed != now || observed.Location() != time.UTC || !reflect.DeepEqual(page, store.Page{Limit: 1, After: after}) || !reflect.DeepEqual(calls, []string{"team", "page"}) {
				t.Fatalf("invitation page: ctx=%v Team=%q now=%v page=%#v calls=%v", c, teamID, observed, page, calls)
			}
			return store.TeamInvitationPage{Items: []model.TeamInvitation{clonePageInvitation(row)}, HasMore: i < 2}, nil
		}}
		result, err := ListInvitationPage(ctx, dao, p, id, model.PageRequest{Limit: 1, Cursor: cursor}, clock)
		if err != nil || !reflect.DeepEqual(result.Items, []model.TeamInvitation{row}) || (result.NextCursor != nil) != (i < 2) || !reflect.DeepEqual(calls, []string{"team", "page"}) {
			t.Fatalf("page %d: %#v error=%v calls=%v", i, result, err, calls)
		}
		if i == 0 {
			blocked := invitationPageContractDAO{team: func(context.Context, string, string) (model.Team, error) {
				t.Fatal("cross-Team cursor reached Team lookup")
				return model.Team{}, nil
			}, page: func(context.Context, string, time.Time, store.Page) (store.TeamInvitationPage, error) {
				t.Fatal("cross-Team cursor reached page lookup")
				return store.TeamInvitationPage{}, nil
			}}
			_, err := ListInvitationPage(ctx, blocked, p, other, model.PageRequest{Limit: 1, Cursor: result.NextCursor}, clock)
			faultCode(t, err, "invalid_input")
		}
		after = &store.Position{ID: row.ID, CreatedAt: row.CreatedAt}
		cursor = result.NextCursor
	}
	full := make([]model.TeamInvitation, 100)
	for i := range full {
		full[i] = model.TeamInvitation{ID: fmt.Sprintf("%08x-aaaa-4aaa-8aaa-aaaaaaaaaaaa", i+1), TeamID: id, CreatedBy: p.UserID, CreatedAt: at.Add(time.Duration(i) * time.Second), ExpiresAt: now.Add(24 * time.Hour)}
	}
	calls := []string{}
	dao := invitationPageContractDAO{team: func(c context.Context, user, teamID string) (model.Team, error) {
		calls = append(calls, "team")
		if c != ctx || user != p.UserID || teamID != id || len(calls) != 1 {
			t.Fatal("complete page changed bounded Team lookup")
		}
		value := team
		copyName := name
		value.Name = &copyName
		return value, nil
	}, page: func(c context.Context, teamID string, observed time.Time, page store.Page) (store.TeamInvitationPage, error) {
		calls = append(calls, "page")
		if c != ctx || teamID != id || observed != now || observed.Location() != time.UTC || !reflect.DeepEqual(page, store.Page{Limit: 100}) || !reflect.DeepEqual(calls, []string{"team", "page"}) {
			t.Fatal("complete page changed DAO arguments/order")
		}
		copies := make([]model.TeamInvitation, len(full))
		for i, v := range full {
			copies[i] = clonePageInvitation(v)
		}
		return store.TeamInvitationPage{Items: copies}, nil
	}}
	result, err := ListInvitationPage(ctx, dao, p, id, model.PageRequest{Limit: 100}, clock)
	if err != nil || !reflect.DeepEqual(result.Items, full) || result.NextCursor != nil || !reflect.DeepEqual(calls, []string{"team", "page"}) || clockCalls != 4 {
		t.Fatalf("full page=%#v error=%v calls=%v clockCalls=%d", result, err, calls, clockCalls)
	}
}
