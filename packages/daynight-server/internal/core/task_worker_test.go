package core

import "testing"

func TestWorkerStateAcceptsOnlyOwnershipStates(t *testing.T) {
	for _, test := range []struct {
		wire  string
		valid bool
	}{
		{wire: "active", valid: true},
		{wire: "released", valid: true},
		{wire: "completed", valid: true},
		{wire: "todo"},
		{wire: "in_progress"},
		{wire: "done"},
		{wire: "executing"},
		{wire: ""},
		{wire: "Active"},
		{wire: "active "},
		{wire: " released"},
	} {
		t.Run(test.wire, func(t *testing.T) {
			if got := WorkerState(test.wire).Valid(); got != test.valid {
				t.Fatalf("ownership state %q: validity %t, want %t", test.wire, got, test.valid)
			}
		})
	}
}

func TestWorkerAgentAcceptsSupportedCanonicalAdapters(t *testing.T) {
	for _, test := range []struct {
		wire  string
		valid bool
	}{
		{wire: "codex", valid: true},
		{wire: "copilot", valid: true},
		{wire: "claude", valid: true},
		{wire: "agent"},
		{wire: ""},
		{wire: "Codex"},
		{wire: "COPILOT"},
		{wire: "codex "},
		{wire: "\tcopilot"},
	} {
		t.Run(test.wire, func(t *testing.T) {
			if got := WorkerAgent(test.wire).Valid(); got != test.valid {
				t.Fatalf("agent adapter %q: validity %t, want %t", test.wire, got, test.valid)
			}
		})
	}
}

func TestWorkerControlModeRestrictsNativeAdapterEligibility(t *testing.T) {
	for _, test := range []struct {
		mode      WorkerAgentControlMode
		agent     WorkerAgent
		supported bool
	}{
		{AgentControlModeHerdr, AgentCodex, true},
		{AgentControlModeHerdr, AgentClaude, true},
		{AgentControlModeHerdr, AgentCopilot, true},
		{AgentControlModeWeb, AgentCodex, true},
		{AgentControlModeWeb, AgentClaude, true},
		{AgentControlModeWeb, AgentCopilot, true},
		{AgentControlModeWeb, "unknown", false},
		{AgentControlModeHerdr, "", false},
		{"", AgentCodex, false},
		{"WEB", AgentCodex, false},
		{"web ", AgentClaude, false},
		{"unknown", AgentCodex, false},
	} {
		t.Run(string(test.mode)+"/"+string(test.agent), func(t *testing.T) {
			if got := test.mode.Supports(test.agent); got != test.supported {
				t.Fatalf("execution eligibility = %t, want %t", got, test.supported)
			}
		})
	}
}

func TestWorkerPhaseAcceptsExecutionSummariesWithoutTerminalStates(t *testing.T) {
	for _, test := range []struct {
		wire  string
		valid bool
	}{
		{wire: "preparing", valid: true},
		{wire: "executing", valid: true},
		{wire: "verifying", valid: true},
		{wire: "completing", valid: true},
		{wire: "waiting", valid: true},
		{wire: "paused", valid: true},
		{wire: "active"},
		{wire: "released"},
		{wire: "completed"},
		{wire: "claiming"},
		{wire: "cleaning"},
		{wire: "finished"},
		{wire: ""},
		{wire: "Executing"},
		{wire: "waiting "},
		{wire: " paused"},
	} {
		t.Run(test.wire, func(t *testing.T) {
			if got := WorkerPhase(test.wire).Valid(); got != test.valid {
				t.Fatalf("execution phase %q: validity %t, want %t", test.wire, got, test.valid)
			}
		})
	}
}
