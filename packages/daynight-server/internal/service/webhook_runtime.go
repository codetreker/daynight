package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"sync"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
)

type webhookRetentionStore interface {
	store.WebhookRetentionTransactions
	store.WebhookReceiptGC
	store.WebhookConfigGC
}

type webhookRuntime struct {
	runner      *webhook.Runner
	retention   *webhook.Retention
	keys        webhook.KeyMaintenance
	logger      *slog.Logger
	mu          sync.Mutex
	started     bool
	failure     error
	cancel      context.CancelFunc
	done        chan struct{}
	keyDone     chan struct{}
	logDone     chan struct{}
	keyFailures chan error
	keyTicks    <-chan time.Time
}

func (a *App) assembleWebhooks(db store.Transactions, keys *secretbox.Keyring, enabled bool, logger *slog.Logger) error {
	management, ok := db.(store.WebhookTransactions)
	if !ok {
		return errors.New("webhook management store unavailable")
	}
	delivery, ok := db.(store.WebhookDeliveryTransactions)
	if !ok {
		return errors.New("webhook delivery store unavailable")
	}
	retention, ok := db.(webhookRetentionStore)
	if !ok {
		return errors.New("webhook retention store unavailable")
	}
	maintenance, ok := db.(store.WebhookKeyMaintenance)
	if !ok {
		return errors.New("webhook key maintenance store unavailable")
	}
	a.Webhooks = &webhook.Service{DB: management, Keys: keys, ConfigurationExpansionAvailable: enabled, DispatchEnabled: enabled}
	r := webhook.NewRunner(delivery, a.Webhooks, enabled)
	r.Logger = logger
	w := &webhookRuntime{runner: r, retention: webhook.NewRetention(retention), keys: webhook.KeyMaintenance{DB: maintenance, Keys: keys}, logger: logger}
	a.webhookRuntime = w
	ready := a.Ready
	a.Ready = func(ctx context.Context) error {
		w.mu.Lock()
		failure := w.failure
		w.mu.Unlock()
		if failure != nil {
			return failure
		}
		return ready(ctx)
	}
	return nil
}

// Start starts the webhook workers after all application dependencies are assembled.
// A root cancellation stops claims immediately; in-flight work is canceled by
// CancelWork after the HTTP and Session drain has begun.
func (a *App) Start(root context.Context) error {
	w := a.webhookRuntime
	if w == nil {
		return nil
	}
	if root == nil || root.Err() != nil {
		return errors.New("invalid webhook runtime context")
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.started {
		return errors.New("webhook runtime already started")
	}
	ctx, cancel := context.WithCancel(context.WithoutCancel(root))
	w.started, w.cancel = true, cancel
	if err := w.runner.StartWithClaimContext(ctx, root); err != nil {
		cancel()
		return err
	}
	if err := w.retention.Start(ctx); err != nil {
		cancel()
		return err
	}
	w.done = make(chan struct{})
	w.keyDone, w.logDone, w.keyFailures = make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go w.maintainKeys(ctx)
	go w.logRetention(ctx)
	go w.supervise(root, ctx)
	return nil
}

func (w *webhookRuntime) supervise(root, ctx context.Context) {
	defer close(w.done)
	rootDone := root.Done()
	for {
		select {
		case <-rootDone:
			w.runner.StopClaims()
			rootDone = nil
		case err := <-w.runner.Failures():
			w.failed(err)
			return
		case err := <-w.retention.Failures():
			w.failed(err)
			return
		case err := <-w.keyFailures:
			w.failed(err)
			return
		case <-ctx.Done():
			return
		}
	}
}

func (w *webhookRuntime) maintainKeys(ctx context.Context) {
	defer close(w.keyDone)
	defer func() {
		if recover() != nil && ctx.Err() == nil {
			w.keyFailures <- errors.New("webhook key maintenance panic")
		}
	}()
	ticks := w.keyTicks
	if ticks == nil {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		ticks = ticker.C
	}
	for {
		select {
		case <-ticks:
			if err := w.rewrap(ctx); err != nil && ctx.Err() == nil {
				w.keyFailures <- err
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

func (w *webhookRuntime) logRetention(ctx context.Context) {
	defer close(w.logDone)
	for {
		select {
		case event := <-w.retention.Events():
			event.Log(ctx, w.logger)
		case <-ctx.Done():
			return
		}
	}
}

func (w *webhookRuntime) failed(err error) {
	w.mu.Lock()
	w.failure = fmt.Errorf("webhook runtime unavailable: %w", err)
	w.mu.Unlock()
	w.runner.StopClaims()
	w.logger.Error("webhook runtime failed", "component", "webhook", "operation", "maintain")
}

func (w *webhookRuntime) rewrap(ctx context.Context) error {
	if w.keys.Keys == nil {
		return nil
	}
	scan, cancel := context.WithTimeout(ctx, 2*time.Second)
	ids, err := w.keys.DB.WebhookMasterKeyIDs(scan)
	cancel()
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
			return nil
		}
		return err
	}
	for _, id := range ids {
		if id == w.keys.Keys.ActiveKeyID() {
			continue
		}
		if _, err := w.keys.RewrapPass(ctx, id, 500); err != nil {
			// A bounded pass can finish partially. Its CAS updates remain valid;
			// the next scan resumes from the remaining old references.
			if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
				continue
			}
			return err
		}
	}
	return nil
}

func (a *App) StopClaims() {
	if a.webhookRuntime != nil {
		a.webhookRuntime.runner.StopClaims()
	}
}

// CancelWork cancels outstanding attempts and maintenance after claims stop.
func (a *App) CancelWork() {
	if w := a.webhookRuntime; w != nil {
		w.mu.Lock()
		cancel := w.cancel
		w.mu.Unlock()
		if cancel != nil {
			cancel()
		}
	}
	a.Engine.CancelWork()
}

// Drain waits for all webhook work and the Session engine before dependencies close.
func (a *App) Drain(ctx context.Context) error {
	if w := a.webhookRuntime; w != nil {
		a.StopClaims()
		w.mu.Lock()
		cancel, done, keyDone, logDone := w.cancel, w.done, w.keyDone, w.logDone
		w.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		if err := w.runner.Stop(ctx); err != nil {
			return err
		}
		if err := w.retention.Stop(ctx); err != nil {
			return err
		}
		if done != nil {
			select {
			case <-done:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		for _, finished := range []<-chan struct{}{keyDone, logDone} {
			if finished != nil {
				select {
				case <-finished:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
		}
	}
	return a.Engine.Stop(ctx)
}

func validateWebhookStartup(ctx context.Context, db store.Transactions, keys *secretbox.Keyring) (result error) {
	startup, ok := db.(store.WebhookStartupReader)
	if !ok {
		return errors.New("webhook startup validation unavailable")
	}
	policies, err := startup.WebhookStartupPolicies(ctx)
	if err != nil {
		return err
	}
	want := wm.Policy{Version: 1, MaxAutomaticAttempts: 10, AutomaticWindowSeconds: 259200,
		AutomaticOffsetsSeconds: []int32{0, 60, 300, 1800, 7200, 21600, 43200, 86400, 172800, 255600},
		MaxManualOperations:     3, PayloadRetentionSeconds: 604800, MetadataRetentionSeconds: 2592000,
		OperationRetentionSeconds: 2592000, OperationMaxAgeSeconds: 300, OperationFutureSkewSeconds: 60,
		HTTPTimeoutSeconds: 15, LeaseSeconds: 45, MinimumFailureWaitSeconds: 5, JitterBasisPoints: 1000,
		JitterMaxSeconds: 1800, KeyOverlapDefaultSeconds: 86400, KeyOverlapMaxSeconds: 604800}
	if len(policies) != 1 || !reflect.DeepEqual(policies[0], want) {
		return errors.New("unsupported or invalid webhook policy")
	}
	if err := startup.CheckWebhookCurrentReferences(ctx); err != nil {
		return err
	}
	recovery, ok := db.(store.WebhookRecoveryReader)
	if !ok {
		return errors.New("webhook key validation unavailable")
	}
	snapshot, err := recovery.OpenWebhookRecoverySnapshot(ctx)
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		result = errors.Join(result, snapshot.Close(cleanup))
	}()
	ids, err := snapshot.WebhookMasterKeyIDs(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if !keys.HasKey(id) {
			return secretbox.ErrMissingKey
		}
		var cursor *store.WebhookCiphertext
		for {
			rows, err := snapshot.WebhookCiphertexts(ctx, id, cursor, 500)
			if err != nil {
				return err
			}
			if len(rows) == 0 {
				break
			}
			for _, row := range rows {
				plain, err := keys.Open(secretbox.Envelope{Version: row.Version, MasterKeyID: row.MasterKeyID, Nonce: row.Nonce, Ciphertext: row.Ciphertext}, []string{row.OwnerKind, row.OwnerID, row.EndpointID, row.Kind, row.RecordID})
				clear(plain)
				if err != nil {
					return fmt.Errorf("webhook ciphertext validation: %w", err)
				}
			}
			last := rows[len(rows)-1]
			cursor = &last
		}
	}
	return nil
}
