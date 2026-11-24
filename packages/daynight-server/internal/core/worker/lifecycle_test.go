package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	protocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
)

const lifecycleUser = "11111111-1111-4111-8111-111111111111"
const lifecycleWorker = "22222222-2222-4222-8222-222222222222"
const lifecycleOp = "33333333-3333-4333-8333-333333333333"
const lifecycleInstance = "44444444-4444-4444-8444-444444444444"
const lifecycleOldOp = "55555555-5555-4555-8555-555555555555"

var lifecycleNow = time.Date(2026, 11, 20, 1, 2, 3, 0, time.UTC)
var lifecycleFailure = errors.New("controlled storage failure")

func lifecyclePtr[T any](v T) *T { return &v }

// These callbacks supply fixed domain facts and capture proposed writes. They
// never make a write visible to a later read or model database persistence.
type lifecycleDAOTest struct {
	store.WorkerLifecycleDAO
	t               *testing.T
	lock            func() error
	state           func() (model.WorkerLifecycle, error)
	op              func(string) (model.LifecycleOperation, error)
	observation     func() (model.LifecycleStoredObservation, error)
	saveState       func(model.WorkerLifecycle) error
	saveOp          func(model.LifecycleOperation) error
	saveObservation func(model.LifecycleStoredObservation) error
	clear           func() error
}

func (d *lifecycleDAOTest) identity(ctx context.Context, u, w string) {
	d.t.Helper()
	if ctx == nil || u != lifecycleUser || w != lifecycleWorker {
		d.t.Fatalf("wrong context/identity %s %s", u, w)
	}
}
func (d *lifecycleDAOTest) LockWorker(ctx context.Context, u, w string) error {
	d.identity(ctx, u, w)
	if d.lock == nil {
		d.t.Fatal("unexpected lock")
	}
	return d.lock()
}
func (d *lifecycleDAOTest) Lifecycle(ctx context.Context, u, w string) (model.WorkerLifecycle, error) {
	d.identity(ctx, u, w)
	if d.state == nil {
		d.t.Fatal("unexpected state read")
	}
	return d.state()
}
func (d *lifecycleDAOTest) Operation(ctx context.Context, u, w, id string) (model.LifecycleOperation, error) {
	d.identity(ctx, u, w)
	if d.op == nil {
		d.t.Fatal("unexpected operation read")
	}
	return d.op(id)
}
func (d *lifecycleDAOTest) Observation(ctx context.Context, u, w string) (model.LifecycleStoredObservation, error) {
	d.identity(ctx, u, w)
	if d.observation == nil {
		d.t.Fatal("unexpected observation read")
	}
	return d.observation()
}
func (d *lifecycleDAOTest) SaveLifecycle(ctx context.Context, s model.WorkerLifecycle) error {
	d.identity(ctx, s.UserID, s.WorkerID)
	if d.saveState == nil {
		d.t.Fatal("unexpected state write")
	}
	return d.saveState(s)
}
func (d *lifecycleDAOTest) SaveOperation(ctx context.Context, o model.LifecycleOperation) error {
	d.identity(ctx, o.UserID, o.WorkerID)
	if d.saveOp == nil {
		d.t.Fatal("unexpected operation write")
	}
	return d.saveOp(o)
}
func (d *lifecycleDAOTest) SaveObservation(ctx context.Context, o model.LifecycleStoredObservation) error {
	d.identity(ctx, o.UserID, o.WorkerID)
	if d.saveObservation == nil {
		d.t.Fatal("unexpected observation write")
	}
	return d.saveObservation(o)
}
func (d *lifecycleDAOTest) DeleteObservation(ctx context.Context, u, w string) error {
	d.identity(ctx, u, w)
	if d.clear == nil {
		d.t.Fatal("unexpected observation clear")
	}
	return d.clear()
}
func lifecycleState() model.WorkerLifecycle {
	return model.WorkerLifecycle{UserID: lifecycleUser, WorkerID: lifecycleWorker, ProtocolVersion: 1, IntentVersion: 1, Desired: "enabled", Admission: "closed", InstanceID: lifecyclePtr(lifecycleInstance), CapabilityVersion: lifecyclePtr(1), UpdatedAt: lifecycleNow}
}
func lifecycleInstanceRequest() model.LifecycleInstanceRequest {
	return model.LifecycleInstanceRequest{ProtocolVersion: 1, OperationID: lifecycleOp, InstanceID: lifecycleInstance, Capabilities: model.LifecycleCapabilities{Disable: true, Resume: true, Inventory: 1, DispatchFence: 1}, Platform: "macos"}
}
func lifecycleIntentRequest(action string) model.LifecycleIntentRequest {
	r := model.LifecycleIntentRequest{ProtocolVersion: 1, OperationID: lifecycleOp, Action: action, ExpectedVersion: "1", Source: "web"}
	if action == "resume" {
		r.LocalEpoch = lifecyclePtr("2")
		r.InstanceID = lifecyclePtr(lifecycleInstance)
	}
	return r
}
func lifecycleActivationRequest(action string) model.LifecycleActivationRequest {
	return model.LifecycleActivationRequest{ProtocolVersion: 1, OperationID: lifecycleOp, Action: action, InstanceID: lifecycleInstance, IntentVersion: "1", LocalEpoch: "2", ScopeGeneration: "3", ReportSequence: "4"}
}
func lifecycleObservation(phase string) model.LifecycleStoredObservation {
	return model.LifecycleStoredObservation{UserID: lifecycleUser, WorkerID: lifecycleWorker, ReceivedAt: lifecycleNow, Envelope: model.LifecycleObservationEnvelope{ProtocolVersion: 1, InstanceID: lifecycleInstance, IntentVersion: "1", LocalEpoch: "2", ScopeGeneration: "3", ReportSequence: "4", Observation: model.LifecycleObservation{Phase: phase, Stop: "confirmed", Save: "durable", Sync: "complete", InventoryComplete: true, DetailsComplete: true, InventoryRevision: "5", InventoryDigest: strings.Repeat("a", 64), ResourceCount: lifecyclePtr(int64(0)), StoppedCount: lifecyclePtr(int64(0)), PendingCount: lifecyclePtr(int64(0)), BlockedCount: lifecyclePtr(int64(0)), Resources: []model.LifecycleResourceObservation{}, Recovery: []model.LifecycleRecoveryObservation{}}}}
}
func lifecycleMissingOp(string) (model.LifecycleOperation, error) {
	return model.LifecycleOperation{}, model.ErrNotFound
}
func lifecycleNewDAO(t *testing.T, s model.WorkerLifecycle) *lifecycleDAOTest {
	return &lifecycleDAOTest{t: t, lock: func() error { return nil }, state: func() (model.WorkerLifecycle, error) { return s, nil }, op: lifecycleMissingOp}
}
func lifecycleWantCode(t *testing.T, err error, code string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("wanted %s, got %v", code, err)
	}
}
func lifecycleStored(t *testing.T, kind string, request any, receipt any) model.LifecycleOperation {
	t.Helper()
	hash, raw, err := protocol.LifecycleRequestHash(kind, request)
	if err != nil {
		t.Fatal(err)
	}
	id, _, err := protocol.LifecycleOriginal(kind, raw)
	if err != nil {
		t.Fatal(err)
	}
	action, source := "instance", "worker"
	switch r := request.(type) {
	case model.LifecycleIntentRequest:
		action, source = r.Action, r.Source
	case model.LifecycleActivationRequest:
		action = r.Action
	}
	return lifecycleNewOperation(lifecycleUser, lifecycleWorker, id, kind, action, source, hash, raw, 1, receipt, lifecycleNow)
}

func TestLifecycleRegisterClosesAdmissionAndPreservesIntent(t *testing.T) {
	for _, tc := range []struct {
		name, desired, admission            string
		fresh, previouslyAllowed, reconnect bool
	}{
		{name: "first", fresh: true},
		{name: "reconnect", desired: "enabled", admission: "open", reconnect: true},
		{name: "repeat registration", desired: "enabled", admission: "closed", previouslyAllowed: true, reconnect: true},
		{name: "disabled", desired: "disabled", admission: "closed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := lifecycleState()
			s.Desired, s.Admission = tc.desired, tc.admission
			s.ReconnectAllowed = tc.previouslyAllowed
			s.IntentVersion = 7
			d := lifecycleNewDAO(t, s)
			r := lifecycleInstanceRequest()
			if tc.fresh {
				d.state = func() (model.WorkerLifecycle, error) { return model.WorkerLifecycle{}, model.ErrNotFound }
			}
			r.InstanceID = lifecycleWorker
			var written model.WorkerLifecycle
			var operation model.LifecycleOperation
			cleared := 0
			d.saveState = func(v model.WorkerLifecycle) error { written = v; return nil }
			d.saveOp = func(v model.LifecycleOperation) error { operation = v; return nil }
			d.clear = func() error { cleared++; return nil }
			got, err := LifecycleRegister(context.Background(), d, lifecycleUser, lifecycleWorker, r, lifecycleNow)
			if err != nil {
				t.Fatal(err)
			}
			if written.Admission != "closed" || written.IntentVersion != map[bool]int64{true: 1, false: 7}[tc.fresh] || written.InstanceID == nil || *written.InstanceID != r.InstanceID || got.InstanceID != r.InstanceID || written.ReconnectAllowed != tc.reconnect || got.ReconnectAllowed != tc.reconnect || cleared != 1 || operation.OperationID != lifecycleOp {
				t.Fatalf("wrong registration %+v %+v %+v", written, got, operation)
			}
			// The original receipt is returned before reading current authority again.
			replay := &lifecycleDAOTest{t: t, lock: func() error { return nil }, op: func(string) (model.LifecycleOperation, error) { return operation, nil }}
			same, e := LifecycleRegister(context.Background(), replay, lifecycleUser, lifecycleWorker, r, lifecycleNow.Add(time.Minute))
			if e != nil || same != got {
				t.Fatalf("replay %+v %v", same, e)
			}
		})
	}
}
func TestLifecycleIntentSupersedesOnlyCurrentIntent(t *testing.T) {
	for _, action := range []string{"disable", "resume"} {
		t.Run(action, func(t *testing.T) {
			s := lifecycleState()
			s.CurrentOperationID = lifecyclePtr(lifecycleOldOp)
			s.Desired = "disabled"
			oldRequest := lifecycleIntentRequest("disable")
			oldRequest.OperationID = lifecycleOldOp
			oldReceipt := model.LifecycleIntentReceipt{ProtocolVersion: 1, WorkerID: lifecycleWorker, OperationID: lifecycleOldOp, Action: "disable", IntentVersion: "1", Desired: "disabled", Admission: "closed", State: "applied", ObservedAt: lifecycleNow}
			old := lifecycleStored(t, "intent", oldRequest, oldReceipt)
			d := lifecycleNewDAO(t, s)
			d.op = func(id string) (model.LifecycleOperation, error) {
				if id == lifecycleOldOp {
					return old, nil
				}
				return model.LifecycleOperation{}, model.ErrNotFound
			}
			o := lifecycleObservation("disabled")
			o.Envelope.OperationID = s.CurrentOperationID
			d.observation = func() (model.LifecycleStoredObservation, error) { return o, nil }
			var saved model.WorkerLifecycle
			var ops []model.LifecycleOperation
			d.saveState = func(v model.WorkerLifecycle) error { saved = v; return nil }
			d.saveOp = func(v model.LifecycleOperation) error { ops = append(ops, v); return nil }
			d.clear = func() error { return nil }
			got, e := LifecycleIntent(context.Background(), d, lifecycleUser, lifecycleWorker, lifecycleIntentRequest(action), lifecycleNow)
			if e != nil {
				t.Fatal(e)
			}
			if got.IntentVersion != "2" || got.State != "accepted" || saved.Admission != "closed" || saved.ReconnectAllowed || saved.CurrentOperationID == nil || *saved.CurrentOperationID != lifecycleOp || len(ops) != 2 || ops[0].State != "superseded" || ops[1].State != "accepted" {
				t.Fatalf("intent %+v %+v %+v", got, saved, ops)
			}
			if action == "resume" && saved.Desired != "enabled" {
				t.Fatal("resume did not set desired")
			}
		})
	}
}
func TestLifecycleResumeRequiresFreshCompleteDisabledObservation(t *testing.T) {
	for _, tc := range []struct {
		name, code string
		change     func(*model.WorkerLifecycle, *model.LifecycleStoredObservation, *model.LifecycleIntentRequest)
	}{
		{"version", "version_conflict", func(s *model.WorkerLifecycle, o *model.LifecycleStoredObservation, r *model.LifecycleIntentRequest) {
			r.ExpectedVersion = "2"
		}},
		{"unsupported", "lifecycle_unsupported", func(s *model.WorkerLifecycle, o *model.LifecycleStoredObservation, r *model.LifecycleIntentRequest) {
			s.CapabilityVersion = nil
		}},
		{"overflow", "lifecycle_unavailable", func(s *model.WorkerLifecycle, o *model.LifecycleStoredObservation, r *model.LifecycleIntentRequest) {
			s.IntentVersion = math.MaxInt64
			r.ExpectedVersion = "9223372036854775807"
		}},
		{"instance", "stale_instance", func(s *model.WorkerLifecycle, o *model.LifecycleStoredObservation, r *model.LifecycleIntentRequest) {
			r.InstanceID = lifecyclePtr(lifecycleOp)
		}},
		{"stale", "stale_report", func(s *model.WorkerLifecycle, o *model.LifecycleStoredObservation, r *model.LifecycleIntentRequest) {
			o.ReceivedAt = o.ReceivedAt.Add(-30 * time.Second)
		}},
		{"local", "stale_report", func(s *model.WorkerLifecycle, o *model.LifecycleStoredObservation, r *model.LifecycleIntentRequest) {
			r.LocalEpoch = lifecyclePtr("3")
		}},
		{"blocked", "safety_blocked", func(s *model.WorkerLifecycle, o *model.LifecycleStoredObservation, r *model.LifecycleIntentRequest) {
			o.Envelope.Observation.Phase = "blocked"
		}},
		{"stopping", "disable_incomplete", func(s *model.WorkerLifecycle, o *model.LifecycleStoredObservation, r *model.LifecycleIntentRequest) {
			o.Envelope.Observation.Phase = "disabling"
		}},
		{"save", "disable_incomplete", func(s *model.WorkerLifecycle, o *model.LifecycleStoredObservation, r *model.LifecycleIntentRequest) {
			o.Envelope.Observation.Save = "failed"
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := lifecycleState()
			o := lifecycleObservation("disabled")
			r := lifecycleIntentRequest("resume")
			tc.change(&s, &o, &r)
			d := lifecycleNewDAO(t, s)
			d.observation = func() (model.LifecycleStoredObservation, error) { return o, nil }
			_, e := LifecycleIntent(context.Background(), d, lifecycleUser, lifecycleWorker, r, lifecycleNow)
			lifecycleWantCode(t, e, tc.code)
		})
	}
	s := lifecycleState()
	o := lifecycleObservation("disabled")
	o.Envelope.Observation.ErrorCode = lifecyclePtr("resume_interrupted")
	d := lifecycleNewDAO(t, s)
	d.observation = func() (model.LifecycleStoredObservation, error) { return o, nil }
	d.saveState = func(model.WorkerLifecycle) error { return nil }
	d.saveOp = func(model.LifecycleOperation) error { return nil }
	d.clear = func() error { return nil }
	if _, e := LifecycleIntent(context.Background(), d, lifecycleUser, lifecycleWorker, lifecycleIntentRequest("resume"), lifecycleNow); e != nil {
		t.Fatal(e)
	}
}
func TestLifecycleActivationVariants(t *testing.T) {
	for _, action := range []string{"", "bootstrap", "reconnect"} {
		t.Run(action, func(t *testing.T) {
			s := lifecycleState()
			s.ReconnectAllowed = action == "reconnect"
			o := lifecycleObservation("resuming")
			d := lifecycleNewDAO(t, s)
			if action == "" {
				s.CurrentOperationID = lifecyclePtr(lifecycleOp)
				o.Envelope.OperationID = s.CurrentOperationID
				d.state = func() (model.WorkerLifecycle, error) { return s, nil }
				op := lifecycleStored(t, "intent", lifecycleIntentRequest("resume"), model.LifecycleIntentReceipt{ProtocolVersion: 1, WorkerID: lifecycleWorker, OperationID: lifecycleOp, Action: "resume", IntentVersion: "1", Desired: "enabled", Admission: "closed", State: "accepted", ObservedAt: lifecycleNow})
				d.op = func(string) (model.LifecycleOperation, error) { return op, nil }
			}
			d.observation = func() (model.LifecycleStoredObservation, error) { return o, nil }
			var state model.WorkerLifecycle
			var operation model.LifecycleOperation
			d.saveState = func(v model.WorkerLifecycle) error { state = v; return nil }
			d.saveOp = func(v model.LifecycleOperation) error { operation = v; return nil }
			request := lifecycleActivationRequest(action)
			got, e := LifecycleActivate(context.Background(), d, lifecycleUser, lifecycleWorker, request, lifecycleNow)
			if e != nil {
				t.Fatal(e)
			}
			if state.Admission != "open" || state.ReconnectAllowed || state.BootstrapConsumed != (action == "bootstrap") || got.Admission != "open" {
				t.Fatalf("activate %+v %+v", got, state)
			}
			replay := &lifecycleDAOTest{t: t, lock: func() error { return nil }, op: func(string) (model.LifecycleOperation, error) { return operation, nil }}
			same, e := LifecycleActivate(context.Background(), replay, lifecycleUser, lifecycleWorker, request, lifecycleNow.Add(time.Minute))
			if e != nil || same != got {
				t.Fatalf("replay %+v %v", same, e)
			}
		})
	}
}
func TestLifecycleActivationSafetyFences(t *testing.T) {
	for _, tc := range []struct {
		name, code string
		change     func(*model.WorkerLifecycle, *model.LifecycleStoredObservation, *model.LifecycleActivationRequest)
	}{
		{"instance", "stale_instance", func(s *model.WorkerLifecycle, o *model.LifecycleStoredObservation, r *model.LifecycleActivationRequest) {
			r.InstanceID = lifecycleOp
		}},
		{"intent", "stale_intent", func(s *model.WorkerLifecycle, o *model.LifecycleStoredObservation, r *model.LifecycleActivationRequest) {
			s.IntentVersion = 2
		}},
		{"disabled", "safety_blocked", func(s *model.WorkerLifecycle, o *model.LifecycleStoredObservation, r *model.LifecycleActivationRequest) {
			s.Desired = "disabled"
		}},
		{"consumed", "safety_blocked", func(s *model.WorkerLifecycle, o *model.LifecycleStoredObservation, r *model.LifecycleActivationRequest) {
			s.BootstrapConsumed = true
		}},
		{"reconnect", "safety_blocked", func(s *model.WorkerLifecycle, o *model.LifecycleStoredObservation, r *model.LifecycleActivationRequest) {
			r.Action = "reconnect"
		}},
		{"sequence", "stale_report", func(s *model.WorkerLifecycle, o *model.LifecycleStoredObservation, r *model.LifecycleActivationRequest) {
			r.ReportSequence = "5"
		}},
		{"unsafe", "safety_blocked", func(s *model.WorkerLifecycle, o *model.LifecycleStoredObservation, r *model.LifecycleActivationRequest) {
			o.Envelope.Observation.ErrorCode = lifecyclePtr("stop_unknown")
		}},
		{"phase", "safety_blocked", func(s *model.WorkerLifecycle, o *model.LifecycleStoredObservation, r *model.LifecycleActivationRequest) {
			o.Envelope.Observation.Phase = "disabled"
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := lifecycleState()
			o := lifecycleObservation("resuming")
			r := lifecycleActivationRequest("bootstrap")
			tc.change(&s, &o, &r)
			d := lifecycleNewDAO(t, s)
			d.observation = func() (model.LifecycleStoredObservation, error) { return o, nil }
			_, e := LifecycleActivate(context.Background(), d, lifecycleUser, lifecycleWorker, r, lifecycleNow)
			lifecycleWantCode(t, e, tc.code)
		})
	}
}
func TestLifecycleResolveTombstoneAndLateRequest(t *testing.T) {
	for _, kind := range []string{"instance", "intent", "activation"} {
		t.Run(kind, func(t *testing.T) {
			var original any
			switch kind {
			case "instance":
				original = lifecycleInstanceRequest()
			case "intent":
				original = lifecycleIntentRequest("disable")
			case "activation":
				original = lifecycleActivationRequest("bootstrap")
			}
			raw := lifecycleMarshal(original)
			d := lifecycleNewDAO(t, lifecycleState())
			var written model.LifecycleOperation
			d.saveOp = func(o model.LifecycleOperation) error { written = o; return nil }
			request := model.LifecycleResolveRequest{ProtocolVersion: 1, RequestKind: kind, Request: raw}
			got, e := LifecycleResolve(context.Background(), d, lifecycleUser, lifecycleWorker, lifecycleOp, request, lifecycleNow)
			if e != nil || got.Kind != "not_committed" || written.State != "not_committed" {
				t.Fatalf("resolve %+v %v", got, e)
			}
			prior := &lifecycleDAOTest{t: t, lock: func() error { return nil }, op: func(string) (model.LifecycleOperation, error) { return written, nil }}
			switch kind {
			case "instance":
				_, e = LifecycleRegister(context.Background(), prior, lifecycleUser, lifecycleWorker, original.(model.LifecycleInstanceRequest), lifecycleNow)
			case "intent":
				_, e = LifecycleIntent(context.Background(), prior, lifecycleUser, lifecycleWorker, original.(model.LifecycleIntentRequest), lifecycleNow)
			case "activation":
				_, e = LifecycleActivate(context.Background(), prior, lifecycleUser, lifecycleWorker, original.(model.LifecycleActivationRequest), lifecycleNow)
			}
			lifecycleWantCode(t, e, "operation_resolved_not_committed")
			same, e := LifecycleResolve(context.Background(), prior, lifecycleUser, lifecycleWorker, lifecycleOp, request, lifecycleNow.Add(time.Second))
			if e != nil || !bytes.Equal(same.Receipt, got.Receipt) {
				t.Fatal("resolution did not retain original result")
			}
		})
	}
}
func TestLifecycleResumeActivationResolutionPreservesIntent(t *testing.T) {
	intent := lifecycleStored(t, "intent", lifecycleIntentRequest("resume"), model.LifecycleIntentReceipt{OperationID: lifecycleOp, State: "accepted"})
	d := &lifecycleDAOTest{t: t, lock: func() error { return nil }, op: func(string) (model.LifecycleOperation, error) { return intent, nil }}
	var saved model.LifecycleOperation
	d.saveOp = func(o model.LifecycleOperation) error { saved = o; return nil }
	activation := lifecycleActivationRequest("")
	resolve := model.LifecycleResolveRequest{ProtocolVersion: 1, RequestKind: "activation", Request: lifecycleMarshal(activation)}
	result, e := LifecycleResolve(context.Background(), d, lifecycleUser, lifecycleWorker, lifecycleOp, resolve, lifecycleNow)
	if e != nil || result.Kind != "intent" || result.ActivationOutcome != "not_committed" || !bytes.Equal(result.Receipt, intent.Receipt) || len(saved.Activation) != 0 {
		t.Fatalf("substage %+v %v", result, e)
	}
	d.op = func(string) (model.LifecycleOperation, error) { return saved, nil }
	d.saveOp = nil
	_, e = LifecycleActivate(context.Background(), d, lifecycleUser, lifecycleWorker, activation, lifecycleNow)
	lifecycleWantCode(t, e, "operation_resolved_not_committed")
	activation.ScopeGeneration = "4"
	_, e = LifecycleActivate(context.Background(), d, lifecycleUser, lifecycleWorker, activation, lifecycleNow)
	lifecycleWantCode(t, e, "operation_conflict")
	resolve.Request = lifecycleMarshal(activation)
	_, e = LifecycleResolve(context.Background(), d, lifecycleUser, lifecycleWorker, lifecycleOp, resolve, lifecycleNow)
	lifecycleWantCode(t, e, "operation_conflict")
}
func TestLifecycleObservationOrderingAndOriginalTimestamp(t *testing.T) {
	s := lifecycleState()
	previous := lifecycleObservation("disabled")
	r := previous.Envelope
	d := lifecycleNewDAO(t, s)
	d.observation = func() (model.LifecycleStoredObservation, error) { return previous, nil }
	receipt, e := LifecycleObserve(context.Background(), d, lifecycleUser, lifecycleWorker, r, lifecycleNow.Add(time.Second))
	if e != nil || receipt.ReceivedAt != lifecycleNow {
		t.Fatalf("duplicate freshness %+v %v", receipt, e)
	}
	for _, change := range []func(*model.LifecycleObservationEnvelope){func(v *model.LifecycleObservationEnvelope) { v.ReportSequence = "3" }, func(v *model.LifecycleObservationEnvelope) { v.Observation.Sync = "pending" }, func(v *model.LifecycleObservationEnvelope) { v.ReportSequence = "5"; v.LocalEpoch = "1" }, func(v *model.LifecycleObservationEnvelope) { v.ReportSequence = "5"; v.ScopeGeneration = "2" }, func(v *model.LifecycleObservationEnvelope) {
		v.ReportSequence = "5"
		v.Observation.InventoryRevision = "4"
	}} {
		v := r
		change(&v)
		_, e = LifecycleObserve(context.Background(), d, lifecycleUser, lifecycleWorker, v, lifecycleNow)
		lifecycleWantCode(t, e, "stale_report")
	}
	r.ReportSequence = "5"
	var saved model.LifecycleStoredObservation
	d.saveObservation = func(o model.LifecycleStoredObservation) error { saved = o; return nil }
	if _, e = LifecycleObserve(context.Background(), d, lifecycleUser, lifecycleWorker, r, lifecycleNow.Add(time.Second)); e != nil || saved.Envelope.ReportSequence != "5" {
		t.Fatal(e)
	}
}
func TestLifecycleObservationUpdatesIntentAndResourceRead(t *testing.T) {
	for _, phase := range []string{"disabled", "blocked"} {
		t.Run(phase, func(t *testing.T) {
			s := lifecycleState()
			s.Desired = "disabled"
			s.CurrentOperationID = lifecyclePtr(lifecycleOp)
			r := lifecycleObservation(phase)
			r.Envelope.OperationID = s.CurrentOperationID
			op := lifecycleStored(t, "intent", lifecycleIntentRequest("disable"), model.LifecycleIntentReceipt{OperationID: lifecycleOp, State: "accepted"})
			d := lifecycleNewDAO(t, s)
			d.op = func(string) (model.LifecycleOperation, error) { return op, nil }
			d.observation = func() (model.LifecycleStoredObservation, error) {
				return model.LifecycleStoredObservation{}, model.ErrNotFound
			}
			d.saveObservation = func(model.LifecycleStoredObservation) error { return nil }
			var updated model.LifecycleOperation
			d.saveOp = func(o model.LifecycleOperation) error { updated = o; return nil }
			if _, e := LifecycleObserve(context.Background(), d, lifecycleUser, lifecycleWorker, r.Envelope, lifecycleNow); e != nil {
				t.Fatal(e)
			}
			if updated.State != map[string]string{"disabled": "applied", "blocked": "blocked"}[phase] {
				t.Fatalf("wrong operation state %+v", updated)
			}
			d.observation = func() (model.LifecycleStoredObservation, error) { return r, nil }
			got, e := LifecycleGet(context.Background(), d, lifecycleUser, lifecycleWorker, lifecycleNow.Add(time.Second))
			if e != nil || got.Observation == nil || got.Observation.Observation.FreshUntil != lifecycleNow.Add(30*time.Second) || got.Instance == nil || got.Instance.InstanceID != lifecycleInstance {
				t.Fatalf("resource %+v %v", got, e)
			}
		})
	}
}
func TestLifecycleGetOperationAndUnknownNeverInventResult(t *testing.T) {
	d := &lifecycleDAOTest{t: t, op: lifecycleMissingOp}
	if _, e := LifecycleGetOperation(context.Background(), d, lifecycleUser, lifecycleWorker, lifecycleOp); !errors.Is(e, model.ErrNotFound) {
		t.Fatal(e)
	}
	op := lifecycleStored(t, "intent", lifecycleIntentRequest("disable"), model.LifecycleIntentReceipt{OperationID: lifecycleOp})
	d.op = func(string) (model.LifecycleOperation, error) { return op, nil }
	r, e := LifecycleGetOperation(context.Background(), d, lifecycleUser, lifecycleWorker, lifecycleOp)
	if e != nil || r.Kind != "intent" {
		t.Fatal(e)
	}
	raw, e := json.Marshal(r)
	if e != nil || !bytes.Contains(raw, []byte(`"activation":null`)) || !bytes.Contains(raw, []byte(`"activationOutcome":"not_started"`)) {
		t.Fatalf("result %s %v", raw, e)
	}
	if _, e = LifecycleGetOperation(context.Background(), d, lifecycleUser, lifecycleWorker, "bad"); e == nil {
		t.Fatal("invalid ID")
	}
}

func TestLifecycleStorageFailuresStopAtFailingBoundary(t *testing.T) {
	cases := []struct {
		name        string
		steps       int
		run         func(*lifecycleDAOTest) error
		state       model.WorkerLifecycle
		op          *model.LifecycleOperation
		observation *model.LifecycleStoredObservation
	}{
		{name: "register", steps: 6, state: lifecycleState(), run: func(d *lifecycleDAOTest) error {
			r := lifecycleInstanceRequest()
			_, e := LifecycleRegister(context.Background(), d, lifecycleUser, lifecycleWorker, r, lifecycleNow)
			return e
		}},
		{name: "disable", steps: 6, state: lifecycleState(), run: func(d *lifecycleDAOTest) error {
			_, e := LifecycleIntent(context.Background(), d, lifecycleUser, lifecycleWorker, lifecycleIntentRequest("disable"), lifecycleNow)
			return e
		}},
		{name: "resume", steps: 7, state: lifecycleState(), observation: lifecyclePtr(lifecycleObservation("disabled")), run: func(d *lifecycleDAOTest) error {
			_, e := LifecycleIntent(context.Background(), d, lifecycleUser, lifecycleWorker, lifecycleIntentRequest("resume"), lifecycleNow)
			return e
		}},
		{name: "bootstrap", steps: 6, state: lifecycleState(), observation: lifecyclePtr(lifecycleObservation("resuming")), run: func(d *lifecycleDAOTest) error {
			_, e := LifecycleActivate(context.Background(), d, lifecycleUser, lifecycleWorker, lifecycleActivationRequest("bootstrap"), lifecycleNow)
			return e
		}},
		{name: "observation", steps: 4, state: lifecycleState(), run: func(d *lifecycleDAOTest) error {
			_, e := LifecycleObserve(context.Background(), d, lifecycleUser, lifecycleWorker, lifecycleObservation("disabled").Envelope, lifecycleNow)
			return e
		}},
		{name: "resolve", steps: 4, state: lifecycleState(), run: func(d *lifecycleDAOTest) error {
			_, e := LifecycleResolve(context.Background(), d, lifecycleUser, lifecycleWorker, lifecycleOp, model.LifecycleResolveRequest{ProtocolVersion: 1, RequestKind: "instance", Request: lifecycleMarshal(lifecycleInstanceRequest())}, lifecycleNow)
			return e
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for failure := 1; failure <= tc.steps; failure++ {
				calls := 0
				next := func() error {
					calls++
					if calls == failure {
						return lifecycleFailure
					}
					if calls > failure {
						t.Fatalf("called after failed boundary %d", failure)
					}
					return nil
				}
				d := &lifecycleDAOTest{t: t, lock: next, state: func() (model.WorkerLifecycle, error) {
					if e := next(); e != nil {
						return model.WorkerLifecycle{}, e
					}
					return tc.state, nil
				}, op: func(string) (model.LifecycleOperation, error) {
					if e := next(); e != nil {
						return model.LifecycleOperation{}, e
					}
					if tc.op != nil {
						return *tc.op, nil
					}
					return model.LifecycleOperation{}, model.ErrNotFound
				}, observation: func() (model.LifecycleStoredObservation, error) {
					if e := next(); e != nil {
						return model.LifecycleStoredObservation{}, e
					}
					if tc.observation != nil {
						return *tc.observation, nil
					}
					return model.LifecycleStoredObservation{}, model.ErrNotFound
				}, saveState: func(model.WorkerLifecycle) error { return next() }, saveOp: func(model.LifecycleOperation) error { return next() }, saveObservation: func(model.LifecycleStoredObservation) error { return next() }, clear: next}
				if e := tc.run(d); !errors.Is(e, lifecycleFailure) || calls != failure {
					t.Fatalf("boundary %d calls %d error %v", failure, calls, e)
				}
			}
		})
	}
}
func TestLifecycleInputAndReadErrors(t *testing.T) {
	invalid := &lifecycleDAOTest{t: t}
	for _, run := range []func() error{
		func() error {
			_, e := LifecycleRegister(context.Background(), invalid, "bad", lifecycleWorker, lifecycleInstanceRequest(), lifecycleNow)
			return e
		},
		func() error {
			_, e := LifecycleIntent(context.Background(), invalid, lifecycleUser, "bad", lifecycleIntentRequest("disable"), lifecycleNow)
			return e
		},
		func() error {
			_, e := LifecycleActivate(context.Background(), invalid, lifecycleUser, "00000000-0000-0000-0000-000000000000", lifecycleActivationRequest("bootstrap"), lifecycleNow)
			return e
		},
		func() error {
			_, e := LifecycleObserve(context.Background(), invalid, "bad", lifecycleWorker, lifecycleObservation("disabled").Envelope, lifecycleNow)
			return e
		},
		func() error {
			_, e := LifecycleResolve(context.Background(), invalid, "bad", lifecycleWorker, lifecycleOp, model.LifecycleResolveRequest{}, lifecycleNow)
			return e
		},
		func() error {
			_, e := LifecycleGet(context.Background(), invalid, "bad", lifecycleWorker, lifecycleNow)
			return e
		},
		func() error {
			_, e := LifecycleGetOperation(context.Background(), invalid, "bad", lifecycleWorker, lifecycleOp)
			return e
		},
		func() error {
			_, e := LifecycleRegister(context.Background(), invalid, lifecycleUser, lifecycleWorker, model.LifecycleInstanceRequest{}, lifecycleNow)
			return e
		},
		func() error {
			_, e := LifecycleIntent(context.Background(), invalid, lifecycleUser, lifecycleWorker, model.LifecycleIntentRequest{}, lifecycleNow)
			return e
		},
		func() error {
			_, e := LifecycleActivate(context.Background(), invalid, lifecycleUser, lifecycleWorker, model.LifecycleActivationRequest{}, lifecycleNow)
			return e
		},
		func() error {
			_, e := LifecycleObserve(context.Background(), invalid, lifecycleUser, lifecycleWorker, model.LifecycleObservationEnvelope{}, lifecycleNow)
			return e
		},
		func() error {
			_, e := LifecycleResolve(context.Background(), invalid, lifecycleUser, lifecycleWorker, lifecycleOp, model.LifecycleResolveRequest{}, lifecycleNow)
			return e
		},
		func() error {
			_, e := LifecycleResolve(context.Background(), invalid, lifecycleUser, lifecycleWorker, lifecycleOp, model.LifecycleResolveRequest{ProtocolVersion: 1, RequestKind: "bad"}, lifecycleNow)
			return e
		},
	} {
		if e := run(); e == nil {
			t.Fatal("invalid input reached DAO")
		}
	}
	for _, tc := range []struct {
		name                         string
		stateError, observationError error
	}{{"state", lifecycleFailure, nil}, {"observation", nil, lifecycleFailure}, {"absent", nil, model.ErrNotFound}} {
		t.Run(tc.name, func(t *testing.T) {
			s := lifecycleState()
			d := lifecycleNewDAO(t, s)
			d.state = func() (model.WorkerLifecycle, error) { return s, tc.stateError }
			d.observation = func() (model.LifecycleStoredObservation, error) {
				return model.LifecycleStoredObservation{}, tc.observationError
			}
			r, e := LifecycleGet(context.Background(), d, lifecycleUser, lifecycleWorker, lifecycleNow)
			if tc.name == "absent" {
				if e != nil || r.Observation != nil {
					t.Fatal(e)
				}
			} else if !errors.Is(e, lifecycleFailure) {
				t.Fatal(e)
			}
		})
	}
}
func TestLifecycleExistingOperationCannotBeRebound(t *testing.T) {
	r := lifecycleInstanceRequest()
	op := lifecycleStored(t, "instance", r, model.LifecycleInstanceReceipt{OperationID: lifecycleOp})
	op.RequestHash = []byte("other")
	d := &lifecycleDAOTest{t: t, lock: func() error { return nil }, op: func(string) (model.LifecycleOperation, error) { return op, nil }}
	_, e := LifecycleRegister(context.Background(), d, lifecycleUser, lifecycleWorker, r, lifecycleNow)
	lifecycleWantCode(t, e, "operation_conflict")
	resolve := model.LifecycleResolveRequest{ProtocolVersion: 1, RequestKind: "instance", Request: lifecycleMarshal(r)}
	_, e = LifecycleResolve(context.Background(), d, lifecycleUser, lifecycleWorker, lifecycleOp, resolve, lifecycleNow)
	lifecycleWantCode(t, e, "operation_conflict")
	_, e = LifecycleResolve(context.Background(), &lifecycleDAOTest{t: t}, lifecycleUser, lifecycleWorker, lifecycleOldOp, resolve, lifecycleNow)
	lifecycleWantCode(t, e, "operation_conflict")
}
func TestLifecycleAbsentObservationAndOldActivationHistory(t *testing.T) {
	d := lifecycleNewDAO(t, lifecycleState())
	d.observation = func() (model.LifecycleStoredObservation, error) {
		return model.LifecycleStoredObservation{}, model.ErrNotFound
	}
	_, e := LifecycleIntent(context.Background(), d, lifecycleUser, lifecycleWorker, lifecycleIntentRequest("resume"), lifecycleNow)
	lifecycleWantCode(t, e, "disable_incomplete")
	_, e = LifecycleActivate(context.Background(), d, lifecycleUser, lifecycleWorker, lifecycleActivationRequest("bootstrap"), lifecycleNow)
	lifecycleWantCode(t, e, "safety_blocked")
	request := lifecycleActivationRequest("")
	receipt := model.LifecycleActivationReceipt{OperationID: lifecycleOp, Admission: "open", IntentVersion: "1"}
	op := lifecycleStored(t, "intent", lifecycleIntentRequest("resume"), model.LifecycleIntentReceipt{State: "superseded"})
	op.State = "superseded"
	op.ActivationOutcome = "committed"
	op.Activation = lifecycleMarshal(receipt)
	op.ActivationHash, op.ActivationRequest, e = protocol.LifecycleRequestHash("activation", request)
	if e != nil {
		t.Fatal(e)
	}
	historical := &lifecycleDAOTest{t: t, lock: func() error { return nil }, op: func(string) (model.LifecycleOperation, error) { return op, nil }}
	got, e := LifecycleActivate(context.Background(), historical, lifecycleUser, lifecycleWorker, request, lifecycleNow)
	if e != nil || got != receipt {
		t.Fatalf("historical receipt %+v %v", got, e)
	}
	result, e := LifecycleResolve(context.Background(), historical, lifecycleUser, lifecycleWorker, lifecycleOp, model.LifecycleResolveRequest{ProtocolVersion: 1, RequestKind: "activation", Request: lifecycleMarshal(request)}, lifecycleNow)
	if e != nil || result.ActivationOutcome != "committed" {
		t.Fatalf("historical resolution %+v %v", result, e)
	}
	request.LocalEpoch = "3"
	_, e = LifecycleResolve(context.Background(), historical, lifecycleUser, lifecycleWorker, lifecycleOp, model.LifecycleResolveRequest{ProtocolVersion: 1, RequestKind: "activation", Request: lifecycleMarshal(request)}, lifecycleNow)
	lifecycleWantCode(t, e, "operation_conflict")
}

func TestLifecycleObservationFencesAndOperationFailures(t *testing.T) {
	for _, tc := range []struct {
		name, code string
		change     func(*model.WorkerLifecycle, *model.LifecycleObservationEnvelope)
	}{
		{"instance", "stale_instance", func(s *model.WorkerLifecycle, r *model.LifecycleObservationEnvelope) { r.InstanceID = lifecycleOp }},
		{"intent", "stale_intent", func(s *model.WorkerLifecycle, r *model.LifecycleObservationEnvelope) { r.IntentVersion = "2" }},
		{"accepting-closed", "safety_blocked", func(s *model.WorkerLifecycle, r *model.LifecycleObservationEnvelope) {
			r.Observation.Phase = "accepting"
		}},
		{"disabled-open", "safety_blocked", func(s *model.WorkerLifecycle, r *model.LifecycleObservationEnvelope) { s.Admission = "open" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := lifecycleState()
			r := lifecycleObservation("disabled").Envelope
			tc.change(&s, &r)
			d := lifecycleNewDAO(t, s)
			d.observation = func() (model.LifecycleStoredObservation, error) {
				return model.LifecycleStoredObservation{}, model.ErrNotFound
			}
			_, e := LifecycleObserve(context.Background(), d, lifecycleUser, lifecycleWorker, r, lifecycleNow)
			lifecycleWantCode(t, e, tc.code)
		})
	}
	for _, failure := range []string{"operation", "receipt", "save"} {
		t.Run(failure, func(t *testing.T) {
			s := lifecycleState()
			s.CurrentOperationID = lifecyclePtr(lifecycleOp)
			s.Desired = "disabled"
			r := lifecycleObservation("disabled").Envelope
			r.OperationID = s.CurrentOperationID
			d := lifecycleNewDAO(t, s)
			d.observation = func() (model.LifecycleStoredObservation, error) {
				return model.LifecycleStoredObservation{}, model.ErrNotFound
			}
			d.saveObservation = func(model.LifecycleStoredObservation) error { return nil }
			op := lifecycleStored(t, "intent", lifecycleIntentRequest("disable"), model.LifecycleIntentReceipt{State: "accepted"})
			if failure == "receipt" {
				op.Receipt = []byte(`{`)
			}
			d.op = func(string) (model.LifecycleOperation, error) {
				if failure == "operation" {
					return model.LifecycleOperation{}, lifecycleFailure
				}
				return op, nil
			}
			d.saveOp = func(model.LifecycleOperation) error { return lifecycleFailure }
			if _, e := LifecycleObserve(context.Background(), d, lifecycleUser, lifecycleWorker, r, lifecycleNow); e == nil {
				t.Fatal("failed operation result disappeared")
			}
		})
	}
}
