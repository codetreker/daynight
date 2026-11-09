//go:build stress

package webhook

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func retentionStressGuard(t *testing.T) {
	t.Helper()
	if os.Getenv("CI") != "" {
		t.Fatal("stress tests are prohibited in CI")
	}
}
func retentionScriptedHistory(t *testing.T, scopes ...*retentionScopeMock) *retentionStoreMock {
	db := retentionEmptyStore(t)
	next := 0
	db.writeHistory = func(_ context.Context, fn func(store.WebhookRetentionScope) error) (store.Completion, error) {
		if next >= len(scopes) {
			t.Fatalf("unexpected history transaction %d", next)
		}
		s := scopes[next]
		next++
		return retentionCallback(fn, s)
	}
	return db
}

func TestRetentionLargePurgeResumesFromCurrentDAOFactsStress(t *testing.T) {
	retentionStressGuard(t)
	d := retentionDeliveryFixture()
	d.PurgingAt = &retentionTestNow
	s := retentionCandidateScope(t, "purge", d)
	s.children = func(_ context.Context, id string, budget int) (int, error) {
		if id != d.ID || budget != 500 {
			t.Fatalf("first purge %s %d", id, budget)
		}
		return 500, nil
	}
	r := NewRetention(retentionScriptedHistory(t, s))
	n, more, err := r.Pass(t.Context())
	if err != nil || n != 500 || !more {
		t.Fatalf("bounded purge %d %v %v", n, more, err)
	}
	last := retentionCandidateScope(t, "purge", d)
	last.children = func(_ context.Context, id string, budget int) (int, error) {
		if id != d.ID || budget != 500 {
			t.Fatal("restart did not resume current closure")
		}
		return 1, nil
	}
	gone := retentionCandidateScope(t, "purge", d)
	gone.children = func(context.Context, string, int) (int, error) { return 0, nil }
	gone.delivery = func(context.Context, string) (int, error) { return 1, nil }
	event := retentionEmptyScope(t)
	event.orphan = func(context.Context) (string, int, error) { return d.EventID, 1, nil }
	restarted := NewRetention(retentionScriptedHistory(t, last, gone, event, retentionEmptyScope(t)))
	n, more, err = restarted.Pass(t.Context())
	if err != nil || n != 3 || more {
		t.Fatalf("fresh component continuation %d %v %v", n, more, err)
	}
}

func TestRetentionPurgeBacklogDoesNotStarvePayloadStress(t *testing.T) {
	retentionStressGuard(t)
	old := retentionDeliveryFixture()
	payload := old
	payload.ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	closeScope := retentionCandidateScope(t, "close", old)
	closeScope.attempts = func(context.Context, string) ([]store.WebhookAttempt, error) { return nil, nil }
	closeScope.seconds = func(context.Context, int64) (int, error) { return 30 * 24 * 3600, nil }
	closeScope.close = func(context.Context, string, time.Time) (int, error) { return 1, nil }
	payloadScope := retentionCandidateScope(t, "payload", payload)
	removed := false
	payloadScope.payload = func(_ context.Context, id string, _ time.Time) (int, error) {
		if id != payload.ID {
			t.Fatal("payload identity changed")
		}
		removed = true
		return 1, nil
	}
	factScope := retentionEmptyScope(t)
	factScope.fact = func(context.Context) (string, int, error) { return old.EventID, 1, nil }
	old.PurgingAt = &retentionTestNow
	purge := retentionCandidateScope(t, "purge", old)
	purge.children = func(_ context.Context, id string, budget int) (int, error) {
		if !removed || id != old.ID || budget != 497 {
			t.Fatalf("backlog starved payload or exceeded shared budget: removed%v id%s budget%d", removed, id, budget)
		}
		return 497, nil
	}
	r := NewRetention(retentionScriptedHistory(t, closeScope, payloadScope, factScope, purge))
	n, more, err := r.Pass(t.Context())
	if err != nil || n != 500 || !more || !removed {
		t.Fatalf("fair history pass %d %v %v", n, more, err)
	}
}

func TestRetentionSharedBudgetWhenHistoryRunsFirstStress(t *testing.T) {
	retentionStressGuard(t)
	d := retentionDeliveryFixture()
	d.PurgingAt = &retentionTestNow
	s := retentionCandidateScope(t, "purge", d)
	s.children = func(_ context.Context, _ string, n int) (int, error) {
		if n != 500 {
			t.Fatalf("history budget%d", n)
		}
		return 500, nil
	}
	db := retentionScriptedHistory(t, s)
	db.scanConfig = nil
	db.expiredReceipts = nil
	r := NewRetention(db)
	r.phase = 2
	n, more, err := r.Pass(t.Context())
	if err != nil || n != 500 || !more || r.Observation().ConfigRows != 0 || r.Observation().ReceiptRows != 0 {
		t.Fatalf("history-first shared budget %d %v %+v %v", n, more, r.Observation(), err)
	}
}
