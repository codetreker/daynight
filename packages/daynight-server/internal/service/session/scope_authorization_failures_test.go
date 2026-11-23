package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestSessionAuthorizationSourcesRefuseUnavailableDependencies(t *testing.T) {
	source := NewSessionAuthorizationSource("https://example.test")
	pat := readPolicy(t, "session:read")
	cookie := model.CredentialAuthorization{Principal: model.Principal{Kind: model.SessionCredential, UserID: pat.Principal.UserID, CredentialID: pat.Principal.CredentialID}, Profile: model.SessionProfile}
	cause := errors.New("authorization source unavailable")
	for _, scenario := range []string{"invalid auth", "nil transaction", "nil snapshot", "missing transaction capability", "missing snapshot capability", "cookie revoked in transaction", "cookie transaction error", "cookie revoked in snapshot", "cookie snapshot error"} {
		t.Run(scenario, func(t *testing.T) {
			var err error
			switch scenario {
			case "invalid auth":
				_, err = source.SessionWrite(t.Context(), nil, model.CredentialAuthorization{})
			case "nil transaction":
				_, err = source.SessionWrite(t.Context(), nil, pat)
			case "nil snapshot":
				_, err = source.SessionSnapshot(t.Context(), nil, pat)
			case "missing transaction capability":
				_, err = source.SessionWrite(t.Context(), scopedCheckerScope{}, pat)
			case "missing snapshot capability":
				_, err = source.SessionSnapshot(t.Context(), inspectionSnapshot{}, pat)
			case "cookie revoked in transaction", "cookie transaction error":
				failure := cause
				if scenario == "cookie revoked in transaction" {
					failure = model.ErrNotFound
				}
				tx := policySessionScope{session: policySessionDAO{lock: func(context.Context, model.Principal, time.Time) error { return failure }}}
				_, err = source.SessionWrite(t.Context(), tx, cookie)
			case "cookie revoked in snapshot", "cookie snapshot error":
				failure := cause
				if scenario == "cookie revoked in snapshot" {
					failure = model.ErrNotFound
				}
				snapshot := policySnapshot{credential: policyCredential{read: func(context.Context, model.Principal) (store.ThreadCredential, error) {
					return store.ThreadCredential{}, failure
				}}}
				_, err = source.SessionSnapshot(t.Context(), snapshot, cookie)
			}
			if err == nil {
				t.Fatal("invalid authorization accepted")
			}
			if (scenario == "cookie transaction error" || scenario == "cookie snapshot error") && !errors.Is(err, cause) {
				t.Fatalf("lost cause: %v", err)
			}
		})
	}
}

func TestSessionAuthorizationRejectsChangedStoredPolicy(t *testing.T) {
	source := NewSessionAuthorizationSource("https://example.test")
	pat := readPolicy(t, "session:read")
	cause := errors.New("storage failure")
	for _, scenario := range []string{"transaction storage failure", "transaction changed identity", "snapshot expired PAT", "snapshot storage failure"} {
		t.Run(scenario, func(t *testing.T) {
			var err error
			if scenario == "transaction storage failure" || scenario == "transaction changed identity" {
				tx := policySessionScope{pat: policyPAT{read: func(context.Context, string, string) (model.PersonalAccessToken, error) {
					if scenario == "transaction storage failure" {
						return model.PersonalAccessToken{}, cause
					}
					return model.PersonalAccessToken{ID: "20000000-0000-4000-8000-000000000002", UserID: pat.Principal.UserID, ScopePolicy: pat.Policy}, nil
				}}, clock: policyClock{read: func(_ context.Context, n time.Time) (time.Time, error) { return n, nil }}}
				_, err = source.SessionWrite(t.Context(), tx, pat)
			} else {
				snap := policySnapshot{pat: func(context.Context, model.Principal, time.Time) (model.PersonalAccessToken, error) {
					if scenario == "snapshot storage failure" {
						return model.PersonalAccessToken{}, cause
					}
					past := time.Now().Add(-time.Hour)
					return model.PersonalAccessToken{ID: pat.Principal.CredentialID, UserID: pat.Principal.UserID, ExpiresAt: &past, ScopePolicy: pat.Policy}, nil
				}}
				_, err = source.SessionSnapshot(t.Context(), snap, pat)
			}
			if err == nil {
				t.Fatal("invalid credential accepted")
			}
			if (scenario == "transaction storage failure" || scenario == "snapshot storage failure") && !errors.Is(err, cause) {
				t.Fatalf("lost cause: %v", err)
			}
		})
	}
}
