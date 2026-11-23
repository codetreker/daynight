package oauth

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type apiIssuerScope struct{ dao store.CredentialFamilyDAO }

func (s apiIssuerScope) CredentialFamilyDAO() store.CredentialFamilyDAO { return s.dao }

type apiIssuerWriter struct {
	t                *testing.T
	ctx              context.Context
	dao              store.CredentialFamilyDAO
	outcome          store.TransactionOutcome
	finalErr         error
	callbackErr      error
	active, finished bool
	calls            int
}

func (w *apiIssuerWriter) WriteCredentialFamily(ctx context.Context, fn func(store.CredentialFamilyScope) error) (store.Completion, error) {
	w.t.Helper()
	w.calls++
	if ctx != w.ctx || w.active || w.calls != 1 {
		w.t.Fatal("unexpected transaction context or repeated issue transaction")
	}
	w.active = true
	err := fn(apiIssuerScope{w.dao})
	w.active = false
	w.callbackErr = err
	w.finished = true
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: w.outcome}, w.finalErr
}

func TestAPIIssuerRequiresConfiguredCanonicalOrigin(t *testing.T) {
	writer := &apiIssuerWriter{t: t}
	if issuer, err := NewAPIIssuer(nil, "https://example.test"); !errors.Is(err, core.ErrInvalidAuthorization) || issuer != nil {
		t.Fatalf("nil writer accepted: %+v %v", issuer, err)
	}
	for _, origin := range []string{"", "https://example.test/", "https://example.test/mcp", "https://example.test?x=1", "https://user@example.test", "ftp://example.test", "https://example.test#fragment", "https://example.test/api%2Fv1"} {
		if issuer, err := NewAPIIssuer(writer, origin); !errors.Is(err, core.ErrInvalidAuthorization) || issuer != nil {
			t.Fatalf("invalid origin %q accepted: %+v %v", origin, issuer, err)
		}
	}
	for _, origin := range []string{"https://example.test", "http://127.0.0.1:8800"} {
		issuer, err := NewAPIIssuer(writer, origin)
		if err != nil || issuer.resource != origin+"/api/v1" || issuer.now == nil || reflect.ValueOf(issuer.issue).Pointer() != reflect.ValueOf(core.IssueAPIFamily).Pointer() {
			t.Fatalf("configured issuer: %+v %v", issuer, err)
		}
	}
}

func TestAPIIssuerReturnsFamilyOnlyAfterConfirmedTransaction(t *testing.T) {
	operationFailure := errors.New("family issue failed")
	writerFailure := errors.New("transaction completion failed")
	for _, test := range []struct {
		name                    string
		outcome                 store.TransactionOutcome
		operationErr, writerErr error
		success                 bool
	}{
		{name: "committed", outcome: store.TransactionCommitted, success: true},
		{name: "operation rejected", outcome: store.TransactionCommitted, operationErr: operationFailure},
		{name: "rolled back", outcome: store.TransactionNotCommitted},
		{name: "unknown", outcome: store.TransactionUnknown},
		{name: "unknown retains completion cause", outcome: store.TransactionUnknown, writerErr: writerFailure},
		{name: "unknown retains cleanup and refusal", outcome: store.TransactionUnknown, writerErr: &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.Join(writerFailure, core.ErrInvalidGrant)}},
		{name: "completion failure", outcome: store.TransactionCommitted, writerErr: writerFailure},
	} {
		t.Run(test.name, func(t *testing.T) {
			now := time.Date(2026, 11, 12, 12, 0, 0, 123456000, time.UTC)
			user := uuid.NewString()
			dao := &authenticationCapability{t: t}
			writer := &apiIssuerWriter{t: t, ctx: t.Context(), dao: dao, outcome: test.outcome, finalErr: test.writerErr}
			issuer, err := NewAPIIssuer(writer, "https://example.test")
			if err != nil {
				t.Fatal(err)
			}
			issuer.now = func() time.Time { return now }
			candidate := core.IssuedFamily{Grant: store.OAuthGrant{ID: uuid.NewString(), UserID: user, ClientID: core.APIClientID, Resource: "https://example.test/api/v1", Scope: core.APIScope, CreatedAt: now, ExpiresAt: now.Add(core.GrantLifetime)}, AccessID: uuid.NewString(), AccessToken: "private access", RefreshToken: "private refresh", AccessExpiresAt: now.Add(time.Hour)}
			calls := 0
			issuer.issue = func(ctx context.Context, actual store.CredentialFamilyDAO, userID, resource string, at time.Time) (core.IssuedFamily, error) {
				calls++
				if ctx != t.Context() || actual != dao || userID != user || resource != "https://example.test/api/v1" || at != now || !writer.active || writer.finished {
					t.Fatal("issue operation escaped the configured family transaction")
				}
				return candidate, test.operationErr
			}
			result, err := issuer.Issue(t.Context(), user)
			if calls != 1 || writer.calls != 1 || !writer.finished || writer.active || !errors.Is(writer.callbackErr, test.operationErr) {
				t.Fatalf("transaction/operation completion: %+v calls=%d", writer, calls)
			}
			if test.success {
				if err != nil || !reflect.DeepEqual(result, candidate) {
					t.Fatalf("committed issuance: %+v %v", result, err)
				}
			} else {
				if err == nil || !reflect.DeepEqual(result, core.IssuedFamily{}) {
					t.Fatalf("unconfirmed issuance disclosed secrets: %+v %v", result, err)
				}
				if test.operationErr != nil && !errors.Is(err, test.operationErr) {
					t.Fatalf("operation cause lost: %v", err)
				}
				if test.writerErr != nil && !errors.Is(err, test.writerErr) {
					t.Fatalf("writer cause lost: %v", err)
				}
				if test.outcome == store.TransactionUnknown {
					var transaction *store.TransactionError
					if !errors.Is(err, core.ErrAuthorizationUnknown) || !errors.As(err, &transaction) || transaction.Outcome != store.TransactionUnknown {
						t.Fatalf("unknown result reported incorrectly: %v", err)
					}
				}
			}
		})
	}
}
