package usage

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestExactMetrics(t *testing.T) {
	for _, s := range []string{"0", "9007199254740993", strings.Repeat("9", 38)} {
		if !Decimal(s, 38) {
			t.Fatal(s)
		}
	}
	for _, s := range []string{"", "-1", "+1", "01", "1.0", "1e3", " 1", strings.Repeat("9", 39)} {
		if Decimal(s, 38) {
			t.Fatal(s)
		}
	}
	good := model.UsageMetrics{Input: Ptr("9007199254740993"), Output: Ptr("7"), Total: Ptr("9007199254741000")}
	if err := Metrics(good, true); err != nil {
		t.Fatal(err)
	}
	for _, m := range []model.UsageMetrics{
		{Input: Ptr("0"), CacheRead: Ptr("1")},
		{Input: Ptr("10"), CacheRead: Ptr("6"), CacheWrite: Ptr("5")},
		{Output: Ptr("1"), Reasoning: Ptr("2")},
		{Input: Ptr("9007199254740993"), Output: Ptr("7"), Total: Ptr("9007199254740999")},
		{Total: Ptr("-1")},
	} {
		if Metrics(m, true) == nil {
			t.Fatalf("accepted %+v", m)
		}
	}
	if Metrics(model.UsageMetrics{}, true) != nil || Metrics(model.UsageMetrics{Input: Ptr("0")}, true) != nil {
		t.Fatal("null or zero")
	}
	for _, s := range []string{"0", "9223372036854775807", "1"} {
		if !Sequence(s, true) {
			t.Fatal(s)
		}
	}
	for _, s := range []string{"9223372036854775808", "01", "-1"} {
		if Sequence(s, true) {
			t.Fatal(s)
		}
	}
	if Sequence("0", false) {
		t.Fatal("positive revision")
	}
	if n, e := Next("9223372036854775806"); e != nil || n != "9223372036854775807" {
		t.Fatal(n, e)
	}
	if _, e := Next("9223372036854775807"); e == nil {
		t.Fatal("overflow")
	}
}
func TestCanonicalVectors(t *testing.T) {
	raw, err := Canonical([]any{"<>&\u2028\u2029", map[string]any{"z": nil, "a": "\n", "\U0001f600": "astral", "\ue000": "bmp"}})
	want := "[\"<>&\u2028\u2029\",{\"a\":\"\\n\",\"z\":null,\"\U0001f600\":\"astral\",\"\ue000\":\"bmp\"}]"
	if err != nil || string(raw) != want {
		t.Fatalf("%s %v", raw, err)
	}
	if _, e := Canonical(map[string]any{"number": 1.5}); e == nil {
		t.Fatal("unexpected floating point")
	}
	if !Timestamp("2026-11-18T03:00:00.123456Z") || Timestamp("2026-11-18T03:00:00.1234567Z") || Timestamp("2026-11-18T03:00:00.1234560Z") || Timestamp("2026-11-18T03:00:00,123Z") || Timestamp("2026-11-18T03:00:00+00:00") {
		t.Fatal("timestamp precision")
	}
	if !UUID("10000000-0000-4000-8000-000000000001") || UUID("10000000000040008000000000000001") {
		t.Fatal("UUID")
	}
	for _, reasons := range [][]string{nil, {"source_conflict", "source_conflict"}, {"raw error"}} {
		if _, e := SortedReasons(reasons); e == nil {
			t.Fatal(reasons)
		}
	}
}
func TestMeasurementHashExcludesObservationAndOrigin(t *testing.T) {
	r := model.UsageRecord{Provider: "copilot", NativeSessionID: "native", ProviderVersion: "sdk-runtime"}
	e := model.UsageEvent{SourceKey: "key", ProfileID: "profile", SourceRevision: "1", ReasonCodes: []string{"model_unknown", "native_recovery_gap"}, NativeMetrics: map[string]any{"inputTokens": "9007199254740993"}}
	a, err := MeasurementHash(r, e)
	if err != nil {
		t.Fatal(err)
	}
	e.EventID = "other"
	e.OriginatingStateID = "another"
	e.ObservedAt = "later"
	e.ReasonCodes = []string{"native_recovery_gap", "model_unknown"}
	b, err := MeasurementHash(r, e)
	if err != nil || a != b {
		t.Fatal(a, b, err)
	}
	e.Model = Ptr("<model>")
	c, _ := MeasurementHash(r, e)
	if c == a {
		t.Fatal("model omitted")
	}
}
func TestRevisionAuthorityAndFinality(t *testing.T) {
	r := model.UsageRecord{SourceKey: Ptr("key"), SourceRevision: Ptr("3"), RevisionAuthority: Ptr("native"), Finality: Ptr("final"), BodyHash: "abc"}
	for _, tc := range []struct{ revision, hash, finality, outcome, code string }{
		{"3", "abc", "final", "duplicate", ""}, {"2", "old", "final", "stale", ""},
		{"4", "zero", "final", "replaced", ""}, {"4", "new", "provisional", "", "finality_regression"},
		{"3", "other", "final", "", "source_conflict"},
	} {
		got, err := Decide(r, tc.revision, tc.hash, tc.finality, false)
		if got != tc.outcome {
			t.Fatal(got, tc)
		}
		if tc.code != "" {
			var f *model.UsageFault
			if !errors.As(err, &f) || f.Code != tc.code {
				t.Fatal(err, tc)
			}
		} else if err != nil {
			t.Fatal(err)
		}
	}
	r.RevisionAuthority = Ptr("immutable")
	r.SourceRevision = Ptr("1")
	if got, e := Decide(r, "1", "abc", "final", false); e != nil || got != "duplicate" {
		t.Fatal(got, e)
	}
	if _, e := Decide(r, "1", "different", "final", false); e == nil {
		t.Fatal("immutable conflict")
	}
}
func TestProviderProfiles(t *testing.T) {
	p, _ := FindProfile("copilot-event-1.0.11-v1", "copilot")
	p = Qualify(p, true)
	e := model.UsageEvent{EventID: "10000000-0000-4000-8000-000000000001", OriginatingStateID: "10000000-0000-4000-8000-000000000002", SourceKey: "copilot-event-v1:10000000-0000-4000-8000-000000000003", ProfileID: p.ID, RevisionAuthority: "immutable", SourceRevision: "1", Finality: "final", Disposition: "active", AggregationRole: "counted", ObservedAt: "2026-11-18T03:00:00Z", ReasonCodes: []string{}, Model: Ptr("model"), NativeMetrics: map[string]any{"inputTokens": "9007199254740993", "outputTokens": "7"}, Metrics: model.UsageMetrics{Output: Ptr("7")}}
	if err := ValidateMeasurement(p, e); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*model.UsageEvent){
		func(e *model.UsageEvent) { e.Metrics.Total = Ptr("7") },
		func(e *model.UsageEvent) { e.SourceRevision = "2" },
		func(e *model.UsageEvent) { e.SourceKey = "random" },
		func(e *model.UsageEvent) { e.IncludedInSourceKey = Ptr("parent") },
		func(e *model.UsageEvent) { e.NativeMetrics = map[string]any{"prompt": "secret"} },
		func(e *model.UsageEvent) { e.NativeMetrics = map[string]any{"outputTokens": 7} },
		func(e *model.UsageEvent) { e.Model = nil },
	} {
		copy := e
		change(&copy)
		if ValidateMeasurement(p, copy) == nil {
			t.Fatal("invalid provider measurement")
		}
	}
	p = Qualify(p, false)
	p.Capability.Qualification = "unverified"
	if ValidateMeasurement(p, e) == nil {
		t.Fatal("unqualified counted")
	}
	c, _ := FindProfile("claude-message-input-0.3.247-v1", "claude")
	c = Qualify(c, true)
	e.ProfileID = c.ID
	e.SourceKey = "claude-message-input-v1:msg"
	e.NativeMetrics = map[string]any{"input_tokens": "2", "cache_read_input_tokens": "3", "cache_creation_input_tokens": "0"}
	e.Metrics = model.UsageMetrics{Input: Ptr("5"), CacheRead: Ptr("3"), CacheWrite: Ptr("0")}
	if err := ValidateMeasurement(c, e); err != nil {
		t.Fatal(err)
	}
	e.Metrics.Input = Ptr("2")
	if ValidateMeasurement(c, e) == nil {
		t.Fatal("cache normalization")
	}
}
func TestStateAndEffectiveCoverage(t *testing.T) {
	now := time.Date(2026, 11, 18, 3, 0, 0, 0, time.UTC)
	p, _ := FindProfile("copilot-event-1.0.11-v1", "copilot")
	p = Qualify(p, true)
	r := model.UsageRecord{ID: "10000000-0000-4000-8000-000000000001", Capability: &p.Capability, CollectionState: Ptr("collecting"), StateSequence: Ptr("0"), ReasonCodes: []string{}, GrantExpiresAt: &now}
	e := model.UsageEvent{EventID: r.ID, StateSequence: "1", CollectionState: "partial", Capability: &p.Capability, ReasonCodes: []string{"input_cache_semantics_unknown", "native_recovery_gap"}, ObservedAt: now.Format(time.RFC3339Nano), Seal: true}
	sealed, err := ApplyState(r, e, p, now)
	if err != nil || sealed.SealedAt == nil {
		t.Fatal(sealed, err)
	}
	if state, reasons := Effective(sealed, EffectiveFacts{Expired: true, Revoked: true}); state != "partial" || len(reasons) != 2 {
		t.Fatal(state, reasons)
	}
	if state, reasons := Effective(r, EffectiveFacts{Expired: true, Known: false}); state != "unavailable" || len(reasons) != 2 {
		t.Fatal(state, reasons)
	}
	e.CollectionState = "complete"
	if _, err = ApplyState(r, e, p, now); err == nil {
		t.Fatal("partial-only complete")
	}
	e.CollectionState = "collecting"
	if _, err = ApplyState(sealed, e, p, now); err == nil {
		t.Fatal("sealed collecting")
	}
	r.ReasonCodes = []string{"source_conflict"}
	e.CollectionState = "partial"
	if _, err = ApplyState(r, e, p, now); err == nil {
		t.Fatal("cleared sticky diagnostic")
	}
	zero := "0"
	summary := model.UsageSummary{Metrics: map[string]model.UsageMetricSummary{"outputTokens": {Known: &zero}}}
	expires := now.Add(time.Hour)
	r.GrantExpiresAt = &expires
	r.ReasonCodes = []string{}
	r.CollectionState = Ptr("partial")
	r.SealedAt = &now
	summary = Coverage(summary, []store.UsageExecution{{SessionID: "one", Backend: "web", State: &r, ParentValid: true, Allowed: true, Known: true}, {SessionID: "one", Backend: "web", State: &r, ParentValid: true, Allowed: true, Known: true}, {SessionID: "two", Backend: "herdr"}}, now)
	if summary.Coverage.Executions != "2" || summary.Coverage.Partial != "1" || summary.Coverage.Unsupported != "1" || summary.Completeness != "partial" {
		t.Fatalf("%+v", summary)
	}
	none := Coverage(model.UsageSummary{}, nil, now)
	if none.Completeness != "no_data" {
		t.Fatal(none)
	}
}
