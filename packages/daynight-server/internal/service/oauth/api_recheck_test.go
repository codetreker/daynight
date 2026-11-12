package oauth

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type apiRecheckDAO struct {
	authenticationCapability
	lock func(context.Context, model.Principal, []store.OAuthBinding, time.Time) error
}

func (d *apiRecheckDAO) LockAccess(ctx context.Context, p model.Principal, binding []store.OAuthBinding, now time.Time) error {
	return d.lock(ctx, p, binding, now)
}

func (d *apiRecheckDAO) ReadAccess(context.Context, model.Principal, []store.OAuthBinding, time.Time) error {
	d.t.Fatal("unexpected unlocked access read")
	return nil
}

type apiRecheckWriter struct {
	t            *testing.T
	ctx          context.Context
	dao          *apiRecheckDAO
	outcome      store.TransactionOutcome
	final        func(error) error
	callbackErr  error
	calls, locks int
	active       bool
}

func (w *apiRecheckWriter) WriteCredentialFamily(ctx context.Context, callback func(store.CredentialFamilyScope) error) (store.Completion, error) {
	w.t.Helper()
	w.calls++
	if ctx != w.ctx || w.active || w.calls != 1 {
		w.t.Fatal("unexpected family transaction or caller context")
	}
	w.active = true
	w.callbackErr = callback(apiIssuerScope{w.dao})
	w.active = false
	return store.Completion{Outcome: w.outcome}, w.final(w.callbackErr)
}

func TestAPIAccessRecheckUsesSavedPrincipalAndFixedBinding(t *testing.T) {
	p := model.Principal{Kind: model.OAuthCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	ctx := context.WithValue(t.Context(), struct{}{}, "original requester")
	w := &apiRecheckWriter{t: t, ctx: ctx, outcome: store.TransactionCommitted, final: func(err error) error { return err }}
	before := time.Now().UTC().Truncate(time.Microsecond)
	w.dao = &apiRecheckDAO{authenticationCapability: authenticationCapability{t: t}}
	w.dao.lock = func(gotCtx context.Context, got model.Principal, bindings []store.OAuthBinding, now time.Time) error {
		w.locks++
		if !w.active || gotCtx != ctx || got != p || w.locks != 1 {
			t.Fatalf("lock active=%v context=%v principal=%+v calls=%d", w.active, gotCtx, got, w.locks)
		}
		want := []store.OAuthBinding{{Resource: "https://example.test/api/v1", Scope: core.APIScope, ClientID: core.APIClientID}}
		if !reflect.DeepEqual(bindings, want) || now.Before(before) || now.After(time.Now().UTC()) || now.Location() != time.UTC || now.Nanosecond()%1000 != 0 {
			t.Fatalf("binding=%+v now=%v", bindings, now)
		}
		return nil
	}
	a := NewAuthenticator(w)
	a.SetOrigin("https://example.test")
	if err := a.RecheckAPIAccess(ctx, p); err != nil || w.calls != 1 || w.locks != 1 || w.active {
		t.Fatalf("recheck=%v calls=%d locks=%d active=%v", err, w.calls, w.locks, w.active)
	}
}

func TestAPIAccessRecheckRejectsInvalidPrincipalAndOriginBeforeTransaction(t *testing.T) {
	valid := model.Principal{Kind: model.OAuthCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	for _, p := range []model.Principal{{}, {Kind: model.PATCredential, UserID: valid.UserID, CredentialID: valid.CredentialID}, {Kind: model.SessionCredential, UserID: valid.UserID, CredentialID: valid.CredentialID}, {Kind: model.OAuthCredential, UserID: valid.UserID, CredentialID: "invalid"}} {
		a := NewAuthenticator(nil)
		a.SetOrigin("https://example.test")
		var fault *model.Fault
		if err := a.RecheckAPIAccess(t.Context(), p); !errors.As(err, &fault) || fault.Code != "unauthenticated" {
			t.Fatalf("invalid principal %+v returned %v", p, err)
		}
	}
	for _, origin := range []string{"", "https://example.test/", "https://example.test/mcp", "https://user@example.test"} {
		a := NewAuthenticator(nil)
		a.SetOrigin(origin)
		if err := a.RecheckAPIAccess(t.Context(), valid); !errors.Is(err, core.ErrInvalidAuthorization) {
			t.Fatalf("invalid origin %q returned %v", origin, err)
		}
	}
}

func TestAPIAccessRecheckPreservesTransactionErrorsAndCompletion(t *testing.T) {
	missing := &store.Error{Phase: "lock OAuth access grant", MissingRow: true, Cause: errors.Join(model.ErrNotFound, pgx.ErrNoRows)}
	sql := &store.Error{Phase: "recheck OAuth access", DatabaseFailure: true, SQLState: "08006", Cause: errors.New("private SQL cause")}
	cleanup := &store.TransactionError{Phase: "cleanup", CleanupFailed: true, Outcome: store.TransactionUnknown, Cause: errors.New("private rollback cause")}
	unknown := &store.TransactionError{Phase: "commit", CommitAttempted: true, Outcome: store.TransactionUnknown, Cause: context.DeadlineExceeded}
	for _, test := range []struct {
		name      string
		daoErr    error
		outcome   store.TransactionOutcome
		final     func(error) error
		faultCode string
		wantCause error
		unknown   bool
	}{
		{name: "revoked expired or binding refusal", daoErr: model.ErrNotFound, outcome: store.TransactionNotCommitted, final: func(err error) error {
			return &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
		}, faultCode: "unauthenticated", wantCause: model.ErrNotFound},
		{name: "missing access joined driver cause", daoErr: missing, outcome: store.TransactionNotCommitted, final: func(err error) error {
			return &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
		}, faultCode: "unauthenticated", wantCause: missing},
		{name: "SQL failure", daoErr: sql, outcome: store.TransactionNotCommitted, final: func(err error) error {
			return &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
		}, wantCause: sql},
		{name: "cancelled callback", daoErr: context.Canceled, outcome: store.TransactionNotCommitted, final: func(err error) error { return err }, wantCause: context.Canceled},
		{name: "unknown commit", outcome: store.TransactionUnknown, final: func(error) error { return unknown }, wantCause: unknown, unknown: true},
		{name: "unknown refusal and cleanup", daoErr: missing, outcome: store.TransactionUnknown, final: func(err error) error {
			return errors.Join(&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}, cleanup)
		}, wantCause: cleanup, unknown: true},
		{name: "unknown without writer error", outcome: store.TransactionUnknown, final: func(error) error { return nil }, unknown: true},
		{name: "unconfirmed rollback", outcome: store.TransactionNotCommitted, final: func(error) error { return nil }, faultCode: "service_unavailable"},
		{name: "missing completion", final: func(error) error { return nil }, faultCode: "service_unavailable"},
	} {
		t.Run(test.name, func(t *testing.T) {
			p := model.Principal{Kind: model.OAuthCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
			w := &apiRecheckWriter{t: t, ctx: t.Context(), outcome: test.outcome, final: test.final}
			w.dao = &apiRecheckDAO{authenticationCapability: authenticationCapability{t: t}, lock: func(context.Context, model.Principal, []store.OAuthBinding, time.Time) error {
				w.locks++
				return test.daoErr
			}}
			a := NewAuthenticator(w)
			a.SetOrigin("https://example.test")
			err := a.RecheckAPIAccess(w.ctx, p)
			if err == nil || w.calls != 1 || w.locks != 1 || w.active {
				t.Fatalf("error=%v calls=%d locks=%d active=%v", err, w.calls, w.locks, w.active)
			}
			if test.wantCause != nil && !errors.Is(err, test.wantCause) {
				t.Fatalf("error %v lost cause %v", err, test.wantCause)
			}
			if test.faultCode != "" {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != test.faultCode {
					t.Fatalf("error=%v want fault=%s", err, test.faultCode)
				}
			}
			if test.unknown {
				var transaction *store.TransactionError
				if !errors.As(err, &transaction) || transaction.Outcome != store.TransactionUnknown {
					t.Fatalf("unknown completion not prioritized: %v", err)
				}
			}
			if errors.Is(test.daoErr, model.ErrNotFound) {
				var fault *model.Fault
				if !errors.As(w.callbackErr, &fault) || fault.Code != "unauthenticated" || !errors.Is(w.callbackErr, test.daoErr) {
					t.Fatalf("callback did not translate and retain actual missing cause: %v", w.callbackErr)
				}
			}
		})
	}
}
