package httpx

import (
	"encoding/json"
	"testing"
)

func TestWorkerMachineInput(t *testing.T) {
	machine, err := WorkerMachineInput(json.RawMessage(`{"id":"machine-id","name":"host"}`))
	if err != nil || machine.ID != "machine-id" || machine.Name != "host" {
		t.Fatalf("valid machine: %#v %v", machine, err)
	}
	for _, input := range []string{`null`, `{"id":"x","name":"host","extra":1}`, `{"name":"host"}`, `{"id":"x","name":null}`} {
		if _, err := WorkerMachineInput(json.RawMessage(input)); err == nil {
			t.Fatalf("accepted invalid machine: %s", input)
		}
	}
}
