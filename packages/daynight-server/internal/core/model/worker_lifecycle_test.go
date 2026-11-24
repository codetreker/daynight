package model

import (
	"encoding/json"
	"testing"
)

func TestLifecycleIntentEncodingKeepsVariantNulls(t *testing.T) {
	for _, action := range []string{"disable", "resume"} {
		v := LifecycleIntentRequest{ProtocolVersion: 1, OperationID: "id", Action: action, ExpectedVersion: "1", Source: "web"}
		raw, e := json.Marshal(v)
		if e != nil {
			t.Fatal(e)
		}
		var fields map[string]json.RawMessage
		if e = json.Unmarshal(raw, &fields); e != nil {
			t.Fatal(e)
		}
		if string(fields["localEpoch"]) != "null" {
			t.Fatal("omitted required null")
		}
		key := "originOperationId"
		other := "instanceId"
		if action == "resume" {
			key, other = other, key
		}
		if _, ok := fields[key]; !ok {
			t.Fatal("missing variant field")
		}
		if _, ok := fields[other]; ok {
			t.Fatal("leaked other variant")
		}
		var round LifecycleIntentRequest
		if e = json.Unmarshal(raw, &round); e != nil || round.Action != action {
			t.Fatalf("roundtrip %+v %v", round, e)
		}
	}
	var invalid LifecycleIntentRequest
	if e := invalid.UnmarshalJSON([]byte(`{"protocolVersion":"bad"}`)); e == nil {
		t.Fatal("invalid intent field")
	}
}
func TestLifecycleResultEncodingIsDiscriminated(t *testing.T) {
	for _, kind := range []string{"intent", "instance", "activation", "not_committed"} {
		v := LifecycleOperationResult{Kind: kind, Receipt: json.RawMessage(`{"value":1}`), ActivationOutcome: "not_started"}
		raw, e := json.Marshal(v)
		if e != nil {
			t.Fatal(e)
		}
		var fields map[string]json.RawMessage
		if e = json.Unmarshal(raw, &fields); e != nil {
			t.Fatal(e)
		}
		want := 2
		if kind == "intent" {
			want = 4
			if string(fields["activation"]) != "null" {
				t.Fatal("missing activation null")
			}
		}
		if len(fields) != want {
			t.Fatalf("variant %s has %d keys", kind, len(fields))
		}
	}
}
