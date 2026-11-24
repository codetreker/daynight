package usage

import (
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func codexResponseEvent() model.UsageEvent {
	call := strings.Repeat("a", 64)
	return model.UsageEvent{
		EventID: "10000000-0000-4000-8000-000000000001", OriginatingStateID: "10000000-0000-4000-8000-000000000002",
		SourceKey: "codex-response-v1:" + call, NativeCallID: Ptr(call), NativeTurnID: Ptr("turn"),
		ProfileID: "codex-response-0.169.0-v1", RevisionAuthority: "immutable", SourceRevision: "1",
		Finality: "final", Disposition: "active", AggregationRole: "counted", ObservedAt: "2026-11-23T14:00:00Z",
		ReasonCodes:   ProfileReasons("codex", "codex-response-0.169.0-v1"),
		Metrics:       model.UsageMetrics{Input: Ptr("100"), Output: Ptr("10"), CacheRead: Ptr("50"), Reasoning: Ptr("3"), Total: Ptr("110"), ProviderTotal: Ptr("110")},
		NativeMetrics: map[string]any{"inputTokens": "100", "outputTokens": "10", "totalTokens": "110", "cachedInputTokens": "50", "cacheWriteInputTokens": "0", "reasoningOutputTokens": "3"},
	}
}

func TestCodexResponseProfilePreservesNativeMetrics(t *testing.T) {
	p, err := FindProfile("codex-response-0.169.0-v1", "codex")
	if err != nil || p.Capability.Qualification != "unverified" || p.Capability.Completion != "partial_only" || p.Capability.Recovery != "native_history_partial" {
		t.Fatal(p, err)
	}
	e := codexResponseEvent()
	if ValidateMeasurement(p, e) == nil {
		t.Fatal("unqualified Codex response was counted")
	}
	p = Qualify(p, true)
	if err := ValidateMeasurement(p, e); err != nil {
		t.Fatal(err)
	}
	e.NativeMetrics["cachedInputTokens"] = "0"
	e.NativeMetrics["reasoningOutputTokens"] = "0"
	e.Metrics.CacheRead, e.Metrics.Reasoning = nil, nil
	if err := ValidateMeasurement(p, e); err != nil {
		t.Fatal("unknown native details must stay null", err)
	}
	e.NativeMetrics["inputTokens"], e.NativeMetrics["outputTokens"], e.NativeMetrics["totalTokens"] = nil, nil, nil
	e.Metrics.Input, e.Metrics.Output, e.Metrics.Total, e.Metrics.ProviderTotal = nil, nil, nil, nil
	if err := ValidateMeasurement(p, e); err != nil {
		t.Fatal("unknown primary metrics must stay representable", err)
	}
}

func TestCodexResponseProfileRejectsInventedMeasurements(t *testing.T) {
	p, _ := FindProfile("codex-response-0.169.0-v1", "codex")
	p = Qualify(p, true)
	for name, change := range map[string]func(*model.UsageEvent){
		"source prefix": func(e *model.UsageEvent) { e.SourceKey = "snapshot:" + *e.NativeCallID },
		"source size":   func(e *model.UsageEvent) { e.SourceKey += "a" },
		"uppercase hash": func(e *model.UsageEvent) {
			e.SourceKey = "codex-response-v1:" + strings.Repeat("A", 64)
			e.NativeCallID = Ptr(strings.Repeat("A", 64))
		},
		"nonhex hash": func(e *model.UsageEvent) {
			e.SourceKey = "codex-response-v1:" + strings.Repeat("g", 64)
			e.NativeCallID = Ptr(strings.Repeat("g", 64))
		},
		"missing call":             func(e *model.UsageEvent) { e.NativeCallID = nil },
		"different call":           func(e *model.UsageEvent) { e.NativeCallID = Ptr(strings.Repeat("b", 64)) },
		"missing turn":             func(e *model.UsageEvent) { e.NativeTurnID = nil },
		"empty turn":               func(e *model.UsageEvent) { e.NativeTurnID = Ptr("") },
		"model inference":          func(e *model.UsageEvent) { e.Model = Ptr("configured-model") },
		"cache write inference":    func(e *model.UsageEvent) { e.Metrics.CacheWrite = Ptr("0") },
		"input difference":         func(e *model.UsageEvent) { e.NativeMetrics["inputTokens"] = "99" },
		"output difference":        func(e *model.UsageEvent) { e.NativeMetrics["outputTokens"] = "9" },
		"total difference":         func(e *model.UsageEvent) { e.NativeMetrics["totalTokens"] = "109" },
		"provider total inference": func(e *model.UsageEvent) { e.Metrics.ProviderTotal = nil },
		"cache difference":         func(e *model.UsageEvent) { e.NativeMetrics["cachedInputTokens"] = "49" },
		"reasoning difference":     func(e *model.UsageEvent) { e.NativeMetrics["reasoningOutputTokens"] = "2" },
		"cache zero inference":     func(e *model.UsageEvent) { e.NativeMetrics["cachedInputTokens"] = "0"; e.Metrics.CacheRead = Ptr("0") },
		"reasoning zero inference": func(e *model.UsageEvent) {
			e.NativeMetrics["reasoningOutputTokens"] = nil
			e.Metrics.Reasoning = Ptr("0")
		},
		"missing coverage":     func(e *model.UsageEvent) { e.ReasonCodes = []string{} },
		"snapshot metadata":    func(e *model.UsageEvent) { e.NativeMetrics["threadTotalTokens"] = "110" },
		"number metric":        func(e *model.UsageEvent) { e.NativeMetrics["inputTokens"] = 100 },
		"invented revision":    func(e *model.UsageEvent) { e.SourceRevision = "2" },
		"provisional response": func(e *model.UsageEvent) { e.Finality = "provisional" },
	} {
		t.Run(name, func(t *testing.T) {
			e := codexResponseEvent()
			change(&e)
			if ValidateMeasurement(p, e) == nil {
				t.Fatal("invalid Codex response accepted")
			}
		})
	}
}

func TestCodexResponseAndSnapshotStatesRetainTheirOwnLimitations(t *testing.T) {
	now := time.Date(2026, 11, 23, 14, 0, 0, 0, time.UTC)
	p, _ := FindProfile("codex-response-0.169.0-v1", "codex")
	p = Qualify(p, true)
	old := model.UsageRecord{ID: "10000000-0000-4000-8000-000000000001", StateSequence: Ptr("0"), ReasonCodes: []string{}}
	e := model.UsageEvent{EventID: old.ID, StateSequence: "1", CollectionState: "partial", Capability: &p.Capability, ReasonCodes: ProfileReasons(p.Provider, p.ID), ObservedAt: now.Format(time.RFC3339Nano), Seal: true}
	if _, err := ApplyState(old, e, p, now); err != nil {
		t.Fatal("response state incorrectly required unsupported", err)
	}
	e.ReasonCodes = []string{"provider_unsupported"}
	if _, err := ApplyState(old, e, p, now); err == nil {
		t.Fatal("response state lost its actual coverage limits")
	}
	e.CollectionState, e.ReasonCodes, e.NativeEndedAt = "complete", []string{}, Ptr(now.Format(time.RFC3339Nano))
	if _, err := ApplyState(old, e, p, now); err == nil {
		t.Fatal("partial-only response profile claimed completeness")
	}
	snapshot, _ := FindProfile("codex-snapshot-unaccountable-v1", "codex")
	snapshot = Qualify(snapshot, true)
	if snapshot.Capability.Qualification != "unsupported" {
		t.Fatal("legacy snapshot was upgraded")
	}
	e.CollectionState, e.Capability, e.ReasonCodes = "unsupported", &snapshot.Capability, ProfileReasons("codex", snapshot.ID)
	if _, err := ApplyState(old, e, snapshot, now); err != nil {
		t.Fatal("legacy snapshot state changed contract", err)
	}
	measurement := codexResponseEvent()
	measurement.ProfileID = snapshot.ID
	if ValidateMeasurement(snapshot, measurement) == nil {
		t.Fatal("legacy snapshot gained a counted plane")
	}
}
