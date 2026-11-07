package team

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type invitationSnapshot struct {
	store.SnapshotScope
	dao  store.TeamReader
	read func(context.Context, func(store.SnapshotScope) error) error
}

func (s *invitationSnapshot) TeamDAO() store.TeamReader { return s.dao }
func (s *invitationSnapshot) ReadSnapshot(ctx context.Context, operation func(store.SnapshotScope) error) error {
	return s.read(ctx, operation)
}

type invitationReader struct {
	store.TeamReader
	team func(context.Context, string, string) (model.Team, error)
	page func(context.Context, string, time.Time, store.Page) (store.TeamInvitationPage, error)
}

func (r *invitationReader) Team(ctx context.Context, userID, teamID string) (model.Team, error) {
	return r.team(ctx, userID, teamID)
}
func (r *invitationReader) TeamInvitationPage(ctx context.Context, teamID string, now time.Time, page store.Page) (store.TeamInvitationPage, error) {
	return r.page(ctx, teamID, now, page)
}

func invitationPrincipal() model.Principal {
	return model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
}

func TestInvitationsAdmittedUsesOneExpiryTime(t *testing.T) {
	principal, teamID := invitationPrincipal(), uuid.NewString()
	now := time.Date(2026, 11, 6, 18, 30, 0, 0, time.UTC)
	items := []model.TeamInvitation{{ID: uuid.NewString(), TeamID: teamID, CreatedAt: now.Add(-time.Hour)}, {ID: uuid.NewString(), TeamID: teamID, CreatedAt: now.Add(-time.Minute)}}
	clockCalls, pageCalls := 0, 0
	reader := &invitationReader{
		team: func(context.Context, string, string) (model.Team, error) {
			return model.Team{TeamRef: model.TeamRef{ID: teamID, Kind: "ordinary"}, Membership: model.TeamMember{Role: model.ProjectAdmin}}, nil
		},
		page: func(_ context.Context, _ string, observed time.Time, page store.Page) (store.TeamInvitationPage, error) {
			if !observed.Equal(now) {
				t.Fatalf("expiry cutoff changed: %v", observed)
			}
			pageCalls++
			if page.After == nil {
				return store.TeamInvitationPage{Items: items[:1], HasMore: true}, nil
			}
			return store.TeamInvitationPage{Items: items[1:]}, nil
		},
	}
	snapshot := &invitationSnapshot{dao: reader}
	snapshot.read = func(_ context.Context, op func(store.SnapshotScope) error) error { return op(snapshot) }
	svc := &Teams{reader: snapshot, now: func() time.Time { clockCalls++; return now.Add(time.Duration(clockCalls-1) * time.Hour) }}
	page, err := svc.InvitationsAdmitted(t.Context(), principal, teamID, model.PageRequest{Limit: 2}, func([]model.TeamInvitation, *string) error { return nil })
	if err != nil || !reflect.DeepEqual(page.Items, items) || page.NextCursor != nil || clockCalls != 1 || pageCalls != 2 {
		t.Fatalf("page=%+v clock calls=%d page calls=%d err=%v", page, clockCalls, pageCalls, err)
	}
}

func TestListInvitationPageUsesOneSnapshotAndForwardsPaging(t *testing.T) {
	principal := invitationPrincipal()
	teamID := uuid.NewString()
	now := time.Date(2026, 11, 6, 18, 30, 0, 0, time.FixedZone("clock", 3600))
	position := store.Position{CreatedAt: now.Add(-time.Hour), ID: uuid.NewString()}
	scope := query.ListScope{Kind: "team_invitations", UserID: principal.UserID, ProjectID: teamID}
	cursor, err := query.EncodeListCursor(scope, position.CreatedAt, position.ID)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	items := []model.TeamInvitation{{ID: uuid.NewString(), TeamID: teamID, CreatedAt: now.Add(-2 * time.Hour)}}
	teamCalls, pageCalls, snapshotCalls := 0, 0, 0
	reader := &invitationReader{
		team: func(gotCtx context.Context, userID, id string) (model.Team, error) {
			teamCalls++
			if gotCtx != ctx || userID != principal.UserID || id != teamID {
				t.Fatalf("Team lookup used context=%v, user=%q, team=%q", gotCtx, userID, id)
			}
			return model.Team{TeamRef: model.TeamRef{ID: teamID, Kind: "ordinary"}, Membership: model.TeamMember{Role: model.ProjectAdmin}}, nil
		},
		page: func(gotCtx context.Context, id string, clock time.Time, page store.Page) (store.TeamInvitationPage, error) {
			pageCalls++
			if gotCtx != ctx || id != teamID || clock != now.UTC() || page.Limit != 2 || page.After == nil || !page.After.CreatedAt.Equal(position.CreatedAt) || page.After.ID != position.ID {
				t.Fatalf("invitation query used context=%v, team=%q, clock=%v, page=%+v", gotCtx, id, clock, page)
			}
			return store.TeamInvitationPage{Items: items, HasMore: true}, nil
		},
	}
	snapshot := &invitationSnapshot{dao: reader}
	snapshot.read = func(gotCtx context.Context, operation func(store.SnapshotScope) error) error {
		snapshotCalls++
		if gotCtx != ctx {
			t.Fatal("snapshot lost request context")
		}
		return operation(snapshot)
	}
	service := &Teams{reader: snapshot, now: func() time.Time { return now }}
	page, err := service.ListInvitationPage(ctx, principal, teamID, model.PageRequest{Limit: 2, Cursor: &cursor})
	if err != nil || !reflect.DeepEqual(page.Items, items) || page.NextCursor == nil || snapshotCalls != 1 || teamCalls != 1 || pageCalls != 1 {
		t.Fatalf("page=%+v, error=%v, snapshot/team/page calls=%d/%d/%d", page, err, snapshotCalls, teamCalls, pageCalls)
	}
	decoded, err := query.ListPage(model.PageRequest{Limit: 2, Cursor: page.NextCursor}, scope)
	if err != nil || decoded.After == nil || decoded.After.ID != items[0].ID || !decoded.After.CreatedAt.Equal(items[0].CreatedAt) {
		t.Fatalf("next cursor did not retain invitation scope and position: %+v, %v", decoded, err)
	}
}

func TestListInvitationPageValidatesBeforeOpeningSnapshot(t *testing.T) {
	for _, test := range []struct {
		name      string
		principal model.Principal
		id        string
		code      string
	}{
		{"unauthenticated", model.Principal{}, uuid.NewString(), "unauthenticated"},
		{"malformed Team", invitationPrincipal(), "invalid", "invalid_input"},
	} {
		t.Run(test.name, func(t *testing.T) {
			snapshot := &invitationSnapshot{read: func(context.Context, func(store.SnapshotScope) error) error {
				t.Fatal("invalid read opened a snapshot")
				return nil
			}}
			page, err := (&Teams{reader: snapshot}).ListInvitationPage(t.Context(), test.principal, test.id, model.PageRequest{Limit: 1})
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != test.code || len(page.Items) != 0 || page.NextCursor != nil {
				t.Fatalf("invalid read returned %+v, %v", page, err)
			}
		})
	}
}

func TestListInvitationPagePropagatesSnapshotAndAuthorizationErrors(t *testing.T) {
	principal, teamID := invitationPrincipal(), uuid.NewString()
	failure := errors.New("snapshot unavailable")
	for _, test := range []struct {
		name string
		err  error
		role model.ProjectRole
		code string
	}{
		{"snapshot", failure, model.ProjectAdmin, ""},
		{"member", nil, model.ProjectMemberRole, "forbidden"},
	} {
		t.Run(test.name, func(t *testing.T) {
			reader := &invitationReader{team: func(context.Context, string, string) (model.Team, error) {
				return model.Team{TeamRef: model.TeamRef{ID: teamID, Kind: "ordinary"}, Membership: model.TeamMember{Role: test.role}}, nil
			}, page: func(context.Context, string, time.Time, store.Page) (store.TeamInvitationPage, error) {
				t.Fatal("failed authorization reached invitation query")
				return store.TeamInvitationPage{}, nil
			}}
			snapshot := &invitationSnapshot{dao: reader}
			snapshot.read = func(_ context.Context, operation func(store.SnapshotScope) error) error {
				if test.err != nil {
					return test.err
				}
				return operation(snapshot)
			}
			page, err := (&Teams{reader: snapshot, now: time.Now}).ListInvitationPage(t.Context(), principal, teamID, model.PageRequest{Limit: 1})
			if len(page.Items) != 0 || page.NextCursor != nil {
				t.Fatalf("failed read returned invitation data: %+v", page)
			}
			if test.err != nil {
				if err != failure {
					t.Fatalf("snapshot error = %v; want original failure", err)
				}
			} else {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != test.code {
					t.Fatalf("authorization error = %v; want %q", err, test.code)
				}
			}
		})
	}
}
