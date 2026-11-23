package worker

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"strings"
	"testing"
)

const lcID = "11111111-1111-4111-8111-111111111111"

func lcPtr[T any](v T) *T { return &v }
func lcJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func lcInstance() model.LifecycleInstanceRequest {
	return model.LifecycleInstanceRequest{ProtocolVersion: 1, OperationID: lcID, InstanceID: lcID, Capabilities: model.LifecycleCapabilities{Disable: true, Resume: true, Inventory: 1, DispatchFence: 1}, Platform: "macos"}
}
func lcObservation() model.LifecycleObservationEnvelope {
	return model.LifecycleObservationEnvelope{ProtocolVersion: 1, InstanceID: lcID, InstanceEpoch: "1", IntentVersion: "1", LocalEpoch: "1", ScopeGeneration: "1", ReportSequence: "1", Observation: model.LifecycleObservation{Phase: "disabled", Stop: "confirmed", Save: "durable", Sync: "complete", InventoryComplete: true, DetailsComplete: true, InventoryRevision: "1", InventoryDigest: strings.Repeat("a", 64), ResourceCount: lcPtr(int64(0)), StoppedCount: lcPtr(int64(0)), PendingCount: lcPtr(int64(0)), BlockedCount: lcPtr(int64(0)), Resources: []model.LifecycleResourceObservation{}, Recovery: []model.LifecycleRecoveryObservation{}}}
}
func TestLifecycleInstanceParsing(t *testing.T) {
	raw := lcJSON(t, lcInstance())
	if _, e := ParseLifecycleInstance(raw); e != nil {
		t.Fatal(e)
	}
	for _, b := range [][]byte{[]byte(`null`), []byte(`[]`), []byte(`{}`), append(append([]byte{}, raw...), raw...), bytes.Replace(raw, []byte(`"previousInstanceEpoch":null,`), nil, 1), bytes.Replace(raw, []byte(`"disable":true`), []byte(`"disable":true,"disable":true`), 1), bytes.Replace(raw, []byte(`"platform":"macos"`), []byte(`"platform":null`), 1), bytes.Replace(raw, []byte(`"inventory":1`), []byte(`"inventory":"1"`), 1), bytes.Replace(raw, []byte(`"inventory":1`), []byte(`"extra":1,"inventory":1`), 1)} {
		if _, e := ParseLifecycleInstance(b); e == nil {
			t.Errorf("accepted %s", b)
		}
	}
	for _, change := range []func(*model.LifecycleInstanceRequest){func(v *model.LifecycleInstanceRequest) { v.ProtocolVersion = 2 }, func(v *model.LifecycleInstanceRequest) { v.OperationID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }, func(v *model.LifecycleInstanceRequest) { v.InstanceID = "00000000-0000-0000-0000-000000000000" }, func(v *model.LifecycleInstanceRequest) { v.PreviousInstanceEpoch = lcPtr("0") }, func(v *model.LifecycleInstanceRequest) { v.Platform = "bsd" }, func(v *model.LifecycleInstanceRequest) { v.Capabilities.Resume = false }} {
		v := lcInstance()
		change(&v)
		if ValidateLifecycleInstance(v) == nil {
			t.Fatal("accepted invalid instance")
		}
	}
}
func TestLifecycleIntentVariantsAndCanonicalHash(t *testing.T) {
	disable := model.LifecycleIntentRequest{ProtocolVersion: 1, OperationID: lcID, Action: "disable", ExpectedVersion: "1", Source: "web"}
	resume := model.LifecycleIntentRequest{ProtocolVersion: 1, OperationID: lcID, Action: "resume", ExpectedVersion: "1", Source: "local", LocalEpoch: lcPtr("1"), InstanceEpoch: lcPtr("1")}
	local := disable
	local.Source = "local"
	local.LocalEpoch = lcPtr("2")
	local.OriginOperationID = lcPtr(lcID)
	for _, v := range []model.LifecycleIntentRequest{disable, resume, local} {
		if _, e := ParseLifecycleIntent(lcJSON(t, v)); e != nil {
			t.Fatal(e)
		}
	}
	for _, change := range []func(*model.LifecycleIntentRequest){func(v *model.LifecycleIntentRequest) { v.Action = "enable" }, func(v *model.LifecycleIntentRequest) { v.ExpectedVersion = "01" }, func(v *model.LifecycleIntentRequest) { v.Source = "worker" }, func(v *model.LifecycleIntentRequest) { v.InstanceEpoch = lcPtr("1") }, func(v *model.LifecycleIntentRequest) { v.LocalEpoch = lcPtr("1") }, func(v *model.LifecycleIntentRequest) { v.ProtocolVersion = 0 }, func(v *model.LifecycleIntentRequest) { v.Source = "local" }} {
		v := disable
		change(&v)
		if ValidateLifecycleIntent(v) == nil {
			t.Fatal("accepted bad intent")
		}
	}
	resume.LocalEpoch = nil
	if ValidateLifecycleIntent(resume) == nil {
		t.Fatal("missing resume epoch")
	}
	raw := lcJSON(t, disable)
	for _, b := range [][]byte{[]byte(`null`), []byte(`[]`), []byte(`{"action":2}`), bytes.Replace(raw, []byte(`"originOperationId":null`), []byte(`"originOperationId":null,"instanceEpoch":"1"`), 1), bytes.Replace(raw, []byte(`"source":"web"`), []byte(`"source":null`), 1), bytes.Replace(raw, []byte(`"localEpoch":null`), []byte(`"localEpoch":false`), 1)} {
		if _, e := ParseLifecycleIntent(b); e == nil {
			t.Fatal("accepted malformed intent")
		}
	}
	hash, canonical, e := LifecycleRequestHash("intent", disable)
	if e != nil {
		t.Fatal(e)
	}
	want := `{"action":"disable","expectedVersion":"1","localEpoch":null,"operationId":"11111111-1111-4111-8111-111111111111","originOperationId":null,"protocolVersion":1,"source":"web"}`
	expected := sha256.Sum256([]byte("daynight.lifecycle.v1/intent\n" + want))
	if string(canonical) != want || !bytes.Equal(hash, expected[:]) {
		t.Fatalf("hash %s", canonical)
	}
	if _, _, e := LifecycleRequestHash("instance", disable); e == nil {
		t.Fatal("wrong domain")
	}
	if _, _, e := LifecycleRequestHash("intent", make(chan int)); e == nil {
		t.Fatal("bad encoder")
	}
	if _, e := LifecycleCanonicalJSON([]byte(`{`)); e == nil {
		t.Fatal("bad canonical input")
	}
}
func TestLifecycleActivationAndResolveParsing(t *testing.T) {
	r := model.LifecycleActivationRequest{ProtocolVersion: 1, OperationID: lcID, InstanceID: lcID, InstanceEpoch: "1", IntentVersion: "1", LocalEpoch: "1", ScopeGeneration: "1", ReportSequence: "1"}
	for _, action := range []string{"", "bootstrap", "reconnect"} {
		r.Action = action
		raw := lcJSON(t, r)
		if _, e := ParseLifecycleActivation(raw); e != nil {
			t.Fatal(e)
		}
		if _, e := ParseLifecycleResolve(lcJSON(t, model.LifecycleResolveRequest{ProtocolVersion: 1, RequestKind: "activation", Request: raw})); e != nil {
			t.Fatal(e)
		}
	}
	r.Action = "resume"
	if ValidateLifecycleActivation(r) == nil {
		t.Fatal("ordinary action must be absent")
	}
	r.Action = ""
	r.InstanceEpoch = "9223372036854775808"
	if ValidateLifecycleActivation(r) == nil {
		t.Fatal("overflow")
	}
	r.InstanceEpoch = "1"
	raw := lcJSON(t, r)
	for _, b := range [][]byte{[]byte(`null`), []byte(`[]`), bytes.Replace(raw, []byte(`"protocolVersion":1`), []byte(`"protocolVersion":null`), 1), bytes.Replace(raw, []byte(`"protocolVersion":1`), []byte(`"protocolVersion":"1"`), 1), append(append([]byte{}, raw[:len(raw)-1]...), []byte(`,"action":""}`)...)} {
		if _, e := ParseLifecycleActivation(b); e == nil {
			t.Fatal("bad activation")
		}
	}
	for _, b := range [][]byte{[]byte(`[]`), []byte(`null`), []byte(`{"protocolVersion":1,"requestKind":"other","request":{}}`), []byte(`{"protocolVersion":0,"requestKind":"instance","request":{}}`)} {
		if _, e := ParseLifecycleResolve(b); e == nil {
			t.Fatal("bad resolve")
		}
	}
}
func TestLifecycleObservationValidation(t *testing.T) {
	v := lcObservation()
	if _, e := ParseLifecycleObservation(lcJSON(t, v)); e != nil {
		t.Fatal(e)
	}
	for _, change := range []func(*model.LifecycleObservationEnvelope){func(v *model.LifecycleObservationEnvelope) { v.ProtocolVersion = 0 }, func(v *model.LifecycleObservationEnvelope) { v.ReportSequence = "0" }, func(v *model.LifecycleObservationEnvelope) { v.Observation.Phase = "ready" }, func(v *model.LifecycleObservationEnvelope) {
		v.Observation.InventoryDigest = "A" + strings.Repeat("a", 63)
	}, func(v *model.LifecycleObservationEnvelope) { v.Observation.ResourceCount = nil }, func(v *model.LifecycleObservationEnvelope) { v.Observation.ResourceCount = lcPtr(int64(-1)) }, func(v *model.LifecycleObservationEnvelope) { v.Observation.InventoryComplete = false }, func(v *model.LifecycleObservationEnvelope) { v.Observation.StoppedCount = lcPtr(int64(1)) }, func(v *model.LifecycleObservationEnvelope) { v.Observation.PendingCount = lcPtr(int64(1)) }, func(v *model.LifecycleObservationEnvelope) { v.Observation.Stop = "stopping" }, func(v *model.LifecycleObservationEnvelope) { v.Observation.Resources = nil }, func(v *model.LifecycleObservationEnvelope) { v.Observation.Recovery = nil }, func(v *model.LifecycleObservationEnvelope) { v.Observation.ErrorCode = lcPtr("/private/path") }, func(v *model.LifecycleObservationEnvelope) {
		v.Observation.Resources = make([]model.LifecycleResourceObservation, 513)
	}, func(v *model.LifecycleObservationEnvelope) {
		v.Observation.Recovery = make([]model.LifecycleRecoveryObservation, 513)
	}} {
		x := lcObservation()
		change(&x)
		if ValidateLifecycleObservation(x) == nil {
			t.Errorf("bad observation %+v", x)
		}
	}
	v.Observation.DetailsComplete = false
	v.Observation.ResourceCount = lcPtr(int64(1000))
	v.Observation.StoppedCount = lcPtr(int64(1000))
	v.Observation.Resources = []model.LifecycleResourceObservation{{ResourceID: lcID, OwnerKind: "task", Stage: "stopped", Stop: "confirmed", Save: "durable"}}
	v.Observation.Recovery = []model.LifecycleRecoveryObservation{{ResourceID: lcID, Recoverability: "blocked", ReasonCode: lcPtr("native_unrecoverable")}}
	if _, e := ParseLifecycleObservation(lcJSON(t, v)); e != nil {
		t.Fatal(e)
	}
	for _, change := range []func(*model.LifecycleObservationEnvelope){func(v *model.LifecycleObservationEnvelope) { v.Observation.Resources[0].ProjectID = lcPtr("bad") }, func(v *model.LifecycleObservationEnvelope) { v.Observation.Resources[0].OwnerKind = "bad" }, func(v *model.LifecycleObservationEnvelope) { v.Observation.Resources[0].Stop = "pending" }, func(v *model.LifecycleObservationEnvelope) { v.Observation.Resources[0].Save = "pending" }, func(v *model.LifecycleObservationEnvelope) {
		v.Observation.Resources = append(v.Observation.Resources, v.Observation.Resources[0])
	}, func(v *model.LifecycleObservationEnvelope) { v.Observation.Recovery[0].Recoverability = "bad" }} {
		var x model.LifecycleObservationEnvelope
		if e := json.Unmarshal(lcJSON(t, v), &x); e != nil {
			t.Fatal(e)
		}
		change(&x)
		if ValidateLifecycleObservation(x) == nil {
			t.Fatal("bad detail")
		}
	}
	if _, e := ParseLifecycleObservation(make([]byte, MaxLifecycleObservationBytes+1)); e == nil {
		t.Fatal("oversize")
	}
	if _, e := ParseLifecycleObservation([]byte(`{}`)); e == nil {
		t.Fatal("missing fields")
	}
	raw := lcJSON(t, v)
	if _, e := ParseLifecycleObservation(bytes.Replace(raw, []byte(`"resources":[`), []byte(`"resources":null,"extra":[`), 1)); e == nil {
		t.Fatal("missing array")
	}
}
