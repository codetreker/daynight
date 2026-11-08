package webhook

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
)

func TestAdmissionUsesCurrentClockAndSigningMaterial(t *testing.T) {
	r, s, now := admissionFixture(t)
	overlapUntil := now.Add(time.Second)
	overlap := wm.SigningKey{ID: "overlap", Slot: "overlap", Secret: make([]byte, 32), OverlapUntil: &overlapUntil}
	overlap.Secret[0] = 17
	s.s.SigningKeys = append(s.s.SigningKeys, overlap)
	script := &admissionFaultScope{admissionScope: s, clockTimes: []time.Time{now, now.Add(2 * time.Second), now.Add(3 * time.Second)}}
	r.DB = admissionFaultDB{scope: script}
	prepared, err := r.admit(t.Context(), s.d)
	if err != nil || prepared == nil {
		t.Fatalf("admission: %v", err)
	}
	if script.clockCalls != 3 || !prepared.attempt.AdmittedAt.Equal(now.Add(3*time.Second)) || !reflect.DeepEqual(prepared.attempt.SigningKeyIDs, []string{s.s.Endpoint.ActiveKeyID}) {
		t.Fatalf("fresh clock/key: %+v calls=%d", prepared.attempt, script.clockCalls)
	}
	ts := strconv.FormatInt(prepared.attempt.AdmittedAt.Unix(), 10)
	mac := hmac.New(sha256.New, s.s.SigningKeys[0].Secret)
	fmt.Fprintf(mac, "%s.%s.", prepared.delivery.EventID, ts)
	mac.Write(prepared.body)
	if prepared.headers.Get("Webhook-Timestamp") != ts || prepared.headers.Get("Webhook-Signature") != "v1,"+base64.StdEncoding.EncodeToString(mac.Sum(nil)) || prepared.headers.Get("Webhook-Id") != s.d.EventID || prepared.headers.Get("Content-Type") != s.d.RequestMediaType {
		t.Fatalf("headers: %v", prepared.headers)
	}
}

func TestAdmissionRechecksLeaseAndPayloadAfterWait(t *testing.T) {
	for _, boundary := range []string{"lease", "payload", "delivery"} {
		t.Run(boundary, func(t *testing.T) {
			r, s, now := admissionFixture(t)
			expiry := now.Add(time.Second)
			switch boundary {
			case "lease":
				s.d.LeaseUntil = &expiry
			case "payload":
				s.d.PayloadExpiresAt = expiry
			case "delivery":
				s.d.ExpiresAt = expiry
			}
			scope := &admissionFaultScope{admissionScope: s, clockTimes: []time.Time{now, now, now.Add(2 * time.Second)}}
			r.DB = admissionFaultDB{scope: scope}
			a, err := r.admit(t.Context(), s.d)
			if err != nil || a != nil || len(s.a) != 0 {
				t.Fatalf("expired admitted: %v %v", a, err)
			}
			if boundary == "lease" {
				if s.d.State != "leased" || scope.clockCalls != 3 {
					t.Fatal("expired lease changed state")
				}
			} else if s.updated.State != "failed" || s.updated.PreparationErrorCode == nil || *s.updated.PreparationErrorCode != "expired" {
				t.Fatalf("expired payload: %+v", s.d)
			}
		})
	}
}

func TestAdmissionMissingHistoryDistinguishesCleanupFromCorruption(t *testing.T) {
	for _, state := range []string{"purging", "new lease", "admitted", "pending", "missing delivery", "corrupt"} {
		t.Run(state, func(t *testing.T) {
			r, s, now := admissionFixture(t)
			claimed := s.d
			sc := &admissionFaultScope{admissionScope: s}
			s.sourceError = model.ErrNotFound
			switch state {
			case "purging":
				s.d.PurgingAt = &now
			case "new lease":
				token := "new"
				s.d.LeaseToken = &token
			case "admitted":
				id := "admitted"
				s.d.CurrentAttemptID = &id
			case "pending":
				s.d.State = "pending"
			case "missing delivery":
				sc.lockError = model.ErrNotFound
			}
			r.DB = admissionFaultDB{scope: sc}
			a, err := r.admit(t.Context(), claimed)
			shouldFail := state == "missing delivery" || state == "corrupt"
			if a != nil || (err != nil) != shouldFail || len(s.a) != 0 {
				t.Fatalf("cleanup=%s attempt=%v error=%v", state, a, err)
			}
			if shouldFail && !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("missing-row cause: %v", err)
			}
		})
	}
}

func TestAdmissionEligibilityUsesOriginalIdentityAndEpoch(t *testing.T) {
	for _, loss := range []string{"project", "task", "endpoint", "revision", "deleted", "epoch"} {
		t.Run(loss, func(t *testing.T) {
			r, s, now := admissionFixture(t)
			switch loss {
			case "project":
				s.s.ProjectEligible = false
			case "task":
				s.s.TaskPresent = false
			case "endpoint":
				s.s.EndpointPresent = false
			case "revision":
				s.s.Endpoint.DestinationRevision++
			case "deleted":
				s.s.Endpoint.DeletedAt = &now
			case "epoch":
				s.s.Matches[0].Continuous = false
			}
			a, err := r.admit(t.Context(), s.d)
			if err != nil || a != nil || len(s.a) != 0 || s.waitCalls != 0 || s.updated.State != "suppressed" || s.updated.PreparationErrorCode == nil || *s.updated.PreparationErrorCode != "eligibility_ended" {
				t.Fatalf("eligibility=%s attempt=%v error=%v delivery=%+v", loss, a, err, s.d)
			}
		})
	}
}

func TestAdmissionValidatesAllFrozenFormatAndKeyFields(t *testing.T) {
	for _, invalid := range []struct {
		name   string
		change func(*admissionScope)
	}{
		{"policy", func(s *admissionScope) { s.d.PolicyVersion = 2 }},
		{"adapter", func(s *admissionScope) { s.d.AdapterVersion = 2 }},
		{"kind", func(s *admissionScope) { s.d.DestinationKind = "queue" }},
		{"configuration", func(s *admissionScope) { s.d.ConfigurationSchemaVersion = 2 }},
		{"method", func(s *admissionScope) { s.d.RequestMethod = "PUT" }},
		{"media", func(s *admissionScope) { s.d.RequestMediaType = "application/json" }},
		{"headers", func(s *admissionScope) { s.d.DeterministicHeadersJSON = []byte("[1]") }},
		{"body length", func(s *admissionScope) { s.d.OriginalBodyBytes++ }},
		{"key ID", func(s *admissionScope) { s.s.SigningKeys[0].ID = "wrong" }},
		{"key size", func(s *admissionScope) { s.s.SigningKeys[0].Secret = []byte("short") }},
		{"revoked key", func(s *admissionScope) { s.s.SigningKeys[0].RevokedAt = &s.now }},
		{"sequence", func(s *admissionScope) { s.d.AttemptSequence = 13 }},
	} {
		t.Run(invalid.name, func(t *testing.T) {
			r, s, _ := admissionFixture(t)
			invalid.change(s)
			if a, err := r.admit(t.Context(), s.d); err == nil || a != nil || len(s.a) != 0 {
				t.Fatalf("damaged %s admitted: %v %v", invalid.name, a, err)
			}
		})
	}
}

func deliveryFinalizationFixture(t *testing.T) (*Runner, *deliveryScopeScript, store.WebhookAttempt, time.Time, *[]store.WebhookAttempt, *[]store.WebhookDelivery, *[]time.Time) {
	t.Helper()
	r, admission, now := admissionFixture(t)
	prepared, err := r.admit(t.Context(), admission.d)
	if err != nil || prepared == nil {
		t.Fatalf("fixture admission: %v", err)
	}
	d, own := prepared.delivery, prepared.attempt
	observed := now.Add(time.Second)
	attempts, deliveries, waits := []store.WebhookAttempt{}, []store.WebhookDelivery{}, []time.Time{}
	sc := &deliveryScopeScript{deliveryUnexpectedScope: deliveryUnexpectedScope{t: t}}
	sc.tryLockDelivery = func(_ context.Context, id string) (store.WebhookDelivery, bool, error) {
		if id != d.ID {
			t.Fatalf("delivery ID %q", id)
		}
		return d, true, nil
	}
	sc.lockAttempts = func(_ context.Context, id string) ([]store.WebhookAttempt, error) {
		if id != d.ID {
			t.Fatalf("attempt delivery %q", id)
		}
		return []store.WebhookAttempt{own}, nil
	}
	sc.lockWait = func(_ context.Context, id string, revision int64) (store.WebhookEndpointWait, error) {
		if id != d.EndpointID || revision != d.DestinationRevision {
			t.Fatal("wait identity")
		}
		return store.WebhookEndpointWait{Owner: d.Owner}, nil
	}
	sc.observedAt = func(context.Context) (time.Time, error) { return observed, nil }
	sc.updateAttempt = func(_ context.Context, a store.WebhookAttempt) error { attempts = append(attempts, a); return nil }
	sc.updateDelivery = func(_ context.Context, d store.WebhookDelivery) error { deliveries = append(deliveries, d); return nil }
	sc.raiseWait = func(_ context.Context, id string, revision int64, until, at time.Time) error {
		if id != d.EndpointID || revision != d.DestinationRevision || !at.Equal(observed) {
			t.Fatal("raise-wait arguments")
		}
		waits = append(waits, until)
		return nil
	}
	sc.nextQueueOrder = func(context.Context) (int64, error) { return 77, nil }
	r.DB = deliveryCommitted(t, sc)
	return r, sc, own, observed, &attempts, &deliveries, &waits
}

func TestFinalizationMapsResponseAndPreservesOriginalBudget(t *testing.T) {
	for _, response := range []struct {
		name           string
		value          httpoutbound.Response
		failure        error
		state, outcome string
		retry          bool
	}{
		{name: "acknowledged despite read error", value: httpoutbound.Response{Status: 202, ReadError: true, Body: []byte("private body")}, state: "delivered", outcome: "acknowledged"},
		{name: "server error", value: httpoutbound.Response{Status: 500}, state: "pending", outcome: "http_error"},
		{name: "retired", value: httpoutbound.Response{Status: 410}, state: "failed", outcome: "http_error"},
		{name: "rate limit", value: httpoutbound.Response{Status: 429, RetryAfter: "60"}, state: "pending", outcome: "http_error", retry: true},
		{name: "unavailable", value: httpoutbound.Response{Status: 503, RetryAfter: "60"}, state: "pending", outcome: "http_error", retry: true},
		{name: "invalid retry", value: httpoutbound.Response{Status: 503, RetryAfter: "not a date"}, state: "pending", outcome: "http_error"},
		{name: "transport", failure: errors.New("secret transport URL"), state: "pending", outcome: "unknown"},
		{name: "invalid status", value: httpoutbound.Response{Status: 600}, state: "pending", outcome: "transport_error"},
	} {
		t.Run(response.name, func(t *testing.T) {
			r, _, own, now, attempts, deliveries, waits := deliveryFinalizationFixture(t)
			done, err := r.finalizeOnce(t.Context(), own, now.Add(-time.Second), 35*time.Millisecond, response.value, response.failure)
			if err != nil || !done || len(*attempts) != 1 || len(*deliveries) != 1 {
				t.Fatalf("finalized done=%v err=%v attempts=%d deliveries=%d", done, err, len(*attempts), len(*deliveries))
			}
			a, d := (*attempts)[0], (*deliveries)[0]
			if a.Outcome == nil || *a.Outcome != response.outcome || a.DurationMS == nil || *a.DurationMS != 35 || a.FinishedAt == nil || !a.FinishedAt.Equal(now) || d.State != response.state || d.LeaseToken != nil || d.CurrentAttemptID != nil || d.AutomaticAttemptCount != 1 || d.AttemptSequence != 1 || !d.ExpiresAt.Equal(now.Add(72*time.Hour-time.Second)) {
				t.Fatalf("completion=%+v delivery=%+v", a, d)
			}
			if response.retry {
				if len(*waits) != 1 || !(*waits)[0].Equal(now.Add(time.Minute)) || d.NextAttemptAt == nil || d.NextAttemptAt.Before((*waits)[0]) {
					t.Fatal("receiver wait ignored")
				}
			} else if len(*waits) != 0 {
				t.Fatal("fabricated receiver wait")
			}
			if response.name == "invalid retry" && (a.RetryAfterDiagnosticCode == nil || *a.RetryAfterDiagnosticCode != "invalid_retry_after") {
				t.Fatal("invalid retry diagnostic absent")
			}
		})
	}
}

func TestFinalizationObsoleteWaitDoesNotRecreateDestination(t *testing.T) {
	for _, current := range []bool{false, true} {
		t.Run(fmt.Sprint(current), func(t *testing.T) {
			r, sc, own, now, attempts, deliveries, waits := deliveryFinalizationFixture(t)
			sc.lockWait = func(context.Context, string, int64) (store.WebhookEndpointWait, error) {
				return store.WebhookEndpointWait{}, model.ErrNotFound
			}
			sc.currentDestination = func(context.Context, string, int64) (bool, error) { return current, nil }
			done, err := r.finalizeOnce(t.Context(), own, now, time.Second, httpoutbound.Response{Status: 503, RetryAfter: "60"}, nil)
			if current {
				if err == nil || done || len(*attempts) != 0 || len(*deliveries) != 0 {
					t.Fatal("missing current wait accepted")
				}
				return
			}
			if err != nil || !done || len(*attempts) != 1 || len(*deliveries) != 1 || len(*waits) != 0 || (*deliveries)[0].State != "suppressed" || (*deliveries)[0].PreparationErrorCode == nil || *(*deliveries)[0].PreparationErrorCode != "destination_changed" {
				t.Fatalf("obsolete wait finalized done=%v err=%v", done, err)
			}
		})
	}
}

func TestFinalizationLateHistoryIsNeverRecreated(t *testing.T) {
	for _, state := range []string{"purged", "closed", "already observed", "different generation", "unrecovered", "recovered"} {
		t.Run(state, func(t *testing.T) {
			now := time.Unix(100, 0).UTC()
			own := store.WebhookAttempt{ID: "attempt", DeliveryID: "delivery", LeaseToken: "lease", Generation: 1}
			got := own
			var expectedErr error
			switch state {
			case "purged":
				expectedErr = model.ErrNotFound
			case "closed":
				got.RetentionClosedAt = &now
			case "already observed":
				got.LateObservedAt = &now
			case "different generation":
				got.Generation++
			case "recovered":
				got.RecoveredUnknownAt = &now
			}
			writes := []store.WebhookAttempt{}
			sc := &deliveryScopeScript{deliveryUnexpectedScope: deliveryUnexpectedScope{t: t}, tryLockDelivery: func(context.Context, string) (store.WebhookDelivery, bool, error) {
				return store.WebhookDelivery{}, false, nil
			}, lockOwnAttempt: func(_ context.Context, id string) (store.WebhookAttempt, error) {
				if id != own.ID {
					t.Fatal("own attempt ID")
				}
				return got, expectedErr
			}, observedAt: func(context.Context) (time.Time, error) { return now, nil }, updateAttempt: func(_ context.Context, a store.WebhookAttempt) error { writes = append(writes, a); return nil }}
			r := NewRunner(deliveryCommitted(t, sc), &Service{}, true)
			done, err := r.finalizeOnce(t.Context(), own, now, time.Second, httpoutbound.Response{Status: 202}, nil)
			if state == "different generation" {
				if err == nil {
					t.Fatal("late identity ignored")
				}
				return
			}
			if err != nil || done != (state != "unrecovered") {
				t.Fatalf("late state=%s done=%v error=%v", state, done, err)
			}
			if state == "recovered" {
				if len(writes) != 1 || writes[0].LateOutcome == nil || *writes[0].LateOutcome != "acknowledged" || writes[0].Outcome != nil {
					t.Fatal("late result overwrote original")
				}
			} else if len(writes) != 0 {
				t.Fatal("closed history rewritten")
			}
		})
	}
}

func TestFinalizationStorageErrorsPreserveCauseAndStopEffects(t *testing.T) {
	for _, phase := range []string{"delivery", "attempts", "wait", "clock", "attempt update", "delivery update", "wait update", "queue", "current revision"} {
		t.Run(phase, func(t *testing.T) {
			r, sc, own, now, attempts, deliveries, _ := deliveryFinalizationFixture(t)
			cause := errors.New("injected " + phase)
			switch phase {
			case "delivery":
				sc.tryLockDelivery = func(context.Context, string) (store.WebhookDelivery, bool, error) {
					return store.WebhookDelivery{}, false, cause
				}
			case "attempts":
				sc.lockAttempts = func(context.Context, string) ([]store.WebhookAttempt, error) { return nil, cause }
			case "wait":
				sc.lockWait = func(context.Context, string, int64) (store.WebhookEndpointWait, error) {
					return store.WebhookEndpointWait{}, cause
				}
			case "clock":
				sc.observedAt = func(context.Context) (time.Time, error) { return time.Time{}, cause }
			case "attempt update":
				sc.updateAttempt = func(context.Context, store.WebhookAttempt) error { return cause }
			case "delivery update":
				sc.updateDelivery = func(context.Context, store.WebhookDelivery) error { return cause }
			case "wait update":
				sc.raiseWait = func(context.Context, string, int64, time.Time, time.Time) error { return cause }
			case "queue":
				sc.nextQueueOrder = func(context.Context) (int64, error) { return 0, cause }
			case "current revision":
				sc.lockWait = func(context.Context, string, int64) (store.WebhookEndpointWait, error) {
					return store.WebhookEndpointWait{}, model.ErrNotFound
				}
				sc.currentDestination = func(context.Context, string, int64) (bool, error) { return false, cause }
			}
			done, err := r.finalizeOnce(t.Context(), own, now, time.Second, httpoutbound.Response{Status: 503, RetryAfter: "60"}, nil)
			if done || !errors.Is(err, cause) {
				t.Fatalf("cause lost done=%v error=%v", done, err)
			}
			if len(*deliveries) != 0 {
				t.Fatal("delivery effect after failure")
			}
			early := phase == "delivery" || phase == "attempts" || phase == "wait" || phase == "clock" || phase == "attempt update" || phase == "current revision"
			if early && len(*attempts) != 0 {
				t.Fatal("attempt effect after early failure")
			}
		})
	}
}

func TestAdmissionDeletionFactsRetainTheirOriginalAnchor(t *testing.T) {
	for _, eventType := range []string{protocol.Deleted, protocol.StepUpdated} {
		t.Run(eventType, func(t *testing.T) {
			r, s, now := admissionFixture(t)
			fact := protocol.Fact{Type: eventType, ProjectID: s.d.ProjectID, TaskID: "44444444-4444-4444-8444-444444444444", TaskVersion: 2, OccurredAt: now}
			if eventType == protocol.Deleted {
				fact.DeletedAt = &now
				s.s.TaskPresent = false
			} else {
				fact.StepID = "1234abcd"
				fact.Action = "deleted"
			}
			body, err := protocol.Render(s.d.EventID, fact)
			if err != nil {
				t.Fatal(err)
			}
			hash := sha256.Sum256(body)
			s.d.EventType, s.d.Body, s.d.BodySHA256, s.d.OriginalBodyBytes = eventType, body, hash[:], len(body)
			s.s.Event.EventType = eventType
			s.s.Matches[0].EventType = eventType
			s.d.OriginalMatchSHA256, err = MatchDigest([]store.WebhookCapturedMatch{s.s.Matches[0].WebhookCapturedMatch})
			if err != nil {
				t.Fatal(err)
			}
			a, err := r.admit(t.Context(), s.d)
			if err != nil || a == nil || !bytes.Equal(a.body, body) || a.delivery.EventType != eventType {
				t.Fatalf("deleted source anchor=%s attempt=%v error=%v", eventType, a, err)
			}
		})
	}
}

func TestAdmissionCurrentAndOverlapKeysKeepTheirOrder(t *testing.T) {
	r, s, now := admissionFixture(t)
	until := now.Add(time.Hour)
	overlap := wm.SigningKey{ID: "overlap", Slot: "overlap", Secret: make([]byte, 32), OverlapUntil: &until}
	overlap.Secret[0] = 71
	s.s.SigningKeys = []wm.SigningKey{overlap, s.s.SigningKeys[0]}
	a, err := r.admit(t.Context(), s.d)
	if err != nil || a == nil || !reflect.DeepEqual(a.attempt.SigningKeyIDs, []string{s.s.Endpoint.ActiveKeyID, "overlap"}) {
		t.Fatalf("key ordering=%v error=%v", a, err)
	}
	var signatures []string
	for _, key := range [][]byte{s.s.SigningKeys[1].Secret, overlap.Secret} {
		mac := hmac.New(sha256.New, key)
		fmt.Fprintf(mac, "%s.%s.", s.d.EventID, a.headers.Get("Webhook-Timestamp"))
		mac.Write(a.body)
		signatures = append(signatures, "v1,"+base64.StdEncoding.EncodeToString(mac.Sum(nil)))
	}
	if a.headers.Get("Webhook-Signature") != strings.Join(signatures, " ") {
		t.Fatal("current-overlap signatures not generated independently")
	}
}

func deliveryAdmissionScript(t *testing.T, s *admissionScope) *deliveryScopeScript {
	t.Helper()
	return &deliveryScopeScript{deliveryUnexpectedScope: deliveryUnexpectedScope{t: t}, maxCalls: map[string]int{"ObservedAt": 3}, observedAt: s.ObservedAt, admissionSources: s.AdmissionSources, lockDelivery: s.LockDelivery, lockAttempts: s.LockAttempts, lockWait: s.LockWait, insertAttempt: s.InsertAttempt, updateDelivery: s.UpdateDelivery}
}

func TestAdmissionTerminalBudgetAndCurrentWait(t *testing.T) {
	for _, caseName := range []string{"wait owner", "wait beyond deadline", "closed automatic plan", "prior acknowledgement"} {
		t.Run(caseName, func(t *testing.T) {
			r, s, now := admissionFixture(t)
			sc := deliveryAdmissionScript(t, s)
			switch caseName {
			case "wait owner":
				sc.lockWait = func(context.Context, string, int64) (store.WebhookEndpointWait, error) {
					return store.WebhookEndpointWait{Owner: wm.Owner{Kind: "personal", ID: "different-owner"}}, nil
				}
			case "wait beyond deadline":
				wait := s.d.ExpiresAt.Add(time.Second)
				s.waitUntil = &wait
			case "closed automatic plan":
				s.d.AutomaticOpen = false
			case "prior acknowledgement":
				ack := "acknowledged"
				s.existingAttempts = []store.WebhookAttempt{{Outcome: &ack}}
			}
			r.DB = deliveryCommitted(t, sc)
			a, err := r.admit(t.Context(), s.d)
			if caseName == "wait owner" {
				if err == nil || a != nil || len(s.a) != 0 || len(s.updates) != 0 {
					t.Fatal("wait integrity accepted")
				}
				return
			}
			if err != nil || a != nil || len(s.a) != 0 || len(s.updates) != 1 {
				t.Fatalf("terminal=%s attempt=%v error=%v", caseName, a, err)
			}
			state, code := "failed", "automatic_exhausted"
			if caseName == "wait beyond deadline" {
				code = "expired"
			}
			if caseName == "prior acknowledgement" {
				state, code = "delivered", ""
			}
			if s.updated.State != state || s.updated.AutomaticOpen || s.updated.LeaseToken != nil || s.updated.NextAttemptAt != nil || s.updated.TerminalAt == nil || !s.updated.TerminalAt.Equal(now) {
				t.Fatalf("terminal delivery=%+v", s.updated)
			}
			if code == "" {
				if s.updated.PreparationErrorCode != nil {
					t.Fatal("acknowledgement retained failure")
				}
			} else if s.updated.PreparationErrorCode == nil || *s.updated.PreparationErrorCode != code {
				t.Fatal("terminal code lost")
			}
		})
	}
}

func TestAdmissionStorageFailureKeepsOriginalCause(t *testing.T) {
	for _, phase := range []string{"initial clock", "source", "delivery lock", "attempt history", "clock after lock", "wait", "clock after wait", "attempt insert", "delivery update"} {
		t.Run(phase, func(t *testing.T) {
			r, s, _ := admissionFixture(t)
			cause := errors.New("storage cause")
			sc := &admissionFaultScope{admissionScope: s, clockError: cause}
			switch phase {
			case "initial clock":
				sc.clockFailure = 1
			case "source":
				s.sourceError = cause
			case "delivery lock":
				sc.lockError = cause
			case "attempt history":
				sc.attemptError = cause
			case "clock after lock":
				sc.clockFailure = 2
			case "wait":
				s.waitError = cause
			case "clock after wait":
				sc.clockFailure = 3
			case "attempt insert":
				s.insertError = cause
			case "delivery update":
				s.updateError = cause
			}
			r.DB = admissionFaultDB{scope: sc}
			a, err := r.admit(t.Context(), s.d)
			if a != nil || !errors.Is(err, cause) {
				t.Fatalf("admission phase=%s result=%v error=%v", phase, a, err)
			}
			if phase != "delivery update" && len(s.updates) != 0 {
				t.Fatal("effect followed storage error")
			}
		})
	}
}

func TestAdmissionKeepsAllOriginalProofWhenOneMatchEnds(t *testing.T) {
	r, s, _ := admissionFixture(t)
	original := s.s.Matches[0]
	original.Continuous = false
	active := s.s.Matches[0]
	active.SubscriptionID = "99999999-9999-4999-8999-999999999999"
	active.BindingID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	s.s.Matches = []store.WebhookAdmissionMatch{original, active}
	s.d.OriginalMatchCount = 2
	digest, err := MatchDigest([]store.WebhookCapturedMatch{original.WebhookCapturedMatch, active.WebhookCapturedMatch})
	if err != nil {
		t.Fatal(err)
	}
	s.d.OriginalMatchSHA256 = digest
	a, err := r.admit(t.Context(), s.d)
	if err != nil || a == nil || a.delivery.OriginalMatchCount != 2 || !bytes.Equal(a.delivery.OriginalMatchSHA256, digest) || !bytes.Equal(a.body, s.d.Body) {
		t.Fatalf("remaining original proof=%v error=%v", a, err)
	}
}
