package service

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/prometheus/client_golang/prometheus"
)

type monitoringAppBackend struct {
	started chan struct{}
	release chan struct{}
	closes  atomic.Int32
	err     error
}

func (b *monitoringAppBackend) CompareAndSet(context.Context, store.MonitoringIdentity, *string, store.MonitoringCandidate) (store.MonitoringCASResult, error) {
	panic("unexpected monitoring request")
}
func (b *monitoringAppBackend) Read(context.Context, store.MonitoringIdentity) (store.MonitoringReadResult, error) {
	panic("unexpected monitoring request")
}
func (b *monitoringAppBackend) ReadSummaries(context.Context, []store.MonitoringIdentity) (store.MonitoringSummariesResult, error) {
	panic("unexpected monitoring request")
}
func (b *monitoringAppBackend) Close() error {
	b.closes.Add(1)
	close(b.started)
	<-b.release
	return b.err
}

func TestAppMonitoringReadinessAndResourceLifetime(t *testing.T) {
	c := appTestConfig(t)
	c.RedisURL = "redis://unavailable.example:6379"
	persistence := newAppBackend(t)
	openers := appTestOpeners(t, c, persistence)
	monitor := &monitoringAppBackend{started: make(chan struct{}), release: make(chan struct{}), err: errors.New("close monitoring")}
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(monitor.release) }) }
	t.Cleanup(release)
	openers.monitoring = func(url string) (monitoringBackend, error) {
		if url != c.RedisURL {
			t.Fatal("incorrect Redis URL")
		}
		return monitor, nil
	}
	app, err := openApp(t.Context(), c, nil, openers)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		release()
		_ = app.Close(context.Background())
	})
	if app.monitoring != monitor {
		t.Fatal("monitoring dependency not retained")
	}
	if err := app.Ready(t.Context()); err != nil {
		t.Fatalf("monitoring affected readiness: %v", err)
	}
	op, err := app.Engine.BeginOperation()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(op.Close)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	if err := app.Close(ctx); !errors.Is(err, context.DeadlineExceeded) || monitor.closes.Load() != 0 {
		t.Fatalf("closed monitoring before active operation ended: %v", err)
	}
	op.Close()
	done := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		done <- app.Close(ctx)
	}()
	select {
	case <-monitor.started:
	case <-time.After(5 * time.Second):
		t.Fatal("monitor close not started")
	}
	if err := <-done; !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("close did not honor deadline: %v", err)
	}
	persistence.mu.Lock()
	persistenceCloses := persistence.closes
	persistence.mu.Unlock()
	if persistenceCloses != 0 {
		t.Fatal("persistence closed before monitoring")
	}
	release()
	if err := app.Close(context.Background()); !errors.Is(err, monitor.err) {
		t.Fatalf("close failure lost: %v", err)
	}
	if err := app.Close(context.Background()); !errors.Is(err, monitor.err) || monitor.closes.Load() != 1 {
		t.Fatalf("close retry: %v", err)
	}
}

func TestAppMonitoringOpenFailureCleansOtherResources(t *testing.T) {
	c := appTestConfig(t)
	c.RedisURL = "redis://redis.example"
	persistence := newAppBackend(t)
	openers := appTestOpeners(t, c, persistence)
	failure := errors.New("store open failed")
	openers.monitoring = func(string) (monitoringBackend, error) { return nil, failure }
	app, err := openApp(t.Context(), c, nil, openers)
	if app != nil || !errors.Is(err, failure) || persistence.closes != 1 {
		t.Fatalf("monitoring startup failure or cleanup: app=%v err=%v", app, err)
	}
}

type monitoringNonTransferFiles struct{ appStorage }

func TestAppMonitoringClosesAfterLaterStartupFailure(t *testing.T) {
	c := appTestConfig(t)
	c.RedisURL = "redis://redis.example"
	persistence := newAppBackend(t)
	openers := appTestOpeners(t, c, persistence)
	openFiles := openers.files
	openers.files = func(path string) (appStorage, error) {
		files, err := openFiles(path)
		if err != nil {
			return nil, err
		}
		return monitoringNonTransferFiles{files}, nil
	}
	monitor := &monitoringAppBackend{started: make(chan struct{}), release: make(chan struct{})}
	close(monitor.release)
	openers.monitoring = func(string) (monitoringBackend, error) { return monitor, nil }
	app, err := openApp(t.Context(), c, nil, openers)
	if app != nil || err == nil || monitor.closes.Load() != 1 || persistence.closes != 1 {
		t.Fatalf("later startup failure leaked resources: app=%v err=%v", app, err)
	}
}

func TestAppMonitoringAndMetricsAssembly(t *testing.T) {
	for _, failMetrics := range []bool{false, true} {
		t.Run(map[bool]string{false: "both enabled", true: "metrics failure"}[failMetrics], func(t *testing.T) {
			c := appTestConfig(t)
			c.RedisURL = "redis://redis.example"
			c.MetricsListenAddress = "127.0.0.1:0"
			backend := newAppBackend(t)
			open := appTestOpeners(t, c, backend)
			monitor := &monitoringAppBackend{started: make(chan struct{}), release: make(chan struct{})}
			close(monitor.release)
			open.monitoring = func(string) (monitoringBackend, error) { return monitor, nil }
			failure := errors.New("metrics creation failed")
			if failMetrics {
				open.metrics = func() (*prometheus.Registry, error) { return nil, failure }
			}
			app, err := openApp(t.Context(), c, nil, open)
			if failMetrics {
				if app != nil || !errors.Is(err, failure) || monitor.closes.Load() != 1 || backend.closes != 1 {
					t.Fatalf("metrics failure did not close monitoring: %v", err)
				}
				return
			}
			if err != nil || app.Metrics == nil || app.monitoring != monitor {
				t.Fatalf("assembly: %v", err)
			}
			if err = app.Close(context.Background()); err != nil || monitor.closes.Load() != 1 {
				t.Fatalf("close: %v", err)
			}
		})
	}
}
