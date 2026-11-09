package team

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
)

const mcpAdmissionUser = "11111111-1111-4111-8111-111111111111"
const mcpAdmissionTeam = "22222222-2222-4222-8222-222222222222"

type mcpAdmittedRead struct {
	after   *store.Position
	teams   store.TeamPage
	members store.TeamMemberPage
}

type mcpAdmittedSnapshot struct {
	store.SnapshotScope
	store.TeamReader
	t      *testing.T
	ctx    context.Context
	reads  []mcpAdmittedRead
	calls  int
	access int
	member bool
}

func (s *mcpAdmittedSnapshot) ReadSnapshot(ctx context.Context, operation func(store.SnapshotScope) error) error {
	s.calls++
	if ctx != s.ctx || s.calls != 1 {
		s.t.Errorf("snapshot context/calls = %v/%d", ctx, s.calls)
	}
	err := operation(s)
	if len(s.reads) != 0 {
		s.t.Errorf("unused admitted reads: %d", len(s.reads))
	}
	if s.member && s.access != 0 {
		s.t.Errorf("unconsumed member access: %d", s.access)
	}
	return err
}
func (s *mcpAdmittedSnapshot) TeamDAO() store.TeamReader { return s }
func (s *mcpAdmittedSnapshot) next(ctx context.Context, page store.Page) mcpAdmittedRead {
	if ctx != s.ctx || page.Limit != 1 || len(s.reads) == 0 {
		s.t.Fatalf("unexpected admitted query: ctx=%v page=%+v remaining=%d", ctx, page, len(s.reads))
	}
	next := s.reads[0]
	s.reads = s.reads[1:]
	if !reflect.DeepEqual(page.After, next.after) {
		s.t.Errorf("query position = %+v; want %+v", page.After, next.after)
	}
	return next
}
func (s *mcpAdmittedSnapshot) TeamsBounded(ctx context.Context, user string, page store.Page, max int) (store.TeamPage, error) {
	if s.member || user != mcpAdmissionUser || max != coreteam.MaxPageResponseJSONBytes {
		s.t.Errorf("TeamsBounded(%s, %d)", user, max)
	}
	return s.next(ctx, page).teams, nil
}
func (s *mcpAdmittedSnapshot) TeamAccess(ctx context.Context, user, team string) error {
	if !s.member || ctx != s.ctx || user != mcpAdmissionUser || team != mcpAdmissionTeam || s.access <= 0 {
		s.t.Fatalf("unexpected TeamAccess(%s, %s)", user, team)
	}
	s.access--
	return nil
}
func (s *mcpAdmittedSnapshot) TeamMembersPage(ctx context.Context, team string, page store.Page) (store.TeamMemberPage, error) {
	if !s.member || team != mcpAdmissionTeam {
		s.t.Errorf("TeamMembersPage(%s)", team)
	}
	return s.next(ctx, page).members, nil
}

type mcpMeasuredPage[T any] struct {
	items  []T
	cursor *string
	reject bool
}

func mcpPageMeasure[T any](t *testing.T, pages []mcpMeasuredPage[T]) func([]T, *string) error {
	t.Helper()
	t.Cleanup(func() {
		if len(pages) != 0 {
			t.Errorf("unused page measurements: %d", len(pages))
		}
	})
	return func(items []T, cursor *string) error {
		if len(pages) == 0 {
			t.Fatal("unexpected page measurement")
		}
		expected := pages[0]
		pages = pages[1:]
		if !reflect.DeepEqual(items, expected.items) || !reflect.DeepEqual(cursor, expected.cursor) {
			t.Errorf("measured page = %+v / %v; want %+v / %v", items, cursor, expected.items, expected.cursor)
		}
		if expected.reject {
			return &limit.Violation{Field: "mcp.page", Actual: (4 << 20) + 1, Max: 4 << 20, Unit: "bytes"}
		}
		return nil
	}
}

func TestMCPTeamAdmittedPageRetainsPrefixAndCursor(t *testing.T) {
	ctx := t.Context()
	principal := model.Principal{Kind: model.PATCredential, UserID: mcpAdmissionUser, CredentialID: "44444444-4444-4444-8444-444444444444"}
	items := make([]model.Team, 3)
	cursors := make([]string, 2)
	positions := make([]*store.Position, 2)
	for i, id := range []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"} {
		name := "Team"
		items[i] = model.Team{TeamRef: model.TeamRef{ID: id, Kind: "ordinary", Name: &name}, Version: 1, CreatedAt: time.Date(2026, 1, 1, 0, 0, i, 0, time.UTC)}
		if i < 2 {
			var err error
			cursors[i], err = query.EncodeListCursor(query.ListScope{Kind: "teams", UserID: principal.UserID}, items[i].CreatedAt, id)
			if err != nil {
				t.Fatal(err)
			}
			positions[i] = &store.Position{ID: id, CreatedAt: items[i].CreatedAt}
		}
	}
	for i := 0; i < 3; i++ {
		read := []mcpAdmittedRead{{teams: store.TeamPage{Items: items[i : i+1], HasMore: i < 2}}}
		if i > 0 {
			read[0].after = positions[i-1]
		}
		measure := []mcpMeasuredPage[model.Team]{{items: items[i : i+1], reject: i == 2}}
		if i < 2 {
			measure[0].cursor = &cursors[i]
			read = append(read, mcpAdmittedRead{after: positions[i], teams: store.TeamPage{Items: items[i+1 : i+2], HasMore: i == 0}})
			measure = append(measure, mcpMeasuredPage[model.Team]{items: items[i : i+2], reject: true})
			if i == 0 {
				measure[1].cursor = &cursors[1]
			}
		}
		snapshot := &mcpAdmittedSnapshot{t: t, ctx: ctx, reads: read}
		request := model.PageRequest{Limit: 10}
		if i > 0 {
			request.Cursor = &cursors[i-1]
		}
		result, err := (&Teams{reader: snapshot}).ListAdmitted(ctx, principal, request, mcpPageMeasure(t, measure))
		if i == 2 {
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "resource_limit_exceeded" || result.Items != nil || result.NextCursor != nil {
				t.Fatalf("oversized Team = %+v / %v", result, err)
			}
		} else if err != nil || !reflect.DeepEqual(result.Items, items[i:i+1]) || result.NextCursor == nil || *result.NextCursor != cursors[i] {
			t.Fatalf("Team page %d = %+v / %v", i, result, err)
		}
	}
}

func TestMCPMemberAdmittedPageRetainsPrefixAndCursor(t *testing.T) {
	ctx := t.Context()
	principal := model.Principal{Kind: model.PATCredential, UserID: mcpAdmissionUser, CredentialID: "44444444-4444-4444-8444-444444444444"}
	items := make([]model.TeamMemberProfile, 2)
	for i, id := range []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"} {
		items[i] = model.TeamMemberProfile{Membership: model.TeamMember{TeamID: mcpAdmissionTeam, UserID: id, Role: model.ProjectMemberRole, Version: 1, CreatedAt: time.Date(2026, 1, 1, 0, 0, i, 0, time.UTC)}}
	}
	cursor, err := coreteam.EncodeMemberCursor(principal, mcpAdmissionTeam, items[0])
	if err != nil {
		t.Fatal(err)
	}
	position := &store.Position{CreatedAt: items[0].Membership.CreatedAt, ID: items[0].Membership.UserID}
	for i := 0; i < 3; i++ {
		index := i
		if i == 2 {
			index = 0
		}
		read := []mcpAdmittedRead{{members: store.TeamMemberPage{Items: items[index : index+1], HasMore: i == 0}}}
		measure := []mcpMeasuredPage[model.TeamMemberProfile]{{items: items[index : index+1], reject: i == 2}}
		if i == 0 {
			measure[0].cursor = &cursor
			read = append(read, mcpAdmittedRead{after: position, members: store.TeamMemberPage{Items: items[1:]}})
			measure = append(measure, mcpMeasuredPage[model.TeamMemberProfile]{items: items, reject: true})
		}
		if i == 1 {
			read[0].after = position
		}
		snapshot := &mcpAdmittedSnapshot{t: t, ctx: ctx, reads: read, member: true, access: len(read)}
		request := model.PageRequest{Limit: 10}
		if i == 1 {
			request.Cursor = &cursor
		}
		result, err := (&Teams{reader: snapshot}).MembersAdmitted(ctx, principal, mcpAdmissionTeam, request, mcpPageMeasure(t, measure))
		if i == 2 {
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "resource_limit_exceeded" || result.Items != nil || result.NextCursor != nil {
				t.Fatalf("oversized member = %+v / %v", result, err)
			}
		} else if err != nil || !reflect.DeepEqual(result.Items, items[index:index+1]) || (i == 0 && (result.NextCursor == nil || *result.NextCursor != cursor)) || (i == 1 && result.NextCursor != nil) {
			t.Fatalf("member page %d = %+v / %v", i, result, err)
		}
	}
}
