package webhook

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
)

type deliverySenderScript struct {
	t    testing.TB
	send func(context.Context, string, []byte, http.Header) (httpoutbound.Response, error)
}

func (s deliverySenderScript) Do(ctx context.Context, target string, body []byte, headers http.Header) (httpoutbound.Response, error) {
	if s.send == nil {
		s.t.Errorf("unexpected outbound delivery")
		panic("unexpected outbound delivery")
	}
	return s.send(ctx, target, body, headers)
}

func TestWorkerOnlyDispatchesCommittedTransactions(t *testing.T) {
	for _, phase := range []string{"success", "claim unknown", "admission unknown", "dispatch clock unknown", "finalize unknown", "admission failure", "finalize failure", "invalid status"} {
		t.Run(phase, func(t *testing.T) {
			runner, admission, now := admissionFixture(t)
			claimed := admission.d
			failure := errors.New("definite storage failure")
			lost := errors.New("commit reply lost")
			var transactions, sends int
			var attemptUpdates, deliveryUpdates []any
			var output bytes.Buffer
			runner.Logger = slog.New(slog.NewJSONHandler(&output, nil))
			claim := &deliveryScopeScript{deliveryUnexpectedScope: deliveryUnexpectedScope{t: t}}
			claim.observedAt = func(context.Context) (time.Time, error) { return now, nil }
			claim.claim = func(_ context.Context, n int, at time.Time, tokens []string) ([]store.WebhookDelivery, error) {
				if n != 1 || len(tokens) != 1 || tokens[0] == "" || !at.Equal(now) {
					t.Fatal("claim requested an invalid lease")
				}
				claimed.LeaseToken = &tokens[0]
				admission.d = claimed
				return []store.WebhookDelivery{claimed}, nil
			}
			final := &deliveryScopeScript{deliveryUnexpectedScope: deliveryUnexpectedScope{t: t}}
			final.tryLockDelivery = func(_ context.Context, id string) (store.WebhookDelivery, bool, error) {
				if id != claimed.ID {
					t.Fatal("finalize wrong delivery")
				}
				return admission.updated, true, nil
			}
			final.lockAttempts = func(_ context.Context, id string) ([]store.WebhookAttempt, error) {
				if id != claimed.ID || len(admission.a) != 1 {
					t.Fatal("missing committed attempt")
				}
				return admission.a, nil
			}
			final.lockWait = func(context.Context, string, int64) (store.WebhookEndpointWait, error) {
				return store.WebhookEndpointWait{Owner: claimed.Owner}, nil
			}
			final.observedAt = func(context.Context) (time.Time, error) { return now.Add(time.Second), nil }
			final.updateAttempt = func(_ context.Context, a store.WebhookAttempt) error {
				attemptUpdates = append(attemptUpdates, a)
				if phase == "finalize failure" {
					return failure
				}
				return nil
			}
			if phase == "invalid status" {
				final.nextQueueOrder = func(context.Context) (int64, error) { return 77, nil }
			}
			final.updateDelivery = func(_ context.Context, d store.WebhookDelivery) error {
				deliveryUpdates = append(deliveryUpdates, d)
				return nil
			}
			dispatch := &deliveryScopeScript{deliveryUnexpectedScope: deliveryUnexpectedScope{t: t}, observedAt: func(context.Context) (time.Time, error) { return now, nil }}
			runner.DB = deliveryTransactionScript{t: t, write: func(ctx context.Context, f func(store.WebhookDeliveryScope) error) (store.Completion, error) {
				transactions++
				var sc store.WebhookDeliveryScope
				switch transactions {
				case 1:
					sc = claim
				case 2:
					if phase == "claim unknown" {
						return store.Completion{Outcome: store.TransactionNotCommitted}, failure
					}
					sc = admission
				case 3:
					if phase == "admission unknown" {
						return store.Completion{Outcome: store.TransactionNotCommitted}, failure
					}
					sc = dispatch
				case 4:
					if phase == "dispatch clock unknown" {
						return store.Completion{Outcome: store.TransactionNotCommitted}, failure
					}
					sc = final
				case 5:
					return store.Completion{Outcome: store.TransactionNotCommitted}, failure
				default:
					t.Errorf("unexpected transaction %d", transactions)
					return store.Completion{Outcome: store.TransactionNotCommitted}, failure
				}
				if phase == "admission failure" && transactions == 2 {
					admission.insertError = failure
				}
				err := f(sc)
				if err != nil {
					return store.Completion{Outcome: store.TransactionNotCommitted}, err
				}
				unknown := (phase == "claim unknown" && transactions == 1) || (phase == "admission unknown" && transactions == 2) || (phase == "dispatch clock unknown" && transactions == 3) || (phase == "finalize unknown" && transactions == 4)
				if unknown {
					return store.Completion{Outcome: store.TransactionUnknown}, lost
				}
				return store.Completion{Outcome: store.TransactionCommitted}, nil
			}}
			runner.client = deliverySenderScript{t: t, send: func(ctx context.Context, target string, body []byte, headers http.Header) (httpoutbound.Response, error) {
				sends++
				if transactions != 3 || ctx.Err() != nil || target != "https://example.com/hook" || !bytes.Equal(body, claimed.Body) || headers.Get("Webhook-Id") != claimed.EventID || headers.Get("Content-Type") != claimed.RequestMediaType || headers.Get("Webhook-Signature") == "" {
					t.Fatal("HTTP escaped before confirmed admission")
				}
				status := 202
				if phase == "invalid status" {
					status = 600
				}
				opaqueBody := bytes.Repeat([]byte("x"), httpoutbound.MaxResponseBytes)
				copy(opaqueBody, []byte("receiver-response-canary"))
				return httpoutbound.Response{Status: status, Body: opaqueBody, ReadError: true, Truncated: true}, nil
			}}
			runner.claimPollInterval = time.Millisecond
			ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
			defer cancel()
			err := runner.worker(ctx, ctx)
			if !errors.Is(err, failure) {
				t.Fatalf("definite failure lost: %v", err)
			}
			expectedSends := 0
			if phase == "success" || phase == "finalize unknown" || phase == "finalize failure" || phase == "invalid status" {
				expectedSends = 1
			}
			if sends != expectedSends {
				t.Fatalf("phase=%s HTTP=%d want=%d", phase, sends, expectedSends)
			}
			if (phase == "success" || phase == "invalid status") && (len(attemptUpdates) != 1 || len(deliveryUpdates) != 1) {
				t.Fatal("committed response not finalized")
			}
			if phase == "success" {
				seen := map[string]bool{}
				for _, line := range strings.Split(strings.TrimSpace(output.String()), "\n") {
					var entry map[string]any
					if err := json.Unmarshal([]byte(line), &entry); err != nil {
						t.Fatal(err)
					}
					logPhase, _ := entry["phase"].(string)
					if entry["event_id"] != claimed.EventID || entry["component"] != "webhook" || entry["operation_id"] != nil {
						t.Fatalf("uncorrelated log %v", entry)
					}
					if logPhase == "claim" || logPhase == "admitted" || logPhase == "http" {
						if entry["http_status"] != nil || entry["duration_ms"] != nil || entry["outcome"] != nil {
							t.Fatalf("fabricated observation %v", entry)
						}
					}
					if logPhase == "finalize" || logPhase == "finished" {
						duration, ok := entry["duration_ms"].(float64)
						if !ok || duration < 0 || entry["http_status"] != float64(202) || entry["outcome"] != "acknowledged" {
							t.Fatalf("missing observed values %v", entry)
						}
					}
					seen[logPhase] = true
				}
				for _, name := range []string{"claim", "admitted", "http", "finalize", "finished"} {
					if !seen[name] {
						t.Fatalf("missing log phase %s", name)
					}
				}
			}
			for _, record := range deliveryUpdates {
				d := record.(store.WebhookDelivery)
				if d.ID != claimed.ID || d.EventID != claimed.EventID || d.EndpointID != claimed.EndpointID || d.Owner != claimed.Owner || d.EventType != claimed.EventType || !d.OccurredAt.Equal(claimed.OccurredAt) || d.OriginalBodyBytes != claimed.OriginalBodyBytes || d.OriginalMatchCount != claimed.OriginalMatchCount || !bytes.Equal(d.Body, claimed.Body) || !bytes.Equal(d.BodySHA256, claimed.BodySHA256) || !bytes.Equal(d.OriginalMatchSHA256, claimed.OriginalMatchSHA256) || !bytes.Equal(d.DestinationConfiguration, claimed.DestinationConfiguration) || !bytes.Equal(d.DeterministicHeadersJSON, claimed.DeterministicHeadersJSON) {
					t.Fatal("finalization changed immutable capture data or persisted receiver body")
				}
			}
			encoded, err := json.Marshal([]any{attemptUpdates, deliveryUpdates})
			if err != nil {
				t.Fatal(err)
			}
			for _, private := range []string{"receiver-response-canary", "commit reply lost", "definite storage failure"} {
				if strings.Contains(string(encoded), private) || strings.Contains(output.String(), private) {
					t.Fatalf("private response/storage cause escaped: %s", private)
				}
			}
		})
	}
}

func TestDeliveryTransactionCompletionRetainsOutcomeAndCause(t *testing.T) {
	cause := errors.New("driver failure")
	for _, outcome := range []store.TransactionOutcome{store.TransactionCommitted, store.TransactionNotCommitted, store.TransactionUnknown} {
		for _, withError := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/%t", outcome, withError), func(t *testing.T) {
				var input error
				if withError {
					input = &store.TransactionError{Outcome: outcome, Phase: "commit", Cause: cause, CleanupFailed: true}
				}
				err := transactionError("test", store.Completion{Outcome: outcome}, input)
				if outcome == store.TransactionCommitted && !withError {
					if err != nil {
						t.Fatal(err)
					}
					return
				}
				if err == nil || withError && !errors.Is(err, cause) {
					t.Fatalf("outcome=%s error=%v", outcome, err)
				}
				if errors.Is(err, errDeliveryOutcomeUnknown) != (outcome == store.TransactionUnknown) {
					t.Fatal("durable outcome misclassified")
				}
			})
		}
	}
}

func TestRecoveryClosesCrashedAttemptAndPreservesBudget(t *testing.T) {
	r, admission, now := admissionFixture(t)
	p, err := r.admit(t.Context(), admission.d)
	if err != nil {
		t.Fatal(err)
	}
	expiredAt := now.Add(46 * time.Second)
	var attempts []store.WebhookAttempt
	var deliveries []store.WebhookDelivery
	var calls []string
	sc := &deliveryScopeScript{deliveryUnexpectedScope: deliveryUnexpectedScope{t: t}, maxCalls: map[string]int{"ObservedAt": 3}}
	sc.observedAt = func(context.Context) (time.Time, error) { calls = append(calls, "clock"); return expiredAt, nil }
	sc.lockExpired = func(_ context.Context, n int, at time.Time) ([]store.WebhookDelivery, error) {
		calls = append(calls, "expired")
		if n != 1 || !at.Equal(expiredAt) {
			t.Fatal("unbounded recovery")
		}
		return []store.WebhookDelivery{p.delivery}, nil
	}
	sc.lockAttempts = func(_ context.Context, id string) ([]store.WebhookAttempt, error) {
		calls = append(calls, "attempts")
		if id != p.delivery.ID {
			t.Fatal("wrong delivery attempts")
		}
		return []store.WebhookAttempt{p.attempt}, nil
	}
	sc.updateAttempt = func(_ context.Context, a store.WebhookAttempt) error {
		calls = append(calls, "attempt update")
		attempts = append(attempts, a)
		return nil
	}
	sc.lockWait = func(context.Context, string, int64) (store.WebhookEndpointWait, error) {
		calls = append(calls, "wait")
		return store.WebhookEndpointWait{Owner: p.delivery.Owner}, nil
	}
	sc.nextQueueOrder = func(context.Context) (int64, error) { calls = append(calls, "queue"); return 77, nil }
	sc.updateDelivery = func(_ context.Context, d store.WebhookDelivery) error {
		calls = append(calls, "delivery update")
		deliveries = append(deliveries, d)
		return nil
	}
	r.DB = deliveryCommitted(t, sc)
	if err := r.recoverExpired(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(attempts) != 1 || len(deliveries) != 1 {
		t.Fatalf("recovery attempts=%d deliveries=%d", len(attempts), len(deliveries))
	}
	a, d := attempts[0], deliveries[0]
	if a.ID != p.attempt.ID || a.Outcome == nil || *a.Outcome != "unknown" || a.RecoveredUnknownAt == nil || !a.RecoveredUnknownAt.Equal(expiredAt) || a.LateObservedAt != nil || d.Generation != 2 || d.State != "pending" || d.CurrentAttemptID != nil || d.LeaseToken != nil || d.AutomaticAttemptCount != 1 || d.AttemptSequence != 1 || d.QueueOrder != 77 || d.NextAttemptAt == nil || !d.NextAttemptAt.Equal(now.Add(time.Minute)) {
		t.Fatalf("recovery attempt=%+v delivery=%+v", a, d)
	}
	want := []string{"clock", "expired", "attempts", "clock", "attempt update", "wait", "clock", "queue", "delivery update"}
	if fmt.Sprint(calls) != fmt.Sprint(want) {
		t.Fatalf("recovery order=%v want=%v", calls, want)
	}
}

func TestRecoveryRereadsLeaseTimeAfterAttemptLock(t *testing.T) {
	r, s, now := admissionFixture(t)
	future := now.Add(45 * time.Second)
	s.d.LeaseUntil = &future
	clockCalls, writes := 0, 0
	sc := &deliveryScopeScript{deliveryUnexpectedScope: deliveryUnexpectedScope{t: t}, maxCalls: map[string]int{"ObservedAt": 2}}
	sc.observedAt = func(context.Context) (time.Time, error) {
		clockCalls++
		if clockCalls == 1 {
			return now, nil
		}
		return now.Add(time.Second), nil
	}
	sc.lockExpired = func(context.Context, int, time.Time) ([]store.WebhookDelivery, error) {
		return []store.WebhookDelivery{s.d}, nil
	}
	sc.lockAttempts = func(context.Context, string) ([]store.WebhookAttempt, error) { return nil, nil }
	sc.updateDelivery = func(context.Context, store.WebhookDelivery) error { writes++; return nil }
	r.DB = deliveryCommitted(t, sc)
	if err := r.recoverExpired(t.Context()); err != nil || writes != 0 || clockCalls != 2 {
		t.Fatalf("re-read lease: err=%v writes=%d clocks=%d", err, writes, clockCalls)
	}
}

func TestLateObservationDoesNotLockCurrentAttemptOrChangeNewLease(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	own := store.WebhookAttempt{ID: "old-attempt", DeliveryID: "delivery", LeaseToken: "old-lease", Generation: 1, RecoveredUnknownAt: &now}
	var calls []string
	var updated []store.WebhookAttempt
	sc := &deliveryScopeScript{deliveryUnexpectedScope: deliveryUnexpectedScope{t: t}, tryLockDelivery: func(context.Context, string) (store.WebhookDelivery, bool, error) {
		calls = append(calls, "try current delivery")
		return store.WebhookDelivery{}, false, nil
	}, lockOwnAttempt: func(_ context.Context, id string) (store.WebhookAttempt, error) {
		calls = append(calls, "own attempt")
		if id != own.ID {
			t.Fatal("locked newer attempt")
		}
		return own, nil
	}, observedAt: func(context.Context) (time.Time, error) { calls = append(calls, "clock"); return now, nil }, updateAttempt: func(_ context.Context, a store.WebhookAttempt) error {
		calls = append(calls, "late update")
		updated = append(updated, a)
		return nil
	}}
	runner := NewRunner(deliveryCommitted(t, sc), &Service{}, true)
	done, err := runner.finalizeOnce(t.Context(), own, now, time.Second, httpoutbound.Response{Status: 202}, nil)
	if err != nil || !done || len(updated) != 1 || updated[0].LateOutcome == nil || *updated[0].LateOutcome != "acknowledged" || fmt.Sprint(calls) != "[try current delivery own attempt clock late update]" {
		t.Fatalf("late=%v done=%v err=%v calls=%v", updated, done, err, calls)
	}
}

func TestRunnerConstructionAndPermanentFailureLifecycle(t *testing.T) {
	db := deliveryTransactionScript{t: t, write: func(context.Context, func(store.WebhookDeliveryScope) error) (store.Completion, error) {
		return store.Completion{Outcome: store.TransactionNotCommitted}, errors.New("permanent failure")
	}}
	runner := NewRunner(db, &Service{}, false)
	if runner.claimPollInterval != time.Second || runner.maintenancePollInterval != time.Second {
		t.Fatal("production polling defaults changed")
	}
	if err := runner.Stop(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := runner.Start(nil); err == nil {
		t.Fatal("nil context accepted")
	}
	if err := runner.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := runner.Start(t.Context()); err == nil {
		t.Fatal("second start accepted")
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	select {
	case err := <-runner.Failures():
		if !strings.Contains(err.Error(), "permanent failure") {
			t.Fatalf("failure=%v", err)
		}
	case <-ctx.Done():
		t.Fatal("permanent failure not reported")
	}
	if err := runner.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	passes := make(chan struct{}, 4)
	maintenanceDB := deliveryTransactionScript{t: t, write: func(ctx context.Context, callback func(store.WebhookDeliveryScope) error) (store.Completion, error) {
		if err := ctx.Err(); err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		now := time.Unix(100, 0).UTC()
		var calls []string
		scope := &deliveryScopeScript{deliveryUnexpectedScope: deliveryUnexpectedScope{t: t},
			observedAt: func(context.Context) (time.Time, error) {
				calls = append(calls, "clock")
				return now, nil
			},
			lockExpired: func(_ context.Context, limit int, at time.Time) ([]store.WebhookDelivery, error) {
				calls = append(calls, "recover")
				if limit != 1 || at != now {
					t.Errorf("maintenance recovery arguments: limit=%d at=%v", limit, at)
				}
				return nil, nil
			},
			lockDueExpiry: func(_ context.Context, limit int, at time.Time) ([]store.WebhookDelivery, error) {
				calls = append(calls, "expire")
				if limit != 1 || at != now {
					t.Errorf("maintenance expiry arguments: limit=%d at=%v", limit, at)
				}
				return nil, nil
			},
		}
		if err := callback(scope); err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		if fmt.Sprint(calls) != "[clock recover expire]" {
			t.Errorf("maintenance pass calls: %v", calls)
		}
		select {
		case passes <- struct{}{}:
		default:
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}}
	maintenance := NewRunner(maintenanceDB, &Service{}, false)
	maintenance.client = deliverySenderScript{t: t}
	maintenance.maintenancePollInterval = 5 * time.Millisecond
	if err := maintenance.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stop, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := maintenance.Stop(stop); err != nil {
			t.Error(err)
		}
	})
	observed, cancelObserved := context.WithTimeout(t.Context(), time.Second)
	defer cancelObserved()
	for range 2 {
		select {
		case <-passes:
		case err := <-maintenance.Failures():
			t.Fatalf("disabled maintenance failed: %v", err)
		case <-observed.Done():
			t.Fatal("disabled runner did not complete two maintenance passes")
		}
	}
	if err := maintenance.Stop(observed); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-maintenance.Failures():
		t.Fatalf("disabled runner used an unconfigured operation: %v", err)
	default:
	}
	for _, broken := range []func(*Runner){func(r *Runner) { r.DB = nil }, func(r *Runner) { r.service = nil }, func(r *Runner) { r.client = nil }} {
		r := NewRunner(db, &Service{}, true)
		broken(r)
		if err := r.Start(t.Context()); err == nil {
			t.Fatal("missing dependency accepted")
		}
	}
}

type deliveryRunnerContextKey struct{}

func TestRunnerInstancesStopAndContinueIndependently(t *testing.T) {
	deadline, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	enteredA, enteredB := make(chan struct{}, 32), make(chan struct{}, 32)
	continueB := make(chan struct{}, 1)
	db := deliveryTransactionScript{t: t, write: func(ctx context.Context, f func(store.WebhookDeliveryScope) error) (store.Completion, error) {
		if err := ctx.Err(); err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		id, _ := ctx.Value(deliveryRunnerContextKey{}).(string)
		if id != "A" && id != "B" {
			t.Errorf("unconfigured runtime context %q", id)
			panic("unconfigured runtime")
		}
		sc := &deliveryScopeScript{deliveryUnexpectedScope: deliveryUnexpectedScope{t: t}, observedAt: func(context.Context) (time.Time, error) { return time.Unix(100, 0), nil }, lockExpired: func(context.Context, int, time.Time) ([]store.WebhookDelivery, error) { return nil, nil }, lockDueExpiry: func(context.Context, int, time.Time) ([]store.WebhookDelivery, error) { return nil, nil }}
		sc.claim = func(ctx context.Context, n int, _ time.Time, tokens []string) ([]store.WebhookDelivery, error) {
			if n != 1 || len(tokens) != 1 || tokens[0] == "" {
				t.Error("invalid claim shape")
			}
			entered := enteredA
			if id == "B" {
				entered = enteredB
			}
			select {
			case entered <- struct{}{}:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			if id == "A" {
				<-ctx.Done()
				return nil, ctx.Err()
			}
			select {
			case <-continueB:
				return nil, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return deliveryCommitted(t, sc).WriteWebhookDelivery(ctx, f)
	}}
	a, b := NewRunner(db, &Service{}, true), NewRunner(db, &Service{}, true)
	a.claimPollInterval, b.claimPollInterval = time.Millisecond, time.Millisecond
	if err := a.Start(context.WithValue(deadline, deliveryRunnerContextKey{}, "A")); err != nil {
		t.Fatal(err)
	}
	if err := b.Start(context.WithValue(deadline, deliveryRunnerContextKey{}, "B")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stop, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := a.Stop(stop); err != nil {
			t.Error(err)
		}
		if err := b.Stop(stop); err != nil {
			t.Error(err)
		}
	})
	for _, channel := range []<-chan struct{}{enteredA, enteredB} {
		for i := 0; i < deliveryWorkers; i++ {
			select {
			case <-channel:
			case err := <-a.Failures():
				t.Fatal(err)
			case err := <-b.Failures():
				t.Fatal(err)
			case <-deadline.Done():
				t.Fatal("instances did not start independent claims")
			}
		}
	}
	if err := a.Stop(deadline); err != nil {
		t.Fatal(err)
	}
	continueB <- struct{}{}
	select {
	case <-enteredB:
	case err := <-b.Failures():
		t.Fatalf("second instance stopped: %v", err)
	case <-deadline.Done():
		t.Fatal("second instance did not resume polling")
	}
	if err := b.Stop(deadline); err != nil {
		t.Fatal(err)
	}
	for _, r := range []*Runner{a, b} {
		select {
		case err := <-r.Failures():
			t.Fatalf("normal instance stop failed: %v", err)
		default:
		}
	}
}

func TestRecoveryExpiredAdmittedDeliveryNeverSchedulesAgain(t *testing.T) {
	for _, closeFailure := range []bool{false, true} {
		t.Run(fmt.Sprint(closeFailure), func(t *testing.T) {
			r, admission, started := admissionFixture(t)
			prepared, err := r.admit(t.Context(), admission.d)
			if err != nil || prepared == nil {
				t.Fatalf("admitted fixture: %v", err)
			}
			expiredAt := prepared.delivery.ExpiresAt.Add(time.Second)
			cause := errors.New("expired delivery closure failed")
			var attemptWrites []store.WebhookAttempt
			var deliveryWrites []store.WebhookDelivery
			var order []string
			scope := &deliveryScopeScript{deliveryUnexpectedScope: deliveryUnexpectedScope{t: t}, maxCalls: map[string]int{"ObservedAt": 2}}
			scope.observedAt = func(context.Context) (time.Time, error) { return expiredAt, nil }
			scope.lockExpired = func(_ context.Context, limit int, at time.Time) ([]store.WebhookDelivery, error) {
				if limit != 1 || !at.Equal(expiredAt) {
					t.Fatal("recovery candidate scope")
				}
				return []store.WebhookDelivery{prepared.delivery}, nil
			}
			scope.lockAttempts = func(_ context.Context, id string) ([]store.WebhookAttempt, error) {
				if id != prepared.delivery.ID {
					t.Fatal("recovery attempt identity")
				}
				return []store.WebhookAttempt{prepared.attempt}, nil
			}
			scope.updateAttempt = func(_ context.Context, a store.WebhookAttempt) error {
				order = append(order, "attempt")
				attemptWrites = append(attemptWrites, a)
				return nil
			}
			scope.updateDelivery = func(_ context.Context, d store.WebhookDelivery) error {
				order = append(order, "delivery")
				deliveryWrites = append(deliveryWrites, d)
				if closeFailure {
					return cause
				}
				return nil
			}
			r.DB = deliveryCommitted(t, scope)
			err = r.recoverExpired(t.Context())
			if closeFailure {
				if !errors.Is(err, cause) {
					t.Fatalf("closure failure lost: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if len(attemptWrites) != 1 || len(deliveryWrites) != 1 || fmt.Sprint(order) != "[attempt delivery]" {
				t.Fatalf("expired recovery writes: attempts=%d deliveries=%d order=%v", len(attemptWrites), len(deliveryWrites), order)
			}
			a, d := attemptWrites[0], deliveryWrites[0]
			if a.ID != prepared.attempt.ID || a.Outcome == nil || *a.Outcome != "unknown" || a.FinishedAt == nil || !a.FinishedAt.Equal(expiredAt) || a.RecoveredUnknownAt == nil || !a.RecoveredUnknownAt.Equal(expiredAt) {
				t.Fatalf("crashed attempt not closed unknown: %+v", a)
			}
			if d.State != "failed" || d.Generation != prepared.delivery.Generation+1 || d.AutomaticOpen || d.LeaseToken != nil || d.LeaseUntil != nil || d.CurrentAttemptID != nil || d.NextAttemptAt != nil || d.TerminalAt == nil || !d.TerminalAt.Equal(expiredAt) || d.PreparationErrorCode == nil || *d.PreparationErrorCode != "expired" {
				t.Fatalf("expired delivery restarted: %+v", d)
			}
			if d.AutomaticAttemptCount != prepared.delivery.AutomaticAttemptCount || d.AttemptSequence != prepared.delivery.AttemptSequence || !d.ExpiresAt.Equal(started.Add(72*time.Hour)) {
				t.Fatal("recovery changed consumed budget or original deadline")
			}
		})
	}
}
