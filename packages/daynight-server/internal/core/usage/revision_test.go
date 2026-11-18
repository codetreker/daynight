package usage

import (
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestIsolatedCompleteProfileAndAuthoritativeCorrection(t *testing.T) {
	now := time.Date(2026, 11, 18, 3, 0, 0, 0, time.UTC)
	p := Profile{Provider: "isolated-fixture", ID: "isolated-native-v1", SourcePrefix: "fixture-call-v1:", AllowInclusion: true, Capability: model.UsageCapability{ProfileID: "isolated-native-v1", Qualification: "verified", MeasurementPlane: "native_event", RevisionAuthority: "native", Metrics: map[string]string{}, Subagents: "included_per_event", Recovery: "durable_after_ingress_only", Completion: "complete_capable"}}
	state := model.UsageRecord{ID: "10000000-0000-4000-8000-000000000001", Provider: p.Provider, ProfileID: p.ID, NativeSessionID: "native", ProviderVersion: "isolated", StateSequence: Ptr("0"), Capability: &p.Capability, CollectionState: Ptr("collecting"), ReasonCodes: []string{}}
	event := model.UsageEvent{EventID: "10000000-0000-4000-8000-000000000002", Kind: "measurement", OriginatingStateID: state.ID, SourceKey: "fixture-call-v1:call", ProfileID: p.ID, RevisionAuthority: "native", SourceRevision: "1", Finality: "final", Disposition: "active", AggregationRole: "counted", Metrics: model.UsageMetrics{Input: Ptr("10"), Output: Ptr("7"), Total: Ptr("17")}, NativeMetrics: map[string]any{}, ReasonCodes: []string{}, ObservedAt: now.Format(time.RFC3339Nano)}
	if err := ValidateMeasurement(p, event); err != nil {
		t.Fatal(err)
	}
	original, err := Measurement(state, event, "10000000-0000-4000-8000-000000000003", now)
	if err != nil {
		t.Fatal(err)
	}
	event.SourceRevision = "2"
	event.Metrics = model.UsageMetrics{Input: Ptr("0"), Output: Ptr("0"), Total: Ptr("0")}
	hash, err := MeasurementHash(state, event)
	if err != nil {
		t.Fatal(err)
	}
	if outcome, e := Decide(original, "2", hash, "final", false); e != nil || outcome != "replaced" {
		t.Fatal(outcome, e)
	}
	corrected, err := Measurement(state, event, original.ID, now)
	if err != nil || Value(corrected.Metrics.Total) != "0" {
		t.Fatal(corrected, err)
	}
	event.SourceRevision = "3"
	event.Disposition = "retracted"
	event.Metrics = model.UsageMetrics{}
	event.ReasonCodes = []string{"source_conflict"}
	if err = ValidateMeasurement(p, event); err != nil {
		t.Fatal(err)
	}
	retracted, err := Measurement(state, event, original.ID, now)
	if err != nil || Value(retracted.Disposition) != "retracted" || retracted.Metrics.Total != nil {
		t.Fatal(retracted, err)
	}
	event.Metrics.Output = Ptr("0")
	if ValidateMeasurement(p, event) == nil {
		t.Fatal("retraction with known zero")
	}
	stateEvent := model.UsageEvent{EventID: event.EventID, Kind: "execution_state", StateSequence: "1", CollectionState: "complete", Capability: &p.Capability, ReasonCodes: []string{}, NativeStartedAt: Ptr(now.Add(-time.Hour).Format(time.RFC3339Nano)), NativeEndedAt: Ptr(now.Format(time.RFC3339Nano)), ObservedAt: now.Format(time.RFC3339Nano), Seal: true}
	sealed, err := ApplyState(state, stateEvent, p, now)
	if err != nil || sealed.SealedAt == nil {
		t.Fatal(sealed, err)
	}
	summary := Coverage(model.UsageSummary{}, []store.UsageExecution{{SessionID: "session", State: &sealed, ParentValid: true, Allowed: true}}, now.Add(8*24*time.Hour))
	if summary.Completeness != "complete" || summary.Coverage.Complete != "1" {
		t.Fatal(summary)
	}
	parent := original
	child := original
	child.ID = "child"
	child.SourceKey = Ptr("child")
	child.AggregationRole = Ptr("included")
	child.IncludedInSourceKey = original.SourceKey
	if err = ValidateInclusion(child, parent); err != nil {
		t.Fatal(err)
	}
	child.AnchorStateID = Ptr("another")
	if ValidateInclusion(child, parent) == nil {
		t.Fatal("cross anchor inclusion")
	}
	if _, err = FindProfile(p.ID, "copilot"); err == nil {
		t.Fatal("fixture profile entered production registry")
	}
}
func TestCoverageStateClassesAndNullRemainDistinct(t *testing.T) {
	now := time.Now().UTC()
	sealed := now
	for _, name := range []string{"collecting", "complete", "partial", "unsupported", "unavailable"} {
		r := model.UsageRecord{CollectionState: Ptr(name), SealedAt: &sealed, ReasonCodes: []string{}}
		got := Coverage(model.UsageSummary{}, []store.UsageExecution{{SessionID: "one", State: &r}}, now)
		if got.Completeness != name {
			t.Fatalf("%s: %+v", name, got)
		}
	}
	r := model.UsageRecord{CollectionState: Ptr("complete"), SealedAt: &sealed, ReasonCodes: []string{}}
	mixed := Coverage(model.UsageSummary{}, []store.UsageExecution{{SessionID: "one", State: &r}, {SessionID: "two", Backend: "herdr"}}, now)
	if mixed.Completeness != "partial" {
		t.Fatal(mixed)
	}
	none := Coverage(model.UsageSummary{}, []store.UsageExecution{{SessionID: "one", Backend: "web"}}, now)
	if none.Completeness != "no_data" || strings.Join(none.ReasonCodes, ",") != "registration_missing" {
		t.Fatal(none)
	}
}
