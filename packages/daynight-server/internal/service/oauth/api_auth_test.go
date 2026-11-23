package oauth

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type apiAuthenticationDAO struct {
	authenticationCapability
	read func(context.Context, []byte, []store.OAuthBinding, time.Time) (store.OAuthAccessIdentity, error)
}

func (d *apiAuthenticationDAO) AuthenticateAccess(ctx context.Context, hash []byte, bindings []store.OAuthBinding, now time.Time) (store.OAuthAccessIdentity, error) {
	return d.read(ctx, hash, bindings, now)
}

type apiAuthenticationWriter struct {
	t           *testing.T
	ctx         context.Context
	dao         *apiAuthenticationDAO
	outcome     store.TransactionOutcome
	finish      func(error) error
	calls       int
	active      bool
	callbackErr error
}

func (w *apiAuthenticationWriter) WriteCredentialFamily(ctx context.Context, callback func(store.CredentialFamilyScope) error) (store.Completion, error) {
	w.calls++
	if ctx != w.ctx || w.calls != 1 || w.active {
		w.t.Fatal("unexpected application authentication transaction or context")
	}
	w.active = true
	w.callbackErr = callback(apiIssuerScope{w.dao})
	w.active = false
	return store.Completion{Outcome: w.outcome}, w.finish(w.callbackErr)
}

func TestAPIAuthenticationBindsConfiguredAudienceAndPreservesEffectiveExpiry(t *testing.T) {
	ctx := context.WithValue(t.Context(), struct{}{}, "application requester")
	token := secret.Random(core.APIAccessPrefix)
	identity := accessIdentity()
	identity.ExpiresAt = time.Now().UTC().Add(time.Hour).Truncate(time.Microsecond).Add(123 * time.Nanosecond)
	w := &apiAuthenticationWriter{t: t, ctx: ctx, outcome: store.TransactionCommitted, finish: func(err error) error { return err }}
	before := time.Now().UTC()
	w.dao = &apiAuthenticationDAO{authenticationCapability: authenticationCapability{t: t}, read: func(gotCtx context.Context, hash []byte, bindings []store.OAuthBinding, now time.Time) (store.OAuthAccessIdentity, error) {
		want := []store.OAuthBinding{{Resource: "https://application.example/api/v1", Scope: core.APIScope, ClientID: core.APIClientID}}
		if !w.active || gotCtx != ctx || !bytes.Equal(hash, secret.Hash(token)) || !reflect.DeepEqual(bindings, want) || now.Before(before.Truncate(time.Microsecond)) || now.After(time.Now().UTC()) || now.Location() != time.UTC || now.Nanosecond()%1000 != 0 {
			t.Fatalf("application authentication changed DAO identity, binding, context, or clock: bindings=%+v now=%v", bindings, now)
		}
		return identity, nil
	}}
	a := NewAuthenticator(w)
	a.SetOrigin("https://application.example")
	got, err := a.AuthenticateAPIAccess(ctx, token)
	if err != nil || got != identity || w.calls != 1 || w.active {
		t.Fatalf("application identity = %+v, %v; want exact %+v", got, err, identity)
	}
}

func TestAPIAuthenticationRejectsInvalidConfiguredOriginBeforeTransaction(t *testing.T) {
	for _, origin := range []string{"", "https://application.example/", "https://application.example/mcp", "https://user@application.example", "https://application.example?query=1"} {
		a := NewAuthenticator(nil)
		a.SetOrigin(origin)
		got, err := a.AuthenticateAPIAccess(t.Context(), secret.Random(core.APIAccessPrefix))
		if !errors.Is(err, core.ErrInvalidAuthorization) || got != (store.OAuthAccessIdentity{}) {
			t.Fatalf("invalid configured origin %q produced %+v, %v", origin, got, err)
		}
	}
}

func TestAPIAuthenticationPreservesWrappedStorageFailuresAndSuppressesIdentity(t *testing.T) {
	missing := &store.Error{Phase: "authenticate application access", MissingRow: true, Cause: model.ErrNotFound}
	sql := &store.Error{Phase: "authenticate application access", DatabaseFailure: true, SQLState: "08006", Cause: errors.New("private SQL cause")}
	for _, test := range []struct {
		name    string
		daoErr  error
		outcome store.TransactionOutcome
		finish  func(error) error
		cause   error
		refused bool
	}{
		{name: "missing access", daoErr: missing, outcome: store.TransactionNotCommitted, finish: func(err error) error {
			return &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
		}, cause: missing, refused: true},
		{name: "SQL failure", daoErr: sql, outcome: store.TransactionNotCommitted, finish: func(err error) error {
			return &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
		}, cause: sql},
		{name: "cancelled read", daoErr: context.Canceled, outcome: store.TransactionNotCommitted, finish: func(err error) error { return err }, cause: context.Canceled},
		{name: "unknown commit", outcome: store.TransactionUnknown, finish: func(error) error {
			return &store.TransactionError{Phase: "commit", CommitAttempted: true, Outcome: store.TransactionUnknown, Cause: context.DeadlineExceeded}
		}, cause: context.DeadlineExceeded},
	} {
		t.Run(test.name, func(t *testing.T) {
			w := &apiAuthenticationWriter{t: t, ctx: t.Context(), outcome: test.outcome, finish: test.finish}
			w.dao = &apiAuthenticationDAO{authenticationCapability: authenticationCapability{t: t}, read: func(context.Context, []byte, []store.OAuthBinding, time.Time) (store.OAuthAccessIdentity, error) {
				return accessIdentity(), test.daoErr
			}}
			a := NewAuthenticator(w)
			a.SetOrigin("https://application.example")
			got, err := a.AuthenticateAPIAccess(w.ctx, secret.Random(core.APIAccessPrefix))
			if !errors.Is(err, test.cause) || got != (store.OAuthAccessIdentity{}) || w.calls != 1 || w.active {
				t.Fatalf("failed application authentication = %+v, %v; cause=%v", got, err, test.cause)
			}
			if test.refused {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "unauthenticated" {
					t.Fatalf("actual wrapped missing access was not unauthenticated: %v", err)
				}
			}
		})
	}
}
