package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"sync"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

type webhookRetentionStore interface {
	store.WebhookRetentionTransactions
	store.WebhookReceiptGC
	store.WebhookConfigGC
}

type webhookRuntime struct {
	runner    *webhook.Runner
	retention *webhook.Retention
	logger    *slog.Logger
	mu        sync.Mutex
	started   bool
	failure   error
	cancel    context.CancelFunc
	done      chan struct{}
	logDone   chan struct{}
}

func (a *App) assembleWebhooks(db store.Transactions, enabled bool, logger *slog.Logger) error {
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
	a.Webhooks = &webhook.Service{DB: management, ConfigurationExpansionAvailable: enabled, DispatchEnabled: enabled}
	r := webhook.NewRunner(delivery, a.Webhooks, enabled)
	r.Logger = logger
	w := &webhookRuntime{runner: r, retention: webhook.NewRetention(retention), logger: logger}
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
	w.logDone = make(chan struct{})
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
		cancel, done, logDone := w.cancel, w.done, w.logDone
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
		if logDone != nil {
			select {
			case <-logDone:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	return a.Engine.Stop(ctx)
}

func validateWebhookStartup(ctx context.Context, db store.Transactions) error {
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
	return nil
}
