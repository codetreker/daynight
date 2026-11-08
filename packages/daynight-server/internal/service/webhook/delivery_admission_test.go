package webhook

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

type admissionScope struct {
	store.WebhookDeliveryScope
	d           store.WebhookDelivery
	s           store.WebhookAdmissionSources
	a           []store.WebhookAttempt
	insertError error
	sourceError error
	waitError   error
	waitCalls   int
	now         time.Time
	waitUntil   *time.Time
}

func (s *admissionScope) ObservedAt(context.Context) (time.Time, error) { return s.now, nil }

func (s *admissionScope) AdmissionSources(context.Context, string, time.Time) (store.WebhookAdmissionSources, error) {
	return s.s, s.sourceError
}
func (s *admissionScope) LockDelivery(context.Context, string) (store.WebhookDelivery, error) {
	return s.d, nil
}
func (s *admissionScope) LockAttempts(context.Context, string) ([]store.WebhookAttempt, error) {
	return s.a, nil
}
func (s *admissionScope) LockWait(context.Context, string, int64) (store.WebhookEndpointWait, error) {
	s.waitCalls++
	return store.WebhookEndpointWait{Owner: s.d.Owner, NotBefore: s.waitUntil}, s.waitError
}
func (s *admissionScope) InsertAttempt(_ context.Context, a store.WebhookAttempt) error {
	if s.insertError != nil {
		return s.insertError
	}
	s.a = append(s.a, a)
	return nil
}
func (s *admissionScope) UpdateDelivery(_ context.Context, d store.WebhookDelivery) error {
	s.d = d
	return nil
}

type admissionDB struct {
	scope   *admissionScope
	outcome store.TransactionOutcome
}

func (d admissionDB) WriteWebhookDelivery(_ context.Context, fn func(store.WebhookDeliveryScope) error) (store.Completion, error) {
	err := fn(d.scope)
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: d.outcome}, nil
}
func admissionFixture(t *testing.T) (*Runner, *admissionScope, time.Time) {
	t.Helper()
	now := time.Unix(1793952005, 0).UTC()
	body, err := os.ReadFile("../../core/webhook/protocol/testdata/event.json")
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{}
	owner := wm.Owner{Kind: "personal", ID: "11111111-1111-4111-8111-111111111111"}
	ep := wm.Endpoint{ID: "22222222-2222-4222-8222-222222222222", Owner: owner, Enabled: true, DestinationRevision: 1, ActiveKeyID: "33333333-3333-4333-8333-333333333333"}
	destination, err := encodeDestination(Destination{Kind: "http", AdapterVersion: "1", URL: "https://example.com/hook"})
	if err != nil {
		t.Fatal(err)
	}
	target, key := destination, make([]byte, 32)
	match := store.WebhookCapturedMatch{SubscriptionID: "55555555-5555-4555-8555-555555555555", BindingID: "66666666-6666-4666-8666-666666666666", ProjectID: "77777777-7777-4777-8777-777777777777", EventType: "task.paused", AuthorizationEpoch: 1}
	digest, err := MatchDigest([]store.WebhookCapturedMatch{match})
	if err != nil {
		t.Fatal(err)
	}
	bodyHash := sha256.Sum256(body)
	token := "88888888-8888-4888-8888-888888888888"
	generation := int64(1)
	until := now.Add(45 * time.Second)
	schedule := make([]time.Time, 10)
	for i := range schedule {
		schedule[i] = now.Add(time.Duration(i) * time.Minute)
	}
	d := store.WebhookDelivery{ID: "44444444-4444-4444-8444-444444444444", EventID: "a0be4d96-fb33-41ba-a7bd-7885c1e94247", EndpointID: ep.ID, Owner: owner, EventType: match.EventType, ProjectID: match.ProjectID, OccurredAt: now, OriginalMatchCount: 1, OriginalMatchSHA256: digest, PolicyVersion: 1, DestinationRevision: 1, DestinationKind: "http", AdapterVersion: 1, RenderVersion: 1, ConfigurationSchemaVersion: 1, DestinationConfiguration: target, DestinationOrigin: "https://example.com", RequestMethod: "POST", RequestMediaType: "application/cloudevents+json", DeterministicHeadersJSON: []byte("[]"), Body: body, OriginalBodyBytes: len(body), BodySHA256: bodyHash[:], AutomaticScheduleAt: schedule, AutomaticExpiresAt: now.Add(72 * time.Hour), PayloadExpiresAt: now.Add(168 * time.Hour), AutomaticOpen: true, Generation: generation, State: "leased", Trigger: "automatic", ExpiresAt: now.Add(72 * time.Hour), LeaseToken: &token, LeaseClaimedAt: &now, LeaseUntil: &until, LeaseGeneration: &generation}
	scope := &admissionScope{d: d, now: now, s: store.WebhookAdmissionSources{Event: store.WebhookCapturedEvent{ID: d.EventID, ProjectID: d.ProjectID, EventType: d.EventType, OccurredAt: now}, Endpoint: ep, SigningKeys: []wm.SigningKey{{ID: ep.ActiveKeyID, EndpointID: ep.ID, Slot: "current", Secret: key}}, Matches: []store.WebhookAdmissionMatch{{WebhookCapturedMatch: match, Continuous: true}}, TaskPresent: true, ProjectEligible: true, EndpointPresent: true}}
	r := NewRunner(admissionDB{scope: scope, outcome: store.TransactionCommitted}, service, true)
	return r, scope, now
}
func TestAdmissionRequiresConfirmedCommit(t *testing.T) {
	r, s, _ := admissionFixture(t)
	r.DB = admissionDB{scope: s, outcome: store.TransactionUnknown}
	attempt, err := r.admit(context.Background(), s.d)
	if err == nil || attempt != nil || len(s.a) != 1 {
		t.Fatalf("unknown admission yielded dispatch: attempt=%v err=%v saved=%d", attempt, err, len(s.a))
	}
}
func TestAdmissionFailureAndOriginalContinuity(t *testing.T) {
	r, s, _ := admissionFixture(t)
	s.insertError = errors.New("insert failed")
	if attempt, err := r.admit(context.Background(), s.d); err == nil || attempt != nil || s.d.AutomaticAttemptCount != 0 || len(s.a) != 0 {
		t.Fatalf("failed insert admitted: %v %v", attempt, err)
	}
	s.insertError = nil
	s.s.Matches[0].Continuous = false
	if attempt, err := r.admit(context.Background(), s.d); err != nil || attempt != nil || s.d.State != "suppressed" || len(s.a) != 0 {
		t.Fatalf("lost proof: %v %v %s", attempt, err, s.d.State)
	}
}
func TestAdmissionRejectsCorruptProof(t *testing.T) {
	for _, corrupt := range []func(*admissionScope){
		func(s *admissionScope) { s.s.Matches[0].AuthorizationEpoch++ },
		func(s *admissionScope) { s.s.Endpoint.Owner.ID = "99999999-9999-4999-8999-999999999999" },
		func(s *admissionScope) { s.s.Event.ProjectID = "99999999-9999-4999-8999-999999999999" },
	} {
		r, s, _ := admissionFixture(t)
		corrupt(s)
		if attempt, err := r.admit(context.Background(), s.d); err == nil || attempt != nil || len(s.a) != 0 {
			t.Fatalf("corruption admitted: %v %v", attempt, err)
		}
	}
}

func TestAdmissionOnlyRequiresCurrentDestinationWait(t *testing.T) {
	r, s, _ := admissionFixture(t)
	s.waitError = errors.New("wait row missing")
	s.s.Endpoint.DestinationRevision++
	if a, err := r.admit(context.Background(), s.d); err != nil || a != nil || s.d.State != "suppressed" || s.waitCalls != 0 {
		t.Fatalf("old destination: attempt=%v err=%v state=%s waits=%d", a, err, s.d.State, s.waitCalls)
	}
	r, s, _ = admissionFixture(t)
	s.waitError = errors.New("wait row missing")
	if a, err := r.admit(context.Background(), s.d); err == nil || a != nil || s.waitCalls != 1 {
		t.Fatalf("current destination: attempt=%v err=%v waits=%d", a, err, s.waitCalls)
	}
}

func TestAdmissionDoesNotConfuseInternalFailureWithRevocation(t *testing.T) {
	r, s, _ := admissionFixture(t)
	s.sourceError = errors.New("permission query unavailable")
	if a, err := r.admit(context.Background(), s.d); err == nil || a != nil || s.d.State != "leased" || len(s.a) != 0 {
		t.Fatalf("permission failure: %v %v %s", a, err, s.d.State)
	}
	r, s, _ = admissionFixture(t)
	s.s.SigningKeys[0].Secret = nil
	if a, err := r.admit(context.Background(), s.d); err == nil || a != nil || s.d.State != "leased" || len(s.a) != 0 {
		t.Fatalf("missing key: %v %v %s", a, err, s.d.State)
	}
}

func TestAdmissionSkipsExpiredClaimBeforeReadingSources(t *testing.T) {
	r, s, now := admissionFixture(t)
	until := now.Add(-time.Second)
	claim := s.d
	claim.LeaseUntil = &until
	s.sourceError = errors.New("source temporarily unavailable")
	if a, err := r.admit(context.Background(), claim); err != nil || a != nil || len(s.a) != 0 {
		t.Fatalf("expired claimant read sources: %v %v", a, err)
	}
}

func TestAdmissionOldTokenAndBudget(t *testing.T) {
	r, s, now := admissionFixture(t)
	claim := s.d
	newToken := "99999999-9999-4999-8999-999999999999"
	s.d.LeaseToken = &newToken
	if a, err := r.admit(context.Background(), claim); err != nil || a != nil || len(s.a) != 0 {
		t.Fatalf("stale token admitted: %v %v", a, err)
	}
	r, s, now = admissionFixture(t)
	s.d.AutomaticAttemptCount = 10
	if a, err := r.admit(context.Background(), s.d); err != nil || a != nil || s.d.State != "failed" || len(s.a) != 0 {
		t.Fatalf("eleventh attempt: %v %v %s", a, err, s.d.State)
	}
	r, s, now = admissionFixture(t)
	deadline := now.Add(-time.Microsecond)
	s.d.ExpiresAt = deadline
	if a, err := r.admit(context.Background(), s.d); err != nil || a != nil || s.d.State != "failed" || len(s.a) != 0 {
		t.Fatalf("expired budget: %v %v %s", a, err, s.d.State)
	}
}

func TestAdmissionPausedAndWaitDoNotConsumeAttempts(t *testing.T) {
	for _, useWait := range []bool{false, true} {
		r, s, now := admissionFixture(t)
		if useWait {
			until := now.Add(30 * time.Second)
			s.waitUntil = &until
		} else {
			s.s.Endpoint.Enabled = false
		}
		if a, err := r.admit(context.Background(), s.d); err != nil || a != nil || s.d.State != "pending" || s.d.AutomaticAttemptCount != 0 || s.d.AutomaticPlanCursor != 0 || len(s.a) != 0 {
			t.Fatalf("pause=%v: %v %v %s", useWait, a, err, s.d.State)
		}
		if s.d.NextAttemptAt == nil || s.d.NextAttemptAt.Before(now.Add(5*time.Second)) || !s.d.ExpiresAt.Equal(now.Add(72*time.Hour)) {
			t.Fatalf("pause moved deadline: %+v", s.d)
		}
	}
}

func TestAdmissionAfterPauseUsesOneMissedOpportunity(t *testing.T) {
	r, s, now := admissionFixture(t)
	s.s.Endpoint.Enabled = false
	if a, err := r.admit(context.Background(), s.d); err != nil || a != nil {
		t.Fatalf("pause: %v %v", a, err)
	}
	s.now = now.Add(7 * time.Minute)
	s.s.Endpoint.Enabled = true
	token := "99999999-9999-4999-8999-999999999999"
	until := s.now.Add(45 * time.Second)
	generation := s.d.Generation
	s.d.State, s.d.LeaseToken, s.d.LeaseClaimedAt, s.d.LeaseUntil, s.d.LeaseGeneration = "leased", &token, &s.now, &until, &generation
	a, err := r.admit(context.Background(), s.d)
	if err != nil || a == nil || len(s.a) != 1 || s.d.AutomaticAttemptCount != 1 || s.d.AutomaticPlanCursor != 8 || a.attempt.AutomaticPlanSlot == nil || *a.attempt.AutomaticPlanSlot != 8 {
		t.Fatalf("resumed backlog: attempt=%v err=%v count=%d cursor=%d", a, err, len(s.a), s.d.AutomaticPlanCursor)
	}
}

func TestAdmissionRejectsUnsupportedAndDamagedPayloads(t *testing.T) {
	for _, damage := range []func(*admissionScope){
		func(s *admissionScope) { s.d.RenderVersion = 2 },
		func(s *admissionScope) { s.d.Body = append([]byte(nil), s.d.Body...); s.d.Body[0] ^= 1 },
		func(s *admissionScope) { s.d.DestinationConfiguration = []byte("invalid destination configuration") },
		func(s *admissionScope) { s.s.SigningKeys = nil },
	} {
		r, s, _ := admissionFixture(t)
		damage(s)
		if a, err := r.admit(context.Background(), s.d); err == nil || a != nil || len(s.a) != 0 {
			t.Fatalf("invalid material admitted: %v %v", a, err)
		}
	}
}

func TestAdmissionManualIntentPreservesAutomaticBudget(t *testing.T) {
	r, s, _ := admissionFixture(t)
	op := "99999999-9999-4999-8999-999999999999"
	s.d.Trigger, s.d.ManualOperationID = "manual", &op
	s.d.AutomaticAttemptCount, s.d.ManualOperationCount = 3, 1
	a, err := r.admit(context.Background(), s.d)
	if err != nil || a == nil || a.attempt.ManualOperationID == nil || *a.attempt.ManualOperationID != op || a.attempt.AutomaticPlanSlot != nil || s.d.AutomaticAttemptCount != 3 || s.d.ManualOperationCount != 1 {
		t.Fatalf("manual admission: %v %v", a, err)
	}
	r, s, _ = admissionFixture(t)
	s.d.Trigger = "manual"
	if a, err := r.admit(context.Background(), s.d); err == nil || a != nil || len(s.a) != 0 {
		t.Fatalf("missing manual identity: %v %v", a, err)
	}
}

type admissionFaultScope struct {
	*admissionScope
	clockCalls   int
	clockTimes   []time.Time
	clockFailure int
	lockError    error
	attemptError error
}

func (s *admissionFaultScope) ObservedAt(context.Context) (time.Time, error) {
	s.clockCalls++
	if s.clockCalls == s.clockFailure {
		return time.Time{}, errors.New("database clock unavailable")
	}
	if len(s.clockTimes) >= s.clockCalls {
		return s.clockTimes[s.clockCalls-1], nil
	}
	return s.now, nil
}
func (s *admissionFaultScope) LockDelivery(context.Context, string) (store.WebhookDelivery, error) {
	return s.d, s.lockError
}
func (s *admissionFaultScope) LockAttempts(context.Context, string) ([]store.WebhookAttempt, error) {
	return s.a, s.attemptError
}

type admissionFaultDB struct{ scope store.WebhookDeliveryScope }

func (db admissionFaultDB) WriteWebhookDelivery(_ context.Context, fn func(store.WebhookDeliveryScope) error) (store.Completion, error) {
	err := fn(db.scope)
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func TestAdmissionFailsClosedOnStorageErrors(t *testing.T) {
	for _, fault := range []struct {
		name      string
		configure func(*admissionFaultScope)
	}{
		{"clock", func(s *admissionFaultScope) { s.clockFailure = 1 }},
		{"delivery lock", func(s *admissionFaultScope) { s.lockError = errors.New("delivery lock unavailable") }},
		{"attempt history", func(s *admissionFaultScope) { s.attemptError = errors.New("attempt history unavailable") }},
		{"clock after source locks", func(s *admissionFaultScope) { s.clockFailure = 2 }},
		{"clock after wait lock", func(s *admissionFaultScope) { s.clockFailure = 3 }},
		{"source reconciliation lock", func(s *admissionFaultScope) {
			s.sourceError = model.ErrNotFound
			s.lockError = errors.New("delivery lock unavailable")
		}},
		{"source reconciliation clock", func(s *admissionFaultScope) { s.sourceError = model.ErrNotFound; s.clockFailure = 2 }},
		{"missing delivery reconciliation clock", func(s *admissionFaultScope) {
			s.sourceError = model.ErrNotFound
			s.lockError = model.ErrNotFound
			s.clockFailure = 2
		}},
		{"delivery removed after source read", func(s *admissionFaultScope) { s.lockError = model.ErrNotFound; s.clockFailure = 2 }},
	} {
		t.Run(fault.name, func(t *testing.T) {
			r, base, _ := admissionFixture(t)
			scope := &admissionFaultScope{admissionScope: base}
			fault.configure(scope)
			r.DB = admissionFaultDB{scope: scope}
			if attempt, err := r.admit(context.Background(), base.d); err == nil || attempt != nil || len(base.a) != 0 {
				t.Fatalf("storage failure admitted: %v %v", attempt, err)
			}
		})
	}
}

func TestAdmissionLeaseCanExpireWhileReconcilingMissingRows(t *testing.T) {
	for _, sourceMissing := range []bool{false, true} {
		r, base, now := admissionFixture(t)
		scope := &admissionFaultScope{admissionScope: base, lockError: model.ErrNotFound, clockTimes: []time.Time{now, now.Add(time.Minute)}}
		if sourceMissing {
			scope.sourceError = model.ErrNotFound
		}
		r.DB = admissionFaultDB{scope: scope}
		if attempt, err := r.admit(context.Background(), base.d); err != nil || attempt != nil || len(base.a) != 0 {
			t.Fatalf("expired while reconciling sourceMissing=%t: %v %v", sourceMissing, attempt, err)
		}
	}
}
