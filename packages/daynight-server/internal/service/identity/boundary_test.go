package identity

import (
	"context"
	"errors"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type unavailableWriter struct{ calls int }

func (w *unavailableWriter) WriteIdentity(context.Context, func(store.IdentityScope) error) (store.Completion, error) {
	w.calls++
	return store.Completion{Outcome: store.TransactionNotCommitted}, errors.New("database unavailable")
}

func TestValidationDoesNotAccessUnavailableStore(t *testing.T) {
	w := &unavailableWriter{}
	s := New(w, nil, "https://example.test/callback")
	ctx := context.Background()
	session := model.Principal{Kind: model.SessionCredential}
	pat := model.Principal{Kind: model.PATCredential}
	for _, call := range []func() error{
		func() error { _, err := s.Authenticate(ctx, model.SessionCredential, "bad"); return err },
		func() error { return s.Logout(ctx, pat) },
		func() error { _, err := s.CreatePAT(ctx, session, core.CreatePAT{Name: ""}); return err },
		func() error { _, err := s.ListPATs(ctx, pat); return err },
		func() error { return s.RevokePAT(ctx, session, "bad") },
		func() error { _, err := s.UpdatePATExpiry(ctx, session, "bad", core.UpdatePATExpiry{}); return err },
		func() error { _, err := s.RedeemDevice(ctx, "wrong", core.DeviceGrantType, "bad", "host"); return err },
		func() error { return s.LogoutDevice(ctx, session) },
	} {
		if err := call(); err == nil {
			t.Fatal("expected validation failure")
		}
	}
	if w.calls != 0 {
		t.Fatalf("validation opened %d transactions", w.calls)
	}
}

type uncertainWriter struct {
	base          store.IdentityWriter
	failAt, calls int
	failure       error
}

func (w *uncertainWriter) WriteIdentity(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
	w.calls++
	completion, err := w.base.WriteIdentity(ctx, fn)
	if err != nil {
		return completion, err
	}
	if w.calls == w.failAt {
		return store.Completion{Outcome: store.TransactionUnknown}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: w.failure}
	}
	return completion, nil
}

func TestUncertainLoginCompletionNeverLeaksSecret(t *testing.T) {
	f := newIdentityFixture(t)
	start := startIdentityLogin(t, f, "/")
	failure := errors.New("commit response lost")
	f.identity.writer = &uncertainWriter{base: f.database, failAt: 2, failure: failure}
	result, err := f.identity.CompleteLogin(context.Background(), identityQuery(start, "alice"), start.BrowserBinding)
	if !errors.Is(err, failure) || result.Secret != "" || result.Session.ID != "" || result.LoginID != start.ID {
		t.Fatalf("completion = %#v, %v", result, err)
	}
}
func TestUncertainConsumeNeverClaimsUpstream(t *testing.T) {
	f := newIdentityFixture(t)
	start := startIdentityLogin(t, f, "/")
	failure := errors.New("commit response lost")
	f.identity.writer = &uncertainWriter{base: f.database, failAt: 1, failure: failure}
	result, err := f.identity.CompleteLogin(context.Background(), identityQuery(start, "alice"), start.BrowserBinding)
	if !errors.Is(err, failure) || f.calls.Load() != 0 || result.Secret != "" {
		t.Fatalf("completion = %#v, %v, upstream calls %d", result, err, f.calls.Load())
	}
}
func TestDeviceInspectionUsesTimeAfterTransaction(t *testing.T) {
	f := newIdentityFixture(t)
	p := identityPrincipal(t, f, completeIdentityLogin(t, f, "alice"))
	d := startDevice(t, f)
	before := d.ExpiresAt.Add(-time.Second)
	calls := 0
	f.identity.now = func() time.Time {
		calls++
		if calls >= 3 {
			return d.ExpiresAt
		}
		return before
	}
	result, err := f.identity.InspectDevice(context.Background(), p, d.UserCode)
	if err != nil || result.Status != "expired" {
		t.Fatalf("inspection = %#v, %v, clock calls %d", result, err, calls)
	}
}
func TestTransactionFailureOverridesDeviceRateRejection(t *testing.T) {
	f := newIdentityFixture(t)
	ctx := context.Background()
	for range 30 {
		if _, err := f.identity.StartDevice(ctx, core.DeviceClientID, "source"); err != nil {
			t.Fatal(err)
		}
	}
	failure := errors.New("commit response lost")
	f.identity.writer = &uncertainWriter{base: f.database, failAt: 1, failure: failure}
	_, err := f.identity.StartDevice(ctx, core.DeviceClientID, "source")
	var fault *model.Fault
	if !errors.Is(err, failure) || errors.As(err, &fault) {
		t.Fatalf("failure precedence: %v", err)
	}
}

type unconfirmedWriter struct {
	base          store.IdentityWriter
	failAt, calls int
	outcome       store.TransactionOutcome
}

func (w *unconfirmedWriter) WriteIdentity(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
	w.calls++
	completion, err := w.base.WriteIdentity(ctx, fn)
	if err == nil && w.calls == w.failAt {
		return store.Completion{Outcome: w.outcome}, nil
	}
	return completion, err
}
func TestUnconfirmedCompletionBlocksClaimAndSecret(t *testing.T) {
	for _, outcome := range []store.TransactionOutcome{store.TransactionNotCommitted, store.TransactionUnknown, "invalid"} {
		t.Run(string(outcome), func(t *testing.T) {
			f := newIdentityFixture(t)
			ctx := context.Background()
			start := startIdentityLogin(t, f, "/")
			f.identity.writer = &unconfirmedWriter{base: f.database, failAt: 1, outcome: outcome}
			result, err := f.identity.CompleteLogin(ctx, identityQuery(start, "alice"), start.BrowserBinding)
			if err == nil || result.Secret != "" || f.calls.Load() != 0 {
				t.Fatalf("unconfirmed consume: %#v %v, upstream %d", result, err, f.calls.Load())
			}
			f.identity.writer = f.database
			start = startIdentityLogin(t, f, "/")
			f.identity.writer = &unconfirmedWriter{base: f.database, failAt: 2, outcome: outcome}
			result, err = f.identity.CompleteLogin(ctx, identityQuery(start, "alice"), start.BrowserBinding)
			if err == nil || result.Secret != "" {
				t.Fatalf("unconfirmed session: %#v %v", result, err)
			}
			f.identity.writer = f.database
			login := completeIdentityLogin(t, f, "alice")
			p := identityPrincipal(t, f, login)
			f.identity.writer = &unconfirmedWriter{base: f.database, failAt: 1, outcome: outcome}
			minted, err := f.identity.CreatePAT(ctx, p, core.CreatePAT{Name: "test"})
			if err == nil || minted.Secret != "" {
				t.Fatalf("unconfirmed PAT: %#v %v", minted, err)
			}
		})
	}
}
