package team

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"reflect"
	"testing"
	"time"
)

const mcpAdmissionUser = "11111111-1111-4111-8111-111111111111"
const mcpAdmissionTeam = "22222222-2222-4222-8222-222222222222"

type mcpPageSnapshot struct {
	store.SnapshotScope
	store.TeamReader
	t                        *testing.T
	ctx                      context.Context
	expected                 store.Page
	teams                    store.TeamPage
	members                  store.TeamMemberPage
	member                   bool
	snapshots, reads, access int
}

func (s *mcpPageSnapshot) ReadSnapshot(ctx context.Context, operation func(store.SnapshotScope) error) error {
	s.snapshots++
	if ctx != s.ctx || s.snapshots != 1 {
		s.t.Fatal("unexpected page snapshot")
	}
	err := operation(s)
	wantAccess := 0
	if s.member {
		wantAccess = 1
	}
	if s.reads != 1 || s.access != wantAccess {
		s.t.Errorf("page reads/access=%d/%d want=1/%d", s.reads, s.access, wantAccess)
	}
	return err
}
func (s *mcpPageSnapshot) TeamDAO() store.TeamReader { return s }
func (s *mcpPageSnapshot) read(ctx context.Context, page store.Page) {
	s.reads++
	if ctx != s.ctx || s.reads != 1 || !reflect.DeepEqual(page, s.expected) {
		s.t.Fatalf("unexpected page query: %+v want=%+v reads=%d", page, s.expected, s.reads)
	}
}
func (s *mcpPageSnapshot) Teams(ctx context.Context, user string, page store.Page) (store.TeamPage, error) {
	if s.member || user != mcpAdmissionUser {
		s.t.Fatalf("unexpected Teams actor %s", user)
	}
	s.read(ctx, page)
	return s.teams, nil
}
func (s *mcpPageSnapshot) TeamAccess(ctx context.Context, user, id string) error {
	s.access++
	if !s.member || ctx != s.ctx || user != mcpAdmissionUser || id != mcpAdmissionTeam || s.access != 1 || s.reads != 0 {
		s.t.Fatal("member access did not precede page read")
	}
	return nil
}
func (s *mcpPageSnapshot) TeamMembersPage(ctx context.Context, id string, page store.Page) (store.TeamMemberPage, error) {
	if !s.member || id != mcpAdmissionTeam || s.access != 1 {
		s.t.Fatal("unexpected member page")
	}
	s.read(ctx, page)
	return s.members, nil
}
func TestMCPTeamPageUsesOneBatchAndScopedCursor(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: mcpAdmissionUser, CredentialID: "44444444-4444-4444-8444-444444444444"}
	items := make([]model.Team, 3)
	for i, id := range []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"} {
		name := "Team"
		items[i] = model.Team{TeamRef: model.TeamRef{ID: id, Kind: "ordinary", Name: &name}, Version: 1, CreatedAt: time.Date(2026, 1, 1, 0, 0, i, 0, time.UTC)}
	}
	var cursor *string
	for offset := 0; offset < len(items); offset += 2 {
		end := min(offset+2, len(items))
		expected := store.Page{Limit: 2}
		if offset > 0 {
			last := items[offset-1]
			expected.After = &store.Position{ID: last.ID, CreatedAt: last.CreatedAt}
		}
		snapshot := &mcpPageSnapshot{t: t, ctx: t.Context(), expected: expected, teams: store.TeamPage{Items: items[offset:end], HasMore: end < len(items)}}
		result, err := (&Teams{reader: snapshot}).List(t.Context(), principal, model.PageRequest{Limit: 2, Cursor: cursor})
		if err != nil || !reflect.DeepEqual(result.Items, items[offset:end]) || (result.NextCursor != nil) != (end < len(items)) {
			t.Fatalf("Team page %d: %+v %v", offset, result, err)
		}
		if result.NextCursor != nil {
			decoded, err := query.ListPage(model.PageRequest{Limit: 2, Cursor: result.NextCursor}, query.ListScope{Kind: "teams", UserID: principal.UserID})
			if err != nil || decoded.After == nil || decoded.After.ID != items[end-1].ID || !decoded.After.CreatedAt.Equal(items[end-1].CreatedAt) {
				t.Fatalf("Team cursor: %+v %v", decoded, err)
			}
		}
		cursor = result.NextCursor
	}
}
func TestMCPMemberPageUsesOneBatchAndScopedCursor(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: mcpAdmissionUser, CredentialID: "44444444-4444-4444-8444-444444444444"}
	items := make([]model.TeamMemberProfile, 3)
	for i, id := range []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"} {
		items[i] = model.TeamMemberProfile{Membership: model.TeamMember{TeamID: mcpAdmissionTeam, UserID: id, Role: model.ProjectMemberRole, Version: 1, CreatedAt: time.Date(2026, 1, 1, 0, 0, i, 0, time.UTC)}}
	}
	var cursor *string
	for offset := 0; offset < len(items); offset += 2 {
		end := min(offset+2, len(items))
		expected := store.Page{Limit: 2}
		if offset > 0 {
			last := items[offset-1].Membership
			expected.After = &store.Position{ID: last.UserID, CreatedAt: last.CreatedAt}
		}
		snapshot := &mcpPageSnapshot{t: t, ctx: t.Context(), expected: expected, member: true, members: store.TeamMemberPage{Items: items[offset:end], HasMore: end < len(items)}}
		result, err := (&Teams{reader: snapshot}).MembersPage(t.Context(), principal, mcpAdmissionTeam, model.PageRequest{Limit: 2, Cursor: cursor})
		if err != nil || !reflect.DeepEqual(result.Items, items[offset:end]) || (result.NextCursor != nil) != (end < len(items)) {
			t.Fatalf("member page %d: %+v %v", offset, result, err)
		}
		if result.NextCursor != nil {
			expectedCursor, err := coreteam.EncodeMemberCursor(principal, mcpAdmissionTeam, items[end-1])
			if err != nil || *result.NextCursor != expectedCursor {
				t.Fatalf("member cursor: %v %v", result.NextCursor, err)
			}
		}
		cursor = result.NextCursor
	}
}
