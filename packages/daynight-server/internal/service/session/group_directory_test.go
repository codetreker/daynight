package session

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type groupDirectoryReadStore func(context.Context, func(store.HistoryDirectoryScope) error) error

func (f groupDirectoryReadStore) ReadHistoryDirectory(c context.Context, fn func(store.HistoryDirectoryScope) error) error {
	return f(c, fn)
}

type groupDirectoryTestScope struct {
	store.HistoryDirectoryScope
	credential store.CredentialReader
	project    store.ProjectReader
	dao        store.HistoryDirectoryDAO
	at         time.Time
}

func (s groupDirectoryTestScope) CredentialDAO() store.CredentialReader          { return s.credential }
func (s groupDirectoryTestScope) ProjectDAO() store.ProjectReader                { return s.project }
func (s groupDirectoryTestScope) HistoryDirectoryDAO() store.HistoryDirectoryDAO { return s.dao }
func (s groupDirectoryTestScope) ObservedAt(context.Context) (time.Time, error)  { return s.at, nil }

type groupDirectoryCredential func(context.Context, model.Principal) (store.ThreadCredential, error)

func (f groupDirectoryCredential) Credential(c context.Context, p model.Principal) (store.ThreadCredential, error) {
	return f(c, p)
}

type groupDirectoryAccess struct {
	store.ProjectReader
	read func(context.Context, model.Principal, string) (model.ProjectAccess, error)
}

func (r groupDirectoryAccess) ProjectAccess(c context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
	return r.read(c, p, id)
}

type groupDirectoryPageDAO struct {
	store.HistoryDirectoryDAO
	fence  func(context.Context, string) (string, error)
	groups func(context.Context, string, *store.HistoryGroupPosition, int) ([]store.HistoryDirectoryGroup, error)
}

func (d groupDirectoryPageDAO) Fence(c context.Context, p string) (string, error) {
	return d.fence(c, p)
}
func (d groupDirectoryPageDAO) Groups(c context.Context, p string, a *store.HistoryGroupPosition, n int) ([]store.HistoryDirectoryGroup, error) {
	return d.groups(c, p, a, n)
}

func TestGroupDirectoryRechecksAuthorizationInsideEverySnapshot(t *testing.T) {
	const project = "11111111-1111-4111-8111-111111111111"
	p := model.Principal{Kind: model.PATCredential, UserID: "22222222-2222-4222-8222-222222222222", CredentialID: "33333333-3333-4333-8333-333333333333"}
	cause := errors.New("snapshot failure")
	for _, stage := range []string{"success", "credential revoked", "credential storage", "project revoked", "page failure", "completion failure"} {
		t.Run(stage, func(t *testing.T) {
			ctx := t.Context()
			calls := []string{}
			scope := groupDirectoryTestScope{at: time.Date(2026, 11, 19, 0, 0, 0, 0, time.UTC)}
			scope.credential = groupDirectoryCredential(func(c context.Context, got model.Principal) (store.ThreadCredential, error) {
				calls = append(calls, "credential")
				if c != ctx || got != p {
					t.Fatal("credential inputs changed")
				}
				switch stage {
				case "credential revoked":
					return store.ThreadCredential{}, model.ErrNotFound
				case "credential storage":
					return store.ThreadCredential{}, cause
				}
				return store.ThreadCredential{}, nil
			})
			scope.project = groupDirectoryAccess{read: func(c context.Context, got model.Principal, id string) (model.ProjectAccess, error) {
				calls = append(calls, "project")
				if c != ctx || got != p || id != project {
					t.Fatal("project inputs changed")
				}
				if stage == "project revoked" {
					return model.ProjectAccess{}, model.ErrNotFound
				}
				return model.ProjectAccess{ProjectID: project, UserID: p.UserID, Role: model.ProjectMemberRole}, nil
			}}
			scope.dao = groupDirectoryPageDAO{fence: func(c context.Context, id string) (string, error) {
				calls = append(calls, "fence")
				if c != ctx || id != project {
					t.Fatal("fence inputs changed")
				}
				return "1", nil
			}, groups: func(c context.Context, id string, after *store.HistoryGroupPosition, n int) ([]store.HistoryDirectoryGroup, error) {
				calls = append(calls, "groups")
				if c != ctx || id != project || after != nil || n != 3 {
					t.Fatal("page inputs changed")
				}
				if stage == "page failure" {
					return nil, cause
				}
				return []store.HistoryDirectoryGroup{{ID: p.UserID, MemberCount: 1, TimeState: "unfinished"}}, nil
			}}
			service := NewGroupDirectory(groupDirectoryReadStore(func(c context.Context, fn func(store.HistoryDirectoryScope) error) error {
				calls = append(calls, "snapshot")
				if c != ctx {
					t.Fatal("snapshot context changed")
				}
				err := fn(scope)
				if err != nil {
					return err
				}
				if stage == "completion failure" {
					return cause
				}
				return nil
			}))
			q := core.HistoryDirectoryRequest{Kind: "groups", Limit: 2}
			out, err := service.Read(ctx, p, project, q)
			expected := []string{"snapshot", "credential", "project", "fence", "groups"}
			switch stage {
			case "credential revoked":
				expected = expected[:2]
				var f *model.Fault
				if !errors.As(err, &f) || f.Code != "unauthenticated" {
					t.Fatalf("revocation error %v", err)
				}
			case "credential storage":
				expected = expected[:2]
				if !errors.Is(err, cause) {
					t.Fatal(err)
				}
			case "project revoked":
				expected = expected[:3]
				if err == nil {
					t.Fatal("revoked project accepted")
				}
			case "page failure", "completion failure":
				if !errors.Is(err, cause) {
					t.Fatalf("lost error %v", err)
				}
			default:
				if err != nil || !out.ObservedAt.Equal(scope.at) || len(out.Items.([]core.HistoryDirectoryGroup)) != 1 {
					t.Fatalf("output %#v %v", out, err)
				}
			}
			if stage != "success" && !reflect.DeepEqual(out, core.HistoryDirectoryPage{}) {
				t.Fatalf("failed read exposed partial result %#v", out)
			}
			if !reflect.DeepEqual(calls, expected) {
				t.Fatalf("calls %v want %v", calls, expected)
			}
		})
	}
}

func TestGroupDirectoryInvalidInputNeverStartsSnapshot(t *testing.T) {
	const project = "11111111-1111-4111-8111-111111111111"
	p := model.Principal{Kind: model.PATCredential, UserID: "22222222-2222-4222-8222-222222222222", CredentialID: "33333333-3333-4333-8333-333333333333"}
	service := NewGroupDirectory(groupDirectoryReadStore(func(context.Context, func(store.HistoryDirectoryScope) error) error {
		t.Fatal("unexpected snapshot")
		return nil
	}))
	if _, err := service.Read(t.Context(), model.Principal{}, project, core.HistoryDirectoryRequest{Kind: "groups", Limit: 1}); err == nil {
		t.Fatal("missing identity accepted")
	}
	if _, err := service.Read(t.Context(), p, project, core.HistoryDirectoryRequest{Kind: "groups", Limit: 201}); err == nil {
		t.Fatal("invalid page accepted")
	}
}

func TestGroupDirectoryRevocationBetweenPagesStopsBeforeDirectoryRead(t *testing.T) {
	const project = "11111111-1111-4111-8111-111111111111"
	p := model.Principal{Kind: model.OAuthCredential, UserID: "22222222-2222-4222-8222-222222222222", CredentialID: "33333333-3333-4333-8333-333333333333"}
	for _, revoke := range []string{"credential", "project"} {
		t.Run(revoke, func(t *testing.T) {
			snapshots, pages := 0, 0
			scope := groupDirectoryTestScope{at: time.Now()}
			scope.credential = groupDirectoryCredential(func(context.Context, model.Principal) (store.ThreadCredential, error) {
				if snapshots == 2 && revoke == "credential" {
					return store.ThreadCredential{}, model.ErrNotFound
				}
				return store.ThreadCredential{}, nil
			})
			scope.project = groupDirectoryAccess{read: func(context.Context, model.Principal, string) (model.ProjectAccess, error) {
				if snapshots == 2 && revoke == "project" {
					return model.ProjectAccess{}, model.ErrNotFound
				}
				return model.ProjectAccess{ProjectID: project, UserID: p.UserID, Role: model.ProjectMemberRole}, nil
			}}
			scope.dao = groupDirectoryPageDAO{fence: func(context.Context, string) (string, error) {
				if snapshots != 1 {
					t.Fatal("revoked access reached directory")
				}
				return "1", nil
			}, groups: func(context.Context, string, *store.HistoryGroupPosition, int) ([]store.HistoryDirectoryGroup, error) {
				pages++
				return []store.HistoryDirectoryGroup{{ID: p.UserID, MemberCount: 1, TimeState: "unknown"}, {ID: p.CredentialID, MemberCount: 1, TimeState: "unknown"}}, nil
			}}
			service := NewGroupDirectory(groupDirectoryReadStore(func(_ context.Context, fn func(store.HistoryDirectoryScope) error) error {
				snapshots++
				return fn(scope)
			}))
			q := core.HistoryDirectoryRequest{Kind: "groups", Limit: 1}
			first, err := service.Read(t.Context(), p, project, q)
			if err != nil || first.NextCursor == nil {
				t.Fatalf("first %#v %v", first, err)
			}
			q.Cursor = *first.NextCursor
			last, err := service.Read(t.Context(), p, project, q)
			if err == nil || last.Items != nil || snapshots != 2 || pages != 1 {
				t.Fatalf("revocation %#v %v snapshots=%d pages=%d", last, err, snapshots, pages)
			}
		})
	}
}
