package identity

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type profileScopeWriter struct {
	scope store.IdentityScope
	calls int
}

func (w *profileScopeWriter) WriteIdentity(ctx context.Context, operation func(store.IdentityScope) error) (store.Completion, error) {
	w.calls++
	if err := operation(w.scope); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func profilePolicy(t *testing.T, scopes ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	p := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, scopes, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile, Policy: &policy}
}

func TestAuthorizedProfileRequiresCurrentPolicy(t *testing.T) {
	withWrite := profilePolicy(t, "account:write")
	patch := model.UserProfilePatch{Name: model.ProfileField{Present: true}}
	w := &profileScopeWriter{}
	svc := New(w, nil, "https://daynight.example/auth/callback")
	_, err := svc.PatchUserAuthorized(t.Context(), withWrite, patch, nil)
	if err == nil || w.calls != 0 {
		t.Fatalf("missing recheck accepted: %v", err)
	}
	invalid := withWrite
	invalid.Policy = nil
	_, err = svc.PatchUserAuthorized(t.Context(), invalid, patch, nil)
	if err == nil || w.calls != 0 {
		t.Fatalf("missing policy accepted: %v", err)
	}
}

func TestAuthorizedProfileRechecksBothCredentialBoundaries(t *testing.T) {
	for _, revokeAt := range []int{0, 1, 2} {
		t.Run(string(rune('0'+revokeAt)), func(t *testing.T) {
			initial := profilePolicy(t, "account:write")
			without := profilePolicy(t, "prompt:read")
			scope := &identityScope{identity: &identityCapability{}, personal: &personalCapability{}, family: &familyCapability{}}
			w := &profileScopeWriter{scope: scope}
			svc := New(w, nil, "https://daynight.example/auth/callback")
			svc.now = func() time.Time { return time.Unix(1, 0) }
			locks, writes, reads, rechecks := 0, 0, 0, 0
			svc.ops.validateProfilePatch = func(model.UserProfilePatch) error { return nil }
			svc.ops.lockProfileCredential = func(_ context.Context, dao store.IdentityDAO, family store.CredentialFamilyDAO, p model.Principal, resource string, _ time.Time) error {
				locks++
				if dao != scope.identity || family != scope.family || p != initial.Principal || resource != "" {
					t.Fatal("incorrect credential binding")
				}
				return nil
			}
			svc.ops.patchUser = func(_ context.Context, dao store.IdentityDAO, id string, _ model.UserProfilePatch) (model.User, error) {
				writes++
				if dao != scope.identity || id != initial.Principal.UserID {
					t.Fatal("incorrect write binding")
				}
				return model.User{}, nil
			}
			svc.ops.user = func(_ context.Context, dao store.IdentityDAO, p model.Principal) (model.User, store.PersonalTeamFacts, error) {
				reads++
				return model.User{ID: p.UserID}, store.PersonalTeamFacts{ID: "team"}, nil
			}
			svc.ops.validatePersonalTeam = func(store.PersonalTeamFacts) error { return nil }
			svc.ops.admitCompleteUser = func(model.User, bool) error { return nil }
			check := func(ctx context.Context, got store.IdentityScope, p model.Principal) (model.CredentialAuthorization, error) {
				rechecks++
				if ctx != t.Context() || got != scope || p != initial.Principal {
					t.Fatal("incorrect recheck binding")
				}
				if rechecks == revokeAt {
					return without, nil
				}
				return initial, nil
			}
			_, err := svc.PatchUserAuthorized(t.Context(), initial, model.UserProfilePatch{}, check)
			if revokeAt == 0 {
				if err != nil || locks != 2 || rechecks != 2 || writes != 1 || reads != 1 {
					t.Fatalf("success %v %d %d %d %d", err, locks, rechecks, writes, reads)
				}
			} else {
				var f *model.Fault
				if !errors.As(err, &f) || f.Code != "insufficient_scope" || locks != revokeAt || rechecks != revokeAt || writes != revokeAt-1 {
					t.Fatalf("refusal %v %d %d %d", err, locks, rechecks, writes)
				}
			}
		})
	}
}

func TestAuthorizedProfileRejectsChangedRecheckIdentity(t *testing.T) {
	auth := profilePolicy(t, "account:write")
	scope := &identityScope{identity: &identityCapability{}, personal: &personalCapability{}, family: &familyCapability{}}
	w := &profileScopeWriter{scope: scope}
	svc := New(w, nil, "https://daynight.example/auth/callback")
	svc.ops.validateProfilePatch = func(model.UserProfilePatch) error { return nil }
	svc.ops.lockProfileCredential = func(context.Context, store.IdentityDAO, store.CredentialFamilyDAO, model.Principal, string, time.Time) error {
		return nil
	}
	check := func(context.Context, store.IdentityScope, model.Principal) (model.CredentialAuthorization, error) {
		changed := auth
		changed.Principal.CredentialID = "33333333-3333-4333-8333-333333333333"
		return changed, nil
	}
	if _, err := svc.PatchUserAuthorized(t.Context(), auth, model.UserProfilePatch{}, check); err == nil {
		t.Fatal("changed identity accepted")
	}
}

// Revocation and expiry detected at the existing lock take precedence over a
// missing account scope. A valid credential without scope cannot mutate either.
func TestAuthorizedProfileCredentialRefusalPrecedesScope(t *testing.T) {
	for _, tc := range []struct {
		name    string
		lockErr error
		want    string
	}{
		{"revoked", model.Unauthenticated(errors.New("revoked")), "unauthenticated"},
		{"expired", model.Unauthenticated(errors.New("expired")), "unauthenticated"},
		{"active", nil, "insufficient_scope"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			auth := profilePolicy(t, "prompt:read")
			scope := &identityScope{identity: &identityCapability{}, personal: &personalCapability{}, family: &familyCapability{}}
			writer := &profileScopeWriter{scope: scope}
			svc := New(writer, nil, "https://daynight.example/auth/callback")
			svc.ops.validateProfilePatch = func(model.UserProfilePatch) error { return nil }
			locks, rechecks, writes := 0, 0, 0
			svc.ops.lockProfileCredential = func(context.Context, store.IdentityDAO, store.CredentialFamilyDAO, model.Principal, string, time.Time) error {
				locks++
				return tc.lockErr
			}
			svc.ops.patchUser = func(context.Context, store.IdentityDAO, string, model.UserProfilePatch) (model.User, error) {
				writes++
				return model.User{}, nil
			}
			check := func(context.Context, store.IdentityScope, model.Principal) (model.CredentialAuthorization, error) {
				rechecks++
				return auth, nil
			}
			_, err := svc.PatchUserAuthorized(t.Context(), auth, model.UserProfilePatch{}, check)
			var f *model.Fault
			if !errors.As(err, &f) || f.Code != tc.want || locks != 1 || rechecks != 0 || writes != 0 {
				t.Fatalf("result %v locks=%d rechecks=%d writes=%d", err, locks, rechecks, writes)
			}
		})
	}
}
