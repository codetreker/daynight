package worker

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	protocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
)

const LifecycleFreshness = 30 * time.Second

func lifecycleFault(code string) error {
	return &model.Fault{Code: code, Message: map[string]string{
		"operation_conflict":               "Worker lifecycle operation has a different request.",
		"operation_resolved_not_committed": "Worker lifecycle operation was resolved without committing.",
		"version_conflict":                 "Worker lifecycle intent has changed.",
		"stale_instance":                   "Worker lifecycle instance has changed.",
		"stale_intent":                     "Worker lifecycle intent has changed.",
		"stale_report":                     "Worker lifecycle observation has changed.",
		"disable_incomplete":               "Worker stopping is not confirmed.",
		"safety_blocked":                   "Worker lifecycle safety checks are incomplete.",
		"lifecycle_unsupported":            "Worker lifecycle is unsupported.",
		"lifecycle_unavailable":            "Worker lifecycle authority is unavailable.",
	}[code]}
}
func lifecycleDecimal(n int64) string { return strconv.FormatInt(n, 10) }
func lifecycleNumber(v string) int64  { n, _ := strconv.ParseInt(v, 10, 64); return n }
func lifecycleSamePointer(a, b *string) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}
func lifecycleIdentity(user, worker string) error {
	owner, err := model.CanonicalID(user)
	if err != nil || owner != user || user == "00000000-0000-0000-0000-000000000000" {
		return &model.Fault{Code: "invalid_input", Message: "Worker owner identity is invalid."}
	}
	id, err := model.CanonicalID(worker)
	if err != nil {
		return err
	}
	if id != worker || id == "00000000-0000-0000-0000-000000000000" {
		return &model.Fault{Code: "invalid_input", Message: "Worker identity is invalid."}
	}
	return nil
}
func lifecycleMarshal(v any) json.RawMessage { raw, _ := json.Marshal(v); return raw }

func lifecycleStoredResult(o model.LifecycleOperation) model.LifecycleOperationResult {
	kind := o.RequestKind
	if o.State == "not_committed" {
		kind = "not_committed"
	}
	return model.LifecycleOperationResult{Kind: kind, Receipt: o.Receipt, Activation: o.Activation, ActivationOutcome: o.ActivationOutcome}
}
func lifecycleExisting(ctx context.Context, d store.WorkerLifecycleReader, user, worker, id, kind string, hash []byte) (model.LifecycleOperation, bool, error) {
	o, err := d.Operation(ctx, user, worker, id)
	if errors.Is(err, model.ErrNotFound) {
		return o, false, nil
	}
	if err != nil {
		return o, false, err
	}
	if o.RequestKind != kind || !bytes.Equal(o.RequestHash, hash) {
		return o, true, lifecycleFault("operation_conflict")
	}
	if o.State == "not_committed" {
		return o, true, lifecycleFault("operation_resolved_not_committed")
	}
	return o, true, nil
}
func lifecycleNewOperation(user, worker, id, kind, action, source string, hash []byte, request json.RawMessage, version int64, receipt any, now time.Time) model.LifecycleOperation {
	return model.LifecycleOperation{UserID: user, WorkerID: worker, OperationID: id, Action: action, Source: source, RequestKind: kind, RequestHash: hash, Request: request, IntentVersion: version, State: "applied", Receipt: lifecycleMarshal(receipt), ActivationOutcome: "not_started", CreatedAt: now, UpdatedAt: now}
}
func lifecycleChangeState(ctx context.Context, d store.WorkerLifecycleDAO, o model.LifecycleOperation, state string, code *string, now time.Time) error {
	if o.RequestKind != "intent" || o.State == "not_committed" {
		return nil
	}
	var receipt model.LifecycleIntentReceipt
	if err := json.Unmarshal(o.Receipt, &receipt); err != nil {
		return fmt.Errorf("decode lifecycle intent receipt: %w", err)
	}
	receipt.State, receipt.ErrorCode = state, code
	o.State, o.ErrorCode, o.UpdatedAt = state, code, now
	o.Receipt = lifecycleMarshal(receipt)
	return d.SaveOperation(ctx, o)
}
func lifecycleCurrent(ctx context.Context, d store.WorkerLifecycleReader, user, worker string) (model.WorkerLifecycle, error) {
	state, err := d.Lifecycle(ctx, user, worker)
	if err != nil {
		return state, err
	}
	if state.CapabilityVersion == nil || *state.CapabilityVersion != 1 {
		return state, lifecycleFault("lifecycle_unsupported")
	}
	return state, nil
}

func LifecycleGet(ctx context.Context, d store.WorkerLifecycleReader, user, worker string, now time.Time) (model.LifecycleResource, error) {
	var r model.LifecycleResource
	if err := lifecycleIdentity(user, worker); err != nil {
		return r, err
	}
	s, err := d.Lifecycle(ctx, user, worker)
	if err != nil {
		return r, err
	}
	r = model.LifecycleResource{ProtocolVersion: 1, WorkerID: worker, IntentVersion: lifecycleDecimal(s.IntentVersion), Desired: s.Desired, Admission: s.Admission, OperationID: s.CurrentOperationID, Capability: "unsupported", ObservedAt: now}
	if s.CapabilityVersion != nil && *s.CapabilityVersion == 1 {
		r.Capability = "supported"
	}
	if s.InstanceID != nil {
		r.Instance = &model.LifecycleInstance{InstanceID: *s.InstanceID}
	}
	o, err := d.Observation(ctx, user, worker)
	if errors.Is(err, model.ErrNotFound) {
		return r, nil
	}
	if err != nil {
		return r, err
	}
	if s.InstanceID != nil && o.Envelope.InstanceID == *s.InstanceID && o.Envelope.IntentVersion == lifecycleDecimal(s.IntentVersion) {
		e := o.Envelope
		r.Observation = &model.LifecycleObservedEnvelope{ProtocolVersion: 1, InstanceID: e.InstanceID, IntentVersion: e.IntentVersion, OperationID: e.OperationID, LocalEpoch: e.LocalEpoch, ScopeGeneration: e.ScopeGeneration, ReportSequence: e.ReportSequence, Observation: model.LifecycleObservedObservation{LifecycleObservation: e.Observation, ReceivedAt: o.ReceivedAt, FreshUntil: o.ReceivedAt.Add(LifecycleFreshness)}}
	}
	return r, nil
}
func LifecycleGetOperation(ctx context.Context, d store.WorkerLifecycleReader, user, worker, id string) (model.LifecycleOperationResult, error) {
	if err := lifecycleIdentity(user, worker); err != nil {
		return model.LifecycleOperationResult{}, err
	}
	canonical, err := model.CanonicalID(id)
	if err != nil || canonical != id || id == "00000000-0000-0000-0000-000000000000" {
		return model.LifecycleOperationResult{}, &model.Fault{Code: "invalid_input", Message: "Worker lifecycle operation identity is invalid."}
	}
	o, err := d.Operation(ctx, user, worker, id)
	if err != nil {
		return model.LifecycleOperationResult{}, err
	}
	return lifecycleStoredResult(o), nil
}

func LifecycleRegister(ctx context.Context, d store.WorkerLifecycleDAO, user, worker string, r model.LifecycleInstanceRequest, now time.Time) (model.LifecycleInstanceReceipt, error) {
	var receipt model.LifecycleInstanceReceipt
	if err := lifecycleIdentity(user, worker); err != nil {
		return receipt, err
	}
	if err := protocol.ValidateLifecycleInstance(r); err != nil {
		return receipt, err
	}
	hash, raw, err := protocol.LifecycleRequestHash("instance", r)
	if err != nil {
		return receipt, err
	}
	if err = d.LockWorker(ctx, user, worker); err != nil {
		return receipt, err
	}
	prior, exists, err := lifecycleExisting(ctx, d, user, worker, r.OperationID, "instance", hash)
	if err != nil {
		return receipt, err
	}
	if exists {
		err = json.Unmarshal(prior.Receipt, &receipt)
		return receipt, err
	}
	s, err := d.Lifecycle(ctx, user, worker)
	if errors.Is(err, model.ErrNotFound) {
		s = model.WorkerLifecycle{UserID: user, WorkerID: worker, ProtocolVersion: 1, IntentVersion: 1, Desired: "enabled", Admission: "closed"}
	} else if err != nil {
		return receipt, err
	}
	s.ReconnectAllowed = s.Desired == "enabled" && (s.Admission == "open" || s.ReconnectAllowed)
	s.InstanceID = &r.InstanceID
	s.Admission = "closed"
	capability := 1
	s.CapabilityVersion = &capability
	s.UpdatedAt = now
	receipt = model.LifecycleInstanceReceipt{ProtocolVersion: 1, WorkerID: worker, InstanceID: r.InstanceID, IntentVersion: lifecycleDecimal(s.IntentVersion), Desired: s.Desired, Admission: "closed", OperationID: r.OperationID, ReconnectAllowed: s.ReconnectAllowed, ObservedAt: now}
	if err = d.SaveLifecycle(ctx, s); err != nil {
		return receipt, err
	}
	if err = d.DeleteObservation(ctx, user, worker); err != nil {
		return receipt, err
	}
	o := lifecycleNewOperation(user, worker, r.OperationID, "instance", "instance", "worker", hash, raw, s.IntentVersion, receipt, now)
	return receipt, d.SaveOperation(ctx, o)
}

func LifecycleIntent(ctx context.Context, d store.WorkerLifecycleDAO, user, worker string, r model.LifecycleIntentRequest, now time.Time) (model.LifecycleIntentReceipt, error) {
	var receipt model.LifecycleIntentReceipt
	if err := lifecycleIdentity(user, worker); err != nil {
		return receipt, err
	}
	if err := protocol.ValidateLifecycleIntent(r); err != nil {
		return receipt, err
	}
	hash, raw, err := protocol.LifecycleRequestHash("intent", r)
	if err != nil {
		return receipt, err
	}
	if err = d.LockWorker(ctx, user, worker); err != nil {
		return receipt, err
	}
	prior, exists, err := lifecycleExisting(ctx, d, user, worker, r.OperationID, "intent", hash)
	if err != nil {
		return receipt, err
	}
	if exists {
		err = json.Unmarshal(prior.Receipt, &receipt)
		return receipt, err
	}
	s, err := lifecycleCurrent(ctx, d, user, worker)
	if err != nil {
		return receipt, err
	}
	if r.ExpectedVersion != lifecycleDecimal(s.IntentVersion) {
		return receipt, lifecycleFault("version_conflict")
	}
	if s.IntentVersion == math.MaxInt64 {
		return receipt, lifecycleFault("lifecycle_unavailable")
	}
	if r.Action == "resume" {
		if s.InstanceID == nil || *s.InstanceID != *r.InstanceID {
			return receipt, lifecycleFault("stale_instance")
		}
		o, e := d.Observation(ctx, user, worker)
		if errors.Is(e, model.ErrNotFound) {
			return receipt, lifecycleFault("disable_incomplete")
		}
		if e != nil {
			return receipt, e
		}
		if !lifecycleFresh(s, o, now) || o.Envelope.LocalEpoch != *r.LocalEpoch {
			return receipt, lifecycleFault("stale_report")
		}
		if o.Envelope.Observation.Phase == "blocked" {
			return receipt, lifecycleFault("safety_blocked")
		}
		if s.Admission != "closed" || o.Envelope.Observation.Phase != "disabled" || !lifecycleResumeSafe(o.Envelope.Observation) {
			return receipt, lifecycleFault("disable_incomplete")
		}
	}
	if s.CurrentOperationID != nil {
		prior, e := d.Operation(ctx, user, worker, *s.CurrentOperationID)
		if e != nil {
			return receipt, e
		}
		if e = lifecycleChangeState(ctx, d, prior, "superseded", nil, now); e != nil {
			return receipt, e
		}
	}
	s.IntentVersion++
	s.Desired = "disabled"
	if r.Action == "resume" {
		s.Desired = "enabled"
	}
	s.Admission = "closed"
	s.CurrentOperationID = &r.OperationID
	s.ReconnectAllowed = false
	s.UpdatedAt = now
	receipt = model.LifecycleIntentReceipt{ProtocolVersion: 1, WorkerID: worker, OperationID: r.OperationID, Action: r.Action, IntentVersion: lifecycleDecimal(s.IntentVersion), Desired: s.Desired, Admission: "closed", State: "accepted", ObservedAt: now}
	if err = d.SaveLifecycle(ctx, s); err != nil {
		return receipt, err
	}
	if err = d.DeleteObservation(ctx, user, worker); err != nil {
		return receipt, err
	}
	o := lifecycleNewOperation(user, worker, r.OperationID, "intent", r.Action, r.Source, hash, raw, s.IntentVersion, receipt, now)
	o.State = "accepted"
	return receipt, d.SaveOperation(ctx, o)
}

func lifecycleFresh(s model.WorkerLifecycle, o model.LifecycleStoredObservation, now time.Time) bool {
	e := o.Envelope
	return s.InstanceID != nil && e.InstanceID == *s.InstanceID && e.IntentVersion == lifecycleDecimal(s.IntentVersion) && lifecycleSamePointer(e.OperationID, s.CurrentOperationID) && !now.Before(o.ReceivedAt) && now.Before(o.ReceivedAt.Add(LifecycleFreshness))
}

// An interrupted local handshake needs a new explicit intent, while its
// complete stop/save proof remains usable for that intent.
func lifecycleResumeSafe(o model.LifecycleObservation) bool {
	if o.ErrorCode != nil && *o.ErrorCode == "resume_interrupted" {
		o.ErrorCode = nil
	}
	return lifecycleSafe(o)
}

func lifecycleSafe(o model.LifecycleObservation) bool {
	return o.Stop == "confirmed" && o.Save == "durable" && o.InventoryComplete && o.ResourceCount != nil && o.StoppedCount != nil && o.PendingCount != nil && o.BlockedCount != nil && *o.ResourceCount == *o.StoppedCount && *o.PendingCount == 0 && *o.BlockedCount == 0 && (o.ErrorCode == nil || *o.ErrorCode == "upload_failed")
}

func LifecycleActivate(ctx context.Context, d store.WorkerLifecycleDAO, user, worker string, r model.LifecycleActivationRequest, now time.Time) (model.LifecycleActivationReceipt, error) {
	var receipt model.LifecycleActivationReceipt
	if err := lifecycleIdentity(user, worker); err != nil {
		return receipt, err
	}
	if err := protocol.ValidateLifecycleActivation(r); err != nil {
		return receipt, err
	}
	hash, raw, err := protocol.LifecycleRequestHash("activation", r)
	if err != nil {
		return receipt, err
	}
	if err = d.LockWorker(ctx, user, worker); err != nil {
		return receipt, err
	}
	var op model.LifecycleOperation
	if r.Action == "" {
		op, err = d.Operation(ctx, user, worker, r.OperationID)
		if err != nil {
			return receipt, err
		}
		if op.State == "not_committed" && op.RequestKind == "activation" && bytes.Equal(op.RequestHash, hash) {
			return receipt, lifecycleFault("operation_resolved_not_committed")
		}
		if op.RequestKind != "intent" || op.Action != "resume" {
			return receipt, lifecycleFault("operation_conflict")
		}
		if len(op.ActivationHash) > 0 {
			if !bytes.Equal(op.ActivationHash, hash) {
				return receipt, lifecycleFault("operation_conflict")
			}
			if op.ActivationOutcome == "not_committed" {
				return receipt, lifecycleFault("operation_resolved_not_committed")
			}
			if op.ActivationOutcome == "committed" {
				err = json.Unmarshal(op.Activation, &receipt)
				return receipt, err
			}
		}
	} else {
		var exists bool
		op, exists, err = lifecycleExisting(ctx, d, user, worker, r.OperationID, "activation", hash)
		if err != nil {
			return receipt, err
		}
		if exists {
			err = json.Unmarshal(op.Receipt, &receipt)
			return receipt, err
		}
	}
	s, err := lifecycleCurrent(ctx, d, user, worker)
	if err != nil {
		return receipt, err
	}
	if s.InstanceID == nil || *s.InstanceID != r.InstanceID {
		return receipt, lifecycleFault("stale_instance")
	}
	if lifecycleDecimal(s.IntentVersion) != r.IntentVersion {
		return receipt, lifecycleFault("stale_intent")
	}
	if s.Desired != "enabled" || s.Admission != "closed" {
		return receipt, lifecycleFault("safety_blocked")
	}
	switch r.Action {
	case "":
		if s.CurrentOperationID == nil || *s.CurrentOperationID != r.OperationID || op.IntentVersion != s.IntentVersion || op.State == "superseded" {
			return receipt, lifecycleFault("stale_intent")
		}
		original, e := protocol.ParseLifecycleIntent(op.Request)
		if e != nil {
			return receipt, e
		}
		if original.LocalEpoch == nil || *original.LocalEpoch != r.LocalEpoch || original.InstanceID == nil || *original.InstanceID != r.InstanceID {
			return receipt, lifecycleFault("stale_report")
		}
	case "bootstrap":
		if s.BootstrapConsumed || s.IntentVersion != 1 || s.CurrentOperationID != nil {
			return receipt, lifecycleFault("safety_blocked")
		}
	case "reconnect":
		if !s.ReconnectAllowed {
			return receipt, lifecycleFault("safety_blocked")
		}
	}
	observation, err := d.Observation(ctx, user, worker)
	if errors.Is(err, model.ErrNotFound) {
		return receipt, lifecycleFault("safety_blocked")
	}
	if err != nil {
		return receipt, err
	}
	e := observation.Envelope
	if !lifecycleFresh(s, observation, now) || e.LocalEpoch != r.LocalEpoch || e.ScopeGeneration != r.ScopeGeneration || e.ReportSequence != r.ReportSequence {
		return receipt, lifecycleFault("stale_report")
	}
	if e.Observation.Phase != "resuming" || !lifecycleSafe(e.Observation) {
		return receipt, lifecycleFault("safety_blocked")
	}
	action := r.Action
	if action == "" {
		action = "resume"
	}
	receipt = model.LifecycleActivationReceipt{ProtocolVersion: 1, WorkerID: worker, OperationID: r.OperationID, Action: action, InstanceID: r.InstanceID, IntentVersion: r.IntentVersion, LocalEpoch: r.LocalEpoch, ScopeGeneration: r.ScopeGeneration, Admission: "open", ObservedAt: now}
	s.Admission = "open"
	s.ReconnectAllowed = false
	if action == "bootstrap" {
		s.BootstrapConsumed = true
	}
	s.UpdatedAt = now
	if err = d.SaveLifecycle(ctx, s); err != nil {
		return receipt, err
	}
	if action == "resume" {
		op.Activation = lifecycleMarshal(receipt)
		op.ActivationRequest = raw
		op.ActivationHash = hash
		op.ActivationOutcome = "committed"
		return receipt, lifecycleChangeState(ctx, d, op, "applied", nil, now)
	}
	op = lifecycleNewOperation(user, worker, r.OperationID, "activation", action, "worker", hash, raw, s.IntentVersion, receipt, now)
	return receipt, d.SaveOperation(ctx, op)
}

func LifecycleObserve(ctx context.Context, d store.WorkerLifecycleDAO, user, worker string, r model.LifecycleObservationEnvelope, now time.Time) (model.LifecycleObservationReceipt, error) {
	var receipt model.LifecycleObservationReceipt
	if err := lifecycleIdentity(user, worker); err != nil {
		return receipt, err
	}
	if err := protocol.ValidateLifecycleObservation(r); err != nil {
		return receipt, err
	}
	if err := d.LockWorker(ctx, user, worker); err != nil {
		return receipt, err
	}
	s, err := lifecycleCurrent(ctx, d, user, worker)
	if err != nil {
		return receipt, err
	}
	if s.InstanceID == nil || r.InstanceID != *s.InstanceID {
		return receipt, lifecycleFault("stale_instance")
	}
	if r.IntentVersion != lifecycleDecimal(s.IntentVersion) || !lifecycleSamePointer(r.OperationID, s.CurrentOperationID) {
		return receipt, lifecycleFault("stale_intent")
	}
	previous, err := d.Observation(ctx, user, worker)
	if err != nil && !errors.Is(err, model.ErrNotFound) {
		return receipt, err
	}
	if err == nil {
		if lifecycleNumber(r.ReportSequence) < lifecycleNumber(previous.Envelope.ReportSequence) {
			return receipt, lifecycleFault("stale_report")
		}
		if r.ReportSequence == previous.Envelope.ReportSequence {
			if !bytes.Equal(lifecycleMarshal(r), lifecycleMarshal(previous.Envelope)) {
				return receipt, lifecycleFault("stale_report")
			}
			return model.LifecycleObservationReceipt{ProtocolVersion: 1, Accepted: true, IntentVersion: r.IntentVersion, InstanceID: r.InstanceID, ReportSequence: r.ReportSequence, ReceivedAt: previous.ReceivedAt}, nil
		}
		if lifecycleNumber(r.LocalEpoch) < lifecycleNumber(previous.Envelope.LocalEpoch) || lifecycleNumber(r.ScopeGeneration) < lifecycleNumber(previous.Envelope.ScopeGeneration) || lifecycleNumber(r.Observation.InventoryRevision) < lifecycleNumber(previous.Envelope.Observation.InventoryRevision) {
			return receipt, lifecycleFault("stale_report")
		}
	}
	if r.Observation.Phase == "accepting" && (s.Admission != "open" || s.Desired != "enabled") {
		return receipt, lifecycleFault("safety_blocked")
	}
	if r.Observation.Phase == "disabled" && s.Admission != "closed" {
		return receipt, lifecycleFault("safety_blocked")
	}
	if err = d.SaveObservation(ctx, model.LifecycleStoredObservation{UserID: user, WorkerID: worker, Envelope: r, ReceivedAt: now}); err != nil {
		return receipt, err
	}
	if s.CurrentOperationID != nil {
		op, e := d.Operation(ctx, user, worker, *s.CurrentOperationID)
		if e != nil {
			return receipt, e
		}
		if op.Action == "disable" && r.Observation.Phase == "disabled" && lifecycleSafe(r.Observation) {
			if e = lifecycleChangeState(ctx, d, op, "applied", nil, now); e != nil {
				return receipt, e
			}
		} else if r.Observation.Phase == "blocked" {
			if e = lifecycleChangeState(ctx, d, op, "blocked", r.Observation.ErrorCode, now); e != nil {
				return receipt, e
			}
		}
	}
	return model.LifecycleObservationReceipt{ProtocolVersion: 1, Accepted: true, IntentVersion: r.IntentVersion, InstanceID: r.InstanceID, ReportSequence: r.ReportSequence, ReceivedAt: now}, nil
}

func LifecycleResolve(ctx context.Context, d store.WorkerLifecycleDAO, user, worker, id string, r model.LifecycleResolveRequest, now time.Time) (model.LifecycleOperationResult, error) {
	var result model.LifecycleOperationResult
	if err := lifecycleIdentity(user, worker); err != nil {
		return result, err
	}
	if r.ProtocolVersion != 1 {
		return result, &model.Fault{Code: "invalid_input", Message: "Worker lifecycle protocol is invalid."}
	}
	originalID, original, err := protocol.LifecycleOriginal(r.RequestKind, r.Request)
	if err != nil {
		return result, err
	}
	if originalID != id {
		return result, lifecycleFault("operation_conflict")
	}
	hash, raw, err := protocol.LifecycleRequestHash(r.RequestKind, original)
	if err != nil {
		return result, err
	}
	if err = d.LockWorker(ctx, user, worker); err != nil {
		return result, err
	}
	op, err := d.Operation(ctx, user, worker, id)
	if err == nil {
		if r.RequestKind == "activation" && op.RequestKind == "intent" && op.Action == "resume" {
			request, ok := original.(model.LifecycleActivationRequest)
			if !ok || request.Action != "" {
				return result, lifecycleFault("operation_conflict")
			}
			intent, parseErr := protocol.ParseLifecycleIntent(op.Request)
			if parseErr != nil {
				return result, parseErr
			}
			if intent.InstanceID == nil || intent.LocalEpoch == nil || request.InstanceID != *intent.InstanceID || request.LocalEpoch != *intent.LocalEpoch || request.IntentVersion != lifecycleDecimal(op.IntentVersion) {
				return result, lifecycleFault("operation_conflict")
			}
			if len(op.ActivationHash) > 0 {
				if !bytes.Equal(op.ActivationHash, hash) {
					return result, lifecycleFault("operation_conflict")
				}
				return lifecycleStoredResult(op), nil
			}
			op.ActivationRequest = raw
			op.ActivationHash = hash
			op.ActivationOutcome = "not_committed"
			op.UpdatedAt = now
			if err = d.SaveOperation(ctx, op); err != nil {
				return result, err
			}
			return lifecycleStoredResult(op), nil
		}
		if op.RequestKind != r.RequestKind || !bytes.Equal(op.RequestHash, hash) {
			return result, lifecycleFault("operation_conflict")
		}
		return lifecycleStoredResult(op), nil
	}
	if !errors.Is(err, model.ErrNotFound) {
		return result, err
	}
	version := int64(1)
	state, e := d.Lifecycle(ctx, user, worker)
	if e == nil {
		version = state.IntentVersion
	} else if !errors.Is(e, model.ErrNotFound) {
		return result, e
	}
	receipt := model.LifecycleResolutionReceipt{ProtocolVersion: 1, WorkerID: worker, OperationID: id, RequestKind: r.RequestKind, RequestHash: hex.EncodeToString(hash), Outcome: "not_committed", ObservedAt: now}
	action, source := "instance", "worker"
	switch v := original.(type) {
	case model.LifecycleIntentRequest:
		action, source = v.Action, v.Source
	case model.LifecycleActivationRequest:
		action = v.Action
		if action == "" {
			action = "resume"
		}
	}
	op = lifecycleNewOperation(user, worker, id, r.RequestKind, action, source, hash, raw, version, receipt, now)
	op.State = "not_committed"
	if err = d.SaveOperation(ctx, op); err != nil {
		return result, err
	}
	return lifecycleStoredResult(op), nil
}
