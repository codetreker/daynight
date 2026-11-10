package oauth

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type authenticationCapability struct {
	store.CredentialFamilyDAO
	t *testing.T
}

func (d *authenticationCapability) IssueFamily(context.Context, store.OAuthFamilyIssue) error {
	d.t.Fatal("unexpected IssueFamily call")
	return nil
}
func (d *authenticationCapability) RevokeFamily(context.Context, string, time.Time) (bool, error) {
	d.t.Fatal("unexpected RevokeFamily call")
	return false, nil
}
func (d *authenticationCapability) AuthenticateAccess(context.Context, []byte, string, string, time.Time) (store.OAuthAccessIdentity, error) {
	d.t.Fatal("unexpected DAO authentication call")
	return store.OAuthAccessIdentity{}, nil
}
func (d *authenticationCapability) InspectGrant(context.Context, string, bool) (store.OAuthGrant, error) {
	d.t.Fatal("unexpected InspectGrant call")
	return store.OAuthGrant{}, nil
}
func (d *authenticationCapability) ActiveClientReferences(context.Context, string, time.Time) (bool, error) {
	d.t.Fatal("unexpected ActiveClientReferences call")
	return false, nil
}

type authenticationScope struct{ fixture *authenticationFixture }

func (s *authenticationScope) CredentialFamilyDAO() store.CredentialFamilyDAO {
	f := s.fixture
	f.events = append(f.events, "capability")
	if !f.active || f.capabilityCalls != 0 {
		f.t.Errorf("unexpected capability call outside callback or repeated")
	}
	f.capabilityCalls++
	return f.capability
}

type authenticationFixture struct {
	t                                            *testing.T
	ctx                                          context.Context
	token, resource                              string
	capability                                   *authenticationCapability
	scope                                        *authenticationScope
	identity                                     store.OAuthAccessIdentity
	operationErr, callbackErr, finalErr          error
	completion                                   store.Completion
	runCallback                                  bool
	active, finished                             bool
	writerCalls, capabilityCalls, operationCalls int
	events                                       []string
	before, operationTime, after                 time.Time
}

func newAuthenticationFixture(t *testing.T, run bool, identity store.OAuthAccessIdentity, operationErr, callbackErr, finalErr error, outcome store.TransactionOutcome, token string) *authenticationFixture {
	t.Helper()
	type contextKey struct{}
	ctx, cancel := context.WithCancel(context.WithValue(t.Context(), contextKey{}, "caller"))
	t.Cleanup(cancel)
	f := &authenticationFixture{t: t, ctx: ctx, token: token, resource: "https://daynight.example/mcp", identity: identity, operationErr: operationErr, callbackErr: callbackErr, finalErr: finalErr, completion: store.Completion{Outcome: outcome}, runCallback: run}
	f.capability = &authenticationCapability{t: t}
	f.scope = &authenticationScope{fixture: f}
	t.Cleanup(func() {
		wantEvents := []string{"writer enter", "writer completion"}
		wantCalls := 0
		if run {
			wantEvents = []string{"writer enter", "capability", "operation", "callback returned", "writer completion"}
			wantCalls = 1
		}
		if f.writerCalls != 1 || f.capabilityCalls != wantCalls || f.operationCalls != wantCalls || !f.finished || f.active || !slices.Equal(f.events, wantEvents) {
			t.Errorf("writer=%d capability=%d operation=%d finished=%v active=%v events=%v; want 1,%d,%d,true,false,%v", f.writerCalls, f.capabilityCalls, f.operationCalls, f.finished, f.active, f.events, wantCalls, wantCalls, wantEvents)
		}
		if run && (f.operationTime.Before(f.before) || f.operationTime.After(f.after) || f.operationTime.Location() != time.UTC) {
			t.Errorf("operation time %v outside [%v, %v] or not UTC", f.operationTime, f.before, f.after)
		}
	})
	return f
}

func (f *authenticationFixture) WriteCredentialFamily(ctx context.Context, operation func(store.CredentialFamilyScope) error) (store.Completion, error) {
	f.events = append(f.events, "writer enter")
	f.writerCalls++
	if f.writerCalls != 1 || ctx != f.ctx {
		f.t.Errorf("writer calls=%d, context=%v; want one call with original context", f.writerCalls, ctx)
	}
	if f.runCallback {
		f.active = true
		err := operation(f.scope)
		f.active = false
		f.events = append(f.events, "callback returned")
		if err != f.callbackErr {
			f.t.Errorf("callback error = %v, want identical %v", err, f.callbackErr)
		}
	}
	f.events = append(f.events, "writer completion")
	f.finished = true
	return f.completion, f.finalErr
}

func (f *authenticationFixture) authenticate(ctx context.Context, dao store.CredentialFamilyDAO, token, resource string, now time.Time) (store.OAuthAccessIdentity, error) {
	f.events = append(f.events, "operation")
	f.operationCalls++
	f.operationTime = now
	if !f.active || f.operationCalls != 1 || ctx != f.ctx || dao != f.capability || token != f.token || resource != f.resource {
		f.t.Errorf("operation calls=%d active=%v context=%v DAO=%v token=%q resource=%q", f.operationCalls, f.active, ctx, dao, token, resource)
	}
	return f.identity, f.operationErr
}

func (f *authenticationFixture) call() (store.OAuthAccessIdentity, error) {
	f.t.Helper()
	a := NewAuthenticator(f)
	a.authenticateAccess = f.authenticate
	f.before = time.Now().UTC()
	got, err := a.AuthenticateAccess(f.ctx, f.token, f.resource)
	f.after = time.Now().UTC()
	if !f.finished {
		f.t.Error("returned before writer completion")
	}
	return got, err
}

func accessIdentity() store.OAuthAccessIdentity {
	return store.OAuthAccessIdentity{GrantID: uuid.NewString(), Principal: model.Principal{Kind: model.OAuthCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}}
}

func TestNewAuthenticatorBindsWriterAndCoreOperation(t *testing.T) {
	writer := &authenticationFixture{}
	a := NewAuthenticator(writer)
	if a.writer != writer || reflect.ValueOf(a.authenticateAccess).Pointer() != reflect.ValueOf(core.AuthenticateAccess).Pointer() {
		t.Fatal("constructor did not bind the supplied writer and Core authentication operation")
	}
}

func TestAuthenticatorReturnsIdentityAfterConfirmedCommit(t *testing.T) {
	identity := accessIdentity()
	f := newAuthenticationFixture(t, true, identity, nil, nil, nil, store.TransactionCommitted, secret.Random(model.OAuthAccessPrefix))
	got, err := f.call()
	if err != nil || got != identity {
		t.Fatalf("AuthenticateAccess() = %+v, %v; want %+v", got, err, identity)
	}
}

func TestAuthenticatorPropagatesTransactionAndDAOFailures(t *testing.T) {
	for _, phase := range []string{"transaction", "DAO"} {
		t.Run(phase, func(t *testing.T) {
			failure := errors.New("authentication storage failed")
			run := phase != "transaction"
			var operationErr, callbackErr error
			if run {
				operationErr, callbackErr = failure, failure
			}
			f := newAuthenticationFixture(t, run, store.OAuthAccessIdentity{}, operationErr, callbackErr, failure, store.TransactionCommitted, secret.Random(model.OAuthAccessPrefix))
			got, err := f.call()
			if err != failure || got != (store.OAuthAccessIdentity{}) {
				t.Fatalf("AuthenticateAccess() = %+v, %v; want zero identity and original error", got, err)
			}
		})
	}
}

func TestAuthenticatorSuppressesIdentityWithoutConfirmedCommit(t *testing.T) {
	for _, outcome := range []store.TransactionOutcome{store.TransactionNotCommitted, store.TransactionUnknown, ""} {
		t.Run(string(outcome), func(t *testing.T) {
			f := newAuthenticationFixture(t, true, accessIdentity(), nil, nil, nil, outcome, secret.Random(model.OAuthAccessPrefix))
			got, err := f.call()
			if err == nil || !strings.Contains(err.Error(), "did not confirm commit") || got != (store.OAuthAccessIdentity{}) {
				t.Fatalf("unconfirmed authentication = %+v, %v", got, err)
			}
		})
	}
}

func TestAuthenticatorRejectsMalformedTokenBeforeDAOAccess(t *testing.T) {
	refusal := model.Unauthenticated(nil)
	f := newAuthenticationFixture(t, true, store.OAuthAccessIdentity{}, refusal, refusal, refusal, store.TransactionUnknown, "not-an-access-token")
	got, err := f.call()
	if err != refusal || got != (store.OAuthAccessIdentity{}) {
		t.Fatalf("malformed authentication = %+v, %v; want original refusal", got, err)
	}
}

func TestAuthenticatorWriterErrorsTakePriority(t *testing.T) {
	t.Run("completion error after success", func(t *testing.T) {
		failure := errors.New("completion failed")
		f := newAuthenticationFixture(t, true, accessIdentity(), nil, nil, failure, store.TransactionCommitted, secret.Random(model.OAuthAccessPrefix))
		got, err := f.call()
		if err != failure || got != (store.OAuthAccessIdentity{}) {
			t.Fatalf("got %+v, %v", got, err)
		}
	})
	t.Run("joined refusal and cleanup", func(t *testing.T) {
		refusal := model.Unauthenticated(nil)
		cleanup := errors.New("cleanup failed")
		joined := errors.Join(refusal, cleanup)
		f := newAuthenticationFixture(t, true, store.OAuthAccessIdentity{}, refusal, refusal, joined, store.TransactionUnknown, secret.Random(model.OAuthAccessPrefix))
		got, err := f.call()
		if err != joined || !errors.Is(err, refusal) || !errors.Is(err, cleanup) || got != (store.OAuthAccessIdentity{}) {
			t.Fatalf("got %+v, %v", got, err)
		}
	})
}
