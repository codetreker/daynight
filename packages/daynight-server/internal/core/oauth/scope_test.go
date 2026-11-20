package oauth

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type scopeFake struct {
	store.OAuthScopeDAO
	steps                         []string
	grant                         store.OAuthGrant
	identity                      store.OAuthAccessIdentity
	readErr, sessionErr, clockErr error
	now, fresh                    time.Time
	sessionCalls                  int
	hash                          []byte
	bindings                      []store.OAuthBinding
	selected                      []scopepolicy.ScopeID
	lockedOwner, lockedGrant      string
	writeOwner, writeGrant        string
	writeVersion                  int64
}

func (f *scopeFake) ScopedAccess(_ context.Context, hash []byte, bindings []store.OAuthBinding, _ time.Time) (store.OAuthAccessIdentity, error) {
	f.steps = append(f.steps, "hash")
	f.hash, f.bindings = hash, bindings
	return f.identity, f.readErr
}
func (f *scopeFake) LockScopedAccess(_ context.Context, _ model.Principal, bindings []store.OAuthBinding, _ time.Time) (store.OAuthAccessIdentity, error) {
	f.steps = append(f.steps, "access")
	f.bindings = bindings
	return f.identity, f.readErr
}
func (f *scopeFake) LockGrantScope(_ context.Context, owner, grant string) (store.OAuthGrant, error) {
	f.steps = append(f.steps, "grant")
	f.lockedOwner, f.lockedGrant = owner, grant
	return f.grant, f.readErr
}
func (f *scopeFake) LockOwnerSession(_ context.Context, _ model.Principal, now time.Time) error {
	f.steps = append(f.steps, "session")
	f.sessionCalls++
	if f.sessionCalls == 1 && now != f.now || f.sessionCalls == 2 && now != f.fresh {
		return errors.New("wrong session time")
	}
	if f.sessionCalls == 2 {
		return f.sessionErr
	}
	return nil
}
func (f *scopeFake) FreshTime(_ context.Context, now time.Time) (time.Time, error) {
	f.steps = append(f.steps, "time")
	if now != f.now {
		return time.Time{}, errors.New("wrong time")
	}
	return f.fresh, f.clockErr
}
func (f *scopeFake) CompareGrantScope(_ context.Context, owner, grant string, version int64, scopes []scopepolicy.ScopeID, now time.Time) (store.OAuthGrant, error) {
	f.steps = append(f.steps, "write")
	f.writeOwner, f.writeGrant, f.writeVersion = owner, grant, version
	f.selected = scopes
	if now != f.fresh {
		return store.OAuthGrant{}, errors.New("wrong write time")
	}
	return f.grant, nil
}
func scopeTestFake(t *testing.T) (*scopeFake, model.Principal) {
	t.Helper()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	owner := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	policy, err := scopepolicy.NewPolicy(scopepolicy.MCP, []scopepolicy.ScopeID{"task:read"}, 3)
	if err != nil {
		t.Fatal(err)
	}
	grant := store.OAuthGrant{ID: uuid.NewString(), UserID: owner.UserID, Resource: "https://server.example/mcp", Scope: Scope, ExpiresAt: now.Add(time.Hour), ScopePolicy: &policy}
	identity := store.OAuthAccessIdentity{Principal: model.Principal{Kind: model.OAuthCredential, UserID: owner.UserID, CredentialID: uuid.NewString()}, GrantID: grant.ID, ExpiresAt: now.Add(time.Hour), ScopePolicy: &policy}
	return &scopeFake{grant: grant, identity: identity, now: now, fresh: now.Add(time.Minute)}, owner
}
func scopeFault(t *testing.T, err error, code string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("got %v, want %s", err, code)
	}
}
func TestAccessPolicyUsesGrantAndProfile(t *testing.T) {
	for _, api := range []bool{false, true} {
		f, _ := scopeTestFake(t)
		resource, prefix, profile := f.grant.Resource, model.OAuthAccessPrefix, model.ScopedMCPProfile
		if api {
			resource, prefix, profile = "https://server.example/api/v1", APIAccessPrefix, model.OAuthAPIProfile
			f.identity.ScopePolicy = nil
		}
		token := secret.Random(prefix)
		got, err := AuthenticateAccessPolicy(t.Context(), f, token, resource, f.now)
		binding, _ := profileForResource(resource)
		if err != nil || got.GrantID != f.grant.ID || got.Authorization.Profile != profile || !reflect.DeepEqual(f.hash, secret.Hash(token)) || !reflect.DeepEqual(f.bindings, []store.OAuthBinding{binding.binding(resource)}) {
			t.Fatalf("got %#v, err %v", got, err)
		}
		got, err = LockAccessPolicy(t.Context(), f, f.identity.Principal, resource, f.now)
		if err != nil || got.Authorization.Profile != profile || !reflect.DeepEqual(f.steps, []string{"hash", "access"}) {
			t.Fatalf("got %#v calls %v err %v", got, f.steps, err)
		}
	}
}
func TestAccessPolicyRejectsInvalidOrStale(t *testing.T) {
	f, _ := scopeTestFake(t)
	if _, err := AuthenticateAccessPolicy(t.Context(), f, "bad", f.grant.Resource, f.now); err == nil || len(f.steps) != 0 {
		t.Fatal("invalid token reached DAO")
	}
	value := secret.Random(model.OAuthAccessPrefix)
	f.readErr = model.ErrNotFound
	_, err := AuthenticateAccessPolicy(t.Context(), f, value, f.grant.Resource, f.now)
	scopeFault(t, err, "unauthenticated")
	f.readErr = nil
	f.identity.ScopePolicy = nil
	if _, err = AuthenticateAccessPolicy(t.Context(), f, value, f.grant.Resource, f.now); err == nil {
		t.Fatal("missing MCP policy accepted")
	}
	f.identity.ExpiresAt = f.now
	if _, err = LockAccessPolicy(t.Context(), f, f.identity.Principal, f.grant.Resource, f.now); err == nil {
		t.Fatal("expired access accepted")
	}
	f.identity.ExpiresAt = f.now.Add(time.Hour)
	original := f.identity.Principal
	original.UserID = uuid.NewString()
	if _, err = LockAccessPolicy(t.Context(), f, original, f.grant.Resource, f.now); err == nil {
		t.Fatal("different actor accepted")
	}
}
func TestUpdateSessionGrantScope(t *testing.T) {
	for _, tc := range []struct {
		name, code string
		change     func(*scopeFake)
		expected   int64
		write      bool
	}{
		{name: "update", expected: 3, write: true},
		{name: "stale", expected: 2, code: "version_conflict"},
		{name: "grant expired after waiting", expected: 3, code: "not_found", change: func(f *scopeFake) { f.grant.ExpiresAt = f.fresh }},
		{name: "grant revoked", expected: 3, code: "not_found", change: func(f *scopeFake) { f.grant.RevokedAt = &f.now }},
		{name: "session expired after waiting", expected: 3, code: "unauthenticated", change: func(f *scopeFake) { f.sessionErr = model.ErrNotFound }},
		{name: "fixed API profile", expected: 3, code: "invalid_input", change: func(f *scopeFake) {
			f.grant.Resource = "https://server.example/api/v1"
			f.grant.Scope = APIScope
			f.grant.ScopePolicy = nil
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, owner := scopeTestFake(t)
			if tc.change != nil {
				tc.change(f)
			}
			_, err := UpdateSessionGrantScope(t.Context(), f, f, owner, owner.UserID, f.grant.ID, tc.expected, []scopepolicy.ScopeID{"task:read", "project:read"}, f.now)
			if tc.code != "" {
				scopeFault(t, err, tc.code)
			} else if err != nil {
				t.Fatal(err)
			}
			want := []string{"grant", "session", "time", "session"}
			if tc.write {
				want = append(want, "write")
			}
			if !reflect.DeepEqual(f.steps, want) {
				t.Fatalf("got %v want %v", f.steps, want)
			}
			if f.lockedOwner != owner.UserID || f.lockedGrant != f.grant.ID {
				t.Fatalf("lock owner=%q grant=%q", f.lockedOwner, f.lockedGrant)
			}
			if tc.write && (f.writeOwner != owner.UserID || f.writeGrant != f.grant.ID || f.writeVersion != tc.expected) {
				t.Fatalf("write owner=%q grant=%q version=%d", f.writeOwner, f.writeGrant, f.writeVersion)
			}
			if tc.write && !reflect.DeepEqual(f.selected, []scopepolicy.ScopeID{"project:read", "task:read"}) {
				t.Fatalf("scopes %v", f.selected)
			}
		})
	}
}
func TestUpdateScopeRejectsInvalidInputsAndFailures(t *testing.T) {
	for _, selected := range [][]scopepolicy.ScopeID{nil, {"task:read", "task:read"}, {"unknown"}} {
		f, owner := scopeTestFake(t)
		_, err := UpdateSessionGrantScope(t.Context(), f, f, owner, owner.UserID, f.grant.ID, 3, selected, f.now)
		scopeFault(t, err, "invalid_input")
		if len(f.steps) != 0 {
			t.Fatal(f.steps)
		}
	}
	f, owner := scopeTestFake(t)
	_, err := UpdateSessionGrantScope(t.Context(), f, f, owner, uuid.NewString(), f.grant.ID, 3, []scopepolicy.ScopeID{"task:read"}, f.now)
	scopeFault(t, err, "identity_mismatch")
	if len(f.steps) != 0 {
		t.Fatal(f.steps)
	}
	f.readErr = model.ErrNotFound
	_, err = UpdateSessionGrantScope(t.Context(), f, f, owner, owner.UserID, f.grant.ID, 3, []scopepolicy.ScopeID{"task:read"}, f.now)
	scopeFault(t, err, "not_found")
	f.readErr = nil
	f.clockErr = errors.New("clock failure")
	_, err = UpdateSessionGrantScope(t.Context(), f, f, owner, owner.UserID, f.grant.ID, 3, []scopepolicy.ScopeID{"task:read"}, f.now)
	if !errors.Is(err, f.clockErr) {
		t.Fatalf("lost clock error: %v", err)
	}
}
