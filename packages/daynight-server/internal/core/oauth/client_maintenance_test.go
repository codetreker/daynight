package oauth

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type cleanupClients struct {
	store.OAuthClientDAO
	err error
}

func (d cleanupClients) LockClientCapacity(context.Context) error { return d.err }
func (d cleanupClients) ExpiredClients(context.Context, time.Time, int) ([]string, error) {
	return nil, nil
}

type cleanupScope struct {
	store.OAuthClientScope
	clients store.OAuthClientDAO
}

func (s cleanupScope) OAuthClientDAO() store.OAuthClientDAO { return s.clients }

type cleanupWriter struct {
	clients store.OAuthClientDAO
	outcome store.TransactionOutcome
	err     error
}

func (w cleanupWriter) WriteOAuthClients(_ context.Context, fn func(store.OAuthClientScope) error) (store.Completion, error) {
	if w.err != nil {
		return store.Completion{Outcome: w.outcome}, w.err
	}
	return store.Completion{Outcome: w.outcome}, fn(cleanupScope{clients: w.clients})
}
func TestPruneClientsFailureAndBudget(t *testing.T) {
	ctx := context.Background()
	now := time.Now()
	boom := errors.New("capacity failure")
	if _, err := PruneClients(ctx, cleanupWriter{}, -1, now); err == nil {
		t.Fatal("negative budget accepted")
	}
	if n, err := PruneClients(ctx, cleanupWriter{}, 0, now); n != 0 || err != nil {
		t.Fatalf("zero budget: %d %v", n, err)
	}
	if _, err := PruneClients(ctx, cleanupWriter{clients: cleanupClients{err: boom}}, 1, now); !errors.Is(err, boom) {
		t.Fatalf("capacity error: %v", err)
	}
	if _, err := PruneClients(ctx, cleanupWriter{clients: cleanupClients{}, outcome: store.TransactionUnknown}, 1, now); err == nil {
		t.Fatal("unknown outcome accepted")
	}
	if n, err := PruneClients(ctx, cleanupWriter{clients: cleanupClients{}, outcome: store.TransactionCommitted}, 1, now); n != 0 || err != nil {
		t.Fatalf("empty: %d %v", n, err)
	}
}

// maintenanceBudgetReceiver keeps the callback result separate from the
// transaction completion and error supplied by the writer.
type maintenanceBudgetReceiver struct {
	t              *testing.T
	ctx            context.Context
	now            time.Time
	lockError      error
	callbackError  error
	finalError     error
	completion     store.Completion
	calls          []string
	callbackCalled int
}

func (r *maintenanceBudgetReceiver) WriteOAuthClients(ctx context.Context, fn func(store.OAuthClientScope) error) (store.Completion, error) {
	r.calls = append(r.calls, "write")
	if ctx != r.ctx {
		r.t.Error("writer received a different context")
	}
	if len(r.calls) != 1 {
		r.t.Error("unexpected additional transaction")
		return r.completion, errors.New("unexpected additional transaction")
	}
	r.callbackCalled++
	if err := fn(r); err != r.callbackError {
		r.t.Errorf("callback error = %v, want %v", err, r.callbackError)
	}
	return r.completion, r.finalError
}

func (r *maintenanceBudgetReceiver) OAuthClientDAO() store.OAuthClientDAO {
	r.calls = append(r.calls, "clients")
	return r
}

func (r *maintenanceBudgetReceiver) CredentialFamilyDAO() store.CredentialFamilyDAO {
	r.t.Fatal("unexpected credential family DAO access")
	return nil
}

func (r *maintenanceBudgetReceiver) LockClientCapacity(ctx context.Context) error {
	r.calls = append(r.calls, "lock")
	if ctx != r.ctx {
		r.t.Error("lock received a different context")
	}
	return r.lockError
}

func (r *maintenanceBudgetReceiver) ExpiredClients(ctx context.Context, now time.Time, limit int) ([]string, error) {
	r.calls = append(r.calls, "expired")
	if ctx != r.ctx || now != r.now || limit != 100 {
		r.t.Errorf("expired clients arguments: context matches=%t, now=%v, limit=%d; want context matches=true, now=%v, limit=100", ctx == r.ctx, now, limit, r.now)
	}
	return nil, nil
}

func (r *maintenanceBudgetReceiver) InsertClient(context.Context, store.OAuthClient, int, time.Time) (bool, error) {
	r.t.Fatal("unexpected insert")
	return false, errors.New("unexpected insert")
}

func (r *maintenanceBudgetReceiver) Client(context.Context, string, bool) (store.OAuthClient, error) {
	r.t.Fatal("unexpected client read")
	return store.OAuthClient{}, errors.New("unexpected client read")
}

func (r *maintenanceBudgetReceiver) PinClient(context.Context, string, time.Time) (store.OAuthClient, error) {
	r.t.Fatal("unexpected pin")
	return store.OAuthClient{}, errors.New("unexpected pin")
}

func (r *maintenanceBudgetReceiver) FreshTime(context.Context, time.Time) (time.Time, error) {
	r.t.Fatal("unexpected fresh time")
	return time.Time{}, errors.New("unexpected fresh time")
}

func (r *maintenanceBudgetReceiver) DeleteClient(context.Context, string) error {
	r.t.Fatal("unexpected delete")
	return errors.New("unexpected delete")
}

func TestPruneClientsMaintenanceBudget(t *testing.T) {
	boom := errors.New("failure")
	for _, tc := range []struct {
		name          string
		lockError     error
		callbackError error
		finalError    error
		wantCalls     []string
	}{
		{name: "empty", wantCalls: []string{"write", "clients", "lock", "expired"}},
		{name: "lock failure", lockError: boom, callbackError: boom, finalError: boom, wantCalls: []string{"write", "clients", "lock"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.WithValue(context.Background(), struct{}{}, "maintenance")
			now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
			r := &maintenanceBudgetReceiver{
				t: t, ctx: ctx, now: now, lockError: tc.lockError,
				callbackError: tc.callbackError, finalError: tc.finalError,
				completion: store.Completion{Outcome: store.TransactionCommitted},
			}
			n, err := PruneClients(ctx, r, 600, now)
			if n != 0 || err != tc.finalError {
				t.Errorf("PruneClients = %d, %v; want 0, %v", n, err, tc.finalError)
			}
			if r.callbackCalled != 1 || !reflect.DeepEqual(r.calls, tc.wantCalls) {
				t.Errorf("callback calls = %d, calls = %v; want 1, %v", r.callbackCalled, r.calls, tc.wantCalls)
			}
		})
	}
}
