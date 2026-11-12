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

// Start starts the application workers after all dependencies are assembled.
// A root cancellation stops claims immediately; in-flight work is canceled by
// CancelWork after the HTTP and Session drain has begun.
func (a *App) Start(root context.Context) error {
	<-a.drainLock
	defer func() { a.drainLock <- struct{}{} }()
	if a.drained {
		return errors.New("application already drained")
	}
	w := a.webhookRuntime
	if w == nil && a.CredentialUsage == nil {
		return nil
	}
	if root == nil || root.Err() != nil {
		return errors.New("invalid application runtime context")
	}
	if a.CredentialUsage != nil {
		if err := a.CredentialUsage.Start(context.WithoutCancel(root)); err != nil {
			return err
		}
		a.usageStarted = true
	}
	if w == nil {
		return nil
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
	if a.CredentialUsage != nil {
		a.CredentialUsage.CancelWork()
	}
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

// Drain seals the recorder only after transport callers have stopped using the
// application. An error's Drained result describes every application producer.
func (a *App) Drain(ctx context.Context) error {
	select {
	case <-a.drainLock:
		defer func() { a.drainLock <- struct{}{} }()
	case <-ctx.Done():
		return appDrainError{cause: ctx.Err()}
	}
	if a.drained {
		return a.drainResult(nil, true)
	}
	if err := a.drainProducers(ctx); err != nil {
		return a.drainResult(err, false)
	}
	if a.CredentialUsage != nil && a.usageStarted {
		if err := a.CredentialUsage.Drain(ctx); err != nil {
			if complete, ok := err.(interface{ Drained() bool }); !ok || !complete.Drained() {
				return a.drainResult(err, false)
			}
			a.drainErr = errors.Join(a.drainErr, err)
		}
	}
	a.drained = true
	return a.drainResult(nil, true)
}

type appDrainError struct {
	cause   error
	drained bool
}

func (e appDrainError) Error() string { return e.cause.Error() }
func (e appDrainError) Unwrap() error { return e.cause }
func (e appDrainError) Drained() bool { return e.drained }

func (a *App) drainResult(err error, complete bool) error {
	if cause := errors.Join(a.drainErr, err); cause != nil {
		return appDrainError{cause: cause, drained: complete}
	}
	return nil
}

func (a *App) drainProducers(ctx context.Context) error {
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
	if err := a.Engine.Stop(ctx); err != nil {
		return err
	}
	if a.oauthMaintenance != nil {
		if err := a.oauthMaintenance.Stop(ctx); err != nil {
			return err
		}
	}
	if a.PrivateContent != nil {
		if err := a.PrivateContent.Close(ctx); err != nil {
			return err
		}
	}
	if a.WorkerReadOnly != nil {
		a.WorkerReadOnly.Close()
	}
	return nil
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
