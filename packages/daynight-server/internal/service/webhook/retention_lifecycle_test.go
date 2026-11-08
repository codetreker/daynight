package webhook

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestRetentionBackgroundReportsPermanentFailureAndDrains(t *testing.T) {
	cause := errors.New("scan unavailable")
	db := retentionEmptyStore(t)
	db.scanConfig = func(context.Context, *store.WebhookConfigGCCandidate, int) (store.WebhookConfigGCScan, error) {
		return store.WebhookConfigGCScan{}, cause
	}
	r := NewRetention(db)
	retentionFail(t, r.Stop(t.Context()))
	retentionFail(t, r.Start(context.Background()))
	select {
	case err := <-r.Failures():
		if !errors.Is(err, cause) {
			t.Fatalf("lost background cause: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("failure not reported")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	retentionFail(t, r.Stop(ctx))
}

func TestRetentionStartRequiresValidSingleActivation(t *testing.T) {
	if err := NewRetention(nil).Start(context.Background()); err == nil {
		t.Fatal("missing DAO accepted")
	}
	r := NewRetention(retentionEmptyStore(t))
	if err := r.Start(nil); err == nil {
		t.Fatal("nil runtime context accepted")
	}
	parent, cancel := context.WithCancel(context.Background())
	retentionFail(t, r.Start(parent))
	if err := r.Start(parent); err == nil {
		t.Fatal("second activation accepted")
	}
	cancel()
	ctx, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	retentionFail(t, r.Stop(ctx))
	if err := r.Start(context.Background()); err == nil {
		t.Fatal("completed instance restarted")
	}
}

func TestRetentionBackgroundUnknownUsesScheduledReadback(t *testing.T) {
	for _, mode := range []string{"config", "receipt", "history"} {
		t.Run(mode, func(t *testing.T) {
			r, _, observed, writes := retentionUnknownScenario(t, mode)
			waits, permit := make(chan time.Duration, 2), make(chan struct{})
			r.wait = func(c context.Context, d time.Duration) bool {
				select {
				case waits <- d:
				case <-c.Done():
					return false
				}
				select {
				case <-permit:
					return true
				case <-c.Done():
					return false
				}
			}
			parent, cancel := context.WithCancel(context.Background())
			defer cancel()
			retentionFail(t, r.Start(parent))
			defer func() {
				cancel()
				c, s := context.WithTimeout(context.Background(), time.Second)
				defer s()
				if e := r.Stop(c); e != nil {
					t.Error(e)
				}
			}()
			select {
			case delay := <-waits:
				if delay != time.Second || observed.Load() || writes.Load() != 1 {
					t.Fatalf("unknown retry %v observed%v writes%d", delay, observed.Load(), writes.Load())
				}
			case err := <-r.Failures():
				t.Fatalf("unknown ended loop: %v", err)
			case <-time.After(time.Second):
				t.Fatal("first scheduling boundary missing")
			}
			permit <- struct{}{}
			select {
			case delay := <-waits:
				if delay != time.Minute || !observed.Load() || writes.Load() != 1 || r.Observation().Unknown {
					t.Fatalf("readback delay=%v observed%v writes%d obs%+v", delay, observed.Load(), writes.Load(), r.Observation())
				}
			case err := <-r.Failures():
				t.Fatal(err)
			case <-time.After(time.Second):
				t.Fatal("readback did not finish")
			}
		})
	}
}

func TestRetentionStopBoundsDelayedDAODrain(t *testing.T) {
	db := retentionEmptyStore(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	db.scanConfig = func(c context.Context, _ *store.WebhookConfigGCCandidate, _ int) (store.WebhookConfigGCScan, error) {
		close(entered)
		<-c.Done()
		<-release
		return store.WebhookConfigGCScan{}, c.Err()
	}
	r := NewRetention(db)
	retentionFail(t, r.Start(context.Background()))
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("DAO not entered")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	err := r.Stop(ctx)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		once.Do(func() { close(release) })
		t.Fatalf("delayed drain did not exhaust stop deadline: %v", err)
	}
	once.Do(func() { close(release) })
	ctx, cancel = context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	retentionFail(t, r.Stop(ctx))
}

func TestRetentionBackgroundSanitizesPanics(t *testing.T) {
	db := retentionEmptyStore(t)
	db.scanConfig = func(context.Context, *store.WebhookConfigGCCandidate, int) (store.WebhookConfigGCScan, error) {
		panic("private-payload-secret")
	}
	r := NewRetention(db)
	retentionFail(t, r.Start(context.Background()))
	select {
	case e := <-r.Failures():
		if e == nil || e.Error() != "webhook retention panic" || strings.Contains(e.Error(), "private") {
			t.Fatalf("panic disclosure: %v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("panic not reported")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	retentionFail(t, r.Stop(ctx))
}

func retentionDrainLogs(r *Retention) string {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	for {
		select {
		case event := <-r.Events():
			event.Log(context.Background(), logger)
		default:
			return output.String()
		}
	}
}

func TestRetentionObservationCountsLagAndLogsSafeIdentity(t *testing.T) {
	d := retentionDeliveryFixture()
	d.Body = []byte("payload-secret-canary")
	d.DestinationConfiguration = []byte("target-secret-canary")
	db := retentionEmptyStore(t)
	calls := 0
	db.writeHistory = func(_ context.Context, f func(store.WebhookRetentionScope) error) (store.Completion, error) {
		calls++
		if calls == 1 {
			s := retentionCandidateScope(t, "payload", d)
			s.payload = func(context.Context, string, time.Time) (int, error) { return 1, nil }
			return retentionCallback(f, s)
		}
		return retentionCallback(f, retentionEmptyScope(t))
	}
	r := NewRetention(db)
	if r.Observation().Available {
		t.Fatal("unrun observation was available")
	}
	n, more, err := r.Pass(t.Context())
	retentionFail(t, err)
	obs := r.Observation()
	if n != 1 || more || !obs.Available || obs.ConfirmedRows != 1 || obs.HistoryRows != 1 || obs.ConfigRows != 0 || obs.ReceiptRows != 0 || obs.Failed || obs.Unknown || !obs.LagKnown || obs.OldestObservedLag != 33*24*time.Hour || !obs.LagObservedAt.Equal(retentionTestNow) {
		t.Fatalf("observation=%+v", obs)
	}
	logs := retentionDrainLogs(r)
	for _, expected := range []string{`"component":"webhook"`, `"phase":"payload"`, `"delivery_id":"` + d.ID + `"`, `"event_id":"` + d.EventID + `"`, `"endpoint_id":"` + d.EndpointID + `"`, `"owner_id":"` + d.Owner.ID + `"`, `"project_id":"` + d.ProjectID + `"`, `"history_rows":1`, `"lag_known":true`} {
		if !strings.Contains(logs, expected) {
			t.Fatalf("missing %s in %s", expected, logs)
		}
	}
	for _, secret := range []string{string(d.Body), string(d.DestinationConfiguration)} {
		if strings.Contains(logs, secret) {
			t.Fatalf("log disclosed %s", secret)
		}
	}
}

func TestRetentionObservationUsesLaterMetadataDeadline(t *testing.T) {
	d := retentionDeliveryFixture()
	d.MetadataExpiresAt = retentionTestNow.Add(-time.Hour)
	db := retentionEmptyStore(t)
	calls := 0
	db.writeHistory = func(_ context.Context, f func(store.WebhookRetentionScope) error) (store.Completion, error) {
		calls++
		if calls == 1 {
			s := retentionCandidateScope(t, "close", d)
			s.attempts = func(context.Context, string) ([]store.WebhookAttempt, error) { return nil, nil }
			s.seconds = func(context.Context, int64) (int, error) { return 30 * 24 * 3600, nil }
			s.close = func(context.Context, string, time.Time) (int, error) { return 1, nil }
			return retentionCallback(f, s)
		}
		return retentionCallback(f, retentionEmptyScope(t))
	}
	r := NewRetention(db)
	n, _, err := r.Pass(t.Context())
	retentionFail(t, err)
	if n != 1 || !r.Observation().LagKnown || r.Observation().OldestObservedLag != time.Hour {
		t.Fatalf("later deadline observation=%+v", r.Observation())
	}
}

func TestRetentionObservationDoesNotDiscloseFailureCause(t *testing.T) {
	for _, outcome := range []store.TransactionOutcome{store.TransactionUnknown, store.TransactionNotCommitted} {
		t.Run(string(outcome), func(t *testing.T) {
			cause := errors.New("private-payload-and-secret-marker")
			db := retentionEmptyStore(t)
			db.writeHistory = func(_ context.Context, fn func(store.WebhookRetentionScope) error) (store.Completion, error) {
				if err := fn(retentionEmptyScope(t)); err != nil {
					t.Fatal(err)
				}
				return store.Completion{Outcome: outcome}, cause
			}
			r := NewRetention(db)
			n, _, err := r.Pass(t.Context())
			if n != 0 || !errors.Is(err, cause) {
				t.Fatalf("cause lost: n%d err%v", n, err)
			}
			obs := r.Observation()
			if !obs.Available || !obs.Failed || obs.LagKnown || obs.ConfirmedRows != 0 || obs.Unknown != (outcome == store.TransactionUnknown) {
				t.Fatalf("failure observation %+v", obs)
			}
			logs := retentionDrainLogs(r)
			code := "maintenance_error"
			if outcome == store.TransactionUnknown {
				code = "transaction_unknown"
			}
			if strings.Contains(logs, cause.Error()) || !strings.Contains(logs, `"error_code":"`+code+`"`) {
				t.Fatalf("failure log=%s", logs)
			}
		})
	}
}

func TestRetentionObservationConcurrentReadersSeeWholePass(t *testing.T) {
	r := NewRetention(retentionEmptyStore(t))
	start := make(chan struct{})
	done := make(chan error, 4)
	for i := 0; i < 4; i++ {
		go func() {
			<-start
			for n := 0; n < 1000; n++ {
				o := r.Observation()
				if o.Available && o.ConfirmedRows != o.ConfigRows+o.ReceiptRows+o.HistoryRows {
					done <- fmt.Errorf("partial observation %+v", o)
					return
				}
			}
			done <- nil
		}()
	}
	close(start)
	for i := 0; i < 350; i++ {
		if i%2 == 0 {
			r.publishObservation(RetentionObservation{ConfirmedRows: 6, ConfigRows: 1, ReceiptRows: 2, HistoryRows: 3}, nil)
		} else {
			r.publishObservation(RetentionObservation{ConfirmedRows: 15, ConfigRows: 4, ReceiptRows: 5, HistoryRows: 6}, nil)
		}
	}
	for i := 0; i < 4; i++ {
		retentionFail(t, <-done)
	}
	if !r.Observation().Available {
		t.Fatal("no completed observation")
	}
}

func TestRetentionBlockedEventConsumerDoesNotBlockPassOrStop(t *testing.T) {
	r := NewRetention(retentionEmptyStore(t))
	consumed, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() { defer close(done); <-r.Events(); close(consumed); <-release }()
	defer func() { close(release); <-done }()
	retentionFail(t, r.Start(context.Background()))
	select {
	case <-consumed:
	case <-time.After(time.Second):
		t.Fatal("event not published")
	}
	for i := 0; i < 350 && r.Observation().DroppedEvents == 0; i++ {
		_, _, err := r.Pass(t.Context())
		retentionFail(t, err)
	}
	if r.Observation().DroppedEvents == 0 {
		t.Fatal("full stream did not report dropped events")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	retentionFail(t, r.Stop(ctx))
	select {
	case _, open := <-r.Events():
		if !open {
			t.Fatal("Stop closed the drainable event stream")
		}
	default:
	}
}

func TestRetentionIdleLoopWaitsForItsOwnWakeup(t *testing.T) {
	db := retentionEmptyStore(t)
	d := retentionDeliveryFixture()
	calls := 0
	db.writeHistory = func(_ context.Context, fn func(store.WebhookRetentionScope) error) (store.Completion, error) {
		calls++
		if calls == 2 {
			scope := retentionCandidateScope(t, "payload", d)
			scope.payload = func(context.Context, string, time.Time) (int, error) { return 1, nil }
			return retentionCallback(fn, scope)
		}
		return retentionCallback(fn, retentionEmptyScope(t))
	}
	waits, permit := make(chan time.Duration, 2), make(chan struct{})
	r := NewRetention(db)
	r.wait = func(ctx context.Context, delay time.Duration) bool {
		select {
		case waits <- delay:
		case <-ctx.Done():
			return false
		}
		select {
		case <-permit:
			return true
		case <-ctx.Done():
			return false
		}
	}
	root, cancel := context.WithCancel(context.Background())
	retentionFail(t, r.Start(root))
	defer func() {
		cancel()
		ctx, stop := context.WithTimeout(context.Background(), time.Second)
		defer stop()
		if err := r.Stop(ctx); err != nil {
			t.Error(err)
		}
	}()
	select {
	case delay := <-waits:
		if delay != time.Minute || r.Observation().ConfirmedRows != 0 {
			t.Fatalf("idle delay=%v observation=%+v", delay, r.Observation())
		}
	case <-time.After(time.Second):
		t.Fatal("idle boundary absent")
	}
	permit <- struct{}{}
	select {
	case delay := <-waits:
		if delay != time.Minute || r.Observation().HistoryRows != 1 {
			t.Fatalf("next idle pass=%v observation=%+v", delay, r.Observation())
		}
	case err := <-r.Failures():
		t.Fatal(err)
	case <-time.After(time.Second):
		t.Fatal("controlled idle wakeup absent")
	}
}
