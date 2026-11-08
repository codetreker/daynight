package service

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

type supervisionDeliveryStore struct {
	cause      error
	panicValue any
}

func (s supervisionDeliveryStore) WriteWebhookDelivery(context.Context, func(store.WebhookDeliveryScope) error) (store.Completion, error) {
	if s.panicValue != nil {
		panic(s.panicValue)
	}
	return store.Completion{Outcome: store.TransactionNotCommitted}, s.cause
}

type supervisionRetentionStore struct {
	store.WebhookRetentionTransactions
	store.WebhookReceiptGC
	store.WebhookConfigGC
	cause      error
	panicValue any
}

func (s supervisionRetentionStore) ScanWebhookConfigGC(context.Context, *store.WebhookConfigGCCandidate, int) (store.WebhookConfigGCScan, error) {
	if s.panicValue != nil {
		panic(s.panicValue)
	}
	return store.WebhookConfigGCScan{}, s.cause
}

func supervisionRuntime(t *testing.T, runner *webhook.Runner, retention *webhook.Retention) (*webhookRuntime, *bytes.Buffer) {
	t.Helper()
	var logs bytes.Buffer
	w := &webhookRuntime{runner: runner, retention: retention, logger: slog.New(slog.NewJSONHandler(&logs, nil)), done: make(chan struct{})}
	return w, &logs
}
func waitSupervision(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatal("webhook supervision did not stop")
	}
}
func stopSupervisionRunner(t *testing.T, r *webhook.Runner) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := r.Stop(ctx); err != nil {
		t.Error(err)
	}
}
func TestWebhookSupervisorReportsWorkerAndRetentionFailures(t *testing.T) {
	failure := errors.New("private storage diagnostic")
	for _, tc := range []struct {
		name, source string
		panicValue   any
		cause        error
	}{
		{"delivery error", "delivery", nil, failure},
		{"delivery panic", "delivery", "private panic", nil},
		{"retention error", "retention", nil, failure},
		{"retention panic", "retention", "private panic", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			runner := webhook.NewRunner(supervisionDeliveryStore{cause: failure}, &webhook.Service{}, false)
			retention := webhook.NewRetention(supervisionRetentionStore{cause: failure})
			w, logs := supervisionRuntime(t, runner, retention)
			if tc.source == "delivery" {
				runner = webhook.NewRunner(supervisionDeliveryStore{cause: tc.cause, panicValue: tc.panicValue}, &webhook.Service{}, false)
				w.runner = runner
			} else {
				retention = webhook.NewRetention(supervisionRetentionStore{cause: tc.cause, panicValue: tc.panicValue})
				w.retention = retention
			}
			go w.supervise(context.Background(), ctx)
			if tc.source == "delivery" {
				if err := runner.Start(ctx); err != nil {
					t.Fatal(err)
				}
				defer stopSupervisionRunner(t, runner)
			} else {
				if err := retention.Start(ctx); err != nil {
					t.Fatal(err)
				}
				defer func() {
					stop, done := context.WithTimeout(context.Background(), 5*time.Second)
					defer done()
					if err := retention.Stop(stop); err != nil {
						t.Error(err)
					}
				}()
			}
			waitSupervision(t, w.done)
			if w.failure == nil {
				t.Fatal("permanent worker failure not reported")
			}
			if tc.cause != nil && !errors.Is(w.failure, tc.cause) {
				t.Fatalf("worker cause lost: %v", w.failure)
			}
			if tc.panicValue != nil && !strings.Contains(w.failure.Error(), "panic") {
				t.Fatalf("panic not reported safely: %v", w.failure)
			}
			if strings.Contains(logs.String(), "private") || !strings.Contains(logs.String(), "webhook runtime failed") {
				t.Fatalf("unsafe failure log: %s", logs.String())
			}
		})
	}
}

func TestWebhookSupervisorRootCancellationPreservesDrain(t *testing.T) {
	root, stopRoot := context.WithCancel(context.Background())
	defer stopRoot()
	work, stopWork := context.WithCancel(context.Background())
	defer stopWork()
	runner := webhook.NewRunner(supervisionDeliveryStore{cause: errors.New("unused")}, &webhook.Service{}, false)
	failure := errors.New("retention unavailable")
	w, _ := supervisionRuntime(t, runner, webhook.NewRetention(supervisionRetentionStore{cause: failure}))
	go w.supervise(root, work)
	stopRoot()
	// Root cancellation stops claims, but must not end the supervisor or cancel
	// the separate in-flight work context before application drain.
	select {
	case <-w.done:
		t.Fatal("supervisor exited on root cancellation")
	case <-time.After(30 * time.Millisecond):
	}
	if work.Err() != nil {
		t.Fatal("root cancellation canceled drain context")
	}
	if err := w.retention.Start(work); err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := w.retention.Stop(ctx); err != nil {
			t.Error(err)
		}
	}()
	waitSupervision(t, w.done)
	if !errors.Is(w.failure, failure) {
		t.Fatalf("retention failure lost after root cancellation: %v", w.failure)
	}
}
