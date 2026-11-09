package webhook

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
)

type deliveryDrainContextKey struct{}

type deliveryDrainScenario struct {
	t                     *testing.T
	name                  string
	now                   time.Time
	input                 store.WebhookDelivery
	sources               store.WebhookAdmissionSources
	mu                    sync.Mutex
	attemptID             string
	claimGranted          bool
	claimCalls            int
	claimCommitted        bool
	admissionCommitted    bool
	dispatchCommitted     bool
	finalizationCommitted bool
	claimed               store.WebhookDelivery
	finalDelivery         store.WebhookDelivery
	finalAttempt          store.WebhookAttempt
	sends                 int
	claimsEntered         chan struct{}
	claimsCancelled       chan error
	outboundEntered       chan context.Context
	releaseResponse       chan struct{}
	finalized             chan struct{}
	releaseOnce           sync.Once
}

func deliveryDrainFixture(t *testing.T, name string) (*Runner, *deliveryDrainScenario) {
	t.Helper()
	r, input, now := admissionFixture(t)
	s := &deliveryDrainScenario{t: t, name: name, now: now, input: input.d, sources: input.s, claimsEntered: make(chan struct{}, deliveryWorkers*2), claimsCancelled: make(chan error, deliveryWorkers*2), outboundEntered: make(chan context.Context, 1), releaseResponse: make(chan struct{}), finalized: make(chan struct{}, 1)}
	r.DB = deliveryTransactionScript{t: t, write: s.write}
	r.client = deliverySenderScript{t: t, send: s.send}
	r.claimPollInterval, r.maintenancePollInterval = time.Millisecond, time.Millisecond
	return r, s
}

// Projections are fixture inputs. Only generated identity binds to a request;
// observed writes never manufacture the subsequent committed read view.
func (s *deliveryDrainScenario) admittedProjection() store.WebhookDelivery {
	d := s.claimed
	slot := int16(1)
	d.AutomaticPlanCursor, d.AutomaticAttemptCount, d.AttemptSequence = 1, 1, 1
	d.LeasePlanSlot = &slot
	d.CurrentAttemptID = &s.attemptID
	d.LastActivityAt = s.now
	d.MetadataExpiresAt = s.now.Add(30 * 24 * time.Hour)
	return d
}

func (s *deliveryDrainScenario) attemptProjection() store.WebhookAttempt {
	slot := int16(1)
	return store.WebhookAttempt{ID: s.attemptID, DeliveryID: s.input.ID, EndpointID: s.input.EndpointID, Trigger: "automatic", LeaseToken: *s.claimed.LeaseToken, Generation: 1, DestinationRevision: 1, Sequence: 1, SigningKeyIDs: []string{s.sources.Endpoint.ActiveKeyID}, AutomaticPlanSlot: &slot, ClaimedAt: s.now, AdmittedAt: s.now}
}

func (s *deliveryDrainScenario) finalProjection() store.WebhookDelivery {
	d := s.admittedProjection()
	d.LeaseToken, d.LeaseClaimedAt, d.LeaseUntil, d.LeaseGeneration, d.LeasePlanSlot, d.CurrentAttemptID = nil, nil, nil, nil, nil, nil
	d.State, d.AutomaticOpen, d.NextAttemptAt, d.TerminalAt = "delivered", false, nil, &s.now
	return d
}

func (s *deliveryDrainScenario) release() { s.releaseOnce.Do(func() { close(s.releaseResponse) }) }

func (s *deliveryDrainScenario) write(ctx context.Context, callback func(store.WebhookDeliveryScope) error) (store.Completion, error) {
	if err := ctx.Err(); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	if ctx.Value(deliveryDrainContextKey{}) != s.name {
		panic(deliveryUnexpectedScope{t: s.t}.unexpected("runtime context ownership"))
	}
	phase := ""
	setPhase := func(expected string) {
		if phase != "" && phase != expected {
			panic(deliveryUnexpectedScope{t: s.t}.unexpected("transaction phase " + phase + " -> " + expected))
		}
		phase = expected
	}
	var granted bool
	var attempt store.WebhookAttempt
	var delivery store.WebhookDelivery
	var attemptWritten, deliveryWritten bool
	scope := &deliveryScopeScript{deliveryUnexpectedScope: deliveryUnexpectedScope{t: s.t}, maxCalls: map[string]int{"ObservedAt": 3}}
	scope.observedAt = func(context.Context) (time.Time, error) { return s.now, nil }
	scope.claim = func(ctx context.Context, limit int, at time.Time, tokens []string) ([]store.WebhookDelivery, error) {
		setPhase("claim")
		if limit != 1 || len(tokens) != 1 || tokens[0] == "" || !at.Equal(s.now) {
			panic(scope.unexpected("claim arguments"))
		}
		s.mu.Lock()
		s.claimCalls++
		granted = !s.claimGranted
		if granted {
			s.claimGranted = true
			delivery = s.input
			token := tokens[0]
			delivery.LeaseToken = &token
		}
		s.mu.Unlock()
		select {
		case s.claimsEntered <- struct{}{}:
		default:
			panic(scope.unexpected("extra claim admission"))
		}
		if granted {
			return []store.WebhookDelivery{delivery}, nil
		}
		<-ctx.Done()
		s.claimsCancelled <- ctx.Err()
		return nil, ctx.Err()
	}
	scope.lockExpired = func(context.Context, int, time.Time) ([]store.WebhookDelivery, error) {
		setPhase("maintenance")
		return nil, nil
	}
	scope.lockDueExpiry = func(context.Context, int, time.Time) ([]store.WebhookDelivery, error) {
		setPhase("maintenance")
		return nil, nil
	}
	scope.admissionSources = func(_ context.Context, id string, _ time.Time) (store.WebhookAdmissionSources, error) {
		setPhase("admission")
		s.mu.Lock()
		defer s.mu.Unlock()
		if !s.claimCommitted || id != s.claimed.ID {
			panic(scope.unexpected("admission before committed claim"))
		}
		return s.sources, nil
	}
	scope.lockDelivery = func(_ context.Context, id string) (store.WebhookDelivery, error) {
		setPhase("admission")
		s.mu.Lock()
		defer s.mu.Unlock()
		if id != s.claimed.ID {
			panic(scope.unexpected("admission delivery identity"))
		}
		return s.claimed, nil
	}
	scope.lockAttempts = func(_ context.Context, id string) ([]store.WebhookAttempt, error) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if id != s.input.ID {
			panic(scope.unexpected("attempt delivery identity"))
		}
		switch phase {
		case "admission":
			return nil, nil
		case "finalize":
			return []store.WebhookAttempt{s.attemptProjection()}, nil
		default:
			panic(scope.unexpected("attempt history outside admission/finalization"))
		}
	}
	scope.lockWait = func(_ context.Context, id string, revision int64) (store.WebhookEndpointWait, error) {
		if id != s.input.EndpointID || revision != s.input.DestinationRevision {
			panic(scope.unexpected("wait identity"))
		}
		if phase != "admission" && phase != "finalize" {
			panic(scope.unexpected("wait outside admission/finalization"))
		}
		return store.WebhookEndpointWait{Owner: s.input.Owner}, nil
	}
	scope.insertAttempt = func(_ context.Context, a store.WebhookAttempt) error {
		setPhase("admission")
		s.mu.Lock()
		if s.attemptID != "" {
			s.mu.Unlock()
			panic(scope.unexpected("duplicate attempt identity"))
		}
		s.attemptID = a.ID
		expected := s.attemptProjection()
		s.mu.Unlock()
		if a.ID == "" || !reflect.DeepEqual(a, expected) {
			panic(scope.unexpected("admission attempt differs from configured projection"))
		}
		attempt, attemptWritten = a, true
		return nil
	}
	scope.tryLockDelivery = func(_ context.Context, id string) (store.WebhookDelivery, bool, error) {
		setPhase("finalize")
		s.mu.Lock()
		defer s.mu.Unlock()
		if !s.admissionCommitted || !s.dispatchCommitted || id != s.input.ID {
			panic(scope.unexpected("finalization before committed dispatch"))
		}
		return s.admittedProjection(), true, nil
	}
	scope.updateAttempt = func(_ context.Context, a store.WebhookAttempt) error {
		setPhase("finalize")
		s.mu.Lock()
		expected := s.attemptProjection()
		s.mu.Unlock()
		ack, status := "acknowledged", int16(http.StatusAccepted)
		expected.DispatchedAt, expected.FinishedAt, expected.Outcome, expected.HTTPStatus = &s.now, &s.now, &ack, &status
		if a.DurationMS == nil || *a.DurationMS < 0 {
			panic(scope.unexpected("missing actual outbound duration"))
		}
		expected.DurationMS = a.DurationMS
		if !reflect.DeepEqual(a, expected) {
			panic(scope.unexpected("finalized attempt differs from configured result"))
		}
		attempt, attemptWritten = a, true
		return nil
	}
	scope.updateDelivery = func(_ context.Context, d store.WebhookDelivery) error {
		if phase != "admission" && phase != "finalize" {
			panic(scope.unexpected("delivery write outside admission/finalization"))
		}
		if !attemptWritten {
			panic(scope.unexpected("delivery update before attempt write"))
		}
		s.mu.Lock()
		expected := s.admittedProjection()
		if phase == "finalize" {
			expected = s.finalProjection()
		}
		s.mu.Unlock()
		if !reflect.DeepEqual(d, expected) {
			panic(scope.unexpected("delivery write differs from configured projection"))
		}
		delivery, deliveryWritten = d, true
		return nil
	}
	if err := callback(scope); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	s.mu.Lock()
	switch phase {
	case "claim":
		if granted {
			s.claimed, s.claimCommitted = delivery, true
		}
	case "admission":
		if !attemptWritten || !deliveryWritten {
			s.mu.Unlock()
			panic(scope.unexpected("incomplete admission writes"))
		}
		s.admissionCommitted = true
	case "":
		if !s.admissionCommitted {
			s.mu.Unlock()
			panic(scope.unexpected("dispatch before committed admission"))
		}
		s.dispatchCommitted = true
	case "finalize":
		if !attemptWritten || !deliveryWritten {
			s.mu.Unlock()
			panic(scope.unexpected("incomplete finalization writes"))
		}
		s.finalAttempt, s.finalDelivery, s.finalizationCommitted = attempt, delivery, true
	case "maintenance":
	default:
		s.mu.Unlock()
		panic(scope.unexpected("unknown transaction phase"))
	}
	s.mu.Unlock()
	if phase == "finalize" {
		s.finalized <- struct{}{}
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func (s *deliveryDrainScenario) send(ctx context.Context, target string, body []byte, headers http.Header) (httpoutbound.Response, error) {
	s.mu.Lock()
	s.sends++
	valid := s.admissionCommitted && s.dispatchCommitted && s.sends == 1 && target == "https://example.com/hook" && bytes.Equal(body, s.input.Body) && headers.Get("Webhook-Id") == s.input.EventID
	s.mu.Unlock()
	if !valid {
		panic(deliveryUnexpectedScope{t: s.t}.unexpected("outbound before committed admission/dispatch"))
	}
	s.outboundEntered <- ctx
	select {
	case <-s.releaseResponse:
	case <-ctx.Done():
		s.t.Errorf("stopping claims canceled admitted outbound: %v", ctx.Err())
		return httpoutbound.Response{}, ctx.Err()
	}
	return httpoutbound.Response{Status: http.StatusAccepted}, nil
}

func (s *deliveryDrainScenario) assertFinalized() {
	s.t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	a, d := s.finalAttempt, s.finalDelivery
	if !s.finalizationCommitted || s.sends != 1 || s.claimCalls != deliveryWorkers || a.ID != s.attemptID || a.FinishedAt == nil || a.Outcome == nil || *a.Outcome != "acknowledged" || d.State != "delivered" || d.LeaseToken != nil || d.CurrentAttemptID != nil || d.NextAttemptAt != nil || d.AttemptSequence != 1 || d.AutomaticAttemptCount != 1 || !bytes.Equal(d.Body, s.input.Body) {
		s.t.Fatalf("%s did not finalize and drain: committed=%v sends=%d claims=%d attempt=%+v delivery=%+v", s.name, s.finalizationCommitted, s.sends, s.claimCalls, a, d)
	}
}

func TestStopClaimsPreservesAdmittedOutboundFinalizationAndDrain(t *testing.T) {
	deadline, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	a, first := deliveryDrainFixture(t, "first")
	b, second := deliveryDrainFixture(t, "second")
	workA, stopWorkA := context.WithCancel(context.WithValue(deadline, deliveryDrainContextKey{}, "first"))
	workB, stopWorkB := context.WithCancel(context.WithValue(deadline, deliveryDrainContextKey{}, "second"))
	claimsA, stopClaimsA := context.WithCancel(context.WithValue(deadline, deliveryDrainContextKey{}, "first"))
	claimsB, stopClaimsB := context.WithCancel(context.WithValue(deadline, deliveryDrainContextKey{}, "second"))
	defer stopWorkA()
	defer stopWorkB()
	defer stopClaimsA()
	defer stopClaimsB()
	t.Cleanup(func() {
		first.release()
		second.release()
		stop, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := a.Stop(stop); err != nil {
			t.Error(err)
		}
		if err := b.Stop(stop); err != nil {
			t.Error(err)
		}
	})
	wait := func(signal <-chan struct{}, name string) {
		t.Helper()
		select {
		case <-signal:
		case err := <-a.Failures():
			t.Fatalf("first runtime: %v", err)
		case err := <-b.Failures():
			t.Fatalf("second runtime: %v", err)
		case <-deadline.Done():
			t.Fatalf("%s: %v", name, deadline.Err())
		}
	}
	waitClaims := func(s *deliveryDrainScenario) {
		t.Helper()
		for i := 0; i < deliveryWorkers; i++ {
			wait(s.claimsEntered, s.name+" claims entered")
		}
	}
	if err := a.StartWithClaimContext(workA, claimsA); err != nil {
		t.Fatal(err)
	}
	waitClaims(first)
	var outbound context.Context
	select {
	case outbound = <-first.outboundEntered:
	case err := <-a.Failures():
		t.Fatal(err)
	case <-deadline.Done():
		t.Fatal("first outbound not entered")
	}
	a.StopClaims()
	for i := 0; i < deliveryWorkers-1; i++ {
		select {
		case err := <-first.claimsCancelled:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("claim cancellation=%v", err)
			}
		case err := <-a.Failures():
			t.Fatal(err)
		case <-deadline.Done():
			t.Fatal("stopped claims did not drain")
		}
	}
	if workA.Err() != nil || outbound.Err() != nil {
		t.Fatalf("claim stop canceled work: parent=%v outbound=%v", workA.Err(), outbound.Err())
	}
	select {
	case <-first.finalized:
		t.Fatal("blocked outbound finalized before response")
	default:
	}
	if err := b.StartWithClaimContext(workB, claimsB); err != nil {
		t.Fatal(err)
	}
	waitClaims(second)
	var secondOutbound context.Context
	select {
	case secondOutbound = <-second.outboundEntered:
	case err := <-b.Failures():
		t.Fatal(err)
	case <-deadline.Done():
		t.Fatal("second outbound not entered")
	}
	b.StopClaims()
	for i := 0; i < deliveryWorkers-1; i++ {
		select {
		case err := <-second.claimsCancelled:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("second claim cancellation=%v", err)
			}
		case err := <-b.Failures():
			t.Fatal(err)
		case <-deadline.Done():
			t.Fatal("second claims did not drain")
		}
	}
	if workB.Err() != nil || secondOutbound.Err() != nil {
		t.Fatal("stopping second claims canceled admitted work")
	}
	second.release()
	wait(second.finalized, "second committed finalization")
	if workA.Err() != nil || outbound.Err() != nil {
		t.Fatal("second runtime progress canceled first admitted work")
	}
	select {
	case <-first.finalized:
		t.Fatal("first outbound did not remain blocked")
	default:
	}
	first.release()
	wait(first.finalized, "first committed finalization after release")
	if err := a.Stop(deadline); err != nil {
		t.Fatal(err)
	}
	if err := b.Stop(deadline); err != nil {
		t.Fatal(err)
	}
	first.assertFinalized()
	second.assertFinalized()
	for _, runner := range []*Runner{a, b} {
		select {
		case err := <-runner.Failures():
			t.Fatalf("normal drain failed: %v", err)
		default:
		}
	}
	if first.finalAttempt.LeaseToken == second.finalAttempt.LeaseToken {
		t.Fatal("independent admitted attempts reused lease identity")
	}
	t.Logf("StopClaims after admitted outbound: work_live=true second_finalized=true first_finalized_after_release=true runtimes_drained=true")
}
