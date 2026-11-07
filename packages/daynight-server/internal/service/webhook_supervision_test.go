package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
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

type supervisionKeysStore struct {
	calls         chan struct{}
	cause         error
	panicValue    any
	waitForCancel bool
}

func (s supervisionKeysStore) WebhookMasterKeyIDs(ctx context.Context) ([]string, error) {
	s.calls <- struct{}{}
	if s.panicValue != nil {
		panic(s.panicValue)
	}
	if s.waitForCancel {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if s.cause != nil {
		return nil, s.cause
	}
	return nil, nil
}
func (supervisionKeysStore) WebhookCiphertexts(context.Context, string, *store.WebhookCiphertext, int) ([]store.WebhookCiphertext, error) {
	panic("unexpected ciphertext scan")
}
func (supervisionKeysStore) CompareAndSwapWebhookCiphertext(context.Context, store.WebhookCiphertext, store.WebhookCiphertext) (bool, error) {
	panic("unexpected ciphertext update")
}

func supervisionRuntime(t *testing.T, runner *webhook.Runner, retention *webhook.Retention) (*webhookRuntime, *bytes.Buffer) {
	t.Helper()
	var logs bytes.Buffer
	w := &webhookRuntime{runner: runner, retention: retention, logger: slog.New(slog.NewJSONHandler(&logs, nil)), done: make(chan struct{}), keyDone: make(chan struct{}), keyFailures: make(chan error, 1)}
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
func supervisionKeys(t *testing.T) *secretbox.Keyring {
	t.Helper()
	encoded := base64.StdEncoding.EncodeToString(make([]byte, 32))
	keys, err := secretbox.Parse([]byte(`{"activeKeyId":"primary","keys":{"primary":"` + encoded + `"}}`))
	if err != nil {
		t.Fatal(err)
	}
	return keys
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
	w, _ := supervisionRuntime(t, runner, webhook.NewRetention(supervisionRetentionStore{}))
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
	failure := errors.New("key maintenance unavailable")
	w.keyFailures <- failure
	waitSupervision(t, w.done)
	if !errors.Is(w.failure, failure) {
		t.Fatalf("key failure lost after root cancellation: %v", w.failure)
	}
}

func TestWebhookKeyMaintenanceSupervision(t *testing.T) {
	for _, tc := range []struct {
		name          string
		cause         error
		panicValue    any
		waitForCancel bool
	}{
		{name: "scan failure", cause: errors.New("private key scan failure")},
		{name: "scan panic", panicValue: "private key panic"},
		{name: "work cancellation", waitForCancel: true},
		{name: "successful scan then cancellation"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			runner := webhook.NewRunner(supervisionDeliveryStore{cause: errors.New("unused")}, &webhook.Service{}, false)
			w, logs := supervisionRuntime(t, runner, webhook.NewRetention(supervisionRetentionStore{}))
			ticks := make(chan time.Time, 1)
			calls := make(chan struct{}, 1)
			w.keyTicks = ticks
			w.keys = webhook.KeyMaintenance{DB: supervisionKeysStore{calls: calls, cause: tc.cause, panicValue: tc.panicValue, waitForCancel: tc.waitForCancel}, Keys: supervisionKeys(t)}
			go w.supervise(context.Background(), ctx)
			go w.maintainKeys(ctx)
			ticks <- time.Now()
			select {
			case <-calls:
			case <-time.After(5 * time.Second):
				t.Fatal("maintenance did not scan")
			}
			if tc.cause != nil || tc.panicValue != nil {
				waitSupervision(t, w.done)
				waitSupervision(t, w.keyDone)
				if tc.cause != nil && !errors.Is(w.failure, tc.cause) {
					t.Fatalf("key failure lost: %v", w.failure)
				}
				if tc.panicValue != nil && (w.failure == nil || !strings.Contains(w.failure.Error(), "panic")) {
					t.Fatalf("key panic lost: %v", w.failure)
				}
				if strings.Contains(logs.String(), "private") || !strings.Contains(logs.String(), "webhook runtime failed") {
					t.Fatalf("unsafe key log: %s", logs.String())
				}
			} else {
				cancel()
				waitSupervision(t, w.keyDone)
				waitSupervision(t, w.done)
				if w.failure != nil {
					t.Fatalf("normal cancellation reported failure: %v", w.failure)
				}
			}
		})
	}
}
