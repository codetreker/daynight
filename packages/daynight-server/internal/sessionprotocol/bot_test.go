package sessionprotocol

import (
	"encoding/json"
	"testing"
)

func TestBotGrantKeepsIndependentRecoveryBoundary(t *testing.T) {
	previous := "1"
	g := Grant{Protocol: Protocol, TestExecutionID: "10000000-0000-0000-0000-000000000001", ControllerID: "10000000-0000-0000-0000-000000000002", ControllerInstanceID: "10000000-0000-0000-0000-000000000003", ExecutionGeneration: "2", Kind: "bootstrap", PreviousGeneration: &previous, StopProof: &StopProof{RecordID: "10000000-0000-0000-0000-000000000004", PreviousControllerInstanceID: "10000000-0000-0000-0000-000000000005", StoppedAt: "2026-11-04T00:00:00Z"}}
	raw, _ := json.Marshal(g)
	if _, err := DecodeBotGrant(raw); err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeTestGrant(raw); err == nil {
		t.Fatal("ordinary Test accepted recovery")
	}
	if _, err := DecodeGrant(raw); err == nil {
		t.Fatal("task accepted independent identity")
	}
	for _, mutate := range []func(*Grant){
		func(g *Grant) { g.ClaimID = g.TestExecutionID },
		func(g *Grant) { g.TestExecutionID = "" },
		func(g *Grant) { g.PreviousGeneration = nil },
		func(g *Grant) { g.StopProof = nil },
		func(g *Grant) { proof := *g.StopProof; proof.Kind = "never_started"; g.StopProof = &proof },
	} {
		bad := g
		mutate(&bad)
		raw, _ := json.Marshal(bad)
		if _, err := DecodeBotGrant(raw); err == nil {
			t.Fatalf("invalid Bot grant accepted: %s", raw)
		}
	}
	g.PreviousGeneration, g.StopProof = nil, nil
	raw, _ = json.Marshal(g)
	if _, err := DecodeBotGrant(raw); err != nil {
		t.Fatal("ordinary grant failed", err)
	}
}
