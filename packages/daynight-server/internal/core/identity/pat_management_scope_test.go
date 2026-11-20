package identity

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestCreateScopedPATRechecksExpiryAfterLock(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	deadline := now.Add(30 * time.Second)
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	d := &descriptionDAO{fresh: now.Add(time.Minute)}
	result, err := NewIdentity("").CreateScopedPAT(t.Context(), d, d, p, p.UserID, CreatePAT{Name: "test", ExpiresAt: &deadline}, nil, []scopepolicy.ScopeID{"task:read"}, now)
	checkFault(t, err, "invalid_input")
	if result.Secret != "" || d.stored.ScopePolicy == nil {
		t.Fatalf("returned secret or omitted proposed policy: %#v", result)
	}
}

func TestCreateScopedPATRefusalsAndFailures(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	failure := errors.New("storage unavailable")
	badDescription := "bad\x00description"
	for _, tc := range []struct {
		name, user, fail, code string
		description            *string
		scopes                 []scopepolicy.ScopeID
		calls                  []string
		cause                  error
	}{
		{"wrong account", uuid.NewString(), "", "forbidden", nil, []scopepolicy.ScopeID{"task:read"}, nil, nil},
		{"invalid description", p.UserID, "", "invalid_input", &badDescription, []scopepolicy.ScopeID{"task:read"}, nil, nil},
		{"empty scopes", p.UserID, "", "invalid_input", nil, nil, nil, nil},
		{"insert fails", p.UserID, "insert", "", nil, []scopepolicy.ScopeID{"task:read"}, []string{"lock", "cleanup", "insert"}, failure},
		{"clock fails", p.UserID, "fresh", "", nil, []scopepolicy.ScopeID{"task:read"}, []string{"lock", "cleanup", "insert", "fresh"}, failure},
		{"session expires", p.UserID, "final lock", "unauthenticated", nil, []scopepolicy.ScopeID{"task:read"}, []string{"lock", "cleanup", "insert", "fresh", "lock"}, model.ErrNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &descriptionDAO{fresh: now, fail: tc.fail, cause: tc.cause}
			result, err := NewIdentity("").CreateScopedPAT(t.Context(), d, d, p, tc.user, CreatePAT{Name: "test"}, tc.description, tc.scopes, now)
			if tc.code != "" {
				checkFault(t, err, tc.code)
			} else if !errors.Is(err, tc.cause) {
				t.Fatalf("error %v", err)
			}
			if result.Secret != "" || !reflect.DeepEqual(d.calls, tc.calls) {
				t.Fatalf("result=%+v calls=%v", result, d.calls)
			}
		})
	}
}

type scopedListDAO struct {
	store.PATScopeDAO
	t     *testing.T
	ctx   context.Context
	user  string
	items []model.PersonalAccessToken
	err   error
	calls int
}

func (d *scopedListDAO) ListPATScopes(ctx context.Context, user string) ([]model.PersonalAccessToken, error) {
	if ctx != d.ctx || user != d.user {
		d.t.Fatalf("unexpected list context or user: %v %q", ctx, user)
	}
	d.calls++
	return d.items, d.err
}

func TestListScopedPATsRefusesInvalidOrExpiredSessionAndReadFailures(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	failure := errors.New("read failed")
	for _, tc := range []struct {
		name, fail, code string
		principal        model.Principal
		readErr, cause   error
		calls            []string
		reads            int
	}{
		{"invalid session", "", "forbidden", model.Principal{}, nil, nil, nil, 0},
		{"session revoked", "first lock", "unauthenticated", p, nil, model.ErrNotFound, []string{"lock"}, 0},
		{"read failure", "", "", p, failure, failure, []string{"lock"}, 1},
		{"session expired after read", "final lock", "unauthenticated", p, nil, model.ErrNotFound, []string{"lock", "fresh", "lock"}, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &descriptionDAO{fresh: now, fail: tc.fail, cause: tc.cause}
			ctx := t.Context()
			scopes := &scopedListDAO{t: t, ctx: ctx, user: tc.principal.UserID, items: []model.PersonalAccessToken{{ID: uuid.NewString()}}, err: tc.readErr}
			items, err := NewIdentity("").ListScopedPATs(ctx, d, scopes, d, tc.principal, now)
			if tc.code != "" {
				checkFault(t, err, tc.code)
			} else if !errors.Is(err, tc.cause) {
				t.Fatalf("error %v", err)
			}
			if items != nil || scopes.calls != tc.reads || !reflect.DeepEqual(d.calls, tc.calls) {
				t.Fatalf("items=%v reads=%d calls=%v", items, scopes.calls, d.calls)
			}
		})
	}
}
