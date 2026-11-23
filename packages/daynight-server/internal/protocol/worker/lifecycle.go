package worker

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"reflect"
	"strconv"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
)

const LifecycleHeader = "X-Daynight-Worker-Lifecycle"
const MaxLifecycleObservationBytes = 256 * 1024

func lifecycleInvalid() error {
	return &model.Fault{Code: "invalid_input", Message: "Worker lifecycle input is invalid."}
}
func validLifecycleID(v string) bool {
	id, err := model.CanonicalID(v)
	return err == nil && id == v && id != "00000000-0000-0000-0000-000000000000"
}
func validLifecycleVersion(v string) bool {
	n, err := strconv.ParseInt(v, 10, 64)
	return err == nil && n > 0 && strconv.FormatInt(n, 10) == v
}
func optionalID(v *string) bool      { return v == nil || validLifecycleID(*v) }
func optionalVersion(v *string) bool { return v == nil || validLifecycleVersion(*v) }
func oneOf(v string, values ...string) bool {
	for _, s := range values {
		if s == v {
			return true
		}
	}
	return false
}
func diagnostic(v *string) bool {
	return v == nil || oneOf(*v, "identity_mismatch", "authority_unavailable", "persistence_failed", "inventory_incomplete", "stop_timeout", "stop_unknown", "save_failed", "upload_failed", "native_unrecoverable", "ownership_changed", "independent_blocker", "unsupported_provider", "resume_interrupted")
}

// exactLifecycle recursively enforces complete objects, including required null
// fields. Ordinary decoding alone cannot distinguish omitted nulls and zeroes.
func exactLifecycle(data []byte, t reflect.Type) error {
	if t.Kind() == reflect.Pointer {
		if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
			return nil
		}
		return exactLifecycle(data, t.Elem())
	}
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return lifecycleInvalid()
	}
	switch t.Kind() {
	case reflect.Struct:
		keys := make([]string, 0, t.NumField())
		types := map[string]reflect.Type{}
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			key := strings.Split(f.Tag.Get("json"), ",")[0]
			keys = append(keys, key)
			types[key] = f.Type
		}
		fields, err := jsonobject.Decode(data, "Worker lifecycle", keys...)
		if err != nil || len(fields) != len(keys) {
			return lifecycleInvalid()
		}
		for key, raw := range fields {
			if err := exactLifecycle(raw, types[key]); err != nil {
				return err
			}
		}
	case reflect.Slice:
		var values []json.RawMessage
		if json.Unmarshal(data, &values) != nil {
			return lifecycleInvalid()
		}
		for _, raw := range values {
			if err := exactLifecycle(raw, t.Elem()); err != nil {
				return err
			}
		}
	}
	return nil
}
func decodeLifecycle[T any](data []byte) (T, error) {
	var v T
	if err := exactLifecycle(data, reflect.TypeOf(v)); err != nil {
		return v, err
	}
	if json.Unmarshal(data, &v) != nil {
		return v, lifecycleInvalid()
	}
	return v, nil
}
func exactKeys(data []byte, keys ...string) (map[string]json.RawMessage, error) {
	m, e := jsonobject.Decode(data, "Worker lifecycle", keys...)
	if e != nil || len(m) != len(keys) {
		return nil, lifecycleInvalid()
	}
	return m, nil
}

func ValidateLifecycleInstance(v model.LifecycleInstanceRequest) error {
	if v.ProtocolVersion != 1 || !validLifecycleID(v.OperationID) || !validLifecycleID(v.InstanceID) || !optionalVersion(v.PreviousInstanceEpoch) || !oneOf(v.Platform, "windows", "linux", "macos") {
		return lifecycleInvalid()
	}
	if !v.Capabilities.Disable || !v.Capabilities.Resume || v.Capabilities.Inventory != 1 || v.Capabilities.DispatchFence != 1 {
		return &model.Fault{Code: "lifecycle_unsupported", Message: "Worker lifecycle capability is incomplete."}
	}
	return nil
}
func ParseLifecycleInstance(data []byte) (model.LifecycleInstanceRequest, error) {
	v, e := decodeLifecycle[model.LifecycleInstanceRequest](data)
	if e == nil {
		e = ValidateLifecycleInstance(v)
	}
	return v, e
}

func ValidateLifecycleIntent(v model.LifecycleIntentRequest) error {
	if v.ProtocolVersion != 1 || !validLifecycleID(v.OperationID) || !validLifecycleVersion(v.ExpectedVersion) || !oneOf(v.Source, "web", "local") {
		return lifecycleInvalid()
	}
	switch v.Action {
	case "disable":
		if v.InstanceEpoch != nil {
			return lifecycleInvalid()
		}
		if v.Source == "web" {
			if v.LocalEpoch != nil || v.OriginOperationID != nil {
				return lifecycleInvalid()
			}
		} else if v.LocalEpoch == nil || v.OriginOperationID == nil || !validLifecycleVersion(*v.LocalEpoch) || !validLifecycleID(*v.OriginOperationID) {
			return lifecycleInvalid()
		}
	case "resume":
		if v.OriginOperationID != nil || v.LocalEpoch == nil || v.InstanceEpoch == nil || !validLifecycleVersion(*v.LocalEpoch) || !validLifecycleVersion(*v.InstanceEpoch) {
			return lifecycleInvalid()
		}
	default:
		return lifecycleInvalid()
	}
	return nil
}
func ParseLifecycleIntent(data []byte) (model.LifecycleIntentRequest, error) {
	var v model.LifecycleIntentRequest
	var selector struct {
		Action string `json:"action"`
	}
	if json.Unmarshal(data, &selector) != nil {
		return v, lifecycleInvalid()
	}
	keys := []string{"protocolVersion", "operationId", "action", "expectedVersion", "source", "localEpoch"}
	if selector.Action == "disable" {
		keys = append(keys, "originOperationId")
	} else {
		keys = append(keys, "instanceEpoch")
	}
	m, e := exactKeys(data, keys...)
	if e != nil {
		return v, e
	}
	for _, key := range []string{"protocolVersion", "operationId", "action", "expectedVersion", "source"} {
		if bytes.Equal(bytes.TrimSpace(m[key]), []byte("null")) {
			return v, lifecycleInvalid()
		}
	}
	if json.Unmarshal(data, &v) != nil {
		return v, lifecycleInvalid()
	}
	return v, ValidateLifecycleIntent(v)
}
func ValidateLifecycleActivation(v model.LifecycleActivationRequest) error {
	if v.ProtocolVersion != 1 || !validLifecycleID(v.OperationID) || !validLifecycleID(v.InstanceID) || !oneOf(v.Action, "", "bootstrap", "reconnect") {
		return lifecycleInvalid()
	}
	for _, s := range []string{v.InstanceEpoch, v.IntentVersion, v.LocalEpoch, v.ScopeGeneration, v.ReportSequence} {
		if !validLifecycleVersion(s) {
			return lifecycleInvalid()
		}
	}
	return nil
}
func ParseLifecycleActivation(data []byte) (model.LifecycleActivationRequest, error) {
	var v model.LifecycleActivationRequest
	keys := []string{"protocolVersion", "operationId", "instanceId", "instanceEpoch", "intentVersion", "localEpoch", "scopeGeneration", "reportSequence"}
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil {
		return v, lifecycleInvalid()
	}
	if _, ok := fields["action"]; ok {
		keys = append(keys, "action")
	}
	m, e := exactKeys(data, keys...)
	if e != nil {
		return v, e
	}
	for _, raw := range m {
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return v, lifecycleInvalid()
		}
	}
	if json.Unmarshal(data, &v) != nil {
		return v, lifecycleInvalid()
	}
	if _, ok := fields["action"]; ok && v.Action == "" {
		return v, lifecycleInvalid()
	}
	return v, ValidateLifecycleActivation(v)
}
func ParseLifecycleResolve(data []byte) (model.LifecycleResolveRequest, error) {
	var v model.LifecycleResolveRequest
	m, e := exactKeys(data, "protocolVersion", "requestKind", "request")
	if e != nil {
		return v, e
	}
	if json.Unmarshal(data, &v) != nil || v.ProtocolVersion != 1 {
		return v, lifecycleInvalid()
	}
	_, _, e = LifecycleOriginal(v.RequestKind, m["request"])
	return v, e
}

// LifecycleOriginal validates a request before hashing, so its strings and
// numbers belong to the fixed ASCII lifecycle grammar. This is the RFC 8785
// subset with ASCII keys/strings and integer numbers, without floating point or
// Unicode ordering ambiguities.
func LifecycleOriginal(kind string, raw []byte) (string, any, error) {
	switch kind {
	case "instance":
		v, e := ParseLifecycleInstance(raw)
		return v.OperationID, v, e
	case "intent":
		v, e := ParseLifecycleIntent(raw)
		return v.OperationID, v, e
	case "activation":
		v, e := ParseLifecycleActivation(raw)
		return v.OperationID, v, e
	default:
		return "", nil, lifecycleInvalid()
	}
}
func LifecycleRequestHash(kind string, v any) ([]byte, json.RawMessage, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, nil, err
	}
	if _, _, err = LifecycleOriginal(kind, raw); err != nil {
		return nil, nil, err
	}
	canonical, err := LifecycleCanonicalJSON(raw)
	if err != nil {
		return nil, nil, err
	}
	digest := sha256.Sum256(append([]byte("daynight.lifecycle.v1/"+kind+"\n"), canonical...))
	return digest[:], canonical, nil
}
func LifecycleCanonicalJSON(raw []byte) (json.RawMessage, error) {
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	return json.Marshal(value)
}

func ValidateLifecycleObservation(v model.LifecycleObservationEnvelope) error {
	if v.ProtocolVersion != 1 || !validLifecycleID(v.InstanceID) || !optionalID(v.OperationID) {
		return lifecycleInvalid()
	}
	for _, s := range []string{v.InstanceEpoch, v.IntentVersion, v.LocalEpoch, v.ScopeGeneration, v.ReportSequence, v.Observation.InventoryRevision} {
		if !validLifecycleVersion(s) {
			return lifecycleInvalid()
		}
	}
	o := v.Observation
	if !oneOf(o.Phase, "accepting", "disabling", "disabled", "blocked", "resuming") || !oneOf(o.Stop, "not_started", "stopping", "confirmed", "unknown") || !oneOf(o.Save, "pending", "durable", "failed") || !oneOf(o.Sync, "pending", "complete", "failed") || !diagnostic(o.ErrorCode) {
		return lifecycleInvalid()
	}
	if len(o.InventoryDigest) != 64 || strings.Trim(o.InventoryDigest, "0123456789abcdef") != "" || o.Resources == nil || o.Recovery == nil || len(o.Resources) > 512 || len(o.Recovery) > 512 {
		return lifecycleInvalid()
	}
	counts := []*int64{o.ResourceCount, o.StoppedCount, o.PendingCount, o.BlockedCount}
	for _, n := range counts {
		if n != nil && (*n < 0 || *n > 9007199254740991) {
			return lifecycleInvalid()
		}
	}
	if o.InventoryComplete {
		for _, n := range counts {
			if n == nil {
				return lifecycleInvalid()
			}
		}
		if *o.StoppedCount > *o.ResourceCount || *o.PendingCount > *o.ResourceCount || *o.BlockedCount > *o.ResourceCount {
			return lifecycleInvalid()
		}
	}
	if o.Stop == "confirmed" && (!o.InventoryComplete || o.ResourceCount == nil || o.StoppedCount == nil || o.PendingCount == nil || o.BlockedCount == nil || *o.ResourceCount != *o.StoppedCount || *o.PendingCount != 0 || *o.BlockedCount != 0) {
		return lifecycleInvalid()
	}
	if o.Save == "durable" && !o.InventoryComplete {
		return lifecycleInvalid()
	}
	if o.Phase == "disabled" && (o.Stop != "confirmed" || o.Save != "durable") {
		return lifecycleInvalid()
	}
	if o.DetailsComplete && (o.ResourceCount == nil || int64(len(o.Resources)) != *o.ResourceCount) {
		return lifecycleInvalid()
	}
	last := ""
	for _, r := range o.Resources {
		if !validLifecycleID(r.ResourceID) || r.ResourceID <= last || !oneOf(r.OwnerKind, "task", "bot", "assistant", "probe", "repository", "configuration", "controller") || !oneOf(r.Stage, "reserved", "running", "stopping", "stopped", "unknown") || !oneOf(r.Stop, "pending", "confirmed", "unknown") || !oneOf(r.Save, "pending", "durable", "failed") || !optionalVersion(r.ExecutionGeneration) || !diagnostic(r.ErrorCode) {
			return lifecycleInvalid()
		}
		last = r.ResourceID
		for _, id := range []*string{r.ProjectID, r.TaskID, r.BotID, r.ExecutionID, r.SessionID} {
			if !optionalID(id) {
				return lifecycleInvalid()
			}
		}
		if o.Stop == "confirmed" && (r.Stop != "confirmed" || r.Stage != "stopped") {
			return lifecycleInvalid()
		}
		if o.Save == "durable" && r.Save != "durable" {
			return lifecycleInvalid()
		}
	}
	last = ""
	for _, r := range o.Recovery {
		if !validLifecycleID(r.ResourceID) || r.ResourceID <= last || !oneOf(r.Recoverability, "unknown", "eligible", "blocked") || !diagnostic(r.ReasonCode) {
			return lifecycleInvalid()
		}
		last = r.ResourceID
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("encode lifecycle observation: %w", err)
	}
	if len(raw) > MaxLifecycleObservationBytes {
		return &model.Fault{Code: "payload_too_large", Message: "Worker lifecycle observation exceeds its limit."}
	}
	return nil
}
func ParseLifecycleObservation(data []byte) (model.LifecycleObservationEnvelope, error) {
	if len(data) > MaxLifecycleObservationBytes {
		return model.LifecycleObservationEnvelope{}, &model.Fault{Code: "payload_too_large", Message: "Worker lifecycle observation exceeds its limit."}
	}
	v, e := decodeLifecycle[model.LifecycleObservationEnvelope](data)
	if e == nil {
		e = ValidateLifecycleObservation(v)
	}
	return v, e
}
