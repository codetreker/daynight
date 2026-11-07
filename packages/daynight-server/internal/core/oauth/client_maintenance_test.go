package oauth

import (
	"context"
	"errors"
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
